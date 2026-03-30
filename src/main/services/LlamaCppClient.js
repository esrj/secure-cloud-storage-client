/**
 * Local LLM inference via node-llama-cpp (main process only).
 *
 * node-llama-cpp is an ESM module with top-level await; it cannot be
 * require()-d from a CommonJS bundle.  All imports are therefore deferred to
 * runtime via dynamic import() which is compatible with ESM from any context.
 *
 * Model path resolution (highest priority first):
 *   1. LLAMA_MODEL_PATH environment variable
 *   2. <projectRoot>/resources/models/Qwen3-14B-Q4_K_M.gguf  (dev)
 *   3. <resourcesPath>/models/Qwen3-14B-Q4_K_M.gguf           (production)
 *
 * Singletons: llama instance, model, context and JSON grammar are created
 * once on the first call to generate() and reused for every subsequent chunk.
 * A fresh LlamaChatSession is created per call so each inference starts from
 * a clean state without reloading the model.
 *
 * Qwen3 "/no_think": prepending this to the system prompt disables the
 * model's <think>…</think> chain-of-thought prefix and forces a direct JSON
 * reply.  The JSON-schema grammar constraint provides a second safety net.
 */
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const MODEL_FILENAME = 'Qwen3-14B-Q4_K_M.gguf'

/**
 * Context window size.
 * KV cache for Qwen3-14B Q4_K_M (GQA 8 heads, 40 layers, 128 head-dim):
 *   2 048 tokens × 160 KB/token = ~0.32 GB  ← 目前開發用，M2 16 GB 安全
 *   8 192 tokens × 160 KB/token = ~1.31 GB  ← 上線時請改回此值（品質較佳）
 *
 * TODO: 上線前請將 CONTEXT_SIZE 從 2048 改回 8192，並同步調整
 *       ClassifyService.js 的 CHUNK_CHAR_LIMIT 從 2000 改回 8000。
 */
const CONTEXT_SIZE = 2048

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

// ── Async mutex (serialize generate() calls so the single sequence slot is
//    never double-acquired before the previous one is disposed) ──────────────
let _inferenceChain = Promise.resolve()

/**
 * Lazily import node-llama-cpp using dynamic import().
 * This bypasses the CJS require() limitation for ESM modules with top-level await.
 */
async function getNLC() {
  if (!_nlc) {
    _nlc = await import('node-llama-cpp')
  }
  return _nlc
}

// ── Path resolution ───────────────────────────────────────────────────────────

/**
 * @returns {string} Absolute path to the GGUF model file.
 */
export function getModelPath() {
  if (process.env.LLAMA_MODEL_PATH) return process.env.LLAMA_MODEL_PATH
  if (is.dev) {
    return join(app.getAppPath(), 'resources', 'models', MODEL_FILENAME)
  }
  return join(process.resourcesPath, 'models', MODEL_FILENAME)
}

// ── Initialisation ────────────────────────────────────────────────────────────

/**
 * Lazily initialise everything.  Subsequent calls are no-ops.
 * @throws {Error} if the model file is missing.
 */
async function ensureReady() {
  if (_context) return

  const modelPath = getModelPath()
  if (!existsSync(modelPath)) {
    throw new Error(
      `LLM model not found.\n` +
        `Expected: "${modelPath}"\n` +
        `Place Qwen3-14B-Q4_K_M.gguf inside resources/models/ or set the ` +
        `LLAMA_MODEL_PATH environment variable.`
    )
  }

  const { getLlama } = await getNLC()
  _llama = await getLlama()
  _model = await _llama.loadModel({ modelPath })
  _context = await _model.createContext({ contextSize: CONTEXT_SIZE, sequences: 1 })
  _grammar = await _llama.createGrammarForJsonSchema(CLASSIFY_JSON_SCHEMA)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a single classification inference.
 *
 * @param {string} prompt   User-visible prompt (document chunk + task header).
 * @param {{ system?: string, temperature?: number }} [opts]
 * @returns {Promise<string>} Raw JSON text from the model.
 */
/**
 * Internal single-inference implementation.
 * Must only be called while holding the mutex (_inferenceChain).
 */
async function _doGenerate(prompt, opts) {
  await ensureReady()

  const { LlamaChatSession } = await getNLC()

  // "/no_think" disables Qwen3's chain-of-thought so the model replies in JSON.
  const systemPrompt = `/no_think\n\n${opts.system ?? ''}`.trim()

  const sequence = _context.getSequence()
  try {
    const session = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt,
      autoDisposeSequence: false // we dispose explicitly in finally
    })

    return await session.prompt(prompt, {
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.1,
      maxTokens: 1024,
      grammar: _grammar
    })
  } finally {
    // Always release the sequence so the next call can acquire it.
    try { await sequence.dispose() } catch {}
  }
}

/**
 * Run a single classification inference.
 * Calls are serialized via an async mutex so the single context sequence
 * slot is never double-acquired (prevents "No sequences left" errors).
 *
 * @param {string} prompt
 * @param {{ system?: string, temperature?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function generate(prompt, opts = {}) {
  // Queue this call after the current in-flight inference completes.
  // Each link in the chain forwards both success and error so the queue
  // never stalls on a failed inference.
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
  if (_context) { await _context.dispose(); _context = null }
  if (_model) { await _model.dispose(); _model = null }
  if (_llama) { await _llama.dispose(); _llama = null }
  _grammar = null
  _nlc = null
}
