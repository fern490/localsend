import { useState } from 'react'
import { DeviceIcon } from './Icons.jsx'

/** Lista dinámica de nodos encontrados en la red. */
export default function DevicePanel({ devices, selectedId, onSelect, showIp, onConnectIp }) {
  const [ip, setIp] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const connect = async (e) => {
    e.preventDefault()
    if (!ip.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onConnectIp(ip.trim())
      setIp('')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="panel devices">
      <div className="panel-title">
        <h2>Dispositivos cercanos</h2>
        <span className="count">{devices.length}</span>
      </div>

      {devices.length === 0 ? (
        <div className="radar-empty">
          <div className="radar">
            <span />
            <span />
            <span />
          </div>
          <p>Buscando en la red local…</p>
          <small>Abrí la app en otro dispositivo conectado al mismo Wi-Fi.</small>
        </div>
      ) : (
        <ul className="device-list">
          {devices.map((d) => (
            <li key={d.id}>
              <button
                className={`device ${selectedId === d.id ? 'selected' : ''}`}
                onClick={() => onSelect(selectedId === d.id ? null : d.id)}
                title={`${d.alias} — ${d.ip}`}
              >
                <span className={`device-icon ${d.deviceType}`}>
                  <DeviceIcon type={d.deviceType} />
                </span>
                <span className="device-text">
                  <strong>{d.alias}</strong>
                  <small>
                    {d.deviceType === 'mobile' ? 'Celular' : d.deviceType === 'laptop' ? 'Laptop' : 'PC'}
                    {showIp && ` · ${d.ip}`}
                    {d.manual && ' · manual'}
                  </small>
                </span>
                {d.connected && <span className="dot-online" title="Conectado" />}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="manual-ip" onSubmit={connect}>
        <label htmlFor="ip">¿No aparece? Conectar por IP</label>
        <div className="row">
          <input id="ip" placeholder="192.168.1.20" value={ip} onChange={(e) => setIp(e.target.value)} disabled={busy} />
          <button className="btn small" disabled={busy}>
            {busy ? '…' : 'Conectar'}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </form>
    </aside>
  )
}
