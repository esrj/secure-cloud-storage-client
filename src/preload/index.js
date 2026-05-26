import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { mergeClassifierApisIntoElectronApi } from './classifierPreloadMerge.js'
import { mergeAgentApisIntoElectronApi } from './agentPreloadMerge.js'

const api = {}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)

    const electronAPIObj = {
      // Auth
      askLogin: () => ipcRenderer.invoke('login'),
      askRegister: (registerInfo) => ipcRenderer.invoke('register', registerInfo),
      // File list / folder navigation
      changeCurFolder: (curFolderId) => ipcRenderer.send('change-cur-folder', curFolderId),
      onFileListRes: (callback) =>
        ipcRenderer.on('file-list-res', (_event, result) => callback(result)),
      // Requests
      onRequestListRes: (callback) =>
        ipcRenderer.on('request-list-res', (_event, result) => callback(result)),
      onRequestedListRes: (callback) =>
        ipcRenderer.on('requested-list-res', (_event, result) => callback(result)),
      // Logging / notices
      onLog: (callback) => ipcRenderer.on('log', (_event, result) => callback(result)),
      onNotice: (callback) =>
        ipcRenderer.on('notice', (_event, result, level) => callback(result, level)),
      // Upload / download / delete
      askUploadFile: (curPath) => ipcRenderer.send('upload', curPath),
      askDownloadFile: (uuid) => ipcRenderer.send('download', uuid),
      askDownloadFileWithOptions: (opts) => ipcRenderer.send('download-with-options', opts),
      // Batch download
      askPickDownloadFolder: (defaultPath) =>
        ipcRenderer.invoke('pick-download-folder', defaultPath),
      askDownloadBatchWithOptions: (opts) =>
        ipcRenderer.invoke('download-batch-with-options', opts),
      cancelDownloadBatch: (batchId) => ipcRenderer.send('download-batch-cancel', batchId),
      onBatchDownloadProgress: (cb) => {
        const handler = (_e, payload) => cb(payload)
        ipcRenderer.on('batch-download-progress', handler)
        return () => ipcRenderer.removeListener('batch-download-progress', handler)
      },
      showItemInFolder: (path) => ipcRenderer.send('show-item-in-folder', path),
      askDeleteFile: (uuid) => ipcRenderer.send('delete', uuid),
      // Folders
      askAddFolder: (curPath, folderName) => ipcRenderer.send('add-folder', curPath, folderName),
      askDeleteFolder: (folderId) => ipcRenderer.send('delete-folder', folderId),
      askAllFolder: () => ipcRenderer.invoke('get-folders'),
      askMoveFile: (uuid, targetFolderId) => ipcRenderer.send('move-file', uuid, targetFolderId),
      // Watermark forensic trace
      askDecodeWatermarkUid: (value) => ipcRenderer.invoke('decode-watermark-uid', value),
      // Public files / search
      askAllPublicFile: () => ipcRenderer.invoke('get-public-files'),
      askSearchFiles: (values) => ipcRenderer.invoke('search-files', values),
      onSearchFiles: (callback) =>
        ipcRenderer.on('partial-search-files', (_event, result) => callback(result)),
      // UI info
      onUserConfig: (callback) => ipcRenderer.on('user-info', (_event, result) => callback(result)),
      onLoginStatus: (callback) =>
        ipcRenderer.on('login-status', (_event, result) => callback(result)),
      onRequestValue: (callback) =>
        ipcRenderer.on('request-value', (_event, result) => callback(result)),
      onUserList: (callback) => ipcRenderer.on('user-list', (_event, result) => callback(result)),
      onGlobalAttrs: (callback) =>
        ipcRenderer.on('global-attrs', (_event, result) => callback(result)),
      updateUserConfig: (config) => ipcRenderer.send('update-user-config', config),
      updateRequestValue: (values) => ipcRenderer.send('update-request-value', values),
      updateUserList: (users) => ipcRenderer.send('update-user-list', users),
      updateFileDescPerm: (values) => ipcRenderer.send('update-file-desc-perm', values),
      // Post-upload batch settings (legacy channel kept for compatibility)
      onUploadBatchDone: (callback) =>
        ipcRenderer.on('upload-batch-done', (_event, result) => callback(result)),
      askBatchUpdateFileDescPerm: (values) =>
        ipcRenderer.invoke('batch-update-file-desc-perm', values),
      // File-level request/reply
      askRequestFile: (requestInfo) => ipcRenderer.send('request-file', requestInfo),
      askRequestList: () => ipcRenderer.send('get-request-list'),
      askRequestedList: () => ipcRenderer.send('get-requested-list'),
      askDeleteRequest: (requestId) => ipcRenderer.send('delete-request', requestId),
      askRespondRequest: (responseInfo) => ipcRenderer.send('respond-request', responseInfo),
      // Secret Sharing
      askShareSecret: (values) => ipcRenderer.invoke('share-secret', values),
      askRecoverSecret: (values) => ipcRenderer.invoke('recover-secret', values),
      sendEmailAuth: (values) => ipcRenderer.invoke('email-auth', values),
      sendRecoverExtraKey: (values) => ipcRenderer.invoke('recover-extra-key', values)
    }

    // Merge smart-classify APIs:
    //   classifyDocuments, preuploadClassifyGetSnapshot, startUploadFromFileList,
    //   requestFileList, onFileListRes (returns unsub), setUploadBatchSmartClassify,
    //   getUploadBatchSmartClassify, askBatchUpdateFileDescPerm (overrides legacy),
    //   onUploadBatchDone (overrides to return unsub), onPreuploadClassifyStatus,
    //   subscribeClassifierLlmProgress, classifierSetEnabled
    mergeClassifierApisIntoElectronApi(electronAPIObj)
    // Merges: agentQuery
    mergeAgentApisIntoElectronApi(electronAPIObj)

    contextBridge.exposeInMainWorld('electronAPI', electronAPIObj)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
