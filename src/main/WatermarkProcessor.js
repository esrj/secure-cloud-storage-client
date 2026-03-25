/**
 * Applies visible AND invisible watermarks to PDF and image files.
 * Due to E2E encryption, watermarking happens client-side.
 * Server provides authenticated metadata (userId, fileId, timestamp) for the watermark text.
 *
 * Invisible watermark techniques:
 *  - PDF   : White text (rgb 1,1,1) scattered across every page. Invisible to the eye,
 *            recoverable by "Select All" in any PDF reader.
 *  - PNG   : True LSB (Least-Significant-Bit) steganography on the R channel.
 *            Lossless format preserves every bit; watermark survives re-open.
 *  - JPEG  : LSB encoding followed by high-quality (95%) re-save.
 *            ⚠ JPEG is lossy – the watermark MAY be partially degraded after
 *            further re-compression. PNG is preferred for invisible watermarks.
 */
import { PDFDocument, rgb, degrees, StandardFonts, TextRenderingMode } from 'pdf-lib'
import Jimp from 'jimp'
import { logger } from './Logger'

/** Supported MIME types for VISIBLE watermark */
export const WATERMARK_SUPPORTED_MIMES = ['application/pdf', 'image/png', 'image/jpeg']

/** Supported MIME types for INVISIBLE watermark */
export const INVISIBLE_WATERMARK_SUPPORTED_MIMES = ['application/pdf', 'image/png', 'image/jpeg']

/** Derive MIME type from file extension */
export function getMimeFromFilename(filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const map = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg'
  }
  return map[ext] || null
}

/** Whether visible watermark is supported for this filename */
export function isWatermarkSupported(filename) {
  return WATERMARK_SUPPORTED_MIMES.includes(getMimeFromFilename(filename))
}

/**
 * Apply visible watermark to a buffer and return the watermarked buffer.
 * @param {Buffer} inputBuffer Decrypted file content
 * @param {string} mimeType MIME type of the file
 * @param {{ text: string, position: string, opacity: number, fontSize: number }} opts
 * @returns {Promise<Buffer>}
 */
export async function applyVisibleWatermark(inputBuffer, mimeType, opts) {
  logger.info(`[WatermarkProcessor] Applying watermark: mime=${mimeType}, position=${opts.position}, opacity=${opts.opacity}`)
  if (mimeType === 'application/pdf') {
    return _watermarkPDF(inputBuffer, opts)
  } else if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
    return _watermarkImage(inputBuffer, mimeType, opts)
  }
  throw new Error('WATERMARK_UNSUPPORTED_FORMAT')
}

// ──────────────────────────────────────────────────────────────
// PDF
// ──────────────────────────────────────────────────────────────
async function _watermarkPDF(inputBuffer, { text, position = 'bottomRight', opacity = 0.3, fontSize = 14 }) {
  const pdfDoc = await PDFDocument.load(inputBuffer)
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const color = rgb(0.4, 0.4, 0.4)

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize()
    const textWidth = font.widthOfTextAtSize(text, fontSize)

    if (position === 'diagonal') {
      // Three diagonal stamps spread across the page
      const step = Math.max(120, height / 3)
      for (let y = step * 0.5; y < height; y += step) {
        page.drawText(text, {
          x: Math.max(10, (width - textWidth) / 2),
          y,
          size: fontSize,
          font,
          color,
          opacity,
          rotate: degrees(45)
        })
      }
    } else {
      const x = position === 'bottomRight' ? Math.max(10, width - textWidth - 20) : 20
      page.drawText(text, { x, y: 20, size: fontSize, font, color, opacity })
    }
  }

  return Buffer.from(await pdfDoc.save())
}

// ──────────────────────────────────────────────────────────────
// Images (PNG / JPEG)
// ──────────────────────────────────────────────────────────────
async function _watermarkImage(inputBuffer, mimeType, { text, position = 'bottomRight', opacity = 0.5, fontSize = 32 }) {
  const image = await Jimp.read(inputBuffer)
  const w = image.bitmap.width
  const h = image.bitmap.height

  // Choose closest available bitmap font
  let fontKey
  if (fontSize >= 32) fontKey = Jimp.FONT_SANS_32_WHITE
  else if (fontSize >= 16) fontKey = Jimp.FONT_SANS_16_WHITE
  else fontKey = Jimp.FONT_SANS_8_WHITE

  const font = await Jimp.loadFont(fontKey)
  const textW = Jimp.measureText(font, text)
  const textH = Jimp.measureTextHeight(font, text, w + 1)

  // Build transparent overlay
  const overlay = new Jimp(w, h, 0x00000000)

  let x = 20
  let y = Math.max(0, h - textH - 20)
  if (position === 'bottomRight') {
    x = Math.max(10, w - textW - 20)
  } else if (position === 'diagonal') {
    x = Math.max(0, (w - textW) / 2)
    y = Math.max(0, (h - textH) / 2)
  }

  overlay.print(font, x, y, text)

  // Reduce alpha channel of every printed pixel to achieve opacity
  const clampedOpacity = Math.min(1, Math.max(0, opacity))
  overlay.scan(0, 0, w, h, function (px, py, idx) {
    const origAlpha = this.bitmap.data[idx + 3]
    if (origAlpha > 0) {
      this.bitmap.data[idx + 3] = Math.round(origAlpha * clampedOpacity)
    }
  })

  image.composite(overlay, 0, 0, {
    mode: Jimp.BLEND_SOURCE_OVER,
    opacitySource: 1,
    opacityDest: 1
  })

  const jimpMime = mimeType === 'image/png' ? Jimp.MIME_PNG : Jimp.MIME_JPEG
  return image.getBufferAsync(jimpMime)
}

