/**
 * Client-side watermark detection.
 * Runs entirely in the renderer process — no file is uploaded to the server.
 *
 * For each format we attempt BOTH visible and invisible detection and return a
 * `findings` array — UI can list one or both. If both are present we keep both;
 * we no longer return early on the first hit (the previous behaviour caused
 * "PDF/DOCX 只報不可視，TXT 只報可視" complaints).
 *
 * Supported formats and methods:
 *  - PDF   : invisible (TextRenderingMode 3, fontSize 8) AND visible text via pdfjs-dist
 *  - PNG   : LSB steganography, R-channel, 32-bit big-endian length header (single mode)
 *  - JPEG  : same LSB decode after canvas decode (single mode)
 *  - DOCX  : invisible (docProps/custom.xml WatermarkPayload) AND visible (word/document.xml body text)
 *  - TXT   : visible "# Watermark:" marker line AND invisible ZWC (zero-width char) steganography
 *
 * @typedef {'pdf-invisible-text'
 *          |'pdf-visible-text'
 *          |'lsb-r-channel'
 *          |'docx-custom-property'
 *          |'docx-body-text'
 *          |'txt-visible-marker'
 *          |'txt-zwc-steganography'
 *          |'unsupported'
 *          |'error'} WatermarkMethod
 *
 * @typedef {Object} WatermarkFinding
 * @property {'visible'|'invisible'} kind
 * @property {WatermarkMethod}       method
 * @property {string}                payload
 * @property {string}                [reason]
 *
 * @typedef {Object} WatermarkDetectResult
 * @property {string}                fileName
 * @property {string}                mimeType
 * @property {boolean}               detected
 * @property {WatermarkFinding[]}    findings        // empty array iff detected=false
 * @property {WatermarkMethod}       method          // back-compat: first finding's method, or 'unsupported'/'error'
 * @property {string}                [payload]       // back-compat: first finding's payload
 * @property {string}                [reason]
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
 * Entry point: detects visible AND invisible watermarks in the given File.
 * @param {File} file
 * @returns {Promise<WatermarkDetectResult>}
 */
export async function detectWatermark(file) {
  const mime = file.type || _mimeFromName(file.name)
  const base = { fileName: file.name, mimeType: mime }

  try {
    if (mime === 'application/pdf') {
      return _finalize(base, await detectPdfWatermark(file))
    }
    if (mime === 'image/png' || mime === 'image/jpeg') {
      return _finalize(base, await detectImageLsbWatermark(file))
    }
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return _finalize(base, await detectDocxWatermark(file))
    }
    if (mime === 'text/plain') {
      return _finalize(base, await detectTxtWatermark(file))
    }
    if (mime === 'application/msword') {
      return {
        ...base,
        detected: false,
        findings: [],
        method: 'unsupported',
        reason: '舊版 DOC 格式暫不支援浮水印偵測，請先將檔案另存為 DOCX 格式後再試。'
      }
    }
    return {
      ...base,
      detected: false,
      findings: [],
      method: 'unsupported',
      reason: `格式 ${mime || '未知'} 不支援浮水印偵測（支援：PDF、PNG、JPEG、DOCX、TXT）`
    }
  } catch (err) {
    return {
      ...base,
      detected: false,
      findings: [],
      method: 'error',
      reason: `偵測過程發生錯誤：${err.message}`
    }
  }
}

/**
 * Merge per-detector output ({findings,reason}) with file-level base, and
 * derive back-compat top-level fields from the findings array.
 *
 * @param {{fileName:string,mimeType:string}} base
 * @param {{findings: WatermarkFinding[], reason?: string, method?: WatermarkMethod}} det
 * @returns {WatermarkDetectResult}
 */
