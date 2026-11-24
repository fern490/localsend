import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * PUENTE SEGURO (pregunta C1 de la defensa)
 *
 * ¿Por qué no importamos `fs` directo en React?
 *  - El Renderer muestra contenido (nombres de archivo, alias que vienen
 *    de la red...). Si tuviera acceso a Node, un XSS o una dependencia
 *    comprometida podría leer/borrar cualquier archivo o abrir sockets.
 *  - Con contextIsolation + sandbox, el Renderer es una página web común.
 *  - contextBridge expone SÓLO estas funciones concretas: React puede pedir
 *    "enviá estos archivos", pero no puede hacer `fs.unlink('C:/...')`.
 *    Y del lado Main cada handler valida sus argumentos.
 */

// Desempaqueta { ok, data, error } y convierte errores en excepciones.
const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args)
  if (!res.ok) throw new Error(res.error)
  return res.data
}

const EVENTS = ['devices', 'status', 'transfer']

contextBridge.exposeInMainWorld('api', {
  getState: () => call('state:get'),
  setSettings: (patch) => call('settings:set', patch),
  chooseDownloadFolder: () => call('settings:choose-folder'),
  chooseFiles: () => call('files:choose'),
  // Electron 32+ ya no expone File.path: la ruta real se obtiene así.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  sendFiles: (deviceId, paths) => call('files:send', deviceId, paths),
  respond: (id, accepted, decisions) => call('transfer:respond', id, accepted, decisions),
  cancel: (id) => call('transfer:cancel', id),
  retry: (id) => call('transfer:retry', id),
  clearFinished: () => call('transfer:clear'),
  connectIp: (address) => call('device:connect-ip', address),
  openDownloads: () => call('shell:open-downloads'),
  showItem: (p) => call('shell:show-item', p),

  /** Suscripción a eventos del Main. Devuelve la función para desuscribirse. */
  on(channel, callback) {
    if (!EVENTS.includes(channel)) throw new Error(`Canal no permitido: ${channel}`)
    const listener = (_event, data) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})
