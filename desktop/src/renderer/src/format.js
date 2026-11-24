export function formatBytes(b = 0) {
  if (b < 1024) return `${b} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do {
    b /= 1024
    i++
  } while (b >= 1024 && i < units.length - 1)
  return `${b.toFixed(b < 10 ? 2 : b < 100 ? 1 : 0)} ${units[i]}`
}

export function formatSpeed(bps) {
  if (!bps) return '—'
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`
}

export function formatEta(seconds) {
  if (seconds == null || !isFinite(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${s % 60} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

export const STATUS_TEXT = {
  pending: 'Esperando tu respuesta',
  waiting: 'Esperando que el otro acepte…',
  transferring: 'Transfiriendo',
  done: 'Completado',
  rejected: 'Rechazado',
  cancelled: 'Cancelado',
  interrupted: 'Interrumpido',
  error: 'Error'
}
