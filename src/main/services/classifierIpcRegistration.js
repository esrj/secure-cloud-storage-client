import { ipcMain } from 'electron'
import {
  setAppClassifierEnabled,
  getUploadBatchSmartClassifyWanted,
  setUploadBatchSmartClassifyWanted
} from './classifierRuntime.js'

let done = false

/** Call once from main (e.g. FileManager constructor). Exposes renderer → main classifier master switch. */
export function registerClassifierIpcOnce() {
  if (done) return
  done = true
  ipcMain.handle('classifier:set-enabled', (_, enabled) => {
    setAppClassifierEnabled(Boolean(enabled))
    return { ok: true }
  })
  ipcMain.handle('classifier:set-upload-batch-smart-classify', (_, wanted) => {
    setUploadBatchSmartClassifyWanted(Boolean(wanted))
    return { ok: true }
  })
  ipcMain.handle('classifier:get-upload-batch-smart-classify', () => ({
    wanted: getUploadBatchSmartClassifyWanted()
  }))
}
