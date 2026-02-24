/**
 * This file handles operation and communication with server related to authentication.
 * Including login, register, secret share and secret recover.
 */
import { logger } from './Logger'
import { socket } from './MessageManager'
import GlobalValueManager from './GlobalValueManager'
import KeyManager from './KeyManager'
import RequestManager from './RequestManager'
import FileManager from './FileManager'
import BlockchainManager from './BlockchainManager'
import { encryptDataShareKey, recoverDataShareKey } from './SecretSharing'
import { UnexpectedErrorMsg } from './Utils'
import DatabaseManager from './DatabaseManager'
import { unlinkSync } from 'fs'

class LoginManager {
  blockchainManager
  fileManager
  keyManager
  requestManager
  /**
   * @param {BlockchainManager} blockchainManager
   * @param {FileManager} fileManager
   * @param {KeyManager} keyManager
   * @param {RequestManager} requestManager
   * @param {DatabaseManager} databaseManager
   */
  constructor(blockchainManager, fileManager, keyManager, requestManager, databaseManager) {
    this.blockchainManager = blockchainManager
    this.fileManager = fileManager
    this.keyManager = keyManager
    this.requestManager = requestManager
    this.databaseManager = databaseManager
    GlobalValueManager.loginManager = this
  }

  /**
   * Respond to server's authentication request.
   * @param {*} cipher
   * @param {*} spk
   * @returns the user info
   */
  async respondToAuth(cipher, spk) {
    logger.info('Getting login response from server. Decrypting auth key...')
    // console.log(cipher)
    return new Promise((resolve, reject) => {
      this.keyManager
        .decrypt(cipher, spk)
        .then((decryptedValue) => {
          // const decryptedValue = await this.keyManager.decrypt(cipher, spk)
          logger.debug(`decryptedValue: ${decryptedValue}`)
          logger.info('Finish decrypting. Sending response back to server')
          socket.emit('auth-res', { decryptedValue }, ({ errorMsg, userInfo }) => {
            if (errorMsg) {
              logger.error(`Authentication response failed because of following error: ${errorMsg}`)
              // GlobalValueManager.sendNotice('Failed to authenticate', 'error')
              GlobalValueManager.userInfo = {}
              GlobalValueManager.loggedIn = false
              reject(new Error(errorMsg))
              return
            }
            if (userInfo) {
              // Previous action is login, not register.
              logger.info('Login succeeded')
              GlobalValueManager.userInfo = userInfo
              GlobalValueManager.loggedIn = true
              // this.fileManager.getFileListProcess(null)
              // this.requestManager.getRequestListProcess()
              // this.requestManager.getRequestedListProcess()
              // send userId and other stored name, email to renderer
              // GlobalValueManager.mainWindow?.webContents.send('user-info', userInfo)
            }
            resolve(userInfo)
          })
        })
        .catch((error) => {
          logger.error(error)
          reject(new Error(UnexpectedErrorMsg))
        })
    })
  }
  /**
   * Asks to login to server.
   * @returns the user info
   */
  async login() {
    return new Promise((resolve, reject) => {
      // only login after window is ready to show
      try {
        // await initKeys()
        const publicKey = this.keyManager.getPublicKeyString()
        logger.info('Asking to login...')
        socket.emit('login', { publicKey }, async ({ errorMsg, cipher, spk }) => {
          if (errorMsg) {
            logger.error(`login failed because of following error: ${errorMsg}`)
            // GlobalValueManager.sendNotice('Failed to login', 'error')
            reject(new Error(errorMsg))
            return
          }
          try {
            const result = await this.respondToAuth(cipher, spk)
            resolve(result)
          } catch (error2) {
            // Logged in respondToAuth
            reject(error2)
          }
        })
      } catch (error) {
        logger.error(`login failed because of following error: ${error}`)
        // GlobalValueManager.sendNotice('Failed to login', 'error')
        reject(new Error(UnexpectedErrorMsg))
      }
    })
  }

  /**
   * Asks to register to server.
   * @param {*} param0
   * @returns
   */
  async register({ name, email }) {
    // only register after window is ready to show
    return new Promise((resolve, reject) => {
      try {
        // await initKeys()
        const publicKey = this.keyManager.getPublicKeyString()
        logger.info('Asking to register...')
        socket.emit(
          'register',
          { publicKey, blockchainAddress: this.blockchainManager.wallet.address, name, email },
          async (response) => {
            if (response.errorMsg) {
              logger.error(`Register failed because of following error: ${response.errorMsg}`)
              reject(new Error(response.errorMsg))
              // GlobalValueManager.sendNotice('Failed to register', 'error')
              return
            }
            try {
              const result = await this.respondToAuth(response.cipher, response.spk)
              resolve(result) // Will notice renderer to input email auth code.
            } catch (error2) {
              // Logged in respondToAuth
              reject(error2)
            }
          }
        )
      } catch (error) {
        logger.error(`Register failed because of following error: ${error}`)
        // GlobalValueManager.sendNotice('Failed to register', 'error')
        reject(new Error(UnexpectedErrorMsg))
      }
    })
  }

