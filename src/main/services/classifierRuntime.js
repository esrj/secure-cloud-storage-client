/**
 * Main-process runtime state for the smart-classify feature.
 *
 * appClassifierEnabled defaults to true — the per-upload toggle
 * (uploadBatchSmartClassifyWanted) is the only user-facing gate.
 * Set to false via IPC if you add a global master switch.
 */

let appClassifierEnabled = true

/**
 * Next upload batch: whether to run LM (set from the file-list toggle before upload).
 */
let uploadBatchSmartClassifyWanted = false

export function setAppClassifierEnabled(v) {
  appClassifierEnabled = Boolean(v)
}

export function getAppClassifierEnabled() {
  return appClassifierEnabled
}

export function setUploadBatchSmartClassifyWanted(v) {
  uploadBatchSmartClassifyWanted = Boolean(v)
}

export function getUploadBatchSmartClassifyWanted() {
  return uploadBatchSmartClassifyWanted
}
