import { Notification } from 'electron'

/**
 * Flujo de aceptación silencioso: notificación nativa con botones.
 *
 * - Windows: toast con XML propio. Cada botón abre una URL de protocolo
 *   (localsend-clase://accept/<id>). Windows lanza la app con esa URL, el
 *   "single instance lock" la redirige a la instancia abierta (evento
 *   'second-instance') y ahí aceptamos/rechazamos sin mostrar la ventana.
 * - macOS: botones nativos (evento 'action').
 * - Linux: Electron no soporta botones en libnotify; al tocar la
 *   notificación se abre la ventana con el diálogo de aceptación.
 */
const alive = new Set() // referencia fuerte: si el GC se lleva la notificación, se pierden los eventos

const esc = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])

export function notifyIncoming(req, { protocol, onAccept, onReject, onOpen }) {
  if (!Notification.isSupported()) return
  const count = req.files.length
  const total = req.files.reduce((a, f) => a + f.size, 0)
  const title = `${req.peerAlias} quiere enviarte ${count} archivo${count === 1 ? '' : 's'}`
  const names = req.files
    .slice(0, 3)
    .map((f) => f.name)
    .join(', ')
  const body = `${names}${count > 3 ? '…' : ''} (${formatBytes(total)})`

  let n
  if (process.platform === 'win32') {
    const toastXml = `
<toast launch="${protocol}://open/${req.id}" activationType="protocol">
  <visual><binding template="ToastGeneric">
    <text>${esc(title)}</text>
    <text>${esc(body)}</text>
  </binding></visual>
  <actions>
    <action content="Aceptar" activationType="protocol" arguments="${protocol}://accept/${req.id}"/>
    <action content="Rechazar" activationType="protocol" arguments="${protocol}://reject/${req.id}"/>
  </actions>
</toast>`
    n = new Notification({ toastXml })
  } else if (process.platform === 'darwin') {
    n = new Notification({
      title,
      body,
      actions: [
        { type: 'button', text: 'Aceptar' },
        { type: 'button', text: 'Rechazar' }
      ]
    })
    n.on('action', (_e, index) => (index === 0 ? onAccept() : onReject()))
  } else {
    n = new Notification({ title, body: `${body}\nTocá para responder`, urgency: 'critical' })
  }

  n.on('click', onOpen)
  n.on('close', () => alive.delete(n))
  alive.add(n)
  n.show()
  return n
}

export function notifySimple(title, body, onClick) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  if (onClick) n.on('click', onClick)
  n.on('close', () => alive.delete(n))
  alive.add(n)
  n.show()
}

export function formatBytes(b) {
  if (b < 1024) return `${b} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do {
    b /= 1024
    i++
  } while (b >= 1024 && i < u.length - 1)
  return `${b.toFixed(b < 10 ? 1 : 0)} ${u[i]}`
}