function _finalize(base, det) {
  const findings = Array.isArray(det.findings) ? det.findings : []
  const detected = findings.length > 0
  const first = findings[0]
  return {
    ...base,
    detected,
    findings,
    method: detected ? first.method : (det.method || 'unsupported'),
    payload: detected ? first.payload : undefined,
    reason: det.reason || (detected ? _composeReason(findings) : undefined)
  }
}

function _composeReason(findings) {
  const parts = findings.map((f) => f.reason || _defaultReasonFor(f))
  return parts.join('；')
}

function _defaultReasonFor(f) {
  return f.kind === 'visible' ? '偵測到可視浮水印' : '偵測到不可視浮水印'
}

// ──────────────────────────────────────────────────────────────
// PDF detection
// ──────────────────────────────────────────────────────────────

/**
 * Distinguish visible vs invisible by text item height, since the invisible
 * watermark writer (WatermarkProcessor._invisiblePDF) fixes fontSize=8.
 * Anything noticeably larger is considered visible.
 *
 * pdfjs's TextItem.height is in user-space units (post-transform); for our
 * writer (size=8) it's typically ~6–8. For a normal visible watermark
 * (default size 14, slider min 8 / max 48) it's >= 10 in nearly all cases.
 */
const PDF_INVISIBLE_HEIGHT_THRESHOLD = 10

// Watermark text format
// ─────────────────────
// The visible watermark embeds 8 hex chars of the (server-keyed) tracked uid:
//     uid:abc12345 | fid:abc12345 | <iso ts>[ | note]
// The invisible watermark embeds the FULL tracked uid with version prefix:
//     uid:v1<iv-hex><ct-hex> | fid:<fileId> | ts:<iso ts>[ | note]
//
// `WM_PATTERN` accepts both shapes so detectors don't need to discriminate.
const WM_PATTERN = /uid:(?:v\d+)?[a-f0-9]+[^|]*\|[^|]*fid:[a-f0-9]+[^\n]*/i

/** Extract the embedded uid string (tracked or short prefix) from a payload. */
export function extractTrackedUidFromPayload(payload) {
  if (typeof payload !== 'string') return null
  const m = payload.match(/uid:((?:v\d+)?[a-f0-9]+)/i)
  return m ? m[1] : null
}

// Y-tolerance used to cluster pdfjs TextItems into "lines". pdfjs sometimes
// splits a single showText() into multiple TextItems whose transforms differ
// only by sub-pixel kerning; we want all of them to land in the same bucket.
const PDF_LINE_Y_TOLERANCE = 2

