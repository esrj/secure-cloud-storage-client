import { createHash } from 'node:crypto'
import { logger } from '../Logger.js'
import { classifyDocuments } from './ClassifyService.js'
import { getClassifierSettings } from './classifierSettings.js'

/** @typedef {{ state: 'running'|'done', result?: object, error?: string }} ClassifyEntry */

/** @type {Map<string, ClassifyEntry>} */
const cache = new Map()

/**
 * Stable id for this picker session (same paths set → same key for upload batch + LM cache).
 * @param {string[]} paths
 */
export function makeUploadBatchClassifyKey(paths) {
  const sorted = [...paths].filter((p) => typeof p === 'string' && p.trim()).sort()
  return createHash('sha256').update(sorted.join('\0'), 'utf8').digest('hex').slice(0, 32)
}

/**
 * @param {string} batchKey
 * @returns {ClassifyEntry | undefined}
 */
export function getPreUploadClassifyEntry(batchKey) {
  return cache.get(batchKey)
}

/**
 * @param {string} batchKey
 */
export function clearPreUploadClassifyEntry(batchKey) {
  cache.delete(batchKey)
}

/**
 * @param {(payload: object) => void} notify
 * @param {string} batchKey
 * @param {string[]} paths
 */
export async function runPreUploadClassification(notify, batchKey, paths) {
  cache.set(batchKey, { state: 'running' })
  notify({ batchKey, phase: 'running' })
  try {
    const { classifierThreshold } = getClassifierSettings()
    const result = await classifyDocuments({
      enable: true,
      paths,
      threshold: classifierThreshold,
      onProgress: (p) => notify({ batchKey, phase: 'running', progress: p })
    })
    cache.set(batchKey, { state: 'done', result })
    notify({ batchKey, phase: 'finished', result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.error(`[SmartClassify] Classification failed for batch ${batchKey}: ${msg}`, {
      stack: e instanceof Error ? e.stack : undefined
    })
    const errResult = {
      supported: false,
      reason: 'CLASSIFY_EXCEPTION',
      llmError: msg,
      labels: [],
      final_labels: []
    }
    cache.set(batchKey, { state: 'done', result: errResult })
    notify({ batchKey, phase: 'finished', result: errResult })
  }
}

/**
 * Build payload for upload-batch-done (renderer / PostUploadDialog).
 * @param {boolean} classifierWanted
 * @param {boolean} classifierEnabled
 * @param {string | null} batchKey
 */
export function snapshotForPostUploadDialog(classifierWanted, classifierEnabled, batchKey) {
  if (!classifierWanted) {
    return { classificationPreview: null, classifyBatchKey: null }
  }
  if (!classifierEnabled) {
    return {
      classificationPreview: {
        supported: false,
        reason: 'CLASSIFIER_DISABLED',
        labels: [],
        final_labels: []
      },
      classifyBatchKey: null
    }
  }
  if (!batchKey) {
    return {
      classificationPreview: { supported: false, reason: 'NO_CLASSIFY_KEY', labels: [], final_labels: [] },
      classifyBatchKey: null
    }
  }
  const entry = cache.get(batchKey)
  if (!entry || entry.state === 'running') {
    return {
      classificationPreview: { pending: true, batchKey },
      classifyBatchKey: batchKey
    }
  }
  return {
    classificationPreview: entry.result ?? { supported: false, reason: 'NO_RESULT', labels: [], final_labels: [] },
    classifyBatchKey: batchKey
  }
}
