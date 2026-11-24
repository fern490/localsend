/** EventEmitter mínimo (React Native no trae el módulo `events` de Node). */
export class Emitter {
  constructor() {
    this._handlers = {}
  }
  on(event, fn) {
    ;(this._handlers[event] ||= new Set()).add(fn)
    return () => this.off(event, fn)
  }
  once(event, fn) {
    const off = this.on(event, (...args) => {
      off()
      fn(...args)
    })
    return off
  }
  off(event, fn) {
    this._handlers[event]?.delete(fn)
  }
  emit(event, ...args) {
    for (const fn of [...(this._handlers[event] || [])]) fn(...args)
  }
}

export function uuid() {
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${hex()}-${hex()}${hex()}${hex()}`
}