export async function detectPdfWatermark(file) {
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

  /** @type {Set<string>} */
  const visibleHits = new Set()
  /** @type {Set<string>} */
  const invisibleHits = new Set()

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const textContent = await page.getTextContent()

    // ── Line clustering ──────────────────────────────────────────────
    // pdfjs returns one TextItem per glyph cluster, so a long invisible
    // watermark like "uid:v1<128 hex chars> | fid:<uuid> | ts:<iso>" tends
    // to be sliced across multiple items even though it was written as a
    // single showText(). Grouping items by Y coordinate lets us reassemble
    // the original string before running the regex.
    //
    // `item.transform = [a,b,c,d,e,f]` where (e,f) is the (x,y) position in
    // user space. We bucket on Math.round(f / TOL) so close-but-not-equal
    // y values land in the same line.
    const lineMap = new Map() // bucketKey -> { y, minH, items: [{x, str, h}] }
    for (const item of textContent.items) {
      const s = item.str || ''
      if (!s) continue
      const x = Array.isArray(item.transform) ? item.transform[4] : 0
      const y = Array.isArray(item.transform) ? item.transform[5] : 0
      const h = typeof item.height === 'number' ? item.height : 0
      const key = Math.round(y / PDF_LINE_Y_TOLERANCE)
      const line = lineMap.get(key)
      if (line) {
        line.items.push({ x, str: s, h })
        if (h > 0 && (line.minH === 0 || h < line.minH)) line.minH = h
      } else {
        lineMap.set(key, { y, minH: h, items: [{ x, str: s, h }] })
      }
    }

    for (const line of lineMap.values()) {
      // Sort by x so left-to-right reading order is restored.
      line.items.sort((a, b) => a.x - b.x)
      const combined = line.items.map((it) => it.str).join('').trim()
      if (!combined) continue
      // Fast skip: only run the (relatively expensive) regex on lines that
      // contain at least one watermark sentinel.
      if (
        !(
          combined.includes('uid:') ||
          combined.includes('fid:') ||
          combined.includes('ts:')
        )
      ) {
        continue
      }
      const match = combined.match(WM_PATTERN)
      if (!match) continue

      // Use the minimum item height in this line to decide visible vs
      // invisible. The writer uses fontSize=8 for invisible — anything
      // noticeably larger is visible. Taking the *min* is safer than the
      // max: even if pdfjs reports some items as 0 height (degenerate),
      // the smallest non-zero one tells us about the rendering size.
      const h = line.minH
      if (h > 0 && h < PDF_INVISIBLE_HEIGHT_THRESHOLD) {
        invisibleHits.add(match[0].trim())
      } else {
        visibleHits.add(match[0].trim())
      }
    }
  }

  /** @type {WatermarkFinding[]} */
  const findings = []
  if (visibleHits.size > 0) {
    findings.push({
      kind: 'visible',
      method: 'pdf-visible-text',
      payload: Array.from(visibleHits)[0],
      reason: `在 PDF 中偵測到可視文字浮水印（共 ${visibleHits.size} 個實例）`
    })
  }
  if (invisibleHits.size > 0) {
    findings.push({
      kind: 'invisible',
      method: 'pdf-invisible-text',
      payload: Array.from(invisibleHits)[0],
      reason: `在 PDF 中偵測到不可視文字浮水印（共 ${invisibleHits.size} 個實例）`
    })
  }

  if (findings.length === 0) {
    return {
      findings: [],
      method: 'pdf-invisible-text',
      reason: '未偵測到可視或不可視文字浮水印'
    }
  }
  return { findings }
}

// ──────────────────────────────────────────────────────────────
// Image LSB detection (PNG + JPEG) — single mode, unchanged
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
      findings: [],
      method: 'lsb-r-channel',
      reason: `LSB header 長度不合理 (${payloadLength})，無浮水印或已損壞`
    }
  }
  const bitsNeeded = 32 + payloadLength * 8
  if (bitsNeeded > totalPixels) {
    return {
      findings: [],
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
      findings: [],
      method: 'lsb-r-channel',
      reason: 'LSB payload 無法以 UTF-8 解碼，無浮水印或已損壞'
    }
  }

  const isWatermark = text.includes('uid:') || text.includes('fid:') || text.includes('ts:')
  if (isWatermark) {
    return {
      findings: [
        {
          kind: 'invisible',
          method: 'lsb-r-channel',
          payload: text,
          reason: '成功從 R 通道 LSB 解碼出浮水印'
        }
      ]
    }
  }
  return {
    findings: [],
    method: 'lsb-r-channel',
    reason: `LSB 解碼成功但內容不符合浮水印格式（前 20 字元：${text.slice(0, 20)}）`
  }
}

// ──────────────────────────────────────────────────────────────
// DOCX detection
// ──────────────────────────────────────────────────────────────

/**
 * Detect watermark in DOCX:
 * 1. Invisible: docProps/custom.xml "WatermarkPayload" property.
 * 2. Visible : word/document.xml w:t nodes containing uid:... pattern.
 * Both are checked; both are reported when present (no early return).
 */
