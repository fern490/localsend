import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native'
import * as ImagePicker from 'expo-image-picker'

/**
 * Permiso de galería (pregunta C2 de la defensa).
 *
 * La promesa de requestMediaLibraryPermissionsAsync() devuelve
 * { granted, canAskAgain }:
 *  - granted            -> seguimos.
 *  - !granted y canAskAgain  -> el usuario dijo "Rechazar" UNA vez: le
 *    explicamos para qué lo necesitamos y le ofrecemos volver a pedirlo.
 *  - !granted y !canAskAgain -> eligió "No volver a preguntar": Android ya
 *    no muestra el diálogo, la única salida es mandarlo a Ajustes.
 * En ningún caso la app se cuelga o falla: siempre queda el selector de
 * Archivos (Storage Access Framework), que no necesita permiso.
 */
export async function ensureMediaPermission() {
  let res = await ImagePicker.getMediaLibraryPermissionsAsync()
  if (res.granted) return true

  res = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (res.granted) return true

  if (res.canAskAgain) {
    const retry = await ask(
      'Necesitamos acceso a tus fotos',
      'Para elegir fotos y videos y mostrarte las miniaturas. Podés usar "Archivos" si preferís no darlo.',
      'Volver a pedir'
    )
    if (retry) return (await ImagePicker.requestMediaLibraryPermissionsAsync()).granted
    return false
  }

  const open = await ask(
    'Permiso bloqueado',
    'Rechazaste el permiso de fotos de forma permanente. Podés habilitarlo en Ajustes > Permisos.',
    'Abrir Ajustes'
  )
  if (open) Linking.openSettings()
  return false
}

/** Android 13+: sin este permiso la notificación del Foreground Service no se ve. */
export async function ensureNotificationPermission() {
  if (Platform.OS !== 'android' || Platform.Version < 33) return true
  const r = await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS')
  return r === PermissionsAndroid.RESULTS.GRANTED
}

function ask(title, message, okText) {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Ahora no', style: 'cancel', onPress: () => resolve(false) },
      { text: okText, onPress: () => resolve(true) }
    ])
  )
}
