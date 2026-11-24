/**
 * Copia del protocolo de desktop/src/main/core/protocol.js.
 * Ver ese archivo para la lista completa de mensajes.
 */
export const APP_TAG = 'localsend-clase'
export const PROTOCOL_VERSION = 1
export const UDP_PORT = 53317
export const WS_PORT = 53318
export const WS_PATH = '/ws'
export const BROADCAST_ADDR = '255.255.255.255'
export const ANNOUNCE_INTERVAL_MS = 2000
export const DEVICE_TTL_MS = 6000

// En el celular usamos chunks más chicos que en la PC (64 KB vs 256 KB):
// cada chunk cruza de JS a nativo, y trozos grandes trabarían la UI.
export const MOBILE_CHUNK_SIZE = 64 * 1024
export const MOBILE_WINDOW = 2 * 1024 * 1024 // máx. sin confirmar
export const ACK_EVERY = 512 * 1024
export const ACCEPT_TIMEOUT_MS = 60_000
export const ACK_TIMEOUT_MS = 15_000
export const HEARTBEAT_MS = 5000
export const PEER_DEAD_MS = 15_000