  /**
   * Asks to share secret keys (user private keys, wallet keys) which is encrypted by the extra key.
   * @param {*} param0
   * @returns
   */
  async shareSecret({ extraKey }) {
    try {
      const secretKeys = {
        walletKey: this.blockchainManager.wallet.privateKey,
        preKeys: this.keyManager.getKeyStrings()
      }
      logger.info('Generating secret shares...')
      const shares = await encryptDataShareKey(extraKey, JSON.stringify(secretKeys))
      const sharesStr = []
      for (const share of shares) {
        sharesStr.push(share.toString('base64'))
      }
      return new Promise((resolve, reject) => {
        logger.info('Asking to share secret keys.')
        socket.emit('secret-share', { shares: sharesStr }, (response) => {
          if (response.errorMsg) {
            logger.error(`Secret share failed because of following error: ${response.errorMsg}`)
            reject(new Error(response.errorMsg))
            // GlobalValueManager.sendNotice('Failed to share secret', 'error')
            return
          }
          resolve() // OK
          // GlobalValueManager.sendNotice('Share secret succeeded', 'success')
        })
      })
    } catch (error) {
      logger.error(error)
      // GlobalValueManager.sendNotice('Failed to share secret', 'error')
      throw new Error(UnexpectedErrorMsg)
    }
  }

  /**
   * Ask to recover user's secret with the registered email
   * @param {*} param0
   * @returns
   */
  async recoverSecret({ email }) {
    return new Promise((resolve, reject) => {
      try {
        logger.info('Asking to recover secret.')
        socket.emit('secret-recover', { email }, (response) => {
          if (response.errorMsg) {
            logger.error(`Secret recover failed because of following error: ${response.errorMsg}`)
            // GlobalValueManager.sendNotice('Failed to recover secret', 'error')
            reject(new Error(response.errorMsg))
            return
          }
          // Ask user to input email authentication code
          // GlobalValueManager.mainWindow?.send('ask-email-auth', { purpose: 'recover' })
          resolve()
        })
      } catch (error) {
        logger.error(error)
        // GlobalValueManager.sendNotice('Failed to recover secret', 'error')
        reject(new Error(UnexpectedErrorMsg))
      }
    })
  }

  /**
   * Called when user input email auth code.
   * @param {*} param0
   * @returns
   */
  async onEmailAuth({ emailAuth, purpose }) {
    return new Promise((resolve, reject) => {
      try {
        // const ActionStr = (purpose == 'recover') ? 'Secret recover' :
        logger.info('Asking to respond to email auth')
        socket.emit('email-auth-res', { emailAuth }, async (response) => {
          if (response.errorMsg) {
            logger.error(
              `Email authentication failed because of following error: ${response.errorMsg}`
            )
            // GlobalValueManager.sendNotice('Email authentication failed', 'error')
            reject(new Error(response.errorMsg))
            return
          }
          if (response.shares) {
            // Previously asked to recover secret
            const deserializedShares = []
            for (const share of response.shares) {
              deserializedShares.push(Buffer.from(share, 'base64'))
            }
            this.shares = deserializedShares
            // Ask user to input extra key
            // GlobalValueManager.mainWindow?.send('ask-extra-key')
            resolve({ purpose: 'recover' })
          } else if (response.userId) {
            // Previous asked to register.
            await this.login()
            this.fileManager.getFileListProcess(null)
            resolve({ userId: response.userId })
          }
        })
      } catch (error) {
        logger.error(error)
        reject(new Error(UnexpectedErrorMsg))
        // GlobalValueManager.sendNotice('Email authentication failed', 'error')
      }
    })
  }

  /**
   * Called when user entered extra key for secret recover.
   * Will decrypt the retrieved secret shares and restore secret keys.
   * @param {*} param0
   * @returns
   */
  async onRecoverExtraKey({ extraKey }) {
    try {
      const decryptedStr = await recoverDataShareKey(extraKey, this.shares)
      if (!decryptedStr) {
        logger.info('Secret key recover failed.')
        // GlobalValueManager.sendNotice(
        //   'Secret keys could not be recovered because not enough shares were retrieved. Please contact the server manager.',
        //   'error'
        // )
        throw new Error(
          'Secret keys could not be recovered because not enough shares were retrieved or extra key is wrong.'
        )
      }
      const secretKeys = JSON.parse(decryptedStr)
      this.blockchainManager.restoreWallet(secretKeys.walletKey)
      this.keyManager.restoreKeys(secretKeys.preKeys)
      logger.info('Secret key recovered')
      // GlobalValueManager.sendNotice('Secret keys successfully recovered.', 'success')
      await this.login()
      await this.databaseManager.recoverFromServer()
      this.fileManager.getFileListProcess(null)
    } catch (error) {
      logger.error(error)
      unlinkSync(GlobalValueManager.dbPath)
      // GlobalValueManager.sendNotice('Secret keys could not be recovered.', 'error')
      throw new Error(UnexpectedErrorMsg)
    } finally {
      this.databaseManager.init()
    }
  }
}

export default LoginManager
