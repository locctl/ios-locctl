const { app, BrowserWindow, Menu, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const http = require('http')

// macOS needs an application menu for cmd+A / cmd+C / cmd+V / cmd+X / undo /
// redo to reach inputs — without it the standard text-editing shortcuts go
// nowhere. Keep it minimal: the in-window controls cover File/View/Window
// territory, we only need the App + Edit menus.
Menu.setApplicationMenu(Menu.buildFromTemplate([
  {
    label: 'ios-locctl',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
    ],
  },
]))

let mainWindow
let backendProc = null
let backendReady = false
let backendStartupError = null

function resolveBackendExe() {
  // In a packaged build, extraResources places files under process.resourcesPath
  // (e.g.  .../resources/backend/ios-locctl-backend).  In dev, we don't spawn;
  // the developer runs `python main.py` manually.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', 'ios-locctl-backend')
  }
  return null
}

function resolveAskpass() {
  if (!app.isPackaged) return null
  return path.join(process.resourcesPath, 'askpass.sh')
}

// dmg copy can drop the executable bit on bundled .sh files. Restore it
// once on first run so `sudo -A askpass` doesn't fail with EACCES.
function ensureExecutable(p) {
  if (!p) return
  try {
    fs.chmodSync(p, 0o755)
  } catch (e) {
    console.warn('[electron] chmod failed for', p, e.message)
  }
}

function startBackend() {
  const exe = resolveBackendExe()
  if (!exe) return
  const askpass = resolveAskpass()
  ensureExecutable(askpass)
  ensureExecutable(exe)

  console.log('[electron] spawning backend:', exe)
  console.log('[electron] askpass:', askpass)

  // Pipe through env so the bundled backend's _resolve_sidecar_command()
  // (see packages/backend/core/device_manager.py) finds askpass via SUDO_ASKPASS
  // without having to know about Electron's resourcesPath.
  const env = { ...process.env }
  if (askpass) env.SUDO_ASKPASS = askpass
  // Backend uses this to locate USAGE.md and other bundled resources without
  // having to know about Electron's process.resourcesPath layout.
  env.IOSLOCCTL_RESOURCES_PATH = process.resourcesPath

  backendProc = spawn(exe, [], {
    cwd: path.dirname(exe),
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  backendProc.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  backendProc.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  backendProc.on('exit', (code, signal) => {
    console.log('[electron] backend exited code=', code, 'signal=', signal)
    backendProc = null
    if (!backendReady && code !== 0 && code !== null) {
      backendStartupError = `backend exited with code ${code}`
    }
  })
  backendProc.on('error', (err) => {
    console.error('[electron] backend spawn error:', err)
    backendStartupError = err.message
  })
}

async function stopBackend() {
  if (!backendProc) return
  const proc = backendProc
  backendProc = null
  try {
    proc.kill('SIGTERM')
  } catch {}
  // Give it 5s to clean up, then SIGKILL
  await new Promise((resolve) => {
    const killer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      resolve()
    }, 5000)
    proc.on('exit', () => { clearTimeout(killer); resolve() })
  })
}

function pingBackendOnce(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8777/docs', { timeout: timeoutMs }, (res) => {
      res.destroy()
      resolve(res.statusCode >= 200 && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

async function waitForBackend(timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await pingBackendOnce()) {
      backendReady = true
      return true
    }
    if (backendStartupError) return false
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function showBackendFailureDialog() {
  const logFolder = path.join(os.homedir(), '.ios-locctl', 'logs')
  const result = await dialog.showMessageBox(mainWindow || null, {
    type: 'error',
    title: 'ios-locctl 啟動失敗',
    message: '無法啟動後端服務',
    detail:
      backendStartupError
        ? `錯誤: ${backendStartupError}\n\nLog 路徑:\n${logFolder}`
        : `Backend 在 30 秒內沒有回應。\n\nLog 路徑:\n${logFolder}\n\n` +
          '常見原因:\n' +
          '• Port 8777 已被其他程式佔用\n' +
          '• Backend binary 缺少權限或被系統 quarantine\n' +
          '   → 在 Terminal 執行: xattr -cr /Applications/ios-locctl.app',
    buttons: ['打開 Log 資料夾', '退出'],
    defaultId: 0,
    cancelId: 1,
  })
  if (result.response === 0) {
    try { fs.mkdirSync(logFolder, { recursive: true }) } catch {}
    shell.openPath(logFolder)
  }
}

async function createWindow() {
  // OSM tile policy (https://operations.osmfoundation.org/policies/tiles/)
  // requires an identifying User-Agent; Electron's default Chrome UA is
  // blocked with HTTP 418. Rewrite the UA on requests to the OSM tile
  // endpoints so we can use the 'Standard' (Mapnik) style for free.
  try {
    const { session } = require('electron')
    const OSM_HOSTS = [
      'tile.openstreetmap.org',
      'a.tile.openstreetmap.org',
      'b.tile.openstreetmap.org',
      'c.tile.openstreetmap.org',
      'tile.openstreetmap.fr',
      'a.tile.openstreetmap.fr',
      'b.tile.openstreetmap.fr',
      'c.tile.openstreetmap.fr',
    ]
    session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
      try {
        const u = new URL(details.url)
        if (OSM_HOSTS.includes(u.hostname)) {
          details.requestHeaders['User-Agent'] =
            'ios-locctl/1.0.0 (+https://github.com/locctl/ios-locctl)'
          details.requestHeaders['Referer'] = 'https://github.com/locctl/ios-locctl'
        }
      } catch {}
      cb({ requestHeaders: details.requestHeaders })
    })
  } catch (e) { console.error('[electron] UA hook failed:', e) }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ios-locctl',
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  mainWindow.once('ready-to-show', () => { mainWindow.show() })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  const isDev = process.argv.includes('--dev') || !app.isPackaged
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    startBackend()
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))

    // Watch for backend startup; show error dialog if it never comes up.
    // Run in parallel to loadFile so the UI paints immediately.
    waitForBackend(30000).then((ok) => {
      if (!ok) showBackendFailureDialog()
    })
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', async () => {
  await stopBackend()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', async (e) => {
  if (backendProc) {
    e.preventDefault()
    await stopBackend()
    app.quit()
  }
})
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
