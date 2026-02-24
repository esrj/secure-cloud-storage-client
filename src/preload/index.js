import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('electronAPI', {
      // Corresponds to main/index.js
      // In renderer, the functions should be called as window.electronAPI.askLogin()
      // In main process, the functions should be called as GlobalValueManager.mainWindow?.webContents.send('', )
      askLogin: () => ipcRenderer.invoke('login'),
      askRegister: (registerInfo) => ipcRenderer.invoke('register', registerInfo),
      changeCurFolder: (curFolderId) => ipcRenderer.send('change-cur-folder', curFolderId),
      onFileListRes: (callback) =>
        ipcRenderer.on('file-list-res', (_event, result) => callback(result)),
      onRequestListRes: (callback) =>
        ipcRenderer.on('request-list-res', (_event, result) => callback(result)),
      onRequestedListRes: (callback) =>
        ipcRenderer.on('requested-list-res', (_event, result) => callback(result)),
      onLog: (callback) => ipcRenderer.on('log', (_event, result) => callback(result)),
      onNotice: (callback) =>
        ipcRenderer.on('notice', (_event, result, level) => callback(result, level)),
      askUploadFile: (curPath) => ipcRenderer.send('upload', curPath),
      askDownloadFile: (uuid) => ipcRenderer.send('download', uuid),
      askDeleteFile: (uuid) => ipcRenderer.send('delete', uuid),
      askAddFolder: (curPath, folderName) => ipcRenderer.send('add-folder', curPath, folderName),
      askDeleteFolder: (folderId) => ipcRenderer.send('delete-folder', folderId),
      askAllFolder: () => ipcRenderer.invoke('get-folders'),
      askMoveFile: (uuid, targetFolderId) => ipcRenderer.send('move-file', uuid, targetFolderId),
      // Search
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
      // Requests
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
    })
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
