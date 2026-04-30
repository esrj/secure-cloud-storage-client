/** Local (renderer) preferences — master syncs via classifierSetEnabled IPC; upload-before syncs via classifier:set-upload-batch-smart-classify. */

const LS_MASTER = 'scs.smartClassify.featureEnabled'
/** 檔案列表「上傳時執行智慧分類」模式（與 main 同步） */
const LS_UPLOAD_MODE = 'scs.uploadBatchSmartClassifyMode'

/** @type {readonly ['off','fast','medium']} */
export const SMART_CLASSIFY_MODES = /** @type {const} */ (['off', 'fast', 'medium'])

export function readSmartClassifyMasterEnabled() {
  try {
    return localStorage.getItem(LS_MASTER) === '1'
  } catch {
    return false
  }
}

/**
 * @param {boolean} v
 */
export function writeSmartClassifyMasterEnabled(v) {
  try {
    if (v) localStorage.setItem(LS_MASTER, '1')
    else localStorage.removeItem(LS_MASTER)
    window.dispatchEvent(new CustomEvent('scs-smart-classify-prefs-changed'))
  } catch {
    /* ignore */
  }
}

/** @returns {'off'|'fast'|'medium'} */
export function readSmartClassifyMode() {
  try {
    const v = localStorage.getItem(LS_UPLOAD_MODE)
    if (v && SMART_CLASSIFY_MODES.includes(v)) return v
  } catch { /* ignore */ }
  return 'off'
}

/** @param {'off'|'fast'|'medium'} mode */
export function writeSmartClassifyMode(mode) {
  try {
    localStorage.setItem(LS_UPLOAD_MODE, mode)
    window.dispatchEvent(new CustomEvent('scs-smart-classify-prefs-changed'))
  } catch { /* ignore */ }
}

/** Backwards-compatible: true when mode is not 'off'. */
export function readUploadSmartClassifyBeforeUpload() {
  return readSmartClassifyMode() !== 'off'
}

/** @param {boolean} v */
export function writeUploadSmartClassifyBeforeUpload(v) {
  writeSmartClassifyMode(v ? 'fast' : 'off')
}
