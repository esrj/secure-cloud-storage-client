/**
 * Client-side invisible watermark detection.
 * Runs entirely in the renderer process — no file is uploaded to the server.
 *
 * Supported formats and methods:
 *  - PDF   : invisible text (TextRenderingMode 3) via pdfjs-dist
 *  - PNG   : LSB steganography, R-channel, 32-bit big-endian length header
 *  - JPEG  : same LSB decode after canvas decode
 *  - DOCX  : custom document property (docProps/custom.xml "WatermarkPayload")
 *            + visible text scan in word/document.xml
 *  - TXT   : visible "# Watermark:" marker line + ZWC (zero-width char) steganography
 *
 * @typedef {Object} WatermarkDetectResult
 * @property {string}  fileName
 * @property {string}  mimeType
 * @property {boolean} detected
 * @property {'pdf-invisible-text'|'lsb-r-channel'|'docx-custom-property'|'docx-body-text'|'txt-visible-marker'|'txt-zwc-steganography'|'unsupported'|'error'} method
 * @property {string}  [payload]
 * @property {string}  [reason]
 */

import * as pdfjsLib from 'pdfjs-dist'
import JSZip from 'jszip'

// Use the bundled worker via Vite's ?url import
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Entry point: detects invisible (and visible) watermark in the given File object.
 * @param {File} file
 * @returns {Promise<WatermarkDetectResult>}
 */
export async function detectWatermark(file) {
  const mime = file.type || _mimeFromName(file.name)
  const base = { fileName: file.name, mimeType: mime }

  try {
    if (mime === 'application/pdf') {
      return { ...base, ...(await detectPdfWatermark(file)) }
    }
    if (mime === 'image/png' || mime === 'image/jpeg') {
      return { ...base, ...(await detectImageLsbWatermark(file)) }
    }
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return { ...base, ...(await detectDocxWatermark(file)) }
    }
    if (mime === 'text/plain') {
      return { ...base, ...(await detectTxtWatermark(file)) }
    }
    if (mime === 'application/msword') {
      return {
        ...base,
        detected: false,
        method: 'unsupported',
        reason: '舊版 DOC 格式暫不支援浮水印偵測，請先將檔案另存為 DOCX 格式後再試。'
      }
    }
    return {
      ...base,
      detected: false,
      method: 'unsupported',
      reason: `格式 ${mime || '未知'} 不支援浮水印偵測（支援：PDF、PNG、JPEG、DOCX、TXT）`
    }
  } catch (err) {
    return {
      ...base,
      detected: false,
      method: 'error',
      reason: `偵測過程發生錯誤：${err.message}`
    }
  }
}

// ──────────────────────────────────────────────────────────────
// PDF detection
// ──────────────────────────────────────────────────────────────

export async function detectPdfWatermark(file) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

  const collectedPayloads = new Set()

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const textContent = await page.getTextContent()

    const pageText = textContent.items
      .filter((item) => item.str && item.str.trim().length > 0)
      .map((item) => item.str.trim())
      .join(' ')

    const matches = pageText.match(/uid:[a-f0-9]{8}[^|]*\|[^|]*fid:[a-f0-9]{8}[^\n]*/gi)
    if (matches) {
      matches.forEach((m) => collectedPayloads.add(m.trim()))
    }

    for (const item of textContent.items) {
      const s = (item.str || '').trim()
      if (s && (s.startsWith('uid:') || (s.includes('fid:') && s.includes('ts:')))) {
        collectedPayloads.add(s)
      }
    }
  }

  if (collectedPayloads.size > 0) {
    const payload = Array.from(collectedPayloads)[0]
    return {
      detected: true,
      method: 'pdf-invisible-text',
      payload,
      reason: `在 PDF 中偵測到不可視文字浮水印（共 ${collectedPayloads.size} 個實例）`
    }
  }

  return {
    detected: false,
    method: 'pdf-invisible-text',
    reason: '未偵測到不可視文字浮水印'
  }
}

// ──────────────────────────────────────────────────────────────
// Image LSB detection (PNG + JPEG)
// ──────────────────────────────────────────────────────────────

export async function detectImageLsbWatermark(file) {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height

  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const pixels = imageData.data
  const totalPixels = canvas.width * canvas.height

  let payloadLength = 0
  for (let i = 0; i < 32; i++) {
    payloadLength = (payloadLength << 1) | (pixels[i * 4] & 1)
  }

  if (payloadLength <= 0 || payloadLength > 50_000) {
    return {
      detected: false,
      method: 'lsb-r-channel',
      reason: `LSB header 長度不合理 (${payloadLength})，無浮水印或已損壞`
    }
  }
  const bitsNeeded = 32 + payloadLength * 8
  if (bitsNeeded > totalPixels) {
    return {
      detected: false,
      method: 'lsb-r-channel',
      reason: `圖片像素不足以容納宣稱的 payload 長度 ${payloadLength} bytes`
    }
  }

  const payloadBytes = new Uint8Array(payloadLength)
  for (let b = 0; b < payloadLength; b++) {
    let byte = 0
    for (let bit = 0; bit < 8; bit++) {
      const pixelIdx = 32 + b * 8 + bit
      byte = (byte << 1) | (pixels[pixelIdx * 4] & 1)
    }
    payloadBytes[b] = byte
  }

  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes)
  } catch {
    return {
      detected: false,
      method: 'lsb-r-channel',
      reason: 'LSB payload 無法以 UTF-8 解碼，無浮水印或已損壞'
    }
  }

  const isWatermark = text.includes('uid:') || text.includes('fid:') || text.includes('ts:')
  if (isWatermark) {
    return { detected: true, method: 'lsb-r-channel', payload: text, reason: '成功從 R 通道 LSB 解碼出浮水印' }
  }

  return {
    detected: false,
    method: 'lsb-r-channel',
    reason: `LSB 解碼成功但內容不符合浮水印格式（前 20 字元：${text.slice(0, 20)}）`
  }
}

