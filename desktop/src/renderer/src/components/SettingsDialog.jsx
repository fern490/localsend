import { useState } from 'react'

export default function SettingsDialog({ settings, onSave, onChooseFolder, onClose }) {
  const [alias, setAlias] = useState(settings.alias)
  const [deviceType, setDeviceType] = useState(settings.deviceType)
  const [showIp, setShowIp] = useState(settings.showIp)

  const save = async (e) => {
    e.preventDefault()
    await onSave({ alias, deviceType, showIp })
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal settings" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h3>Configuración</h3>

        <label>
          Nombre del dispositivo
          <input value={alias} maxLength={40} onChange={(e) => setAlias(e.target.value)} />
        </label>

        <label>
          Tipo de equipo (icono que ven los demás)
          <select value={deviceType} onChange={(e) => setDeviceType(e.target.value)}>
            <option value="desktop">PC de escritorio</option>
            <option value="laptop">Laptop</option>
          </select>
        </label>

        <label>
          Carpeta de descargas
          <div className="row">
            <input value={settings.downloadDir} readOnly />
            <button type="button" className="btn small" onClick={onChooseFolder}>
              Cambiar…
            </button>
          </div>
        </label>

        <label className="check">
          <input type="checkbox" checked={showIp} onChange={(e) => setShowIp(e.target.checked)} />
          Mostrar direcciones IP (usuarios avanzados)
        </label>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary">Guardar</button>
        </div>
      </form>
    </div>
  )
}
