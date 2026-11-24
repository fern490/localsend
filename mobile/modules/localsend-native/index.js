import { requireOptionalNativeModule } from 'expo'

/**
 * Puente JS del módulo nativo. En Expo Go (o iOS) el módulo no existe:
 * `Native` queda en null y la app sigue funcionando sin descubrimiento UDP
 * (se puede conectar escribiendo la IP de la PC).
 */
const Native = requireOptionalNativeModule('LocalsendNative')

export const isNativeAvailable = !!Native

export const Udp = {
  start: (port) => (Native ? Native.udpStart(port) : Promise.reject(new Error('UDP no disponible (¿Expo Go?)'))),
  send: (message, host, port) => (Native ? Native.udpSend(message, host, port) : false),
  stop: () => Native?.udpStop(),
  onMessage: (cb) => Native?.addListener('onUdpMessage', cb) ?? { remove() {} },
  onError: (cb) => Native?.addListener('onUdpError', cb) ?? { remove() {} },
  broadcastAddresses: () => (Native ? Native.getBroadcastAddresses() : []),
  localIp: () => (Native ? Native.getLocalIp() : null)
}

export const ForegroundService = {
  start: (title, text) => {
    try {
      Native?.startTransferService(title, text)
    } catch (e) {
      console.warn('No se pudo iniciar el foreground service', e)
    }
  },
  update: (title, text, progress) => {
    try {
      Native?.updateTransferService(title, text, Math.round(progress))
    } catch {
      /* nada */
    }
  },
  stop: () => {
    try {
      Native?.stopTransferService()
    } catch {
      /* nada */
    }
  }
}
