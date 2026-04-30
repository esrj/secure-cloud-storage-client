/**
 * Local LLM inference via node-llama-cpp (main process only).
 *
 * node-llama-cpp is an ESM module with top-level await; it cannot be
 * require()-d from a CommonJS bundle.  All imports are therefore deferred to
 * runtime via dynamic import() which is compatible with ESM from any context.
 *
 * Model path resolution (highest priority first):
 *   1. LLAMA_MODEL_PATH environment variable
 *   2. <projectRoot>/resources/models/<filename>  (dev)
 *   3. <resourcesPath>/models/<filename>           (production)
 *
 * The active model is selected by the smart-classify mode (fast / medium / high).
 * When the mode changes, the old model/context are disposed and a new one is loaded.
 *
 * Context window is chosen dynamically based on the document text length:
 *   ≤ 512 chars → 512 tokens,  ≤ 1024 → 1024,  ≤ 2048 → 2048,  else → 4096
 * System prompt + response overhead (~300 tokens) is already accounted for.
 *
 * Qwen3 "/no_think": prepending this to the system prompt disables the
 * model's <think>…</think> chain-of-thought prefix and forces a direct JSON
 * reply.  The JSON-schema grammar constraint provides a second safety net.
 */
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { logger } from '../Logger'

// ── Mode → model filename mapping ────────────────────────────────────────────
// 'high' (27B) 已停用；仍保留檔案於 resources/models/ 但不對外暴露。
// 若日後恢復，將 high 行解除註解即可。
const MODEL_MAP = {
  fast:   'Qwen3.5-4B-q4_k_m.gguf',
  medium: 'Qwen3.5-9B-q4_k_m.gguf'
  // high:   'Qwen3.5-27B-q4_k_m.gguf'
}

/**
 * Fixed token budget consumed by prompts and generation, independent of
 * document text length:
 *   - System prompt (ZH_CLASSIFY_SYSTEM_PROMPT): ~450 tokens (Chinese + JSON schema)
 *   - "/no_think" prefix + user prompt wrapper:  ~50 tokens
 *   - maxTokens for response:                    512 tokens
 *   ──────────────────────────────────────────────────────
 *   Total ≈ 1 012 tokens → round up to 1 024 for safety.
 */
const OVERHEAD_TOKENS = 1024

/**
 * Context tiers — pick the smallest that fits system + document + response.
 * Each entry: [maxDocChars, contextSize].
 * Chinese text ≈ 1 token/char (conservative); budget = contextSize − overhead.
 *
 *  contextSize  budget(chars)   user's doc range
 *  ─────────    ─────────────   ────────────────
 *  2 048        1 024           ≤ 1 024 chars
 *  4 096        3 072           > 1 024 chars
 */
const CONTEXT_TIERS = [
  [2048 - OVERHEAD_TOKENS, 2048],
  [4096 - OVERHEAD_TOKENS, 4096]
]

/** Maximum context size (largest tier). */
export const MAX_CONTEXT_SIZE = 4096

/** Maximum characters for the document chunk (4096 − overhead). */
export const MAX_CHUNK_CHARS = MAX_CONTEXT_SIZE - OVERHEAD_TOKENS

/**
 * Pick the optimal context window for a given character length.
 * @param {number} charLen
 * @returns {number}
 */
export function pickContextSize(charLen) {
  for (const [maxChars, ctx] of CONTEXT_TIERS) {
    if (charLen <= maxChars) return ctx
  }
  return MAX_CONTEXT_SIZE
}

const CLASSIFY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          score: { type: 'number' },
          evidence: { type: 'array', items: { type: 'string' } }
        },
        required: ['name', 'score', 'evidence']
      }
    },
    final_labels: { type: 'array', items: { type: 'string' } }
  },
  required: ['labels', 'final_labels']
}

// ── Singletons ────────────────────────────────────────────────────────────────
/** @type {any} cached dynamic-import of node-llama-cpp */
let _nlc = null
let _llama = null
let _model = null
let _context = null
let _grammar = null
/** Currently loaded mode, so we know when to reload */
let _loadedMode = null
/** Context size of the currently allocated _context */
let _loadedCtxSize = 0

// ── Async mutex (serialize generate() calls so the single sequence slot is
//    never double-acquired before the previous one is disposed) ──────────────
let _inferenceChain = Promise.resolve()

/**
 * Lazily import node-llama-cpp using dynamic import().
 */
async function getNLC() {
  if (!_nlc) {
    _nlc = await import('node-llama-cpp')
  }
  return _nlc
}

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * @param {'fast'|'medium'|'high'} mode
 * @returns {string} Absolute path to the GGUF model file.
 */
