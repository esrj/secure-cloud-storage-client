/**
 * This file handles a local database which stores file tag and attribute settings.
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
   * Initialize database scheme and statements
   */
  init() {
    this.db = Database(GlobalValueManager.dbPath)
    // Tags
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS tag_table (
        fileid TEXT not null,
        tag TEXT not null,
        PRIMARY KEY (fileid, tag)
        );`
      )
      .run()
    this.insertTag = this.db.prepare(`INSERT INTO tag_table (fileid, tag) VALUES (?, ?);`)
    this.getTags = this.db.prepare(`SELECT tag FROM tag_table WHERE fileid = ?;`)
    this.deleteTags = this.db.prepare(`DELETE FROM tag_table WHERE fileid = ?;`)
    // Attributes
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS attr_table (
        fileid TEXT not null,
        attrid INTEGER not null,
        PRIMARY KEY (fileid, attrid)
        );`
      )
      .run()
    this.insertAttrId = this.db.prepare(`INSERT INTO attr_table (fileid, attrid) VALUES (?, ?);`)
    this.getAttrIds = this.db.prepare(`SELECT attrid FROM attr_table WHERE fileid = ?;`)
    this.deleteAttrId = this.db.prepare(`DELETE FROM attr_table WHERE fileid = ?;`)
  }

  /**
   * Get tags of file
   * @param {string} fileId
   * @returns {Array<string>} tags
   */
  getTagsOfFile(fileId) {
    return this.getTags.all(fileId)
  }

  /**
   * Get attribute Ids of file
   * @param {string} fileId
   * @returns {Array<string>} attribute Ids
   */
  getAttrIdsOfFile(fileId) {
    return this.getAttrIds.all(fileId)
  }

  /**
   * Store tags and attribute Ids into database
   * @param {string} fileId
   * @param {Array<string>} tags
   * @param {Array<number>} attrIds
   */
  storeTagAttr(fileId, tags, attrIds) {
    this.deleteTags.run(fileId)
    this.deleteAttrId.run(fileId)
    for (const tag of tags) {
      this.insertTag.run(fileId, tag)
    }
    for (const attrId of attrIds) {
      this.insertAttrId.run(fileId, attrId)
    }
  }

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
      // Upload with HTTPS. Maybe combine with HttpsFileProcess?
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
   * @returns
   */
  async recoverFromServer() {
    try {
      this.db.close()
      // Create file streams
      const sk = this.keyManager.getKeys().sk
      const { key, iv } = await deriveAESKeyIvFromBuffer(sk)
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
      const fileStream = createWriteStream(GlobalValueManager.dbPath)
      decipher.pipe(fileStream)
      // Download from server
      const request = net.request({
        method: 'GET',
        url: `${GlobalValueManager.httpsUrl}/downloadDb`,
        headers: { socketid: socket.id }
      })
      request.end()

      request.on('response', (response) => {
        logger.info(`STATUS: ${response.statusCode}`)
        // logger.info(`HEADERS: ${JSON.stringify(response.headers)}`)

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
