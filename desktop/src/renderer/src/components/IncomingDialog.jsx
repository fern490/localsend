import { useState } from 'react'
import { formatBytes } from '../format.js'
import { DeviceIcon } from './Icons.jsx'

const OPTIONS = [
  ['rename', 'Mantener ambos'],
  ['replace', 'Reemplazar'],
  ['skip', 'Omitir']
]

/**
 * Diálogo de aceptación. Si algún archivo ya existe en la carpeta de
 * destino, se ofrece Reemplazar / Mantener ambos (renombrar) / Omitir.
 */
export default function IncomingDialog({ request, downloadDir, onRespond }) {
  const conflicts = request.files.filter((f) => f.conflict)
  const [decisions, setDecisions] = useState(() => Object.fromEntries(conflicts.map((f) => [f.fileId, 'rename'])))
  const total = request.files.reduce((a, f) => a + f.size, 0)

  const setAll = (value) => setDecisions(Object.fromEntries(conflicts.map((f) => [f.fileId, value])))

  return (
    <div className="modal-backdrop">
      <div className="modal incoming" role="dialog" aria-modal="true">
        <div className="incoming-head">
          <span className={`device-icon big ${request.peerType}`}>
            <DeviceIcon type={request.peerType} />
          </span>
          <div>
            <h3>{request.peerAlias} quiere enviarte</h3>
            <p>
              {request.files.length} archivo{request.files.length === 1 ? '' : 's'} · {formatBytes(total)}
            </p>
          </div>
        </div>

        <ul className="incoming-files">
          {request.files.map((f) => (
            <li key={f.fileId} className={f.conflict ? 'conflict' : ''}>
              <div className="file-line">
                <span className="name">{f.name}</span>
                <span className="size">{formatBytes(f.size)}</span>
              </div>
              {f.resumeFrom > 0 && (
                <small className="hint ok">Se reanudará desde {formatBytes(f.resumeFrom)} (intento anterior)</small>
              )}
              {f.conflict && (
                <div className="conflict-row">
                  <small>Ya existe en la carpeta:</small>
                  <div className="segmented">
                    {OPTIONS.map(([value, label]) => (
                      <button
                        key={value}
                        className={decisions[f.fileId] === value ? 'active' : ''}
                        onClick={() => setDecisions((d) => ({ ...d, [f.fileId]: value }))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>

        {conflicts.length > 1 && (
          <div className="apply-all">
            <small>Aplicar a todos los repetidos:</small>
            {OPTIONS.map(([value, label]) => (
              <button key={value} className="link" onClick={() => setAll(value)}>
                {label}
              </button>
            ))}
          </div>
        )}

        <p className="dest">
          Se guardará en <code>{downloadDir}</code>
        </p>

        <div className="modal-actions">
          <button className="btn ghost" onClick={() => onRespond(request.id, false)}>
            Rechazar
          </button>
          <button className="btn primary" onClick={() => onRespond(request.id, true, decisions)}>
            Aceptar
          </button>
        </div>
      </div>
    </div>
  )
}
