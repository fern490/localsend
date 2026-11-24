import { useEffect, useMemo, useRef, useState } from 'react'
import DevicePanel from './components/DevicePanel.jsx'
import TransferCard from './components/TransferCard.jsx'
import IncomingDialog from './components/IncomingDialog.jsx'
import SettingsDialog from './components/SettingsDialog.jsx'
import { UploadIcon, FileIcon, GearIcon } from './components/Icons.jsx'
import { formatBytes } from './format.js'

/**
 * RENDERER: sólo vista. Todo lo que pasa en red/disco se pide a través de
 * window.api (definido en preload/index.js). Acá no hay `fs` ni sockets.
 */
const api = window.api

export default function App() {
  const [settings, setSettings] = useState(null)
  const [status, setStatus] = useState({ udp: false, tcp: false, ips: [] })
  const [devices, setDevices] = useState([])
  const [transfers, setTransfers] = useState({})
  const [selectedId, setSelectedId] = useState(null)
  const [files, setFiles] = useState([]) // [{ path, name, size }]
  const [dragging, setDragging] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [toast, setToast] = useState(null)
  const dragDepth = useRef(0)

  // Estado inicial + suscripción a eventos del proceso Main.
  useEffect(() => {
    api.getState().then((s) => {
      setSettings(s.settings)
      setStatus(s.status)
      setDevices(s.devices)
      setTransfers(Object.fromEntries(s.transfers.map((t) => [t.id, t])))
    })
    const offs = [
      api.on('devices', setDevices),
      api.on('status', setStatus),
      api.on('transfer', (t) => setTransfers((prev) => ({ ...prev, [t.id]: t })))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // Si el dispositivo elegido desaparece de la red, lo deseleccionamos.
  useEffect(() => {
    if (selectedId && !devices.some((d) => d.id === selectedId)) setSelectedId(null)
  }, [devices, selectedId])

  const notify = (text, kind = 'info') => {
    setToast({ text, kind })
    setTimeout(() => setToast(null), 4000)
  }

  /* ─────────────── Zona de Drag & Drop (toda la ventana) ─────────────── */
  // Usamos un contador porque dragenter/dragleave se disparan también al
  // pasar por los elementos hijos; sin esto el efecto "parpadea".
  useEffect(() => {
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
    const onEnter = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current++
      setDragging(true)
    }
    const onOver = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e) => {
      if (!hasFiles(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const onDrop = (e) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const dropped = [...(e.dataTransfer?.files || [])].map((f) => ({
        path: api.getPathForFile(f),
        name: f.name,
        size: f.size
      }))
      addFiles(dropped)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const addFiles = (list) => {
    const valid = list.filter((f) => f.path)
    if (valid.length) {
      setFiles((prev) => {
        const known = new Set(prev.map((f) => f.path))
        return [...prev, ...valid.filter((f) => !known.has(f.path))]
      })
    }
  }

  const chooseFiles = async () => {
    const paths = await api.chooseFiles()
    addFiles(paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop(), size: null })))
  }

  const send = async () => {
    if (!selectedId || files.length === 0) return
    try {
      await api.sendFiles(
        selectedId,
        files.map((f) => f.path)
      )
      setFiles([])
    } catch (err) {
      notify(err.message, 'error')
    }
  }

  const respond = (id, accepted, decisions) => api.respond(id, accepted, decisions).catch((e) => notify(e.message, 'error'))
  const retry = (id) => api.retry(id).catch((e) => notify(e.message, 'error'))
  const cancel = (id) => api.cancel(id).catch((e) => notify(e.message, 'error'))

  const list = useMemo(() => Object.values(transfers).reverse(), [transfers])
  const pendingIncoming = list.find((t) => t.direction === 'in' && t.status === 'pending')
  const visible = list.filter((t) => t.status !== 'pending')
  const selected = devices.find((d) => d.id === selectedId)
  const online = status.udp && status.tcp
  const totalSize = files.reduce((a, f) => a + (f.size || 0), 0)

  if (!settings) return <div className="loading">Iniciando…</div>

  return (
    <div className={`app ${dragging ? 'is-dragging' : ''}`}>
      <header className="topbar">
        <div className="status" title={online ? 'Recibiendo conexiones' : status.udpError || status.tcpError || 'Servidor detenido'}>
          <span className={`led ${online ? 'on' : 'off'}`} />
          <div>
            <strong>{online ? 'Disponible' : 'No disponible'}</strong>
            <small>
              UDP {status.udp ? '✓' : '✗'} · TCP {status.tcp ? '✓' : '✗'}
              {settings.showIp && status.ips?.length > 0 && ` · ${status.ips.join(', ')}:${status.port}`}
            </small>
          </div>
        </div>
        <div className="me">
          <span>
            Sos <b>{settings.alias}</b>
          </span>
          <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Configuración">
            <GearIcon />
          </button>
        </div>
      </header>

      <main className="layout">
        <DevicePanel
          devices={devices}
          selectedId={selectedId}
          onSelect={setSelectedId}
          showIp={settings.showIp}
          onConnectIp={(ip) => api.connectIp(ip)}
        />

        <section className="center">
          <div className={`dropzone ${dragging ? 'hover' : ''} ${files.length ? 'has-files' : ''}`}>
            {files.length === 0 ? (
              <>
                <UploadIcon />
                <h2>Arrastrá archivos acá</h2>
                <p>o</p>
                <button className="btn" onClick={chooseFiles}>
                  Elegir archivos
                </button>
              </>
            ) : (
              <div className="selection">
                <div className="selection-head">
                  <strong>
                    {files.length} archivo{files.length === 1 ? '' : 's'} {totalSize > 0 && `· ${formatBytes(totalSize)}`}
                  </strong>
                  <div>
                    <button className="link" onClick={chooseFiles}>
                      Agregar
                    </button>
                    <button className="link" onClick={() => setFiles([])}>
                      Limpiar
                    </button>
                  </div>
                </div>
                <ul className="file-list">
                  {files.map((f) => (
                    <li key={f.path}>
                      <FileIcon />
                      <span className="name">{f.name}</span>
                      {f.size != null && <span className="size">{formatBytes(f.size)}</span>}
                      <button className="link" onClick={() => setFiles((prev) => prev.filter((x) => x.path !== f.path))}>
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="send-row">
                  {selected ? (
                    <button className="btn primary big" onClick={send}>
                      Enviar a {selected.alias}
                    </button>
                  ) : (
                    <p className="hint">Elegí un dispositivo de la lista para enviar</p>
                  )}
                </div>
              </div>
            )}
            <div className="drop-overlay">
              <UploadIcon />
              <h2>Soltá para agregar</h2>
            </div>
          </div>

          <div className="transfers">
            <div className="panel-title">
              <h2>Transferencias</h2>
              <div>
                <button className="link" onClick={() => api.openDownloads()}>
                  Abrir carpeta de descargas
                </button>
                {visible.length > 0 && (
                  <button
                    className="link"
                    onClick={async () => {
                      const remaining = await api.clearFinished()
                      setTransfers(Object.fromEntries(remaining.map((t) => [t.id, t])))
                    }}
                  >
                    Limpiar terminadas
                  </button>
                )}
              </div>
            </div>
            {visible.length === 0 ? (
              <p className="empty">Todavía no hay transferencias.</p>
            ) : (
              visible.map((t) => <TransferCard key={t.id} t={t} onCancel={cancel} onRetry={retry} onShow={(p) => api.showItem(p)} />)
            )}
          </div>
        </section>
      </main>

      {pendingIncoming && (
        <IncomingDialog key={pendingIncoming.id} request={pendingIncoming} downloadDir={settings.downloadDir} onRespond={respond} />
      )}

      {showSettings && (
        <SettingsDialog
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={async (patch) => setSettings(await api.setSettings(patch))}
          onChooseFolder={async () => setSettings(await api.chooseDownloadFolder())}
        />
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  )
}
