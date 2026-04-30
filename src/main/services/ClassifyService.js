/**
 * Document classification via local LLM (node-llama-cpp, main process only).
 *
 * Multi-file batch pipeline (since 2026-04):
 *   1. Extract text from each file (txt / pdf / docx via TextExtractService).
 *      Files whose extraction fails are KEPT — they enter the prompt with
 *      filename only, since the filename itself is a strong classification
 *      signal (e.g. "海軍任務日誌.docx").
 *   2. Build ONE composite prompt containing every file's name plus a
 *      head+tail-condensed snippet of its body. Per-file character budget is
 *      computed dynamically from the model's context window so the whole
 *      batch fits in a single inference.
 *   3. Run ONE inference. The model returns a single set of labels covering
 *      the whole batch — exactly the "看整批、給同一組標籤" semantics the
 *      product asks for.
 *   4. Apply threshold to derive final_labels for the batch.
 */
import { basename } from 'node:path'
import { extractTextFromFiles } from './TextExtractService.js'
import { getClassifierSettings } from './classifierSettings.js'
import { generate, MAX_CHUNK_CHARS, pickContextSize } from './LlamaCppClient.js'
import { ZH_CLASSIFY_SYSTEM_PROMPT } from './classifyZhPrompt.js'
import {
  clampThreshold,
  computeFinalLabelsFromBalanced,
  parseZhClassificationResponse
} from '../utils/classifyZhJson.js'
import { getSmartClassifyMode } from './classifierRuntime.js'
import { logger } from '../Logger.js'

/**
 * Per-file framing overhead in the composite prompt (the `# 檔案 N：xxx.pdf`
 * header, separator line, and a small slack for newlines / quote chars).
 * Roughly tracks token count on Chinese input (1 char ≈ 1 token).
 */
const PER_FILE_FRAME_OVERHEAD = 60

/**
 * Minimum characters of body text we'll dedicate to each file in the
 * composite prompt. Below this, the snippet is too short to be informative.
 */
const MIN_PER_FILE_CHARS = 120

/**
 * Hard cap on per-file body characters even when only one file is in the
 * batch. Prevents a single huge document from monopolising the context and
 * keeps inference time predictable.
 */
const MAX_PER_FILE_CHARS = 1800

/**
 * Head+tail condense `text` to fit `budget` chars.
 * Titles/abstracts live at the top and conclusions/summaries at the bottom —
 * both are the most informative regions for classification.
 *
 * @param {string} text
 * @param {number} budget
 * @returns {string}
 */
function condenseToBudget(text, budget) {
  const t = typeof text === 'string' ? text : ''
  if (t.length === 0) return ''
  if (t.length <= budget) return t
  const ELLIPSIS = '\n…（中略）…\n'
  const half = Math.floor((budget - ELLIPSIS.length) / 2)
  if (half <= 0) return t.slice(0, budget)
  return t.slice(0, half) + ELLIPSIS + t.slice(-half)
}

/**
 * Compute the per-file character budget so the composite body fits the
 * largest viable context tier.
 *
 * @param {number} fileCount
 * @returns {number}
 */
function perFileBudgetForBatch(fileCount) {
  const N = Math.max(1, fileCount)
  const totalBudget = Math.max(0, MAX_CHUNK_CHARS - N * PER_FILE_FRAME_OVERHEAD)
  const raw = Math.floor(totalBudget / N)
  return Math.max(MIN_PER_FILE_CHARS, Math.min(MAX_PER_FILE_CHARS, raw))
}

/**
 * Build one composite body containing every file's framing + condensed text.
 *
 * @param {Array<{ path: string, text: string, extracted: boolean }>} files
 * @param {number} perFileBudget
 * @returns {string}
 */
