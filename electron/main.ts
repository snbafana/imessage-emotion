import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { openAppDatabase, type AppDatabase } from '../src/lib/db/schema'
import {
  startIMessageSync,
  type IMessageSyncController,
  type IMessageSyncStatus,
} from '../src/lib/sync/imessage-sync'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null
let db: AppDatabase | null = null
let imessageSync: IMessageSyncController | null = null
let lastSyncStatus: IMessageSyncStatus = {
  state: 'idle',
  cursor: 0,
  importedMessages: 0,
}

function startAppServices() {
  const dbPath = path.join(app.getPath('userData'), 'imessage-emotion.sqlite')
  db = openAppDatabase(dbPath)
  imessageSync = startIMessageSync(db, {
    onStatus(status) {
      lastSyncStatus = status
      win?.webContents.send('imessage-sync-status', status)
    },
  })
}

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

ipcMain.handle('imessage-sync-status', () => lastSyncStatus)
ipcMain.handle('imessage-sync-now', async () => imessageSync?.syncNow() ?? lastSyncStatus)

app.whenReady().then(() => {
  startAppServices()
  createWindow()
})

app.on('before-quit', () => {
  imessageSync?.stop()
  db?.close()
})
