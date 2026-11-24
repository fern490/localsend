/**
 * Constantes del protocolo compartidas por todo el proceso Main.
 * La app móvil tiene una copia equivalente en mobile/src/net/protocol.js:
 * si cambiás algo acá, cambialo allá también.
 */

// Etiqueta que viaja en cada beacon UDP. Sirve para ignorar paquetes de
// otras aplicaciones que usen el mismo puerto (por ejemplo el LocalSend real).
export const APP_TAG = 'localsend-clase'
export const PROTOCOL_VERSION = 1

// Puerto UDP fijo donde TODOS los dispositivos escuchan beacons.
// Elegimos 53317 porque es el mismo que usa LocalSend y está por encima de
// 49151 (rango dinámico/privado), así que no choca con servicios del sistema.
export const UDP_PORT = 53317

// Puerto TCP del servidor HTTP + WebSocket (negociación y datos).
export const WS_PORT = 53318
export const WS_PATH = '/ws'

// 255.255.255.255 = "broadcast limitado": el router NO lo reenvía fuera de la
// red local, llega a todos los equipos del mismo segmento sin conocer sus IPs.
export const BROADCAST_ADDR = '255.255.255.255'

export const ANNOUNCE_INTERVAL_MS = 2000 // cada cuánto mandamos un beacon
export const DEVICE_TTL_MS = 6000 // sin beacons por 6 s => el dispositivo se va de la lista

// Transferencia
export const DESKTOP_CHUNK_SIZE = 256 * 1024 // trozos de 256 KB al leer del disco
export const DESKTOP_WINDOW = 8 * 1024 * 1024 // máx. bytes enviados sin confirmar (ack)
export const ACK_EVERY = 1024 * 1024 // el receptor confirma cada 1 MB escrito
export const ACCEPT_TIMEOUT_MS = 60_000 // tiempo que esperamos la decisión del usuario
export const ACK_TIMEOUT_MS = 15_000 // sin acks por 15 s => conexión muerta
export const HEARTBEAT_MS = 5000 // ping de aplicación
export const PEER_DEAD_MS = 15_000 // sin recibir nada por 15 s => cerramos el socket

/**
 * Mensajes de control (texto JSON) que viajan por el WebSocket:
 *
 *  hello      { id, alias, deviceType, maxChunk, window }     primer mensaje de cada lado
 *  ping       {}                                               latido
 *  offer      { transferId, files:[{fileId,name,size,mime}] }  emisor propone
 *  accept     { transferId, files:{ [fileId]: {action:'write'|'skip', offset} } }
 *  reject     { transferId, reason }
 *  file-start { transferId, fileId, offset }                   a continuación llegan chunks BINARIOS
 *  ack        { transferId, fileId, received }                 bytes ya escritos en disco
 *  file-end   { transferId, fileId, size }
 *  file-ok    { transferId, fileId, size }                     tamaño verificado
 *  file-error { transferId, fileId, reason }
 *  done       { transferId }
 *  cancel     { transferId, reason }
 *
 * Los chunks del archivo viajan como frames BINARIOS del WebSocket, nunca
 * como JSON/base64. Así el receptor los distingue sin parsear nada.
 */