function buildCompositeBody(files, perFileBudget) {
  return files
    .map((f, idx) => {
      const header = `# 檔案 ${idx + 1}：${basename(f.path)}`
      if (!f.extracted || !f.text) {
        return `${header}\n（無法擷取內文，請僅依檔名判斷）`
      }
      const body = condenseToBudget(f.text, perFileBudget)
      return `${header}\n${body}`
    })
    .join('\n\n---\n\n')
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
  const enable = input?.enable !== false

  if (!enable) {
    return { supported: false, reason: 'DISABLED', labels: [], final_labels: [] }
  }

  const mode = getSmartClassifyMode()
  if (mode === 'off') {
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
  // Note: We still call extractTextFromFiles, but unlike the per-file pipeline
  // we keep ALL paths in the batch — files whose extraction returned empty
  // text still contribute via filename in the composite prompt.
  const extracted = await extractTextFromFiles(paths)
  const extractedByPath = new Map()
  if (extracted.supported) {
    for (const e of extracted.texts) extractedByPath.set(e.path, e.text)
  }

  /** @type {Array<{ path: string, text: string, extracted: boolean }>} */
  const files = paths.map((p) => {
    const text = extractedByPath.get(p) ?? ''
    return { path: p, text, extracted: text.length > 0 }
  })

  const filesWithText = files.filter((f) => f.extracted).length
  const extraction = {
    attempted: true,
    ok: filesWithText > 0,
    filesCount: files.length,
    filesWithText,
    files: files.map((f) => ({
      path: f.path,
      name: basename(f.path),
      charLen: f.text.length,
      extracted: f.extracted
    }))
  }

  // ── 2. Build composite body ──────────────────────────────────────────────
  const perFileBudget = perFileBudgetForBatch(files.length)
  let composite = buildCompositeBody(files, perFileBudget)

  // Safety net: if a very large batch + many extracted bodies overshoots the
  // model's char budget, hard-truncate. The per-file budget already prevents
  // this in normal cases; this only triggers for pathological inputs.
  if (composite.length > MAX_CHUNK_CHARS) {
    const TAIL = '\n…（後續檔案內容因長度超過模型上限而省略，已盡量保留檔名與前段內容）'
    composite = composite.slice(0, MAX_CHUNK_CHARS - TAIL.length) + TAIL
  }

  if (composite.length === 0) {
    return {
      supported: false,
      reason: 'EMPTY_CONTENT',
      labels: [],
      final_labels: [],
      extraction
    }
  }

  logger.info(
    `[Classify] Batch composite: files=${files.length}, withText=${filesWithText}, ` +
      `perFileBudget=${perFileBudget}, compositeLen=${composite.length}, mode=${mode}`
  )

  const ctxSize = pickContextSize(composite.length)
  const temperature =
    typeof input?.temperature === 'number'
      ? input.temperature
      : mode === 'medium'
        ? 0.25
        : 0.1

  // ── 3. Single inference for the whole batch ──────────────────────────────
  const userPrompt = `本輪門檻 threshold = ${threshold}
本批共 ${files.length} 個檔案，請針對「整批檔案」綜合判斷並輸出一組嚴格 JSON（規格見 system，僅 JSON、勿 markdown、勿 <think>）。
注意：score 必須真實反映你對「整批」的判斷，不可全部填 0、也不可照抄 system 範例的數值。

以下為本批每個檔案的「檔名 + 摘要內容」：

${composite}`

  // Report a 1/1 progress so the UI spinner has a sensible signal.
  const report = (done) => {
    if (typeof input?.onProgress === 'function') {
      input.onProgress({ done, total: 1 })
    }
  }
  report(0)

  let raw
  try {
    raw = await generate(userPrompt, {
      system: ZH_CLASSIFY_SYSTEM_PROMPT,
      temperature,
      mode,
      contextSize: ctxSize
    })
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
  report(1)

  const parsed = parseZhClassificationResponse(raw)
  if (!parsed.ok) {
    return {
      supported: false,
      reason: 'JSON_PARSE_FAILED',
      labels: [],
      final_labels: [],
      extraction,
      llmRawText: raw,
      thresholdUsed: threshold
    }
  }

  // ── 4. Threshold ─────────────────────────────────────────────────────────
  const balancedLabels = parsed.labels
  const final_labels = computeFinalLabelsFromBalanced(balancedLabels, threshold)

  return {
    supported: true,
    labels: balancedLabels,
    final_labels,
    classification: { labels: balancedLabels, final_labels },
    extraction: {
      ...extraction,
      chunksClassified: 1,
      parseSuccessRuns: 1
    },
    llmRawText: input?.debug ? raw : undefined,
    thresholdUsed: threshold
  }
}

export { parseZhClassificationJson } from '../utils/classifyZhJson.js'
