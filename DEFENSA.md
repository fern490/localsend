# Guía para la defensa

Dónde está cada respuesta en el código. Los números de línea corresponden a esta versión; si editan los archivos, búsquenlos por el texto citado.

## Bloque A: Red y conectividad

### A1. "Muestren el socket UDP. ¿Qué IP usan para el broadcast y por qué ese puerto?"
- PC: `desktop/src/main/core/discovery.js:48`, `dgram.createSocket({ type: 'udp4', reuseAddr: true })`. En la línea 64, `setBroadcast(true)`: sin esto el sistema operativo rechaza enviar a una dirección broadcast.
- Celular: `mobile/modules/localsend-native/.../LocalsendNativeModule.kt:40` (`udpStart`), con `DatagramSocket`, `broadcast = true` y el **MulticastLock** (línea 158).
- **IP:** `255.255.255.255` (`protocol.js:23`), el *broadcast limitado*. Llega a todos los equipos del segmento sin conocer sus IPs y los routers no lo reenvían afuera. Además mandamos al broadcast de la subred (`192.168.x.255`), porque Windows con varias placas de red (VirtualBox, VPN) manda el limitado por una sola.
- **Puerto 53317** (`protocol.js:15`): es fijo para que todos sepan dónde escuchar. Es el mismo que usa LocalSend y está en el rango dinámico/privado (> 49151), así que no choca con servicios del sistema.

### A2. "¿Cómo diferencian un mensaje de metadatos (JSON) de un chunk binario?"
- `desktop/src/main/core/peer.js:35`: la librería `ws` entrega `isBinary`. **Frame de texto = JSON de control; frame binario = trozo de archivo.** Nunca mandamos datos como base64 dentro de JSON.
- Celular: `mobile/src/net/peer.js:29`, `typeof e.data !== 'string'` (con `binaryType = 'arraybuffer'`).

### A3. "¿Dónde se detiene el envío para esperar 'Aceptado'?"
- `desktop/src/main/core/transfers.js:148`: `await peer.waitFor(... 'accept' | 'reject' ...)`. Hasta que llega la respuesta **no se abre el archivo**. Hay un timeout de 60 s.
- Celular: `mobile/src/net/transfers.js:117`, la misma lógica.
- `waitFor` (en `peer.js`) es una promesa que se resuelve con el mensaje esperado o se rechaza si se cae la conexión.

## Bloque B: Sistema de archivos y memoria

### B1. "Si les pido 10 GB, ¿lo cargan en RAM?"
**No.** `desktop/src/main/core/transfers.js:217`: `for await (const chunk of fs.createReadStream(path, { highWaterMark: 256 KB }))`. Se pide el próximo trozo solo después de mandar el anterior, y en la línea 221 el emisor espera `ack` si hay más de 8 MB sin confirmar.

Celular: `mobile/src/net/transfers.js:174`, con `FileHandle` (`handle.offset` + `readBytes(64 KB)`).

**Prueba:** `npm test` en `desktop/` manda 400 MB entre dos nodos y el proceso no pasa de ~100 MB de RAM.

### B2. "¿Qué pasa si el archivo ya existe?"
- La UI pregunta por cada archivo: `desktop/src/renderer/src/components/IncomingDialog.jsx` (Mantener ambos, Reemplazar u Omitir).
- La lógica está en `desktop/src/main/core/fsutils.js:50` (`resolveTarget`) y en la línea 70 (`finalizePart`):
  - Mantener ambos → `foto (1).jpg`.
  - Reemplazar → se borra el viejo **recién cuando el nuevo llegó completo**.
  - Omitir → se avisa al emisor con `action: 'skip'`.
- Siempre se escribe en un `.part` y se renombra al final (`rename` es atómico), así nunca queda un archivo "a medias" con el nombre final.
- Escritura no bloqueante: `transfers.js:381`, `fs.createWriteStream`. Escribe en el *thread pool* de libuv y la UI no se congela.
- Rutas: `fsutils.js:16`, `sanitizeFileName`. Convierte `/storage/emulated/0/DCIM/x.jpg` en `x.jpg`, evita `../../` (path traversal) y quita caracteres prohibidos en Windows. Después todo se arma con `path.join`.

## Bloque C: Arquitectura

### C1. "Muestren `preload.js`. ¿Por qué `contextBridge` y no `fs` en React?"
- `desktop/src/preload/index.js:25`. En la ventana: `contextIsolation: true`, `nodeIntegration: false` y `sandbox: true` (`desktop/src/main/index.js:92`).
- **Por qué:** el Renderer muestra datos que vienen de la red (alias, nombres de archivo). Si tuviera `fs`, un XSS o una dependencia maliciosa podría leer o borrar cualquier archivo. Con el puente, React solo puede pedir acciones concretas ("enviá estos archivos") y el Main **valida** cada argumento. Por ejemplo, `shell:show-item` solo acepta rutas dentro de la carpeta de descargas.

### C2. "¿Cómo manejan el permiso si el usuario dice 'Rechazar' la primera vez?"
`mobile/src/services/permissions.js:17`. La promesa devuelve `{ granted, canAskAgain }`:
- Si rechazó una vez (`canAskAgain = true`), explicamos para qué sirve y ofrecemos volver a pedirlo.
- Si eligió "no volver a preguntar" (`canAskAgain = false`), Android ya no muestra el diálogo y ofrecemos **Abrir Ajustes** (`Linking.openSettings()`).
- La app nunca se rompe: el botón **Archivos** usa el selector del sistema (SAF), que no necesita ese permiso.

## Cierre: "Escenario de fallo" (desconectar la red a mitad)

1. **Detección:** si TCP no avisa (Wi-Fi caído "en silencio"), el *heartbeat* de `peer.js:65` cierra la conexión a los 15 s sin datos. Sin esto la barra quedaría cargando para siempre.
2. **Receptor** (`transfers.js:448`, `_lost`): cierra el stream, **conserva el `.part`** y muestra "Se guardó lo recibido: si el emisor reintenta, se reanuda".
3. **Emisor:** pasa a *Interrumpido* con el botón **Reanudar**. El celular conserva la selección de archivos.
4. **Al reintentar**, el receptor responde con `offset` y se envía solo lo que faltaba (probado: corta a ~150 MB y retoma desde ahí con SHA-256 idéntico).
5. **Qué mejoraríamos:**
   - Guardar los datos de reanudación en disco, porque hoy viven en memoria y se pierden si se cierra la app.
   - Agregar un hash (SHA-256) por archivo además del tamaño.
   - Reintento automático con *backoff* cuando vuelve la red.
   - Cifrado TLS (el LocalSend real usa HTTPS con certificados autofirmados).

## Rúbrica: dónde se ve cada punto

| Criterio | Qué mostrar |
|---|---|
| Integración | Radar en menos de 5 s, envío en ambos sentidos, "bytes verificados" en las dos apps |
| Dominio del código | Esta guía y los comentarios en cada archivo clave |
| UX/UI | LED, overlay de drag & drop, barra con MB/s y tiempo restante, haptics, modo oscuro/claro |
| Memoria | Streams + ventana de acks (B1) y resultado de `npm test` |
