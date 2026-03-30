/** Local (renderer) preferences — master syncs via classifierSetEnabled IPC; upload-before syncs via classifier:set-upload-batch-smart-classify. */

const LS_MASTER = 'scs.smartClassify.featureEnabled'
/** 檔案列表「上傳時執行智慧分類」開關（與 main 同步） */
const LS_UPLOAD_BEFORE = 'scs.uploadBatchSmartClassifyBeforeUpload'

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

export function readUploadSmartClassifyBeforeUpload() {
  try {
    return localStorage.getItem(LS_UPLOAD_BEFORE) === '1'
  } catch {
    return false
  }
}

/**
 * @param {boolean} v
 */
export function writeUploadSmartClassifyBeforeUpload(v) {
  try {
    if (v) localStorage.setItem(LS_UPLOAD_BEFORE, '1')
    else localStorage.removeItem(LS_UPLOAD_BEFORE)
    window.dispatchEvent(new CustomEvent('scs-smart-classify-prefs-changed'))
  } catch {
    /* ignore */
  }
}