export async function detectDocxWatermark(file) {
  const arrayBuffer = await file.arrayBuffer()
  let zip
  try {
    zip = await JSZip.loadAsync(arrayBuffer)
  } catch {
    return {
      findings: [],
      method: 'docx-custom-property',
      reason: 'DOCX 解析失敗（可能不是有效的 DOCX 檔案）'
    }
  }

  /** @type {WatermarkFinding[]} */
  const findings = []

  // 1. Invisible: custom document property
  const customFile = zip.file('docProps/custom.xml')
  if (customFile) {
    const xml = await customFile.async('string')
    const match = xml.match(/<vt:lpwstr>([^<]*uid:[^<]*)<\/vt:lpwstr>/)
    if (match) {
      findings.push({
        kind: 'invisible',
        method: 'docx-custom-property',
        payload: match[1],
        reason: '在 DOCX 自訂屬性（docProps/custom.xml）中偵測到不可視浮水印'
      })
    }
  }

  // 2. Visible: scan document body text
  const docFile = zip.file('word/document.xml')
  if (docFile) {
    const xml = await docFile.async('string')
    // ── Run reassembly ────────────────────────────────────────────
    // OOXML stores a paragraph's visible text as a sequence of
    // `<w:t>` elements, one per run. Word (and even our own writer
    // after a round-trip through `zip.generateAsync`) may split a
    // single logical string across multiple runs, especially when
    // run-property changes are inserted mid-text. Joining with a
    // space corrupts the watermark: a hex uid like "abc12345" can
    // become "abc 12345", which no longer matches WM_PATTERN.
    //
    // Joining with the empty string reconstructs the original visible
    // text exactly (each w:t's content is what the reader sees end-to-end,
    // with no whitespace inserted between runs). The decoded HTML
    // entities (&amp; etc.) inside w:t are unlikely to appear inside a
    // watermark and don't affect uid/fid/ts matching, so we leave them.
    const textNodes = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])
    const combined = textNodes.join('')
    const match = combined.match(WM_PATTERN)
    if (match) {
      findings.push({
        kind: 'visible',
        method: 'docx-body-text',
        payload: match[0].trim(),
        reason: '在 DOCX 文件內容中偵測到可視浮水印文字'
      })
    }
  }

  if (findings.length === 0) {
    return {
      findings: [],
      method: 'docx-custom-property',
      reason: '未在 DOCX 中偵測到浮水印（自訂屬性或文件文字均無符合記錄）'
    }
  }
  return { findings }
}

// ──────────────────────────────────────────────────────────────
// TXT detection
// ──────────────────────────────────────────────────────────────

/**
 * Detect watermark in TXT:
 * 1. Visible : "# Watermark: uid:..." marker line.
 * 2. Invisible: ZWC (ZWSP=0, ZWJ=1) sequence appended at the END of the file.
 * Both are checked; both are reported when present (no early return).
 */
export async function detectTxtWatermark(file) {
  const text = await file.text()

  /** @type {WatermarkFinding[]} */
  const findings = []

  // 1. Visible marker
  const visibleMatch = text.match(/# Watermark: (uid:[^\n]+)/)
  if (visibleMatch) {
    findings.push({
      kind: 'visible',
      method: 'txt-visible-marker',
      payload: visibleMatch[1].trim(),
      reason: '在檔案末尾偵測到可視浮水印標記行'
    })
  }

  // 2. ZWC invisible (ZWSP U+200B = 0, ZWJ U+200D = 1)
  // ZWC block is appended at the END of the file — scan backward from the end.
  const ZWSP = '\u200B'
  const ZWJ = '\u200D'

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
          findings.push({
            kind: 'invisible',
            method: 'txt-zwc-steganography',
            payload: decoded,
            reason: '成功從零寬字元序列（ZWC）解碼出不可視浮水印'
          })
        }
      } catch {
        // ZWC present but not decodable as our watermark — ignore
      }
    }
  }

  if (findings.length === 0) {
    return {
      findings: [],
      method: 'txt-zwc-steganography',
      reason: '未偵測到浮水印（可視標記行或零寬字元序列均無符合記錄）'
    }
  }
  return { findings }
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
