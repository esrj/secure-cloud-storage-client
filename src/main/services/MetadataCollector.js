/**
 * Assembles agent-searchable metadata by merging file records (from server)
 * with locally stored tags / attributes (from SQLite via DatabaseManager).
 *
 * All fields are non-sensitive: no cipher, no spk, no raw content.
 */

import { extname } from 'node:path'

/**
 * @typedef {object} SearchableFile
 * @property {string}   fileId
 * @property {string}   name
 * @property {string}   ext              - Lowercase extension, e.g. "pdf"
 * @property {string}   file_type        - Same as ext (alias)
 * @property {number}   size             - Size in bytes
 * @property {string}   sizeLabel        - Human-readable size
 * @property {string}   date             - Upload date "YYYY-MM-DD"
 * @property {string}   upload_time      - Same as date (alias)
 * @property {number}   perm             - 0=private 1=public 2=non-public
 * @property {string}   permLabel        - "私人" | "公開" | "不公開"
 * @property {boolean}  is_public        - perm === 1
 * @property {string}   security_level   - Derived from perm: "私人"/"公開"/"不公開"
 * @property {string}   desc             - File description
 * @property {string[]} tags             - Classification tags
 * @property {string}   uploader_name    - Display name of the file owner
 * @property {string}   uploader_id      - User ID of the file owner
 */

const PERM_LABEL = { 0: '私人', 1: '公開', 2: '不公開' }

function bytesToSize(bytes) {
  const n = parseInt(bytes, 10)
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1000)), units.length - 1)
  return `${(n / Math.pow(1000, i)).toFixed(2)} ${units[i]}`
}

/**
 * @param {object} rawFile
 * @param {import('../DatabaseManager').default|null} databaseManager
 * @param {string} uploaderName  - Current user's display name (passed from renderer)
 * @returns {SearchableFile}
 */
function enrichFile(rawFile, databaseManager, uploaderName) {
  const fileId = rawFile.fileId ?? rawFile.id ?? ''
  const name = rawFile.name ?? ''
  const ext = extname(name).replace('.', '').toLowerCase()
  const size = parseInt(rawFile.size ?? 0, 10)
  const date =
    rawFile.date ?? (rawFile.timestamp ? String(rawFile.timestamp).split('T')[0] : '')
  const perm = rawFile.perm ?? rawFile.permissions ?? 0
  const desc = rawFile.desc ?? rawFile.description ?? ''
  const ownerId = rawFile.owner ?? rawFile.ownerId ?? ''

  // Tags: prefer server-provided tags; fall back to DatabaseManager (now a no-op)
  let tags = []
  if (Array.isArray(rawFile.tags) && rawFile.tags.length > 0) {
    tags = rawFile.tags.filter((t) => typeof t === 'string' && t.trim())
  } else {
    try {
      const rows = databaseManager?.getTagsOfFile(fileId) ?? []
      tags = rows.map((r) => r.tag)
    } catch {
      // ignore
    }
  }

  const permLabel = PERM_LABEL[perm] ?? String(perm)

  return {
    fileId,
    name,
    ext,
    file_type: ext || '未知',
    size,
    sizeLabel: bytesToSize(size),
    date,
    upload_time: date,
    perm,
    permLabel,
    is_public: perm === 1,
    security_level: permLabel,
    desc,
    tags,
    uploader_name: uploaderName || '未知',
    uploader_id: ownerId
  }
}

/**
 * Enrich a batch of raw file records.
 *
 * @param {object[]} rawFiles
 * @param {import('../DatabaseManager').default|null} databaseManager
 * @param {string} [uploaderName]
 * @returns {SearchableFile[]}
 */
export function buildSearchableMetadata(rawFiles, databaseManager, uploaderName = '') {
  if (!Array.isArray(rawFiles)) return []
  return rawFiles.map((f) => enrichFile(f, databaseManager, uploaderName))
}
