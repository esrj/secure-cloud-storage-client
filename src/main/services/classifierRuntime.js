/**
 * Main-process runtime state for the smart-classify feature.
 *
 * appClassifierEnabled defaults to true — the per-upload mode selector
 * (uploadBatchSmartClassifyMode) is the only user-facing gate.
 * Set to false via IPC if you add a global master switch.
 */

/** @type {'off'|'fast'|'medium'} */
const VALID_MODES = ['off', 'fast', 'medium']

let appClassifierEnabled = true

/** @type {'off'|'fast'|'medium'} */
let uploadBatchSmartClassifyMode = 'off'

export function setAppClassifierEnabled(v) {
  appClassifierEnabled = Boolean(v)
}

export function getAppClassifierEnabled() {
  return appClassifierEnabled
}

/** @param {'off'|'fast'|'medium'|'high'|boolean} v */
export function setUploadBatchSmartClassifyWanted(v) {
  if (typeof v === 'boolean') {
    uploadBatchSmartClassifyMode = v ? 'fast' : 'off'
  } else if (v === 'high') {
    // 'high' (27B) 已停用，自動降級為 medium 以維持相容性
    uploadBatchSmartClassifyMode = 'medium'
  } else if (VALID_MODES.includes(v)) {
    uploadBatchSmartClassifyMode = v
  } else {
    uploadBatchSmartClassifyMode = 'off'
  }
}

export function getUploadBatchSmartClassifyWanted() {
  return uploadBatchSmartClassifyMode !== 'off'
}

/** @returns {'off'|'fast'|'medium'} */
export function getSmartClassifyMode() {
  return uploadBatchSmartClassifyMode
}
