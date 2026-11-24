# Protocolo

Las dos apps hablan el mismo protocolo. Las constantes están en `desktop/src/main/core/protocol.js` y en su copia `mobile/src/net/protocol.js`.

## 1. Descubrimiento (UDP 53317)

Cada dispositivo escucha en **UDP 53317** y cada **2 s** manda un *beacon* a `255.255.255.255` y al broadcast de su subred (ej. `192.168.1.255`):

```json
{ "app": "localsend-clase", "version": 1, "type": "announce",
  "id": "8f2c…", "alias": "Naranja Alegre", "deviceType": "desktop", "port": 53318 }
```

- Quien recibe un `announce` contesta directo (*unicast*) con `type: "reply"`, así el otro lo ve sin esperar al próximo beacon.
- **TTL:** si un dispositivo no manda nada por **6 s**, se borra de la lista. Por eso la lista se actualiza sola cuando alguien apaga el Wi-Fi.
- `port: 0` significa "no tengo servidor" (el celular). Para mandarle algo, la PC le envía `type: "connect-request"` por UDP y el celular abre la conexión WebSocket hacia la PC.
- La IP se toma del **paquete** (`rinfo.address`), no del JSON.

## 2. Conexión (TCP 53318, WebSocket en `/ws`)

```
Celular / PC A                                   PC B (servidor)
     │──── TCP + upgrade WebSocket ───────────────────▶│
     │──── hello {id, alias, deviceType, maxChunk, window} ─▶│
     │◀─── hello {…} ──────────────────────────────────│
     │◀──▶ ping (cada 5 s; si pasan 15 s sin nada, se cierra)
```

- **Frames de texto:** JSON de control.
- **Frames binarios:** trozos (*chunks*) del archivo en curso.

## 3. Transferencia

```
Emisor                                              Receptor
  │── offer {transferId, files:[{fileId,name,size,mime}]} ─▶│  (metadatos)
  │                                                    │  el usuario decide
  │◀─ accept {files:{id:{action:'write'|'skip', offset}}} ──│  (o reject)
  │── file-start {fileId, offset} ────────────────────▶│
  │══ chunk binario ═══════════════════════════════════▶│  escribe en .part
  │══ chunk binario ═══════════════════════════════════▶│
  │◀─ ack {received}  (cada 1 MB escrito en disco) ─────│
  │   …                                                │
  │── file-end {size} ────────────────────────────────▶│  verifica tamaño
  │◀─ file-ok {size}  (o file-error) ───────────────────│  renombra .part
  │── done ───────────────────────────────────────────▶│
```

### Control de flujo

El emisor no puede tener más de `window` bytes enviados sin confirmar (8 MB en la PC, 2 MB en el celular). El receptor confirma (`ack`) **recién cuando los bytes están escritos en disco**.

Si el disco o el Wi-Fi del receptor son lentos, el emisor espera. La memoria queda acotada aunque el archivo pese 10 GB.

### Tamaño de chunk

El emisor usa `min(su chunk, maxChunk del receptor)`: 256 KB entre PCs y **64 KB cuando participa el celular**.

### Reanudación

Si se corta la conexión, el receptor guarda el `.part` y anota `(emisorId, nombre, tamaño)`. Cuando el emisor reintenta, el `accept` trae `offset` = bytes ya guardados, y el emisor arranca a leer desde ahí (`createReadStream({start})` en la PC, `handle.offset` en el celular).

### Colisiones (PC)

Si el nombre ya existe, el usuario elige **Mantener ambos** (`foto (1).jpg`), **Reemplazar** u **Omitir** (se manda `action: 'skip'` y el emisor saltea ese archivo).
