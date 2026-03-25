/**
 * Client-side invisible watermark detection.
 * Runs entirely in the renderer process — no file is uploaded to the server.
 *
 * Supported methods:
 *  - PDF  : finds text embedded with TextRenderingMode.Invisible (mode 3)
 *           AND legacy white-text hidden watermarks
 *  - PNG  : LSB steganography, R-channel, 32-bit big-endian length header
 *  - JPEG : same LSB decode after rendering to canvas (JPEG decoded first)
 *
 * @typedef {Object} WatermarkDetectResult
 * @property {string}  fileName
 * @property {string}  mimeType
 * @property {boolean} detected
 * @property {'pdf-invisible-text'|'lsb-r-channel'|'unsupported'|'error'} method
 * @property {string}  [payload]
 * @property {string}  [reason]
 */

import * as pdfjsLib from 'pdfjs-dist'

// Use the bundled worker via Vite's ?url import
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Entry point: detects invisible watermark in the given File object.
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
    return {
      ...base,
      detected: false,
      method: 'unsupported',
      reason: `格式 ${mime || '未知'} 不支援浮水印偵測（支援：PDF、PNG、JPEG）`
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

/**
 * Detect invisible text watermark in a PDF.
 * pdfjs-dist's getTextContent() returns ALL text including Tr-3 invisible text
 * and white-coloured text — the same content that appears when you "Select All".
 */
export async function detectPdfWatermark(file) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

  const collectedPayloads = new Set()

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const textContent = await page.getTextContent()

    // Accumulate all text strings on this page
    const pageText = textContent.items
      .filter((item) => item.str && item.str.trim().length > 0)
      .map((item) => item.str.trim())
      .join(' ')

    // Primary: look for our watermark pattern (uid: prefix)
    const matches = pageText.match(/uid:[a-f0-9]{8}[^|]*\|[^|]*fid:[a-f0-9]{8}[^\n]*/gi)
    if (matches) {
      matches.forEach((m) => collectedPayloads.add(m.trim()))
    }

    // Fallback: any item whose text looks like a partial watermark fragment
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
// Image LSB detection  (PNG + JPEG)
// ──────────────────────────────────────────────────────────────

/**
 * Decode LSB watermark from PNG or JPEG.
 * Renders the image to a canvas so JPEG is decoded to raw RGBA pixels first.
 */
export async function detectImageLsbWatermark(file) {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height

  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const pixels = imageData.data // Uint8ClampedArray, RGBA order
  const totalPixels = canvas.width * canvas.height

  // Step 1: read 32-bit big-endian header = payload byte length
  let payloadLength = 0
  for (let i = 0; i < 32; i++) {
    // R channel of pixel i is at index i*4 in RGBA buffer
    payloadLength = (payloadLength << 1) | (pixels[i * 4] & 1)
  }

  // Step 2: sanity checks
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

  // Step 3: read payload bytes (MSB-first, one bit per pixel in R channel)
  const payloadBytes = new Uint8Array(payloadLength)
  for (let b = 0; b < payloadLength; b++) {
    let byte = 0
    for (let bit = 0; bit < 8; bit++) {
      const pixelIdx = 32 + b * 8 + bit
      byte = (byte << 1) | (pixels[pixelIdx * 4] & 1)
    }
    payloadBytes[b] = byte
  }

  // Step 4: decode UTF-8
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

  // Step 5: validate content looks like our watermark
  const isWatermark =
    text.includes('uid:') || text.includes('fid:') || text.includes('ts:')

  if (isWatermark) {
    return {
      detected: true,
      method: 'lsb-r-channel',
      payload: text,
      reason: '成功從 R 通道 LSB 解碼出浮水印'
    }
  }

  // Has data but doesn't match our format — could be coincidental noise
  return {
    detected: false,
    method: 'lsb-r-channel',
    reason: `LSB 解碼成功但內容不符合浮水印格式（前 20 字元：${text.slice(0, 20)}）`
  }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function _mimeFromName(filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  return (
    { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[
      ext
    ] || ''
  )
}
