"use strict";
const electron = require("electron");
const preload = require("@electron-toolkit/preload");
function mergeClassifierApisIntoElectronApi(electronApi) {
  electronApi.classifierSetEnabled = (enabled) => electron.ipcRenderer.invoke("classifier:set-enabled", enabled);
  electronApi.subscribeClassifierLlmProgress = (cb) => {
    if (typeof cb !== "function") return () => {
    };
    const fn = (_, p) => cb(p);
    electron.ipcRenderer.on("classifier-llm-progress", fn);
    return () => electron.ipcRenderer.removeListener("classifier-llm-progress", fn);
  };
  electronApi.classifyDocuments = (input) => electron.ipcRenderer.invoke("classify-documents", input);
  electronApi.preuploadClassifyGetSnapshot = (batchKey) => electron.ipcRenderer.invoke("preupload-classify-snapshot", batchKey);
  electronApi.startUploadFromFileList = (folderId) => electron.ipcRenderer.invoke("file-manager:start-upload", folderId);
  electronApi.requestFileList = (folderId) => electron.ipcRenderer.invoke("file-manager:refresh-list", folderId);
  electronApi.onFileListRes = (cb) => {
    if (typeof cb !== "function") return () => {
    };
    const fn = (_, p) => cb(p);
    electron.ipcRenderer.on("file-list-res", fn);
    return () => electron.ipcRenderer.removeListener("file-list-res", fn);
  };
  electronApi.setUploadBatchSmartClassify = (wanted) => electron.ipcRenderer.invoke("classifier:set-upload-batch-smart-classify", wanted);
  electronApi.getUploadBatchSmartClassify = () => electron.ipcRenderer.invoke("classifier:get-upload-batch-smart-classify");
  electronApi.askBatchUpdateFileDescPerm = (payload) => electron.ipcRenderer.invoke("ask-batch-update-file-desc-perm", payload);
  electronApi.onUploadBatchDone = (cb) => {
    if (typeof cb !== "function") return () => {
    };
    const fn = (_, p) => cb(p);
    electron.ipcRenderer.on("upload-batch-done", fn);
    return () => electron.ipcRenderer.removeListener("upload-batch-done", fn);
  };
  electronApi.onPreuploadClassifyStatus = (cb) => {
    if (typeof cb !== "function") return () => {
    };
    const fn = (_, p) => cb(p);
    electron.ipcRenderer.on("preupload-classify-status", fn);
    return () => electron.ipcRenderer.removeListener("preupload-classify-status", fn);
  };
  return electronApi;
}
function mergeAgentApisIntoElectronApi(electronApi) {
  electronApi.agentQuery = (payload) => electron.ipcRenderer.invoke("agent:query", payload);
  return electronApi;
}
const api = {};
if (process.contextIsolated) {
  try {
    electron.contextBridge.exposeInMainWorld("electron", preload.electronAPI);
    electron.contextBridge.exposeInMainWorld("api", api);
    const electronAPIObj = {
      // Auth
      askLogin: () => electron.ipcRenderer.invoke("login"),
      askRegister: (registerInfo) => electron.ipcRenderer.invoke("register", registerInfo),
      // File list / folder navigation
      changeCurFolder: (curFolderId) => electron.ipcRenderer.send("change-cur-folder", curFolderId),
      onFileListRes: (callback) => electron.ipcRenderer.on("file-list-res", (_event, result) => callback(result)),
      // Requests
      onRequestListRes: (callback) => electron.ipcRenderer.on("request-list-res", (_event, result) => callback(result)),
      onRequestedListRes: (callback) => electron.ipcRenderer.on("requested-list-res", (_event, result) => callback(result)),
      // Logging / notices
      onLog: (callback) => electron.ipcRenderer.on("log", (_event, result) => callback(result)),
      onNotice: (callback) => electron.ipcRenderer.on("notice", (_event, result, level) => callback(result, level)),
      // Upload / download / delete
      askUploadFile: (curPath) => electron.ipcRenderer.send("upload", curPath),
      askDownloadFile: (uuid) => electron.ipcRenderer.send("download", uuid),
      askDownloadFileWithOptions: (opts) => electron.ipcRenderer.send("download-with-options", opts),
      // Batch download
      askPickDownloadFolder: (defaultPath) => electron.ipcRenderer.invoke("pick-download-folder", defaultPath),
      askDownloadBatchWithOptions: (opts) => electron.ipcRenderer.invoke("download-batch-with-options", opts),
      cancelDownloadBatch: (batchId) => electron.ipcRenderer.send("download-batch-cancel", batchId),
      onBatchDownloadProgress: (cb) => {
        const handler = (_e, payload) => cb(payload);
        electron.ipcRenderer.on("batch-download-progress", handler);
        return () => electron.ipcRenderer.removeListener("batch-download-progress", handler);
      },
      showItemInFolder: (path) => electron.ipcRenderer.send("show-item-in-folder", path),
      askDeleteFile: (uuid) => electron.ipcRenderer.send("delete", uuid),
      // Folders
      askAddFolder: (curPath, folderName) => electron.ipcRenderer.send("add-folder", curPath, folderName),
      askDeleteFolder: (folderId) => electron.ipcRenderer.send("delete-folder", folderId),
      askAllFolder: () => electron.ipcRenderer.invoke("get-folders"),
      askMoveFile: (uuid, targetFolderId) => electron.ipcRenderer.send("move-file", uuid, targetFolderId),
      // Watermark forensic trace
      askDecodeWatermarkUid: (value) => electron.ipcRenderer.invoke("decode-watermark-uid", value),
      // Public files / search
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
      // Post-upload batch settings (legacy channel kept for compatibility)
      onUploadBatchDone: (callback) => electron.ipcRenderer.on("upload-batch-done", (_event, result) => callback(result)),
      askBatchUpdateFileDescPerm: (values) => electron.ipcRenderer.invoke("batch-update-file-desc-perm", values),
      // File-level request/reply
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
    };
    mergeClassifierApisIntoElectronApi(electronAPIObj);
    mergeAgentApisIntoElectronApi(electronAPIObj);
    electron.contextBridge.exposeInMainWorld("electronAPI", electronAPIObj);
  } catch (error) {
    console.error(error);
  }
} else {
  window.electron = preload.electronAPI;
  window.api = api;
}