// ══════════════════════════════════════════════════════════════
// INVISIBLE WATERMARK
// ══════════════════════════════════════════════════════════════

/**
 * Apply invisible watermark to a buffer.
 * @param {Buffer} inputBuffer Decrypted file content
 * @param {string} mimeType
 * @param {{ text: string }} opts
 * @returns {Promise<Buffer>}
 */
export async function applyInvisibleWatermark(inputBuffer, mimeType, opts) {
  logger.info(`[WatermarkProcessor] Applying INVISIBLE watermark: mime=${mimeType}`)
  if (mimeType === 'application/pdf') {
    return _invisiblePDF(inputBuffer, opts)
  } else if (mimeType === 'image/png') {
    return _lsbPNG(inputBuffer, opts)
  } else if (mimeType === 'image/jpeg') {
    return _lsbJPEG(inputBuffer, opts)
  }
  throw new Error('WATERMARK_UNSUPPORTED_FORMAT')
}

// ──────────────────────────────────────────────────────────────
// PDF invisible: TextRenderingMode.Invisible (PDF spec mode 3)
// Text is fully invisible on ANY background colour because the PDF
// renderer draws nothing — yet the text string is present in the
// document structure and can be found via "Select All" or a text search.
// ──────────────────────────────────────────────────────────────
async function _invisiblePDF(inputBuffer, { text }) {
  const pdfDoc = await PDFDocument.load(inputBuffer)
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize()
    // Scatter multiple copies so partial-page crops still contain the mark
    for (let y = 30; y < height; y += 120) {
      for (let x = 10; x < width - 10; x += 180) {
        page.drawText(text, {
          x,
          y,
          size: 8,
          font,
          color: rgb(0, 0, 0), // colour is irrelevant for mode 3, but required
          renderingMode: TextRenderingMode.Invisible // mode 3: renders nothing
        })
      }
    }
  }
  return Buffer.from(await pdfDoc.save())
}

// ──────────────────────────────────────────────────────────────
// LSB helpers shared by PNG and JPEG
// ──────────────────────────────────────────────────────────────

/**
 * Encode a UTF-8 string into the LSB of the R channel (RGBA bitmap data).
 * Format: [4-byte big-endian payload length][UTF-8 bytes]
 * @param {Buffer} bitmapData Jimp RGBA byte buffer (modified in-place)
 * @param {number} width
 * @param {number} height
 * @param {string} text
 */
function _encodeLSB(bitmapData, width, height, text) {
  const textBytes = Buffer.from(text, 'utf8')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(textBytes.length, 0)
  const payload = Buffer.concat([header, textBytes])

  const capacity = width * height // 1 bit per pixel in R channel
  if (payload.length * 8 > capacity) {
    throw new Error(
      `Invisible watermark text too long for this image (need ${payload.length * 8} bits, have ${capacity}).`
    )
  }

  let bitPos = 0
  for (let byteIdx = 0; byteIdx < payload.length; byteIdx++) {
    for (let bit = 7; bit >= 0; bit--) {
      const rOffset = bitPos * 4 // R channel of pixel `bitPos`
      const bitValue = (payload[byteIdx] >> bit) & 1
      bitmapData[rOffset] = (bitmapData[rOffset] & 0xfe) | bitValue
      bitPos++
    }
  }
}

// ──────────────────────────────────────────────────────────────
// PNG: true LSB steganography (lossless — every bit is preserved)
// ──────────────────────────────────────────────────────────────
async function _lsbPNG(inputBuffer, { text }) {
  const image = await Jimp.read(inputBuffer)
  _encodeLSB(image.bitmap.data, image.bitmap.width, image.bitmap.height, text)
  return image.getBufferAsync(Jimp.MIME_PNG)
}

// ──────────────────────────────────────────────────────────────
// JPEG: LSB encoding + high-quality re-save
// ⚠  JPEG is lossy. Re-compression after download may degrade the watermark.
//    PNG is recommended when invisible watermark reliability is critical.
// ──────────────────────────────────────────────────────────────
async function _lsbJPEG(inputBuffer, { text }) {
  const image = await Jimp.read(inputBuffer)
  _encodeLSB(image.bitmap.data, image.bitmap.width, image.bitmap.height, text)
  // Quality 95 minimises JPEG artefacts that would destroy LSB data
  image.quality(95)
  return image.getBufferAsync(Jimp.MIME_JPEG)
}