// ──────────────────────────────────────────────────────────────
// DOCX detection
// ──────────────────────────────────────────────────────────────

/**
 * Detect watermark in DOCX:
 * 1. Invisible: checks docProps/custom.xml for "WatermarkPayload" property.
 * 2. Visible: scans word/document.xml w:t nodes for uid: pattern.
 */
export async function detectDocxWatermark(file) {
  const arrayBuffer = await file.arrayBuffer()
  let zip
  try {
    zip = await JSZip.loadAsync(arrayBuffer)
  } catch {
    return {
      detected: false,
      method: 'docx-custom-property',
      reason: 'DOCX 解析失敗（可能不是有效的 DOCX 檔案）'
    }
  }

  // 1. Invisible: custom document property
  const customFile = zip.file('docProps/custom.xml')
  if (customFile) {
    const xml = await customFile.async('string')
    const match = xml.match(/<vt:lpwstr>([^<]*uid:[^<]*)<\/vt:lpwstr>/)
    if (match) {
      return {
        detected: true,
        method: 'docx-custom-property',
        payload: match[1],
        reason: '在 DOCX 自訂屬性（docProps/custom.xml）中偵測到不可視浮水印'
      }
    }
  }

  // 2. Visible: scan document body text
  const docFile = zip.file('word/document.xml')
  if (docFile) {
    const xml = await docFile.async('string')
    const textNodes = [...xml.matchAll(/<w:t[^>]*>([^<]+)<\/w:t>/g)].map((m) => m[1])
    const combined = textNodes.join(' ')
    const match = combined.match(/uid:[a-f0-9]{8}[^|]*\|[^|]*fid:[a-f0-9]{8}[^\n]*/i)
    if (match) {
      return {
        detected: true,
        method: 'docx-body-text',
        payload: match[0].trim(),
        reason: '在 DOCX 文件內容中偵測到可視浮水印文字'
      }
    }
  }

  return {
    detected: false,
    method: 'docx-custom-property',
    reason: '未在 DOCX 中偵測到浮水印（自訂屬性或文件文字均無符合記錄）'
  }
}

// ──────────────────────────────────────────────────────────────
// TXT detection
// ──────────────────────────────────────────────────────────────

/**
 * Detect watermark in TXT:
 * 1. Visible: looks for "# Watermark: uid:..." line.
 * 2. Invisible: decodes ZWC (ZWSP=0, ZWJ=1) sequence from start of file.
 */
export async function detectTxtWatermark(file) {
  const text = await file.text()

  // 1. Visible marker
  const visibleMatch = text.match(/# Watermark: (uid:[^\n]+)/)
  if (visibleMatch) {
    return {
      detected: true,
      method: 'txt-visible-marker',
      payload: visibleMatch[1].trim(),
      reason: '在檔案末尾偵測到可視浮水印標記行'
    }
  }

  // 2. ZWC invisible (ZWSP U+200B = 0, ZWJ U+200D = 1)
  // ZWC block is appended at the END of the file — scan backward from the end.
  // This avoids prepending invisible chars that corrupt the file's readable start.
  const ZWSP = '\u200B'
  const ZWJ = '\u200D'

  // Locate the trailing ZWC block by scanning backward
  let zwcStart = text.length
  while (zwcStart > 0 && (text[zwcStart - 1] === ZWSP || text[zwcStart - 1] === ZWJ)) {
    zwcStart--
  }
  const zwcBlock = text.slice(zwcStart)

  if (zwcBlock.length >= 32) {
    let payloadLength = 0
    for (let i = 0; i < 32; i++) {
      payloadLength = (payloadLength << 1) | (zwcBlock[i] === ZWJ ? 1 : 0)
    }

    if (payloadLength > 0 && payloadLength <= 50_000 && zwcBlock.length >= 32 + payloadLength * 8) {
      const bytes = new Uint8Array(payloadLength)
      for (let b = 0; b < payloadLength; b++) {
        let byte = 0
        for (let bit = 0; bit < 8; bit++) {
          byte = (byte << 1) | (zwcBlock[32 + b * 8 + bit] === ZWJ ? 1 : 0)
        }
        bytes[b] = byte
      }
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (decoded.includes('uid:') || decoded.includes('fid:')) {
          return {
            detected: true,
            method: 'txt-zwc-steganography',
            payload: decoded,
            reason: '成功從零寬字元序列（ZWC）解碼出不可視浮水印'
          }
        }
      } catch {
        // ZWC present but not decodable as our watermark
      }
    }
  }

  return {
    detected: false,
    method: 'txt-zwc-steganography',
    reason: '未偵測到浮水印（可視標記行或零寬字元序列均無符合記錄）'
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function _mimeFromName(filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  return (
    {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword',
      txt: 'text/plain'
    }[ext] || ''
  )
}
