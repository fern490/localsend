# LocalSend Clase: Sockets y FileSystem

Recreación de LocalSend: transferencia de archivos **P2P en red local, sin configuración**. Una app de escritorio (Electron + React) y una app Android (React Native con Expo) se descubren solas por **UDP broadcast** y se pasan archivos por **WebSocket sobre TCP**, leyendo y escribiendo con **streams** para no cargar nada entero en RAM.

## Estructura

```
localsend/
├── desktop/                 App de escritorio (Electron-Vite + React)
│   ├── src/main/            Proceso Main: red y disco
│   │   ├── core/            Núcleo P2P sin Electron (UDP, WS, streams) ← se puede testear
│   │   ├── index.js         Ventana, IPC, notificaciones nativas
│   │   └── settings.js      electron-store (alias, carpeta de descargas)
│   ├── src/preload/         Puente seguro (contextBridge)
│   ├── src/renderer/        Interfaz en React (sin acceso a Node)
│   └── test/                Prueba automática del núcleo de red
├── mobile/                  App Android (Expo, development build)
│   ├── modules/localsend-native/   Módulo nativo en Kotlin: UDP + Foreground Service
│   ├── src/net/             Descubrimiento, conexión y transferencias
│   ├── src/services/        Permisos y configuración
│   ├── src/ui/              Radar, tarjetas, hojas modales
│   └── test/                Prueba de integración contra el nodo de escritorio
├── binarios/                Acá van el .exe/.AppImage y el .apk
├── INSTRUCCIONES.md         Red, firewall, instalación y compilación
├── PROTOCOLO.md             Mensajes UDP y WebSocket
└── DEFENSA.md               Dónde está cada respuesta de la defensa
```

## Inicio rápido

```bash
# Escritorio
cd desktop && npm install && npm run dev

# Móvil (con Android Studio o EAS; ver INSTRUCCIONES.md)
cd mobile && npm install && npx expo install --fix && npx expo run:android
```

## Pruebas automáticas

`cd desktop && npm test` levanta dos nodos reales y verifica:

- Descubrimiento por broadcast y que el TTL quite al dispositivo apagado.
- Un archivo de **400 MB** que llega con SHA-256 idéntico usando **~100 MB de RAM**.
- Colisiones: mantener ambos, reemplazar y omitir.
- Rechazo y cancelación (se borra el temporal).
- Corte de conexión a mitad y **reanudación** desde el último byte.
- Saneado de rutas Android/Windows.

`mobile/test/` corre la lógica real del celular (con Expo simulado en Node) contra el nodo de la PC: descubrimiento mutuo en < 1 s, celular→PC, PC→celular de 200 MB, foreground service, corte y reanudación, y rechazo.
