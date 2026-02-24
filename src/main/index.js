import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { sendMessage } from './MessageManager'
import LoginManager from './LoginManager'
import { logger } from './Logger'
import FileManager from './FileManager'
import RequestManager from './RequestManager'
import GlobalValueManager from './GlobalValueManager'
import AESModule from './AESModule'
import BlockchainManager from './BlockchainManager'
import KeyManager from './KeyManager'
import ABSEManager from './ABSEManager'
import DatabaseManager from './DatabaseManager'
import { unlinkSync } from 'node:fs'

// Initilize class instances
const keyManager = new KeyManager()
keyManager.initKeys()

const requestManager = new RequestManager(keyManager)
const aesModule = new AESModule(keyManager)
const blockchainManager = new BlockchainManager()
const abseManager = new ABSEManager(keyManager)
abseManager.init()
const databaseManager = new DatabaseManager(keyManager)
const fileManager = new FileManager(aesModule, blockchainManager, abseManager, databaseManager)
const loginManager = new LoginManager(
  blockchainManager,
  fileManager,
  keyManager,
  requestManager,
  databaseManager
)

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  GlobalValueManager.mainWindow = mainWindow
  mainWindow.setBackgroundColor('#fff')

  mainWindow.on('ready-to-show', async () => {
    mainWindow.show()
    let pp
    try {
      pp = await abseManager.getPP()
    } catch (error) {
      logger.error(error)
    }
    
    try {
      await loginManager.login()
      fileManager.getFileListProcess(null)
    } catch (error) {
      logger.error(error)
      GlobalValueManager.sendNotice(error.message, 'error')
    }
    GlobalValueManager.mainWindow?.webContents.send('request-value', {
      seenReplies: GlobalValueManager.requestConfig.seenReplies,
      seenRequests: GlobalValueManager.requestConfig.seenRequests
    })
    GlobalValueManager.mainWindow?.webContents.send('user-list', {
      whiteList: GlobalValueManager.userListConfig.whiteList,
      blackList: GlobalValueManager.userListConfig.blackList
    })
    GlobalValueManager.mainWindow?.webContents.send('global-attrs', {
      globalAttrs: pp ? pp.U.filter((attr) => attr != 'None') : []
    })
    // blockchainManager.printContractOwner().catch((error) => logger.error(error))
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.on('send-message', () => sendMessage('test message'))
  // ipcMain.on('get-keys', () =>
  //   getKeyEngine().then((result) => {
  //     logger.info('key is get in index.js')
  //     console.log(result.export(false))
  //   })
  // )

  // IPC methods. Should correspond to preload/index.js
  ipcMain.handle('login', async () => {
    return await loginManager.login()
  })
  ipcMain.handle('register', async (_event, registerInfo) => {
    return await loginManager.register(registerInfo)
  })
  ipcMain.on('upload', (_event, parentFolderId) => fileManager.uploadFileProcess(parentFolderId))
  ipcMain.on('change-cur-folder', (_event, curFolderId) => {
    GlobalValueManager.curFolderId = curFolderId
    if (GlobalValueManager.loggedIn) fileManager.getFileListProcess(curFolderId)
  })
  ipcMain.on('download', (_event, fileId) => fileManager.downloadFileProcess(fileId))
  ipcMain.on('delete', (_event, fileId) => fileManager.deleteFileProcess(fileId))
  ipcMain.on('add-folder', (_event, curPath, folderName) =>
    fileManager.addFolderProcess(curPath, folderName)
  )
  ipcMain.on('delete-folder', (_event, folderId) => fileManager.deleteFolderProcess(folderId))
  ipcMain.on('change-protocol', () => {
    if (process.env.FILE_PROTOCOL === 'https') {
      process.env.FILE_PROTOCOL = 'ftps'
    } else {
      process.env.FILE_PROTOCOL = 'https'
    }
    logger.info(`File protocol changed to ${process.env.FILE_PROTOCOL}`)
  })
  ipcMain.on('get-request-list', () => requestManager.getRequestListProcess())
  ipcMain.on('get-requested-list', () => requestManager.getRequestedListProcess())
  ipcMain.on('delete-request', (_event, uuid) => {
    requestManager.deleteRequestProcess(uuid)
  })
  ipcMain.on('request-file', (_event, requestInfo) => {
    requestManager.requestFileProcess(requestInfo)
  })
  ipcMain.on('respond-request', (_event, responseInfo) => {
    requestManager.respondRequestProcess(responseInfo)
  })
  ipcMain.handle('get-folders', async () => {
    return await fileManager.getAllFoldersProcess()
  })
  ipcMain.on('move-file', (_event, uuid, targetFolderId) =>
    fileManager.moveFileProcess(uuid, targetFolderId)
  )
  ipcMain.handle('get-public-files', async () => {
    return await fileManager.getAllPublicFilesProcess()
  })
  ipcMain.handle('search-files', async (_event, values) => {
    return await fileManager.searchFilesProcess(values)
  })
  ipcMain.on('update-user-config', (_event, config) => {
    GlobalValueManager.updateUser(config)
  })
  ipcMain.on('update-request-value', (_event, values) => {
    GlobalValueManager.updateRequest(values)
  })
  ipcMain.on('update-user-list', (_event, users) => {
    GlobalValueManager.updateUserList(users)
    requestManager.getRequestedListProcess()
  })
  ipcMain.on('update-file-desc-perm', (_event, values) => {
    fileManager.updateFileDescPermProcess(values)
  })
  // Secret sharing
  ipcMain.handle('share-secret', (_event, values) => {
    return loginManager.shareSecret(values)
  })
  ipcMain.handle('recover-secret', (_event, values) => {
    return loginManager.recoverSecret(values)
  })
  ipcMain.handle('email-auth', (_event, values) => {
    return loginManager.onEmailAuth(values)
  })
  ipcMain.handle('recover-extra-key', (_event, values) => {
    return loginManager.onRecoverExtraKey(values)
  })
  createWindow()
  // login()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', async () => {
  await databaseManager.encryptToServer()
  if (process.platform !== 'darwin') {
    app.quit()
  } else {
    databaseManager.init()
  }
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.

// app.on('will-quit', async (event) => {
//   // encrypt database and upload to server
//   console.log('app will quit.')
//   event.preventDefault()
//   await databaseManager.encryptToServer()
//   console.log('app going to quit')
//   app.exit(0)
// })

// TODO: might need to remove in production
app.commandLine.appendSwitch('ignore-certificate-errors')
app.commandLine.appendSwitch('allow-insecure-localhost', 'true')
