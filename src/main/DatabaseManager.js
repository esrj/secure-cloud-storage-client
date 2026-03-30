/**
 * Local SQLite database for client-side backup.
 *
 * NOTE: tag_table and attr_table have been REMOVED.
 * Tags and attribute IDs are now stored in the server-side PostgreSQL
 * (file_tags / file_attrs tables) and returned as part of the file-list response.
 *
 * This class is kept solely for the encrypted DB backup / recovery feature
 * (encryptToServer / recoverFromServer). The SQLite file itself is essentially
 * empty now and can be thought of as a placeholder.
 */
import Database from 'better-sqlite3'
import GlobalValueManager from './GlobalValueManager'
import { basename } from 'node:path'
import KeyManager from './KeyManager'
import { deriveAESKeyIvFromBuffer } from './Utils'
import { createReadStream, createWriteStream } from 'node:fs'
import { net } from 'electron'
import { socket } from './MessageManager'
import { logger } from './Logger'
import crypto from 'node:crypto'
import FormData from 'form-data'

class DatabaseManager {
  keyManager
  /**
   *
   * @param {KeyManager} keyManager
   */
  constructor(keyManager) {
    this.keyManager = keyManager
    this.init()
  }

  /**
   * Initialize database.
   * Old tag_table / attr_table rows are cleaned up on first run so the
   * SQLite file stays lean after the migration to PostgreSQL.
   */
  init() {
    this.db = Database(GlobalValueManager.dbPath)

    // Remove legacy tables if they still exist (one-time migration cleanup)
    try {
      this.db.prepare('DROP TABLE IF EXISTS tag_table').run()
      this.db.prepare('DROP TABLE IF EXISTS attr_table').run()
    } catch (e) {
      logger.warn(`[DatabaseManager] Could not drop legacy tables: ${e.message}`)
    }
  }

  // ── Stub methods kept for call-site compatibility ────────────────────────
  // Any code that still calls these will silently no-op rather than throw.

  /** @deprecated tags are now stored in PostgreSQL */
  getTagsOfFile(_fileId) {
    return []
  }

  /** @deprecated attrIds are now stored in PostgreSQL */
  getAttrIdsOfFile(_fileId) {
    return []
  }

  /** @deprecated tags are now stored in PostgreSQL */
  storeTagAttr(_fileId, _tags, _attrIds) {
    logger.debug('[DatabaseManager] storeTagAttr is a no-op: data lives in PostgreSQL now.')
  }

  // ── Backup / Recovery (unchanged) ────────────────────────────────────────

  /**
   * Encrypt the database and store on server.
   */
  async encryptToServer() {
    try {
      this.db.close()
      const sk = this.keyManager.getKeys().sk
      const { key, iv } = await deriveAESKeyIvFromBuffer(sk)
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
      const fileStream = createReadStream(GlobalValueManager.dbPath)
      fileStream.pipe(cipher)
      logger.info('Upload encrypted database to server.')
      const form = new FormData()
      form.append('file', cipher, basename(GlobalValueManager.dbPath))
      const request = net.request({
        method: 'POST',
        url: `${GlobalValueManager.httpsUrl}/uploadDb`,
        headers: {
          ...form.getHeaders(),
          socketid: socket.id
        }
      })
      request.chunkedEncoding = true
      form.pipe(request)

      return new Promise((resolve, reject) => {
        request.on('response', (response) => {
          logger.info(`STATUS: ${response.statusCode}`)
          response.on('data', (chunk) => {
            logger.debug(`BODY: ${chunk}`)
          })
          response.on('end', () => {
            if (response.statusCode === 200) {
              logger.info('Succesfully upload encrypted database to server.')
            } else {
              logger.error(
                `Https received status code ${response.statusCode} and status message ${response.statusMessage}.`
              )
            }
          })
          resolve()
        })

        request.on('error', (error) => {
          logger.error(error)
          resolve()
        })
        form.on('error', (error) => {
          logger.error(error)
          resolve()
        })
      })
    } catch (error) {
      logger.error(error)
    }
  }

  /**
   * Retrieve encrypted database and recover from server
   */
  async recoverFromServer() {
    try {
      this.db.close()
      const sk = this.keyManager.getKeys().sk
      const { key, iv } = await deriveAESKeyIvFromBuffer(sk)
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
      const fileStream = createWriteStream(GlobalValueManager.dbPath)
      decipher.pipe(fileStream)
      const request = net.request({
        method: 'GET',
        url: `${GlobalValueManager.httpsUrl}/downloadDb`,
        headers: { socketid: socket.id }
      })
      request.end()

      request.on('response', (response) => {
        logger.info(`STATUS: ${response.statusCode}`)
        response.on('data', (chunk) => {
          if (response.statusCode === 200) {
            decipher.write(chunk)
          } else {
            logger.info(`BODY: ${chunk}`)
          }
        })
        response.on('end', () => {
          logger.info('No more data in response.')
          decipher.end()
          if (response.statusCode !== 200) {
            logger.error(
              `Https received status code ${response.statusCode} and status message ${response.statusMessage}.`
            )
          }
        })
      })

      request.on('error', (error) => {
        logger.error(`ERROR: ${error.message}`)
        decipher.end()
      })

      return new Promise((resolve, reject) => {
        fileStream.on('finish', () => {
          logger.info('Database successfully recovered')
          resolve()
        })
        fileStream.on('error', (err) => {
          reject(err)
        })
        decipher.on('error', (err) => {
          reject(err)
        })
      })
    } catch (error) {
      logger.error(error)
    }
  }
}

export default DatabaseManager
