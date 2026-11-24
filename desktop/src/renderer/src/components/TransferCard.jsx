import { formatBytes, formatSpeed, formatEta, STATUS_TEXT } from '../format.js'

/** Monitor de transferencia: barra real, velocidad y tiempo restante. */
export default function TransferCard({ t, onCancel, onRetry, onShow }) {
  const pct = t.totalBytes > 0 ? Math.min(100, (t.bytesDone / t.totalBytes) * 100) : t.status === 'done' ? 100 : 0
  const active = t.status === 'transferring'
  const arrow = t.direction === 'out' ? '↑ Enviando a' : '↓ Recibiendo de'
  const savedFiles = t.files.filter((f) => f.savedPath)
  const visibleFiles = t.files.filter((f) => f.status !== 'skipped')

  return (
    <div className={`transfer ${t.status}`}>
      <div className="transfer-head">
        <div>
          <strong>
            {arrow} {t.peerAlias || 'dispositivo'}
          </strong>
          <small>
            {visibleFiles.length} archivo{visibleFiles.length === 1 ? '' : 's'} · {formatBytes(t.totalBytes)}
            {t.currentFile && active && ` · ${t.currentFile}`}
          </small>
        </div>
        <span className={`badge ${t.status}`}>{STATUS_TEXT[t.status] || t.status}</span>
      </div>

      <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="bar" style={{ width: `${pct}%` }} />
      </div>

      <div className="transfer-stats">
        <span>
          <b>{pct.toFixed(1)}%</b> · {formatBytes(t.bytesDone)} de {formatBytes(t.totalBytes)}
        </span>
        {active && (
          <span>
            {formatSpeed(t.speed)} · quedan {formatEta(t.eta)}
          </span>
        )}
      </div>

      {t.status === 'done' && (
        <ul className="verified">
          {t.files
            .filter((f) => f.status === 'done')
            .map((f) => (
              <li key={f.fileId}>
                ✓ {f.name}: {f.size.toLocaleString('es-AR')} bytes verificados
              </li>
            ))}
        </ul>
      )}

      {t.error && <p className={`transfer-msg ${t.status}`}>{t.error}</p>}

      <div className="transfer-actions">
        {['transferring', 'waiting'].includes(t.status) && (
          <button className="btn ghost small" onClick={() => onCancel(t.id)}>
            Cancelar
          </button>
        )}
        {t.direction === 'out' && ['interrupted', 'error'].includes(t.status) && (
          <button className="btn small" onClick={() => onRetry(t.id)}>
            {t.resumable ? 'Reanudar' : 'Reintentar'}
          </button>
        )}
        {t.direction === 'in' && t.status === 'done' && savedFiles.length > 0 && (
          <button className="btn ghost small" onClick={() => onShow(savedFiles[0].savedPath)}>
            Mostrar en carpeta
          </button>
        )}
      </div>
    </div>
  )
}
