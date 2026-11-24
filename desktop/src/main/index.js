import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { LocalSendNode } from './core/node.js'
import { createSettings } from './settings.js'
import { notifyIncoming, notifySimple, formatBytes } from './notifications.js'

/**
 * PROCESO MAIN
 * Es el único que toca la red (UDP/TCP) y el disco (fs). La ventana
 * (Renderer, React) no tiene acceso a Node: le habla a este proceso sólo
 * a través de los canales IPC que expone preload/index.js.
 */

const PROTOCOL = 'localsend-clase'
const APP_ID = 'com.clase.localsend'

// Una sola instancia: si se abre otra (por ejemplo desde un botón de la
// notificación de Windows) le pasa sus argumentos a esta y se cierra.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main()
}

function main() {
  let win = null
  let settings
  let node

  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

  // Registro del protocolo localsend-clase:// (botones de la notificación).
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }

  const send = (channel, data) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, data)
  }

  const showWindow = () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  /** Acepta con la opción segura para colisiones: "Mantener ambos". */
  const acceptFromNotification = (id) => {
    const t = node.transfers.get(id)
    if (!t || t.status !== 'pending') return
    const decisions = {}
    for (const f of t.files) if (f.conflict) decisions[f.fileId] = 'rename'
    node.respond(id, true, decisions)
  }

  const handleProtocolUrl = (url) => {
    const m = /^localsend-clase:\/\/(accept|reject|open)\/([\w-]+)/.exec(url || '')
    if (!m) return
    const [, action, id] = m
    if (action === 'accept') acceptFromNotification(id)
    else if (action === 'reject') node.respond(id, false)
    else showWindow()
  }

  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`))
    if (url) handleProtocolUrl(url)
    else showWindow()
  })
  app.on('open-url', (e, url) => {
    e.preventDefault()
    handleProtocolUrl(url)
  })

  function createWindow() {
    win = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 820,
      minHeight: 560,
      show: false,
      title: 'LocalSend Clase',
      backgroundColor: '#0f1115',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        // Seguridad estricta: el Renderer NO puede usar require/fs/net.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    win.on('ready-to-show', () => win.show())
    // Links externos fuera de la app.
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })
    // Que soltar un archivo NO navegue la ventana hacia el archivo.
    win.webContents.on('will-navigate', (e) => e.preventDefault())

    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      win.loadFile(path.join(__dirname, '../renderer/index.html'))
    }
    win.on('closed', () => (win = null))
  }

  app.whenReady().then(() => {
    settings = createSettings()
    node = new LocalSendNode({ getSettings: () => settings.get() })

    node.on('devices', (d) => send('devices', d))
    node.on('status', (s) => send('status', s))
    node.on('transfer', (t) => {
      send('transfer', t)
      // Aviso de fin si la ventana no está a la vista.
      if (t.direction === 'in' && t.status === 'done' && !win?.isFocused()) {
        const n = t.files.filter((f) => f.status === 'done').length
        notifySimple('Transferencia completa', `Recibiste ${n} archivo(s) de ${t.peerAlias} (${formatBytes(t.totalBytes)})`, () =>
          shell.openPath(settings.get().downloadDir)
        )
      }
    })
    node.on('incoming', (req) => {
      // Si la ventana no está enfocada => notificación nativa con botones.
      if (!win || !win.isFocused()) {
        notifyIncoming(req, {
          protocol: PROTOCOL,
          onAccept: () => acceptFromNotification(req.id),
          onReject: () => node.respond(req.id, false),
          onOpen: showWindow
        })
        win?.flashFrame(true)
      }
    })

    registerIpc()
    node.start()
    createWindow()

    // Si la app se abrió desde un botón de la notificación (Windows en frío).
    const url = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`))
    if (url) setTimeout(() => handleProtocolUrl(url), 1500)
  })

  app.on('window-all-closed', () => {
    node?.stop()
    app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  /**
   * Canales IPC. Cada handler devuelve { ok, data } o { ok:false, error }
   * para que la UI muestre mensajes claros en vez de excepciones crudas.
   */
  function registerIpc() {
    const handle = (channel, fn) =>
      ipcMain.handle(channel, async (_e, ...args) => {
        try {
          return { ok: true, data: await fn(...args) }
        } catch (err) {
          return { ok: false, error: err.message }
        }
      })

    handle('state:get', () => ({
      settings: settings.get(),
      status: node.getStatus(),
      devices: node.getDevices(),
      transfers: node.getTransfers()
    }))
    handle('settings:set', (patch) => {
      const s = settings.set(patch || {})
      node.discovery.announce() // que los demás vean el alias nuevo enseguida
      return s
    })
    handle('settings:choose-folder', async () => {
      const r = await dialog.showOpenDialog(win, {
        title: 'Carpeta de descargas',
        defaultPath: settings.get().downloadDir,
        properties: ['openDirectory', 'createDirectory']
      })
      if (r.canceled || !r.filePaths[0]) return settings.get()
      return settings.set({ downloadDir: r.filePaths[0] })
    })
    handle('files:choose', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Elegir archivos', properties: ['openFile', 'multiSelections'] })
      return r.canceled ? [] : r.filePaths
    })
    handle('files:send', (deviceId, paths) => {
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p))) {
        throw new Error('Rutas inválidas')
      }
      return node.sendFiles(String(deviceId), paths)
    })
    handle('transfer:respond', (id, accepted, decisions) => node.respond(String(id), !!accepted, decisions || {}))
    handle('transfer:cancel', (id) => node.cancel(String(id)))
    handle('transfer:retry', (id) => node.retry(String(id)))
    handle('transfer:clear', () => {
      node.clearFinished()
      return node.getTransfers()
    })
    handle('device:connect-ip', async (address) => {
      const [ip, port] = String(address).trim().split(':')
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('IP inválida (ej: 192.168.1.20)')
      const peer = await node.connectToAddress(ip, Number(port) || undefined)
      return peer.info
    })
    handle('shell:open-downloads', async () => {
      const dir = settings.get().downloadDir
      await fs.promises.mkdir(dir, { recursive: true })
      return shell.openPath(dir)
    })
    handle('shell:show-item', (p) => {
      // Sólo dejamos mostrar archivos dentro de la carpeta de descargas.
      const dir = path.resolve(settings.get().downloadDir)
      const target = path.resolve(String(p))
      if (!target.startsWith(dir)) throw new Error('Ruta no permitida')
      shell.showItemInFolder(target)
    })
  }
}
