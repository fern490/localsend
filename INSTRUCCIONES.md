# Instrucciones: red, instalación y compilación

## 1. Configurar la red (lo más importante)

Para que la PC y el celular se encuentren solos tienen que estar **en la misma red local** y el **firewall tiene que dejar pasar dos puertos**:

| Puerto | Protocolo | Para qué |
|---|---|---|
| **53317** | UDP | Descubrimiento (beacons broadcast) |
| **53318** | TCP | Servidor HTTP + WebSocket (negociación y datos) |

### Checklist

1. **Mismo Wi-Fi.** PC y celular conectados a la misma red, no a la red de "invitados".
2. **Sin datos móviles.** La app del celular se bloquea si no está en Wi-Fi, a propósito.
3. **Aislamiento de clientes.** Muchas redes de facultad o de bares no dejan que los dispositivos se vean entre sí (*AP/client isolation*). Si no se detectan, la solución más rápida es **activar el hotspot del celular y conectar la PC a ese hotspot**: es una red local sin aislamiento.
4. **Firewall de Windows.** La primera vez que abrís la app, Windows pregunta si permite el acceso. Tildá **"Redes privadas"** y aceptá. Si la red figura como **Pública**, cambiala a Privada (Configuración → Red e Internet → Wi-Fi → Propiedades → Perfil de red: *Privada*).
   También se puede hacer con PowerShell como administrador:
   ```powershell
   Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
   New-NetFirewallRule -DisplayName "LocalSend Clase UDP" -Direction Inbound -Protocol UDP -LocalPort 53317 -Action Allow -Profile Private
   New-NetFirewallRule -DisplayName "LocalSend Clase TCP" -Direction Inbound -Protocol TCP -LocalPort 53318 -Action Allow -Profile Private
   ```
5. **Firewall de Linux** (si usás `ufw`):
   ```bash
   sudo ufw allow 53317/udp
   sudo ufw allow 53318/tcp
   ```
6. **VPN apagada** en los dos dispositivos.

### Cómo verificar que la red está bien

- En la app de escritorio, el **LED tiene que estar verde** (UDP ✓ · TCP ✓) y arriba se ve tu IP, por ejemplo `192.168.1.10:53318`.
- Desde el navegador del celular abrí `http://192.168.1.10:53318/info`. Si ves un JSON con el nombre de la PC, el firewall está bien y la red deja pasar TCP.
- Si eso funciona pero igual no aparecen en el radar, lo que está bloqueado es el **broadcast UDP**. Usá **Ajustes → Conectar por IP** en el celular (o "¿No aparece? Conectar por IP" en la PC).

---

## 2. App de escritorio (Electron + React)

Requisitos: **Node.js 20 o superior**.

```bash
cd desktop
npm install
npm run dev        # abre la app en modo desarrollo
npm test           # prueba automática del núcleo de red (sin Electron)
```

### Generar el instalador

```bash
npm run dist:win     # en Windows   -> dist/LocalSend_Desktop_Setup.exe
npm run dist:linux   # en Linux     -> dist/LocalSend_Desktop_Setup.AppImage
```

> El `.exe` conviene generarlo **desde Windows**. Desde Linux hace falta tener Wine instalado.

Copiá el resultado a la carpeta `binarios/`.

---

## 3. App móvil (Expo con *development build*)

Requisitos: **Node.js 20 o superior** y un celular Android (o emulador).

```bash
cd mobile
npm install
npx expo install --fix     # ajusta todas las versiones a las del SDK de Expo instalado
```

### ¿Por qué no Expo Go?

La app usa un **módulo nativo propio** (`mobile/modules/localsend-native`, en Kotlin) para dos cosas que Expo Go no trae: el **socket UDP** del descubrimiento y el **Foreground Service**. Por eso se compila un *development build*, que es "tu propio Expo Go" con ese código adentro.

Si igual la abrís en Expo Go, la app funciona pero **sin descubrimiento automático**. En ese caso hay que conectar por IP desde Ajustes.

### Desarrollo (opción A, con Android Studio instalado)

```bash
npx expo run:android      # compila e instala en el celular conectado por USB
```

### Desarrollo (opción B, compila en la nube de Expo, sin Android Studio)

```bash
npx eas-cli login                                   # cuenta gratuita de expo.dev
npx eas-cli build -p android --profile development   # te da un link para instalar la app
npm start                                           # servidor de desarrollo (escaneá el QR)
```

### Generar el APK final

```bash
npx eas-cli build -p android --profile preview     # APK en la nube (recomendado)
# o, en local con Android Studio:
npm run build:apk:local                            # -> android/app/build/outputs/apk/release/app-release.apk
```

Renombrá el archivo a `LocalSend_Mobile.apk` y copialo a `binarios/`.

> **Si falla la compilación del módulo nativo** (por ejemplo por un cambio de plantilla en una versión nueva de Expo), regenerá el esqueleto oficial y copiá encima los dos archivos Kotlin:
> ```bash
> npx create-expo-module@latest --local --name LocalsendNative --package expo.modules.localsendnative
> ```
> Después copiá `LocalsendNativeModule.kt`, `TransferService.kt` y el `AndroidManifest.xml` de este repo dentro del módulo generado.

---

## 4. Cómo hacer la demo

1. Abrí la app de escritorio. Esperá el **LED verde**.
2. Abrí la app en el celular (con Wi-Fi). En menos de 5 segundos la PC aparece en el radar del celular y el celular aparece en la lista de la PC.
3. **Celular → PC:** tocá *Fotos y videos*, elegí una imagen, tocá la PC y confirmá con *Enviar*. En la PC aparece el diálogo *Aceptar/Rechazar* (o una notificación del sistema si la ventana está minimizada).
4. **PC → celular:** arrastrá un video a la ventana, hacé clic en el celular de la lista y luego en *Enviar a …*. En el celular aceptá. Mientras dura la transferencia hay una notificación persistente (Foreground Service).
5. **Integridad:** al terminar, las dos apps muestran "N bytes verificados" con el tamaño exacto en bytes.
6. **Corte de red:** apagá el Wi-Fi a mitad de un envío. Las dos apps pasan a *Interrumpido* en unos 15 segundos como máximo. Volvé a encender el Wi-Fi y tocá *Reanudar*: sigue desde el último byte guardado.

---

## 5. Problemas comunes

| Síntoma | Causa probable | Solución |
|---|---|---|
| LED rojo, "UDP ✗" | Otra app usa el puerto 53317 (¿el LocalSend real?) | Cerrala. La app reintenta sola cada 3 s |
| No se ven, pero `/info` abre en el navegador | La red bloquea el broadcast | Conectar por IP, o usar el hotspot del celular |
| No abre `/info` | Firewall o red Pública | Ver punto 1.4 |
| El celular dice "Conectate a una red Wi-Fi" | Está en datos móviles | Conectalo al Wi-Fi |
| En Expo Go no aparece nada | Expo Go no tiene el módulo UDP | Usar el development build o conectar por IP |
| La notificación de progreso no se ve | Permiso de notificaciones denegado (Android 13+) | Ajustes → Apps → LocalSend → Notificaciones |
