/**
 * This file handles operations and communication with server related to files.
 * Including upload, download, delete, search.
 */
import { dialog } from 'electron'
import { socket } from './MessageManager'
import { createReadStream, createWriteStream, unlinkSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
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

class FileManager {
  aesModule
  blockchainManager
  uploadQueue
  /**
   * @param {AESModule} aesModule
   * @param {BlockchainManager} blockchainManager
   * @param {ABSEManager} abseManager
   * @param {DatabaseManager} databaseManager
   * @param {number} queueConcurrency
   */
  constructor(aesModule, blockchainManager, abseManager, databaseManager, queueConcurrency = 1) {
    this.aesModule = aesModule
    this.blockchainManager = blockchainManager
    this.abseManager = abseManager
    this.databaseManager = databaseManager
    this.uploadQueue = cq()
      .limit({ concurrency: queueConcurrency })
      .process(this.#uploadProcess.bind(this))

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
        this.getFileListProcess(GlobalValueManager.curFolderId)
      }
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

  // can return promise, but not needed
  /**
   * The process of actually uploading the file.
   * @param {{ filePath: string, parentFolderId: string }} info
   * @returns
   */
  async #uploadProcess({ filePath, parentFolderId }) {
    let cipher = null
    let spk = null
    let encryptedStream = null
    let fileStream = null
    const originalFileName = basename(filePath)
    // Read the file from disk and create an encrypt stream of the file.
    try {
      fileStream = createReadStream(filePath)
      // throw new Error('Test filestream creation error.') // Test for file stream creation error
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
    // Pre-upload the file by sending the encrypted AES key, and get the generated fileId
    logger.info('Sending key and iv to server...')
    socket.emit('upload-file-pre', { cipher, spk, parentFolderId }, async (response) => {
      const { errorMsg, fileId } = response
      if (errorMsg) {
        logger.error(`Failed to upload file: ${errorMsg}. Upload aborted.`)
        this.#sendUploadErrorNotice(errorMsg)
        return
      }

      // Store the encrypted file to disk with name <fileId>
      const tempEncryptedFilePath = resolve(GlobalValueManager.tempPath, fileId)
      const writeStream = createWriteStream(tempEncryptedFilePath)
      // Coordinator to make sure upload to blockchain only after hash is created and file is uploaded to server.
      const fileUploadCoordinator = new FileUploadCoordinator(
        this.blockchainManager,
        JSON.stringify({ filename: originalFileName })
      )
      this.aesModule
        .makeHashPromise(encryptedStream)
        .then((digest) => {
          fileUploadCoordinator.finishHash(digest)
        })
        .catch((error) => {
          logger.error(error)
          this.#sendUploadErrorNotice('File hash calculation failed.')
        })
      // When the encrypted filestream successfully got written on disk, read it and actually uplaod to server.
      writeStream.on('close', async () => {
        logger.info(`Encrypted file finished writing.`, { tempEncryptedFilePath })
        const protocol = GlobalValueManager.serverConfig.protocol
        logger.info(`Uploading file ${basename(filePath)} with protocol ${protocol}`)

        // Actually uploading file by the selected protocol
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
              logger.error('Invalid file protocol')
              this.#sendUploadErrorNotice('Invalid file protocol.')
              return
          }
        } catch (error) {
          logger.error(error)
          this.#sendUploadErrorNotice(`Upload with ${protocol} failed.`, CheckLogForDetailMsg)
          return
        }
        // Upload file info to blockchain
        try {
          await fileUploadCoordinator.uploadToBlockchainWhenReady()
          GlobalValueManager.sendNotice(
            'File and info uploaded to server and blockchain.',
            'normal'
          )
        } catch (error) {
          logger.error(error)
          this.#sendUploadErrorNotice('Blockchain upload failed.', ContactManagerOrTryAgainMsg)
        }

        // this.getFileListProcess(GlobalValueManager.curFolderId)
      })
      writeStream.on('error', (error) => {
        logger.error(error)
        this.#sendUploadErrorNotice(
          'Encrypted file failed to write.',
          CheckDiskSizePermissionTryAgainMsg
        )
      })

      // Start write process
      encryptedStream.pipe(writeStream)

      // Test write encryption file error
      // writeStream.emit('error')
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
          // Get tag and attribute from local storage and add into fileList
          const filesObj = JSON.parse(files)
          filesObj.forEach((file) => {
            file.tags = this.databaseManager.getTagsOfFile(file.id).map((row) => row.tag)
            file.attrs = this.databaseManager
              .getAttrIdsOfFile(file.id)
              .map((row) => globalAttrs.at(row.attrid))
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

  async searchFilesProcess({ tags }) {
  logger.info(`Searching with tags ${tags}`)
  try {
    tags = tags.filter((tag) => tag != '').slice(0, 5)

    // ✅ 每個 tag 各自做 trapdoor => OR 搜尋
    const TKs = []
    for (const tag of tags) {
      const tk = await this.abseManager.Trapdoor([tag]) // 注意：這裡只放單一 tag
      TKs.push(tk)
    }

    return new Promise((resolve, reject) => {
      logger.info('Search payload', { tags, TKsCount: TKs.length })
      socket.emit('search-files', { TKs, tags }, (response) => {
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
      logger.info(`Asking to ${actionStr}...`)
      socket.emit(
        'update-file-desc-perm',
        { fileId, description: desc, permission: perm, CTw },
        (response) => {
          const { errorMsg } = response
          if (errorMsg) {
            logger.error(`Failed to ${actionStr}: ${errorMsg}`)
            GlobalValueManager.sendNotice(`Failed to ${actionStr}`, 'error')
          } else {
            // Store tags and selected attrs id in local database
            // Turn attrs into IDs
            const attrIds = selectedAttrs.map((attr) => globalAttrs.indexOf(attr))
            logger.debug(`store attrids`, { attrIds })
            this.databaseManager.storeTagAttr(fileId, tags, attrIds)
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
