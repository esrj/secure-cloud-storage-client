/**
 * Document classification via local LLM (node-llama-cpp, main process only).
 *
 * Pipeline:
 *   1. Extract text from each file (txt / pdf / docx via TextExtractService)
 *   2. Split each file into ≤3 chunks of ≤128 KiB each
 *   3. Run local inference on every chunk using the system prompt
 *   4. Balance scores across all chunks (and all files in a batch)
 *   5. Return a single set of final_labels for the entire batch
 */
import { basename } from 'node:path'
import { extractTextFromFiles } from './TextExtractService.js'
import { getClassifierSettings } from './classifierSettings.js'
import { generate } from './LlamaCppClient.js'
import { ZH_CLASSIFY_SYSTEM_PROMPT } from './classifyZhPrompt.js'
import {
  balanceZhLabelsFromRuns,
  clampThreshold,
  computeFinalLabelsFromBalanced,
  parseZhClassificationResponse
} from '../utils/classifyZhJson.js'

/**
 * Max characters per chunk.
 * 2 048 context window 扣掉 system prompt (~800 tokens) + response (~400 tokens)
 * 約剩 850 tokens 給文件，中文 ~1700 字 → 保守取 2000 字。
 * TODO: 上線前請將 CHUNK_CHAR_LIMIT 從 2_000 改回 8_000（配合 CONTEXT_SIZE 8192）。
 * Documents longer than 3 × CHUNK_CHAR_LIMIT are truncated after 3 chunks.
 */
const CHUNK_CHAR_LIMIT = 2_000
/** Single file: maximum number of chunks; excess text is discarded */
const MAX_CHUNKS_PER_FILE = 3

/**
 * @param {string} fullText
 * @returns {string[]}
 */
function sliceTextIntoChunks(fullText) {
  const t = typeof fullText === 'string' ? fullText : ''
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < MAX_CHUNKS_PER_FILE; i++) {
    const start = i * CHUNK_CHAR_LIMIT
    if (start >= t.length) break
    out.push(t.slice(start, start + CHUNK_CHAR_LIMIT))
  }
  return out
}

/**
 * @param {{
 *   paths?: string[],
 *   enable?: boolean,
 *   debug?: boolean,
 *   temperature?: number,
 *   threshold?: number,
 *   onProgress?: (p: { done: number, total: number }) => void
 * }} input
 */
export async function classifyDocuments(input) {
  const enable = input?.enable !== false // default true

  if (!enable) {
    return { supported: false, reason: 'DISABLED', labels: [], final_labels: [] }
  }

  const settings = getClassifierSettings()
  const threshold = clampThreshold(
    typeof input?.threshold === 'number' ? input.threshold : settings.classifierThreshold
  )

  const paths = Array.isArray(input?.paths)
    ? input.paths.filter((p) => typeof p === 'string' && p.trim())
    : []

  if (paths.length === 0) {
    return {
      supported: false,
      reason: 'NO_FILES',
      labels: [],
      final_labels: [],
      extraction: { attempted: false }
    }
  }

  // ── 1. Text extraction ────────────────────────────────────────────────────
  const extracted = await extractTextFromFiles(paths)
  if (!extracted.supported) {
    return {
      supported: false,
      reason: extracted.reason,
      labels: [],
      final_labels: [],
      extraction: { attempted: true, ok: false }
    }
  }

  const extraction = {
    attempted: true,
    ok: true,
    filesCount: extracted.texts.length,
    files: extracted.texts.map((t) => ({
      path: t.path,
      name: basename(t.path),
      charLen: t.text.length,
      chunks: sliceTextIntoChunks(t.text).length
    }))
  }

  // ── 2. Build chunk jobs ───────────────────────────────────────────────────
  /** @type {Array<{ path: string, chunkIndex: number, chunkTotal: number, body: string }>} */
  const chunkJobs = []
  for (const { path, text } of extracted.texts) {
    const parts = sliceTextIntoChunks(text)
    for (let ci = 0; ci < parts.length; ci++) {
      chunkJobs.push({ path, chunkIndex: ci + 1, chunkTotal: parts.length, body: parts[ci] })
    }
  }

  if (chunkJobs.length === 0) {
    return {
      supported: false,
      reason: 'EMPTY_CONTENT',
      labels: [],
      final_labels: [],
      extraction
    }
  }

  const totalChunks = chunkJobs.length
  const report = (done) => {
    if (typeof input?.onProgress === 'function') {
      input.onProgress({ done, total: totalChunks })
    }
  }

  // ── 3. Inference loop ─────────────────────────────────────────────────────
  /** @type {Array<{ labels: import('../utils/classifyZhJson.js').ZhLabelEntry[] }>} */
  const okRuns = []
  /** @type {string[]} */
  const rawResponses = []

  try {
    for (let i = 0; i < chunkJobs.length; i++) {
      const job = chunkJobs[i]
      const userPrompt = `本輪門檻 threshold = ${threshold}

此為同一批上傳中的其中一段文字。請僅依下列「文件片段」輸出 JSON（規格見 system，僅 JSON、勿 markdown）。

檔案：${basename(job.path)}（第 ${job.chunkIndex}/${job.chunkTotal} 段）

${job.body}`

      const raw = await generate(userPrompt, {
        system: ZH_CLASSIFY_SYSTEM_PROMPT,
        temperature: typeof input?.temperature === 'number' ? input.temperature : 0.1
      })

      rawResponses.push(raw)
      const parsed = parseZhClassificationResponse(raw)
      if (parsed.ok) okRuns.push({ labels: parsed.labels })

      report(i + 1)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      supported: false,
      reason: 'LLM_GENERATE_FAILED',
      labels: [],
      final_labels: [],
      extraction,
      llmError: msg,
      thresholdUsed: threshold
    }
  }

  if (okRuns.length === 0) {
    return {
      supported: false,
      reason: 'JSON_PARSE_FAILED',
      labels: [],
      final_labels: [],
      extraction,
      llmRawText: rawResponses[0] ?? '',
      thresholdUsed: threshold
    }
  }

  // ── 4. Balance + threshold ────────────────────────────────────────────────
  const balancedLabels = balanceZhLabelsFromRuns(okRuns)
  const final_labels = computeFinalLabelsFromBalanced(balancedLabels, threshold)

  return {
    supported: true,
    labels: balancedLabels,
    final_labels,
    classification: { labels: balancedLabels, final_labels },
    extraction: {
      ...extraction,
      chunksClassified: chunkJobs.length,
      parseSuccessRuns: okRuns.length
    },
    llmRawText: input?.debug ? rawResponses.join('\n---\n') : undefined,
    thresholdUsed: threshold
  }
}

export { parseZhClassificationJson } from '../utils/classifyZhJson.js'
