"use strict";
const electron = require("electron");
const preload = require("@electron-toolkit/preload");
const api = {};
if (process.contextIsolated) {
  try {
    electron.contextBridge.exposeInMainWorld("electron", preload.electronAPI);
    electron.contextBridge.exposeInMainWorld("api", api);
    electron.contextBridge.exposeInMainWorld("electronAPI", {
      // Corresponds to main/index.js
      // In renderer, the functions should be called as window.electronAPI.askLogin()
      // In main process, the functions should be called as GlobalValueManager.mainWindow?.webContents.send('', )
      askLogin: () => electron.ipcRenderer.invoke("login"),
      askRegister: (registerInfo) => electron.ipcRenderer.invoke("register", registerInfo),
      changeCurFolder: (curFolderId) => electron.ipcRenderer.send("change-cur-folder", curFolderId),
      onFileListRes: (callback) => electron.ipcRenderer.on("file-list-res", (_event, result) => callback(result)),
      onRequestListRes: (callback) => electron.ipcRenderer.on("request-list-res", (_event, result) => callback(result)),
      onRequestedListRes: (callback) => electron.ipcRenderer.on("requested-list-res", (_event, result) => callback(result)),
      onLog: (callback) => electron.ipcRenderer.on("log", (_event, result) => callback(result)),
      onNotice: (callback) => electron.ipcRenderer.on("notice", (_event, result, level) => callback(result, level)),
      askUploadFile: (curPath) => electron.ipcRenderer.send("upload", curPath),
      askDownloadFile: (uuid) => electron.ipcRenderer.send("download", uuid),
      askDownloadFileWithOptions: (opts) => electron.ipcRenderer.send("download-with-options", opts),
      askDeleteFile: (uuid) => electron.ipcRenderer.send("delete", uuid),
      askAddFolder: (curPath, folderName) => electron.ipcRenderer.send("add-folder", curPath, folderName),
      askDeleteFolder: (folderId) => electron.ipcRenderer.send("delete-folder", folderId),
      askAllFolder: () => electron.ipcRenderer.invoke("get-folders"),
      askMoveFile: (uuid, targetFolderId) => electron.ipcRenderer.send("move-file", uuid, targetFolderId),
      // Search
      askAllPublicFile: () => electron.ipcRenderer.invoke("get-public-files"),
      askSearchFiles: (values) => electron.ipcRenderer.invoke("search-files", values),
      onSearchFiles: (callback) => electron.ipcRenderer.on("partial-search-files", (_event, result) => callback(result)),
      // UI info
      onUserConfig: (callback) => electron.ipcRenderer.on("user-info", (_event, result) => callback(result)),
      onLoginStatus: (callback) => electron.ipcRenderer.on("login-status", (_event, result) => callback(result)),
      onRequestValue: (callback) => electron.ipcRenderer.on("request-value", (_event, result) => callback(result)),
      onUserList: (callback) => electron.ipcRenderer.on("user-list", (_event, result) => callback(result)),
      onGlobalAttrs: (callback) => electron.ipcRenderer.on("global-attrs", (_event, result) => callback(result)),
      updateUserConfig: (config) => electron.ipcRenderer.send("update-user-config", config),
      updateRequestValue: (values) => electron.ipcRenderer.send("update-request-value", values),
      updateUserList: (users) => electron.ipcRenderer.send("update-user-list", users),
      updateFileDescPerm: (values) => electron.ipcRenderer.send("update-file-desc-perm", values),
      // Post-upload batch settings
      onUploadBatchDone: (callback) => electron.ipcRenderer.on("upload-batch-done", (_event, result) => callback(result)),
      askBatchUpdateFileDescPerm: (values) => electron.ipcRenderer.invoke("batch-update-file-desc-perm", values),
      // Requests
      askRequestFile: (requestInfo) => electron.ipcRenderer.send("request-file", requestInfo),
      askRequestList: () => electron.ipcRenderer.send("get-request-list"),
      askRequestedList: () => electron.ipcRenderer.send("get-requested-list"),
      askDeleteRequest: (requestId) => electron.ipcRenderer.send("delete-request", requestId),
      askRespondRequest: (responseInfo) => electron.ipcRenderer.send("respond-request", responseInfo),
      // Secret Sharing
      askShareSecret: (values) => electron.ipcRenderer.invoke("share-secret", values),
      askRecoverSecret: (values) => electron.ipcRenderer.invoke("recover-secret", values),
      sendEmailAuth: (values) => electron.ipcRenderer.invoke("email-auth", values),
      sendRecoverExtraKey: (values) => electron.ipcRenderer.invoke("recover-extra-key", values)
    });
  } catch (error) {
    console.error(error);
  }
} else {
  window.electron = preload.electronAPI;
  window.api = api;
}