export function getModelPath(mode = 'fast') {
  if (process.env.LLAMA_MODEL_PATH) return process.env.LLAMA_MODEL_PATH
  const filename = MODEL_MAP[mode] || MODEL_MAP.fast
  if (is.dev) {
    return join(app.getAppPath(), 'resources', 'models', filename)
  }
  return join(process.resourcesPath, 'models', filename)
}

// ── Initialisation ────────────────────────────────────────────────────────────

/**
 * Dispose current model/context if loaded.
 */
async function teardown() {
  if (_context) { try { await _context.dispose() } catch {} _context = null }
  if (_model) { try { await _model.dispose() } catch {} _model = null }
  _loadedMode = null
  _loadedCtxSize = 0
}

/**
 * Ensure model for `mode` is loaded and context is at least `ctxSize`.
 * If the mode changed or the requested context is larger, reload.
 * @param {'fast'|'medium'|'high'} mode
 * @param {number} ctxSize
 */
async function ensureReady(mode, ctxSize) {
  const needReloadModel = _loadedMode !== mode
  const needReloadCtx = ctxSize > _loadedCtxSize

  if (!needReloadModel && !needReloadCtx && _context) return

  if (needReloadModel) {
    await teardown()
  } else if (needReloadCtx && _context) {
    try { await _context.dispose() } catch {}
    _context = null
  }

  const modelPath = getModelPath(mode)
  if (!existsSync(modelPath)) {
    throw new Error(
      `LLM model not found.\n` +
        `Expected: "${modelPath}"\n` +
        `Place ${MODEL_MAP[mode] || MODEL_MAP.fast} inside resources/models/ or set the ` +
        `LLAMA_MODEL_PATH environment variable.`
    )
  }

  const { getLlama } = await getNLC()
  if (!_llama) _llama = await getLlama()

  if (!_model || needReloadModel) {
    let sizeMB = 'unknown'
    try { sizeMB = (statSync(modelPath).size / (1024 * 1024)).toFixed(1) } catch {}
    logger.info(`[LLM] Loading model mode="${mode}", path="${modelPath}", size=${sizeMB} MB`)
    _model = await _llama.loadModel({ modelPath })
    _loadedMode = mode
    logger.info(`[LLM] Model loaded successfully (mode="${mode}")`)
  }

  logger.info(`[LLM] Creating context mode="${mode}" contextSize=${ctxSize}`)
  _context = await _model.createContext({ contextSize: ctxSize, sequences: 1 })
  _loadedCtxSize = ctxSize

  if (!_grammar) {
    _grammar = await _llama.createGrammarForJsonSchema(CLASSIFY_JSON_SCHEMA)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Internal single-inference implementation.
 * Must only be called while holding the mutex (_inferenceChain).
 * @param {string} prompt
 * @param {{ system?: string, temperature?: number, mode?: string, contextSize?: number }} opts
 */
async function _doGenerate(prompt, opts) {
  const mode = opts.mode || 'fast'
  const ctxSize = opts.contextSize || pickContextSize(prompt.length)

  await ensureReady(mode, ctxSize)

  const { LlamaChatSession } = await getNLC()

  const systemPrompt = `/no_think\n\n${opts.system ?? ''}`.trim()

  const sequence = _context.getSequence()
  try {
    const session = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt,
      autoDisposeSequence: false
    })

    const t0 = Date.now()
    const out = await session.prompt(prompt, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.1,
      maxTokens: 512,
      grammar: _grammar
    })
    const dur = Date.now() - t0
    const preview = String(out).replace(/\s+/g, ' ').slice(0, 240)
    logger.info(`[LLM] generate done mode="${mode}" ctx=${ctxSize} ${dur}ms outLen=${out.length} preview="${preview}"`)
    return out
  } finally {
    try { await sequence.dispose() } catch {}
  }
}

/**
 * Run a single classification inference.
 * Calls are serialized via an async mutex so the single context sequence
 * slot is never double-acquired (prevents "No sequences left" errors).
 *
 * @param {string} prompt
 * @param {{ system?: string, temperature?: number, mode?: string, contextSize?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function generate(prompt, opts = {}) {
  let resolveSlot, rejectSlot
  const slot = new Promise((res, rej) => { resolveSlot = res; rejectSlot = rej })

  _inferenceChain = _inferenceChain
    .then(() => _doGenerate(prompt, opts))
    .then(resolveSlot, rejectSlot)

  return slot
}

/**
 * Release all resources (call on app quit if desired).
 */
export async function dispose() {
  await teardown()
  if (_llama) { await _llama.dispose(); _llama = null }
  _grammar = null
  _nlc = null
}
