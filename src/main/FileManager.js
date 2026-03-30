/**
 * This file handles operations and communication with server related to files.
 * Including upload, download, delete, search.
 */
import { dialog } from 'electron'
import { socket } from './MessageManager'
import { createReadStream, createWriteStream, unlinkSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { unlink, readFile, writeFile } from 'node:fs/promises'
import {
  applyVisibleWatermark,
  applyInvisibleWatermark,
  getMimeFromFilename,
  isWatermarkSupported
} from './WatermarkProcessor'
import { logger } from './Logger'
import { uploadFileProcessHttps, downloadFileProcessHttps } from './HttpsFileProcess'
import { uploadFileProcessFtps, downloadFileProcessFtps } from './FtpsFileProcess'
import { basename, resolve } from 'node:path'
import { createPipeProgress } from './util/PipeProgress'
import cq from 'concurrent-queue'
import GlobalValueManager from './GlobalValueManager'
import AESModule from './AESModule'
import BlockchainManager from './BlockchainManager'
import FileUploadCoordinator from './FileUploadCoordinator'
import {
  bigIntToHex,
  CheckDiskSizePermissionTryAgainMsg,
  CheckLogForDetailMsg,
  ContactManagerOrTryAgainMsg,
  TryAgainMsg
} from './Utils'
import { downloadFileProcessSftp, uploadFileProcessSftp } from './SftpFileProcess'
import ABSEManager from './ABSEManager'
import DatabaseManager from './DatabaseManager'
import {
  runPreUploadClassification,
  makeUploadBatchClassifyKey,
  snapshotForPostUploadDialog
} from './services/preUploadClassifyCache.js'
import {
  getUploadBatchSmartClassifyWanted,
  getAppClassifierEnabled
} from './services/classifierRuntime.js'

class FileManager {
  aesModule
  blockchainManager
  uploadQueue
  #uploadBatch = {
    expected: 0,
    fileIds: [],
    pathsByFileId: {},
    classifyBatchKey: null,
    classifierWanted: false
  }
  /**
   * @param {AESModule} aesModule
   * @param {BlockchainManager} blockchainManager
   * @param {ABSEManager} abseManager
   * @param {DatabaseManager} databaseManager
   * @param {number} queueConcurrency
   */
  constructor(aesModule, blockchainManager, abseManager, databaseManager, queueConcurrency = 3) {
    this.aesModule = aesModule
    this.blockchainManager = blockchainManager
    this.abseManager = abseManager
    this.databaseManager = databaseManager
    this.uploadQueue = cq()
      .limit({ concurrency: queueConcurrency })
      .process(this.#uploadProcess.bind(this))
    // Blockchain transactions must be serialized to avoid nonce collisions
    this.blockchainQueue = cq()
      .limit({ concurrency: 1 })
      .process(async ({ coordinator }) => {
        await coordinator.uploadToBlockchainWhenReady()
      })

    /**
     * A message from server when upload verification finished.
     */
    socket.on('upload-file-res', (response) => {
      if (response.errorMsg) {
        logger.error(
          `Failed to upload file ${response.fileId}: ${response.errorMsg}. Upload aborted.`
        )
        this.#sendUploadErrorNotice(response.errorMsg)
      } else {
        GlobalValueManager.sendNotice(`Success to upload file ${response.fileId}`, 'success')
        this.#uploadBatch.fileIds.push(response.fileId)
        this.getFileListProcess(GlobalValueManager.curFolderId)
      }
      // Decrement regardless of success/failure, then check if whole batch is done
      this.#uploadBatch.expected = Math.max(0, this.#uploadBatch.expected - 1)
      this.#checkUploadBatchDone()
    })

    /**
     * Send the partial search result to renderer when receiving from server.
     */
    socket.on('partial-search-files', (response) => {
      const { files } = response
      // logger.debug('get file', files)
      GlobalValueManager.mainWindow?.webContents.send('partial-search-files', files)
    })
  }

  /**
   * Send upload error notice to renderer
   * @param {String} errorMsg
   * @param {String} treatmentMsg
   * @example this.#sendUploadErrorNotice('File encryption failed.', TryAgainMsg)
   */
  #sendUploadErrorNotice(errorMsg, treatmentMsg = TryAgainMsg) {
    GlobalValueManager.sendNotice(`Failed to upload file: ${errorMsg} ${treatmentMsg}`, 'error')
  }

  /**
   * Send download error notice to renderer
   * @param {String} errorMsg
   * @param {String} treatmentMsg
   * @example this.#sendDownloadErrorNotice('File decryption failed.', TryAgainMsg)
   */
  #sendDownloadErrorNotice(errorMsg, treatmentMsg = TryAgainMsg) {
    GlobalValueManager.sendNotice(`Failed to download file: ${errorMsg} ${treatmentMsg}`, 'error')
  }

  /**
   * Check if all files in the current upload batch have received a response.
   * If so, notify the renderer to open the post-upload settings dialog.
   */
  #checkUploadBatchDone() {
    if (this.#uploadBatch.expected === 0 && this.#uploadBatch.fileIds.length > 0) {
      const { classifyBatchKey, classifierWanted, fileIds, pathsByFileId } = this.#uploadBatch
      const sourcePaths = fileIds.map((id) => pathsByFileId[id]).filter(Boolean)
      const { classificationPreview } = snapshotForPostUploadDialog(
        classifierWanted,
        getAppClassifierEnabled(),
        classifyBatchKey
      )
      GlobalValueManager.mainWindow?.webContents.send('upload-batch-done', {
        fileIds: [...fileIds],
        sourcePaths,
        classificationPreview,
        classifyBatchKey
      })
      this.#uploadBatch = {
        expected: 0,
        fileIds: [],
        pathsByFileId: {},
        classifyBatchKey: null,
        classifierWanted: false
      }
    }
  }

  /**
   * The process of actually uploading the file.
   * Properly awaits each stage so concurrent-queue concurrency control works correctly.
   * @param {{ filePath: string, parentFolderId: string }} info
   */
  async #uploadProcess({ filePath, parentFolderId }) {
    let cipher = null
    let spk = null
    let encryptedStream = null
    let fileStream = null
    const originalFileName = basename(filePath)

    // Step 1: Read the file and create an encrypted stream
    try {
      fileStream = createReadStream(filePath)
      logger.info('Encrypting file...')
      ;({ cipher, spk, encryptedStream } = await this.aesModule.encrypt(fileStream))
      encryptedStream.on('error', (err) => {
        logger.error(err)
        this.#sendUploadErrorNotice('File encryption failed.')
      })
    } catch (error) {
      logger.error(`Failed to create stream or encrypt file: ${error}. Upload aborted.`)
      this.#sendUploadErrorNotice(
        'File stream creation failed.',
        'Please check if file exists and try again.'
      )
      return
    }

    // Step 2: Pre-upload — send encrypted AES key to server and get fileId
    logger.info('Sending key and iv to server...')
    let fileId
    try {
      fileId = await new Promise((resolve, reject) => {
        socket.emit('upload-file-pre', { cipher, spk, parentFolderId }, (response) => {
          if (response.errorMsg) reject(new Error(response.errorMsg))
          else resolve(response.fileId)
        })
      })
    } catch (error) {
      logger.error(`Failed to pre-upload: ${error.message}. Upload aborted.`)
      this.#sendUploadErrorNotice(error.message)
      return
    }

    // Keep source path for post-upload dialog + retry classify flow
    if (this.#uploadBatch.pathsByFileId) {
      this.#uploadBatch.pathsByFileId[fileId] = filePath
    }

    // Step 3: Set up tee — split encryptedStream into hash stream and write stream
    const tempEncryptedFilePath = resolve(GlobalValueManager.tempPath, fileId)
    const writeStream = createWriteStream(tempEncryptedFilePath)
    const fileUploadCoordinator = new FileUploadCoordinator(
      this.blockchainManager,
      JSON.stringify({ filename: originalFileName })
    )
    const hashPassThrough = new PassThrough()
    const writePassThrough = new PassThrough()
    encryptedStream.pipe(hashPassThrough)
    encryptedStream.pipe(writePassThrough)

    // Hash calculation runs concurrently with disk write
    this.aesModule
      .makeHashPromise(hashPassThrough)
      .then((digest) => {
        fileUploadCoordinator.finishHash(digest)
      })
      .catch((error) => {
        logger.error(error)
        this.#sendUploadErrorNotice('File hash calculation failed.')
      })

    // Step 4: Write to disk then upload to server (awaited)
    try {
      await new Promise((resolve, reject) => {
        writeStream.on('close', async () => {
          logger.info(`Encrypted file finished writing.`, { tempEncryptedFilePath })
          const protocol = GlobalValueManager.serverConfig.protocol
          logger.info(`Uploading file ${basename(filePath)} with protocol ${protocol}`)
          try {
            switch (protocol) {
              case 'https':
                await uploadFileProcessHttps(
                  tempEncryptedFilePath,
                  originalFileName,
                  fileId,
                  fileUploadCoordinator
                )
                break
              case 'ftps':
                await uploadFileProcessFtps(
                  tempEncryptedFilePath,
                  originalFileName,
                  fileId,
                  fileUploadCoordinator
                )
                break
              case 'sftp':
                await uploadFileProcessSftp(
                  tempEncryptedFilePath,
                  originalFileName,
                  fileId,
                  fileUploadCoordinator
                )
                break
              default:
                throw new Error('Invalid file protocol')
            }
            resolve()
          } catch (err) {
            reject(err)
          }
        })
        writeStream.on('error', (error) => {
          logger.error(error)
          this.#sendUploadErrorNotice(
            'Encrypted file failed to write.',
            CheckDiskSizePermissionTryAgainMsg
          )
          reject(error)
        })
        writePassThrough.pipe(writeStream)
      })
    } catch (error) {
      logger.error(error)
      this.#sendUploadErrorNotice(
        `Upload with ${GlobalValueManager.serverConfig.protocol} failed.`,
        CheckLogForDetailMsg
      )
      return
    }

    // Step 5: Enqueue blockchain upload to serialized queue (non-blocking for upload slots)
    // blockchainQueue has concurrency: 1 to prevent Ethereum nonce collisions
    this.blockchainQueue({ coordinator: fileUploadCoordinator }).catch((error) => {
      logger.error(error)
      this.#sendUploadErrorNotice('Blockchain upload failed.', ContactManagerOrTryAgainMsg)
    })
  }

  /**
   * Browse and select files to upload, and push to an upload queue for concurrent upload process.
   * @param {string} parentFolderId
   */
  async uploadFileProcess(parentFolderId) {
    logger.info('Browsing file...')
    const { filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections']
    })
    if (filePaths.length > 0) {
      const classifierWanted = getUploadBatchSmartClassifyWanted()
      const classifierEnabled = getAppClassifierEnabled()
      const classifyBatchKey =
        classifierWanted && classifierEnabled ? makeUploadBatchClassifyKey(filePaths) : null

      this.#uploadBatch = {
        expected: filePaths.length,
        fileIds: [],
        pathsByFileId: {},
        classifyBatchKey,
        classifierWanted
      }

      // Fire LM classification in background; upload continues concurrently
      if (classifierWanted && classifierEnabled && classifyBatchKey) {
        void runPreUploadClassification(
          (payload) =>
            GlobalValueManager.mainWindow?.webContents.send('preupload-classify-status', payload),
          classifyBatchKey,
          filePaths
        )
      }

      for (const filePath of filePaths) {
        this.uploadQueue({ filePath, parentFolderId })
      }
    } else {
      GlobalValueManager.sendNotice('File upload canceled.', 'error')
    }
  }

  /**
   * Get the file list under current folder.
   * @param {string} parentFolderId
   */
  getFileListProcess(parentFolderId) {
    logger.info(`Getting file list for ${parentFolderId || 'home'}...`)
    socket.emit('get-file-list', { parentFolderId }, async (response) => {
      try {
        const { files, folders, errorMsg } = response
        if (errorMsg) {
          logger.error(`Failed to get file list: ${errorMsg}`)
          GlobalValueManager.sendNotice('Failed to get file list', 'error')
        } else {
          logger.info('Sucess to get file list')
          const globalAttrs = (await this.abseManager.getPP())?.U || []
          // tags and attrIds now come directly from the server (PostgreSQL)
          const filesObj = JSON.parse(files)
          filesObj.forEach((file) => {
            file.tags = Array.isArray(file.tags) ? file.tags : []
            file.attrs = Array.isArray(file.attrIds)
              ? file.attrIds.map((id) => globalAttrs.at(id)).filter(Boolean)
              : []
            logger.debug(`attrs for file ${file.id}`, { attrs: file.attrs })
          })
          GlobalValueManager.mainWindow?.webContents.send('file-list-res', {
            files: filesObj,
            folders
          })
        }
      } catch (error) {
        logger.error(error)
        GlobalValueManager.sendNotice('Failed to get file list', 'error')
      }
    })
  }

  /**
   * Ask the server to download file.
   * @param {string} fileId the file to download
   */
  downloadFileProcess(fileId) {
    logger.info(`Asking for file ${fileId}...`)
    /**
     * Pre-download request to get the fileInfo
     */
    socket.emit('download-file-pre', { fileId }, async (response) => {
      try {
        if (response.errorMsg) {
          logger.error(`Failed to download file: ${response.errorMsg}`)
          this.#sendDownloadErrorNotice(response.errorMsg, ContactManagerOrTryAgainMsg)
          return
        }
        if (!response.fileInfo) {
          //! This should not happen
          logger.error(`File ${fileId} not found`)
          this.#sendDownloadErrorNotice('File not found', ContactManagerOrTryAgainMsg)
          return
        }
        // console.log(fileInfo)
        // Get the verification info of this file from blockchain.
        try {
          const blockchainVerification = await this.blockchainManager.getFileVerification(
            fileId,
            response.fileInfo.verifyblocknumber
          )
          if (!blockchainVerification || blockchainVerification.verificationInfo != 'success') {
            logger.error(`File ${fileId} not verified.`)
            this.#sendDownloadErrorNotice(
              'File not verified on blockchain.',
              ContactManagerOrTryAgainMsg
            )
            return
          }
        } catch (error) {
          logger.error(error)
          this.#sendDownloadErrorNotice(
            'Failed to get file verification from blockchain.',
            ContactManagerOrTryAgainMsg
          )
          return
        }
        logger.info(`File ${fileId} is verified.`)

        const proxied = response.fileInfo.ownerId !== response.fileInfo.originOwnerId

        // Get file information from blockchain. Will be used later to chekc for hash.
        let blockchainFileInfo = null
        try {
          blockchainFileInfo = await this.blockchainManager.getFileInfo(
            fileId,
            response.fileInfo.infoblocknumber
          )
          logger.debug(blockchainFileInfo)
          if (!blockchainFileInfo) {
            logger.error(`File ${fileId} info not on blockchain.`)
            this.#sendDownloadErrorNotice(
              'File info not on blockchain.',
              ContactManagerOrTryAgainMsg
            )
            return
          }
        } catch (error) {
          logger.error(error)
          this.#sendDownloadErrorNotice(
            'Failed to get file info from blockchain.',
            ContactManagerOrTryAgainMsg
          )
          return
        }

        const { id, name, cipher, spk, size } = response.fileInfo
        // Second download process for actually downloading the file.
        this.downloadFileProcess2(id, name, cipher, spk, size, proxied, blockchainFileInfo)
      } catch (error) {
        logger.error(error)
        this.#sendDownloadErrorNotice('Unexpected error.', ContactManagerOrTryAgainMsg)
      }
    })
  }

  /**
   * The second dowload process for actually downloading the file.
   * @param {*} fileId
   * @param {*} filename
   * @param {*} cipher
   * @param {*} spk
   * @param {*} size
   * @param {*} proxied
   * @param {*} blockchainFileInfo
   * @returns
   */
  async downloadFileProcess2(fileId, filename, cipher, spk, size, proxied, blockchainFileInfo) {
    try {
      // Let the user select where to store the file. TODO: move to process 1.
      const { filePath, canceled } = await dialog.showSaveDialog({
        defaultPath: filename,
        properties: ['showOverwriteConfirmation', 'createDirectory']
      })
      if (canceled) {
        logger.info('Download canceled.')
        GlobalValueManager.sendNotice('Download canceled.', 'error')
        return
      }

      //-- Write stream for writing file later --//
      let writeStream
      try {
        writeStream = createWriteStream(filePath)
      } catch (error) {
        logger.error(error)
        this.#sendDownloadErrorNotice(
          'Failed to create write stream.',
          CheckDiskSizePermissionTryAgainMsg
        )
      }
      let writeCompleteResolve, writeCompleteReject
      const writeCompletePromise = new Promise((resolve, reject) => {
        writeCompleteResolve = resolve
        writeCompleteReject = reject
      })
      writeStream.on('error', (err) => {
        logger.error(`Failed to write file ${filename}: ${err}. Download aborted.`)
        this.#sendDownloadErrorNotice('Failed to write file.', CheckDiskSizePermissionTryAgainMsg)
        try {
          unlinkSync(filePath)
        } catch (error) {
          if (error.code !== 'ENOENT') {
            logger.error(error)
          }
        } finally {
          writeCompleteReject()
        }
      })
      writeStream.on('finish', () => {
        logger.info(`Downloaded file ${filename} to ${filePath}`)
        GlobalValueManager.sendNotice('File downloaded. Verifying hash...', 'normal')
        writeCompleteResolve()
      })
      // Test write error
      // writeStream.emit('error')

      //-- Decrypt file --//
      const decipher = await this.aesModule.decrypt(cipher, spk, proxied)
      decipher.on('error', (err) => {
        logger.error(err)
        this.#sendDownloadErrorNotice(
          'Failed to decrypt file. The file could be corrupted or modified.',
          ContactManagerOrTryAgainMsg
        )
        try {
          unlinkSync(filePath)
        } catch (error) {
          if (error.code !== 'ENOENT') {
            logger.error(error)
          }
        }
      })
      // Test decrypt error
      // decipher.emit('error')

      logger.info(
        `Downloading file ${fileId} with protocol ${GlobalValueManager.serverConfig.protocol}...`
      )
      // download progress
      const pipeProgress = createPipeProgress({ total: size }, logger)

      //-- Caculate hash --//
      const hashPromise = this.aesModule.makeHashPromise(pipeProgress)

      pipeProgress.pipe(decipher)
      decipher.pipe(writeStream)

      //-- Download file with protocol --//
      const protocol = GlobalValueManager.serverConfig.protocol
      try {
        logger.info(`Downloading file ${fileId} with protocol ${protocol}`)
        switch (protocol) {
          case 'https':
            await downloadFileProcessHttps(fileId, pipeProgress, filePath)
            break
          case 'ftps':
            await downloadFileProcessFtps(fileId, pipeProgress, filePath)
            break
          case 'sftp':
            await downloadFileProcessSftp(fileId, pipeProgress, filePath)
            break
          default:
            logger.error('Invalid file protocol')
            this.#sendDownloadErrorNotice('Invalid file protocol.')
            break
        }
        await writeCompletePromise
      } catch (error) {
        logger.error(error)
        this.#sendDownloadErrorNotice(`Download with ${protocol} failed.`, CheckLogForDetailMsg)
        return
      }

      //-- Verify hash --//
      try {
        const fileHash = await hashPromise
        const blockchainHash = bigIntToHex(blockchainFileInfo.fileHash, 64) // sha256 have length 64
        if (fileHash !== blockchainHash) {
          try {
            logger.debug('File Hash different', {
              fileHash,
              blockchainHash
            })
            logger.error(`File hash did not meet for file ${fileId}`)
            this.#sendDownloadErrorNotice(
              'File hash did not meet. The file could be modified.',
              ContactManagerOrTryAgainMsg
            )
            socket.emit('download-file-hash-error', {
              fileId,
              fileHash,
              blockchainHash
            })
          } catch (error1) {
            logger.error(error1)
          } finally {
            try {
              await unlink(filePath)
            } catch (error2) {
              if (error2.code !== 'ENOENT') {
                logger.error(error2)
              }
            }
          }
          return
        }
        logger.info(`File hash verified for file ${fileId}.`)
        GlobalValueManager.sendNotice('Success to download file', 'success')
      } catch (error) {
        logger.error(error)
        this.#sendDownloadErrorNotice('File hash calculation failed.')
      }
    } catch (error) {
      logger.error(`Failed to download file: ${error}. Download aborted.`)
      this.#sendDownloadErrorNotice('Unexpected error.', ContactManagerOrTryAgainMsg)
    }
  }

  /**
   * Download a file with options (original or watermark).
   * Called by the IPC handler for 'download-with-options'.
   * @param {{ fileId: string, mode: 'original'|'watermark', watermarkOptions: object|null }} opts
   */
  downloadFileWithOptionsProcess({ fileId, mode, watermarkOptions }) {
    if (mode !== 'watermark') {
      // Original download: reuse existing flow
      this.downloadFileProcess(fileId)
      return
    }
    this.#downloadWithWatermark(fileId, watermarkOptions)
  }

  /**
   * Full watermark download flow.
   * 1) Server logs download event + returns authenticated metadata
   * 2) Pre-download to get file info + blockchain verify
   * 3) Download + decrypt to temp file
   * 4) Apply watermark
   * 5) Save to user's chosen path
   */
  async #downloadWithWatermark(fileId, watermarkOptions) {
    // Step 1: get auth metadata from server (logs the download event)
    let watermarkMeta
    try {
      watermarkMeta = await new Promise((resolve, reject) => {
        socket.emit(
          'download-file-with-watermark',
          {
            fileId,
            mode: 'watermark',
            watermark: {
              visible: watermarkOptions?.visible === true,
              invisible: watermarkOptions?.invisible === true,
              customNote: watermarkOptions?.customNote ?? '',
              position: watermarkOptions?.position ?? 'bottomRight',
              opacity: watermarkOptions?.opacity ?? 0.3,
              fontSize: watermarkOptions?.fontSize ?? 14
            }
          },
          (response) => {
            if (response.errorMsg) reject(new Error(response.errorMsg))
            else resolve(response.watermarkMeta)
          }
        )
      })
    } catch (e) {
      logger.error(`[WM] get watermark meta failed: ${e.message}`)
      this.#sendDownloadErrorNotice(e.message, ContactManagerOrTryAgainMsg)
      return
    }

    // Step 2: pre-download → file info + blockchain verification
    socket.emit('download-file-pre', { fileId }, async (response) => {
      try {
        if (response.errorMsg) {
          this.#sendDownloadErrorNotice(response.errorMsg, ContactManagerOrTryAgainMsg)
          return
        }
        if (!response.fileInfo) {
          this.#sendDownloadErrorNotice('File not found', ContactManagerOrTryAgainMsg)
          return
        }

        // Blockchain verify
        try {
          const bv = await this.blockchainManager.getFileVerification(
            fileId,
            response.fileInfo.verifyblocknumber
          )
          if (!bv || bv.verificationInfo !== 'success') {
            this.#sendDownloadErrorNotice('File not verified on blockchain.', ContactManagerOrTryAgainMsg)
            return
          }
        } catch (e) {
          logger.error(e)
          this.#sendDownloadErrorNotice('Blockchain verification failed.', ContactManagerOrTryAgainMsg)
          return
        }

        let blockchainFileInfo = null
        try {
          blockchainFileInfo = await this.blockchainManager.getFileInfo(
            fileId,
            response.fileInfo.infoblocknumber
          )
          if (!blockchainFileInfo) {
            this.#sendDownloadErrorNotice('File info not on blockchain.', ContactManagerOrTryAgainMsg)
            return
          }
        } catch (e) {
          logger.error(e)
          this.#sendDownloadErrorNotice('Failed to get blockchain file info.', ContactManagerOrTryAgainMsg)
          return
        }

        const { id, name, cipher, spk, size } = response.fileInfo
        const proxied = response.fileInfo.ownerId !== response.fileInfo.originOwnerId
        const mimeType = watermarkOptions?.mimeType ?? getMimeFromFilename(name)

        // Sanity check: confirm format is still supported server-side
        if (!isWatermarkSupported(name)) {
          this.#sendDownloadErrorNotice(
            `${name} 格式不支援浮水印，改以原檔下載。`
          )
          this.downloadFileProcess(fileId)
          return
        }

        // Step 3: show save dialog
        const { filePath, canceled } = await dialog.showSaveDialog({
          defaultPath: name,
          properties: ['showOverwriteConfirmation', 'createDirectory']
        })
        if (canceled) {
          GlobalValueManager.sendNotice('Download canceled.', 'error')
          return
        }

        // Step 4: download + decrypt to temp path
        const tempPath = resolve(
          GlobalValueManager.tempPath,
          `${id}_wm_${Date.now()}`
        )
        try {
          await this.#downloadDecryptToPath(id, name, cipher, spk, size, proxied, blockchainFileInfo, tempPath)
        } catch (e) {
          logger.error(e)
          // cleanup will happen inside #downloadDecryptToPath on error
          return
        }

        // Step 5: apply watermark
        GlobalValueManager.sendNotice('Applying watermark...', 'normal')
        try {
          const decryptedBuffer = await readFile(tempPath)

          // Build watermark text from server-authenticated metadata + optional custom note
          const shortUid = (watermarkMeta.userId || '').slice(0, 8)
          const shortFid = (watermarkMeta.fileId || '').slice(0, 8)
          const ts = watermarkMeta.ts || new Date().toISOString()
          const customNote = (watermarkOptions?.customNote || '').trim()
          const wmText = `uid:${shortUid} | fid:${shortFid} | ${ts}${customNote ? ' | ' + customNote : ''}`

          // Apply visible watermark first (if requested), then invisible on top
          let processedBuffer = decryptedBuffer

          if (watermarkOptions?.visible === true) {
            processedBuffer = await applyVisibleWatermark(processedBuffer, mimeType, {
              text: wmText,
              position: watermarkOptions?.position ?? 'bottomRight',
              opacity: watermarkOptions?.opacity ?? 0.3,
              fontSize: watermarkOptions?.fontSize ?? 14
            })
          }

          if (watermarkOptions?.invisible === true) {
            processedBuffer = await applyInvisibleWatermark(processedBuffer, mimeType, {
              text: wmText
            })
          }

          await writeFile(filePath, processedBuffer)
          const modes = [
            watermarkOptions?.visible === true && '可視',
            watermarkOptions?.invisible === true && '不可視'
          ]
            .filter(Boolean)
            .join(' + ')
          GlobalValueManager.sendNotice(`File downloaded with ${modes} watermark.`, 'success')
        } catch (e) {
          logger.error(e)
          const code = e.message === 'WATERMARK_UNSUPPORTED_FORMAT' ? e.message : 'Watermark failed.'
          this.#sendDownloadErrorNotice(code, TryAgainMsg)
        } finally {
          try { await unlink(tempPath) } catch (_) { /* ignore */ }
        }
      } catch (error) {
        logger.error(error)
        this.#sendDownloadErrorNotice('Unexpected error.', ContactManagerOrTryAgainMsg)
      }
    })
  }

  /**
   * Download + decrypt a file to an explicit output path, then verify hash.
   * Used by watermark flow to get decrypted file before applying watermark.
   */
  async #downloadDecryptToPath(fileId, filename, cipher, spk, size, proxied, blockchainFileInfo, outputPath) {
    const writeStream = createWriteStream(outputPath)
    let writeCompleteResolve, writeCompleteReject
    const writeCompletePromise = new Promise((resolve, reject) => {
      writeCompleteResolve = resolve
      writeCompleteReject = reject
    })
    writeStream.on('finish', () => writeCompleteResolve())
    writeStream.on('error', async (err) => {
      logger.error(err)
      try { await unlink(outputPath) } catch (_) { /* ignore */ }
      writeCompleteReject(err)
    })

    const decipher = await this.aesModule.decrypt(cipher, spk, proxied)
    decipher.on('error', async (err) => {
      logger.error(err)
      this.#sendDownloadErrorNotice('File decryption failed.', ContactManagerOrTryAgainMsg)
      try { await unlink(outputPath) } catch (_) { /* ignore */ }
    })

    const pipeProgress = createPipeProgress({ total: size }, logger)
    const hashPromise = this.aesModule.makeHashPromise(pipeProgress)
    pipeProgress.pipe(decipher)
    decipher.pipe(writeStream)

    const protocol = GlobalValueManager.serverConfig.protocol
    try {
      switch (protocol) {
        case 'https':
          await downloadFileProcessHttps(fileId, pipeProgress, outputPath)
          break
        case 'ftps':
          await downloadFileProcessFtps(fileId, pipeProgress, outputPath)
          break
        case 'sftp':
          await downloadFileProcessSftp(fileId, pipeProgress, outputPath)
          break
        default:
          throw new Error('Invalid file protocol')
      }
      await writeCompletePromise
    } catch (error) {
      logger.error(error)
      this.#sendDownloadErrorNotice(`Download failed.`, CheckLogForDetailMsg)
      throw error
    }

    // Verify hash
    try {
      const fileHash = await hashPromise
      const blockchainHash = bigIntToHex(blockchainFileInfo.fileHash, 64)
      if (fileHash !== blockchainHash) {
        logger.error(`Hash mismatch for ${fileId}`)
        this.#sendDownloadErrorNotice('File hash mismatch. File may be modified.', ContactManagerOrTryAgainMsg)
        socket.emit('download-file-hash-error', { fileId, fileHash, blockchainHash })
        try { await unlink(outputPath) } catch (_) { /* ignore */ }
        throw new Error('Hash mismatch')
      }
      logger.info(`[WM] Hash verified for ${fileId}`)
    } catch (error) {
      if (error.message !== 'Hash mismatch') {
        logger.error(error)
        this.#sendDownloadErrorNotice('Hash verification failed.')
      }
      throw error
    }
  }

  /**
   * Ask to delete a file on server.
   * @param {string} fileId
   */
  deleteFileProcess(fileId) {
    logger.info(`Asking to delete file ${fileId}...`)
    socket.emit('delete-file', { fileId }, (response) => {
      const { errorMsg } = response
      if (errorMsg) {
        logger.error(`Failed to delete file ${fileId}: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to delete file', 'error')
      } else {
        logger.info(`Success to delete file ${fileId}`)
        GlobalValueManager.sendNotice('Success to delete file', 'success')
        this.getFileListProcess(GlobalValueManager.curFolderId)
      }
    })
  }

  /**
   * Ask to add a folder.
   * @param {*} parentFolderId
   * @param {*} folderName
   */
  addFolderProcess(parentFolderId, folderName) {
    logger.info(`Asking to add folder ${folderName}...`)
    socket.emit('add-folder', { parentFolderId, folderName }, (response) => {
      const { errorMsg } = response
      if (errorMsg) {
        logger.error(`Failed to add folder ${folderName}: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to add folder', 'error')
      } else {
        logger.info(`Success to add folder ${folderName}`)
        GlobalValueManager.sendNotice('Success to add folder', 'success')
        this.getFileListProcess(GlobalValueManager.curFolderId)
      }
    })
  }

  /**
   * Ask to delete a folder
   * @param {*} folderId
   */
  deleteFolderProcess(folderId) {
    logger.info(`Asking to delete folder ${folderId}...`)
    socket.emit('delete-folder', { folderId }, (response) => {
      const { errorMsg } = response
      if (errorMsg) {
        logger.error(`Failed to delete folder: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to delete folder', 'error')
      } else {
        logger.info(`Success to delete folder ${folderId}`)
        GlobalValueManager.sendNotice('Success to delete folder', 'success')
        this.getFileListProcess(GlobalValueManager.curFolderId)
      }
    })
  }

  /**
   * Ask to get all folders. Used for selecting destination for moving files.
   * @returns
   */
  getAllFoldersProcess() {
    logger.info('Asking for all folders...')
    return new Promise((resolve) => {
      socket.emit('get-all-folders', (response) => {
        const { folders, errorMsg } = response
        if (errorMsg) {
          logger.error(`Failed to get all folders: ${errorMsg}`)
          GlobalValueManager.sendNotice('Failed to get all folders', 'error')
          resolve(null)
        } else {
          resolve(folders)
        }
      })
    })
  }

  /**
   * Ask to move file to a certain folder.
   * @param {*} fileId
   * @param {*} targetFolderId
   */
  moveFileProcess(fileId, targetFolderId) {
    logger.info(`Asking to move file ${fileId} to ${targetFolderId}...`)
    socket.emit('move-file', { fileId, targetFolderId }, (response) => {
      const { errorMsg } = response
      if (errorMsg) {
        logger.error(`Failed to move file ${fileId} to ${targetFolderId}: ${errorMsg}`)
        GlobalValueManager.sendNotice('Failed to move file', 'error')
      } else {
        logger.info(`Moved file ${fileId} to ${targetFolderId}`)
        GlobalValueManager.sendNotice('Success to move file', 'success')
        this.getFileListProcess(GlobalValueManager.curFolderId)
      }
    })
  }

  /**
   * Ask to get all public files. Should not be called.
   * @returns
   */
  getAllPublicFilesProcess() {
    logger.info('Asking for all public files...')
    return new Promise((resolve) => {
      socket.emit('get-public-files', (response) => {
        const { files, errorMsg } = response
        if (errorMsg) {
          logger.error(`Failed to get all public files: ${errorMsg}`)
          GlobalValueManager.sendNotice('Failed to get all public files', 'error')
          resolve(null)
        } else {
          resolve(files)
        }
      })
    })
  }

  /**
   * Ask to search files with the provided tags.
   * @param {*} param0
   * @returns
   */
  // async searchFilesProcess({ tags }) {
  //   logger.info(`Searching with tags ${tags}`)
  //   try {
  //     tags = tags.filter((tag) => tag != '').slice(0, 5)
  //     // Calculate the trapdoor
  //     let TK = this.TK
  //     if (!TK) TK = await this.abseManager.Trapdoor(tags)
  //     // const TK = await this.abseManager.Trapdoor(tags)


  //     return new Promise((resolve, reject) => {
  //       console.log('tags=', tags.join(','))
  //       console.log('TStar head=', TK.TStar?.slice(0, 12))
  //       console.log('sky head=', TK.sky?.slice(0, 12))
  //       const nonZeroIdx = TK.T?.map((x,i)=> x !== '0'.repeat(x.length) ? i : -1).filter(i=>i>=0)
  //       console.log('nonZeroIdx=', nonZeroIdx)
  //       socket.emit('search-files', { TK, tags }, (response) => {
  //         logger.debug(`Server respond search`, response)
  //         const { errorMsg, files } = response
  //         if (errorMsg) {
  //           logger.error(`Failed to search files: ${errorMsg}`)
  //           GlobalValueManager.sendNotice(`Failed to search file: ${errorMsg}`, 'error')
  //           reject(errorMsg)
  //         } else {
  //           resolve(files)
  //         }
  //       })
  //     })
  //   } catch (error) {
  //     logger.error(error)
  //     GlobalValueManager.sendNotice(
  //       'Failed to search file because of trapdoor calculation',
  //       'error'
  //     )
  //   }
  // }

//   async searchFilesProcess({ tags }) {
//   logger.info(`Searching with tags ${tags}`)
//   try {
//     tags = tags.filter((tag) => tag != '').slice(0, 5)

//     // ✅ 每個 tag 各自做 trapdoor => OR 搜尋
//     const TKs = []
//     for (const tag of tags) {
//       const tk = await this.abseManager.Trapdoor([tag]) // 注意：這裡只放單一 tag
//       TKs.push(tk)
//     }

//     return new Promise((resolve, reject) => {
//       logger.info('Search payload', { tags, TKsCount: TKs.length })
//       socket.emit('search-files', { TKs, tags }, (response) => {
//         const { errorMsg, files } = response
//         if (errorMsg) {
//           logger.error(`Failed to search files: ${errorMsg}`)
//           GlobalValueManager.sendNotice(`Failed to search file: ${errorMsg}`, 'error')
//           reject(errorMsg)
//         } else {
//           resolve(files)
//         }
//       })
//     })
//   } catch (error) {
//     logger.error(error)
//     GlobalValueManager.sendNotice('Failed to search file because of trapdoor calculation', 'error')
//   }
// }
async searchFilesProcess({ tags }) {
  logger.info(`Searching with tags ${tags}`)
  try {
    tags = tags
      .filter((t) => t != null && t !== '')
      .map((t) => t.trim().normalize('NFC'))
      .filter((t) => t.length > 0)
      .slice(0, 5)

    const TK = await this.abseManager.Trapdoor(tags)

    return new Promise((resolve, reject) => {
      logger.info('Search payload', { tags })
      socket.emit('search-files', { TK, tags }, (response) => {
        const { errorMsg, files } = response
        if (errorMsg) {
          logger.error(`Failed to search files: ${errorMsg}`)
          GlobalValueManager.sendNotice(`Failed to search file: ${errorMsg}`, 'error')
          reject(errorMsg)
        } else {
          resolve(files)
        }
      })
    })
  } catch (error) {
    logger.error(error)
    GlobalValueManager.sendNotice('Failed to search file because of trapdoor calculation', 'error')
  }
}

  /**
   * Batch update permission/description/tags/attrs for multiple files at once.
   * Computes CTw once and applies it to all fileIds in parallel.
   * @returns {{ succeeded: string[], failed: string[] }}
   */
  async batchUpdateFileDescPermProcess({ fileIds, desc, perm, selectedAttrs, tags }) {
    const succeeded = []
    const failed = []
    try {
      tags = tags.filter((t) => t !== '').slice(0, 5)
      const pp = await this.abseManager.getPP()
      const globalAttrs = pp ? pp.U : []
      selectedAttrs = selectedAttrs.filter((attr) => globalAttrs.includes(attr))
      const attrIds = selectedAttrs.map((attr) => globalAttrs.indexOf(attr))

      logger.debug(
        `[batchUpdate] Starting batch update: fileIds=${JSON.stringify(fileIds)}, perm=${perm}, tags=${JSON.stringify(tags)}, selectedAttrs=${JSON.stringify(selectedAttrs)}, attrIds=${JSON.stringify(attrIds)}, desc.length=${desc?.length}`
      )

      // Compute CTw once for all files (same tags/attrs for the whole batch)
      let CTw = null
      if (perm == 1 && tags.length > 0) {
        CTw = await this.abseManager.Enc(tags, selectedAttrs)
        logger.debug(`[batchUpdate] CTw computed for tags=${JSON.stringify(tags)}`)
      } else {
        logger.debug(
          `[batchUpdate] CTw skipped: perm=${perm}, tags.length=${tags.length}`
        )
      }

      await Promise.all(
        fileIds.map(async (fileId) => {
          try {
            await new Promise((resolve, reject) => {
              logger.debug(
                `[batchUpdate] Emitting update-file-desc-perm for fileId=${fileId}, permission=${perm}, tags=${JSON.stringify(tags)}, hasCTw=${!!CTw}`
              )
              socket.emit(
                'update-file-desc-perm',
                { fileId, description: desc, permission: perm, CTw, tags, attrIds },
                (response) => {
                  if (response.errorMsg) {
                    logger.error(
                      `[batchUpdate] Server returned error for fileId=${fileId}: ${response.errorMsg}`
                    )
                    reject(new Error(response.errorMsg))
                  } else {
                    logger.debug(
                      `[batchUpdate] Server OK for fileId=${fileId}. tags/attrIds stored in PostgreSQL.`
                    )
                    resolve()
                  }
                }
              )
            })
            succeeded.push(fileId)
          } catch (e) {
            logger.error(`[batchUpdate] Failed to update fileId=${fileId}: ${e.message}`)
            failed.push(fileId)
          }
        })
      )

      logger.debug(
        `[batchUpdate] Done. succeeded=${JSON.stringify(succeeded)}, failed=${JSON.stringify(failed)}`
      )
      // Refresh file list once after all local DB writes are complete
      this.getFileListProcess(GlobalValueManager.curFolderId)
    } catch (error) {
      logger.error(`[batchUpdate] Outer error: ${error}`)
    }
    return { succeeded, failed }
  }

  /**
   * Ask to update file description, permission, attribute and tags.
   * @param {*} param0
   */
  async updateFileDescPermProcess({ fileId, desc, perm, selectedAttrs, tags }) {
    const actionStr = `update file ${fileId} description, permission and index`
    try {
      // Filter tags to remove empty and keep first five
      tags = tags.filter((tag) => tag != '').slice(0, 5)
      // Filter selectedAttrs to only keep those in pp.U
      const globalAttrs = (await this.abseManager.getPP()).U
      selectedAttrs = selectedAttrs.filter((attr) => globalAttrs.includes(attr))
      // Calculate TK if perm is public(1) and tags is not empty
      let CTw = null
      if (perm == 1 && tags.length > 0) {
        CTw = await this.abseManager.Enc(tags, selectedAttrs)
        // Testing if can be searched correctly
        // const TK = await this.abseManager.Trapdoor(tags)
        // this.TK = TK
        // const matchedFiles = await this.abseManager.Search(TK, [{ ...CTw, fileid: fileId }])
        // logger.debug(`matched files when update index: ${matchedFiles}`)
        logger.debug(`Selected tags: ${tags}, selected attrs: ${selectedAttrs}`)
      }
      const attrIds = selectedAttrs.map((attr) => globalAttrs.indexOf(attr))
      logger.info(`Asking to ${actionStr}...`)
      socket.emit(
        'update-file-desc-perm',
        { fileId, description: desc, permission: perm, CTw, tags, attrIds },
        (response) => {
          const { errorMsg } = response
          if (errorMsg) {
            logger.error(`Failed to ${actionStr}: ${errorMsg}`)
            GlobalValueManager.sendNotice(`Failed to ${actionStr}`, 'error')
          } else {
            // tags and attrIds are now stored in PostgreSQL by the server
            logger.info(`Success to ${actionStr}`)
            GlobalValueManager.sendNotice(`Success to ${actionStr}`, 'success')
            this.getFileListProcess(GlobalValueManager.curFolderId)
          }
        }
      )
    } catch (error) {
      logger.error(error)
      GlobalValueManager.sendNotice(`Failed to ${actionStr}`, 'error')
    }
  }
}

export default FileManager
