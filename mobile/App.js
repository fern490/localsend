import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, FlatList, Image, Pressable, ScrollView, StyleSheet, Text, ToastAndroid, Platform, View, useColorScheme } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { Ionicons } from '@expo/vector-icons'
import { useNetInfo } from '@react-native-community/netinfo'
import * as ImagePicker from 'expo-image-picker'
import * as DocumentPicker from 'expo-document-picker'
import * as Haptics from 'expo-haptics'
import * as MediaLibrary from 'expo-media-library'
import * as Sharing from 'expo-sharing'

import { MobileNode } from './src/net/node'
import { loadSettings, saveSettings } from './src/services/settings'
import { ensureMediaPermission, ensureNotificationPermission } from './src/services/permissions'
import { isNativeAvailable, Udp } from './modules/localsend-native'
import { fileSize } from './src/fs/files'
import { makeTheme } from './src/ui/theme'
import Radar from './src/ui/Radar'
import TransferCard from './src/ui/TransferCard'
import { ConfirmSheet, IncomingSheet, SettingsSheet } from './src/ui/Sheets'
import { formatBytes } from './src/ui/format'

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  )
}

const toast = (msg) => (Platform.OS === 'android' ? ToastAndroid.show(msg, ToastAndroid.SHORT) : console.log(msg))
const FINAL = ['done', 'rejected', 'cancelled', 'error', 'interrupted']

function Main() {
  const theme = makeTheme(useColorScheme())
  const net = useNetInfo()
  const [settings, setSettings] = useState(null)
  const [devices, setDevices] = useState([])
  const [discovery, setDiscovery] = useState({ listening: false, error: null })
  const [transfers, setTransfers] = useState({})
  const [selection, setSelection] = useState([]) // archivos elegidos (se conservan si falla)
  const [target, setTarget] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const nodeRef = useRef(null)
  const settingsRef = useRef(null)
  const prevStatus = useRef({})
  const lastSentId = useRef(null)

  // Sólo seguimos si hay Wi-Fi: así nunca se usan datos móviles por error.
  const onWifi = net.type === 'wifi' || net.type === 'ethernet'
  const netKnown = net.type != null && net.type !== 'unknown'

  /* ── Arranque: configuración + nodo P2P ── */
  useEffect(() => {
    let mounted = true
    loadSettings().then((s) => {
      if (!mounted) return
      settingsRef.current = s
      setSettings(s)
      const node = new MobileNode(() => settingsRef.current)
      node.on('devices', setDevices)
      node.on('status', setDiscovery)
      node.on('transfer', (t) => setTransfers((prev) => ({ ...prev, [t.id]: t })))
      nodeRef.current = node
    })
    ensureNotificationPermission().catch(() => {})
    return () => {
      mounted = false
      nodeRef.current?.stop()
    }
  }, [])

  /* ── Wi-Fi conectado => escanear; Wi-Fi perdido => frenar ── */
  useEffect(() => {
    const node = nodeRef.current
    if (!node) return
    if (onWifi) node.start()
    else node.stop()
  }, [onWifi, settings])

  /* ── Al volver de segundo plano (ej. después de una llamada) reabrimos el UDP ── */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const node = nodeRef.current
      if (state !== 'active' || !node || !onWifi) return
      const busy = [...node.transfers.values()].some((t) => ['waiting', 'transferring'].includes(t.status))
      if (!busy) node.start()
    })
    return () => sub.remove()
  }, [onWifi])

  /* ── Haptics: vibración corta al terminar bien o con error ── */
  useEffect(() => {
    for (const t of Object.values(transfers)) {
      const before = prevStatus.current[t.id]
      if (before === t.status) continue
      prevStatus.current[t.id] = t.status
      if (!before) continue
      if (t.status === 'done') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
        if (t.id === lastSentId.current) setSelection([]) // recién ahora soltamos la selección
      } else if (['error', 'interrupted', 'rejected'].includes(t.status)) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
      }
    }
  }, [transfers])

  /* ── Paso 1: elegir archivos ── */
  const addToSelection = (items) =>
    setSelection((prev) => {
      const known = new Set(prev.map((f) => f.uri))
      return [...prev, ...items.filter((f) => !known.has(f.uri))]
    })

  const pickMedia = async () => {
    const granted = await ensureMediaPermission()
    if (!granted) return
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, quality: 1 })
    if (r.canceled) return
    addToSelection(
      r.assets.map((a) => ({
        uri: a.uri,
        name: a.fileName || a.uri.split('/').pop(),
        size: a.fileSize || fileSize(a.uri),
        mime: a.mimeType || (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
        kind: a.type === 'video' ? 'video' : 'image'
      }))
    )
  }

  const pickFiles = async () => {
    // El selector de documentos (SAF) no necesita permisos de almacenamiento.
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' })
    if (r.canceled) return
    addToSelection(
      r.assets.map((a) => ({
        uri: a.uri,
        name: a.name,
        size: a.size || fileSize(a.uri),
        mime: a.mimeType || 'application/octet-stream',
        kind: a.mimeType?.startsWith('image/') ? 'image' : a.mimeType?.startsWith('video/') ? 'video' : 'file'
      }))
    )
  }

  /* ── Paso 2: tocar el dispositivo ── */
  const onDevicePress = (device) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    if (selection.length === 0) return toast('Primero elegí qué querés enviar')
    setTarget(device)
  }

  /* ── Paso 3: confirmar ── */
  const confirmSend = async () => {
    const device = target
    setTarget(null)
    try {
      lastSentId.current = await nodeRef.current.sendFiles(device.id, selection)
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
      toast(e.message)
    }
  }

  const retry = async (id) => {
    try {
      lastSentId.current = await nodeRef.current.retry(id)
    } catch (e) {
      toast(e.message)
    }
  }

  const saveToGallery = async (t) => {
    const perm = await MediaLibrary.requestPermissionsAsync(true)
    if (!perm.granted) return toast('Sin permiso para guardar en la galería')
    let n = 0
    for (const f of t.files) {
      if (f.savedUri && /^(image|video)\//.test(f.mime)) {
        await MediaLibrary.saveToLibraryAsync(f.savedUri)
        n++
      }
    }
    toast(`${n} archivo(s) guardados en la galería`)
  }

  const share = async (t) => {
    const f = t.files.find((x) => x.savedUri)
    if (f && (await Sharing.isAvailableAsync())) await Sharing.shareAsync(f.savedUri, { mimeType: f.mime })
  }

  const list = useMemo(() => Object.values(transfers).reverse(), [transfers])
  const incoming = list.find((t) => t.direction === 'in' && t.status === 'pending')
  const visible = list.filter((t) => t.status !== 'pending')
  const selectionSize = selection.reduce((a, f) => a + (f.size || 0), 0)
  const localIp = useMemo(() => (onWifi ? Udp.localIp() : null), [onWifi, net.details])

  const renderDevice = useCallback(
    ({ item }) => (
      <Pressable
        onPress={() => onDevicePress(item)}
        style={({ pressed }) => [styles.device, { backgroundColor: theme.card, borderColor: theme.border, opacity: pressed ? 0.7 : 1 }]}
      >
        <View style={[styles.deviceIcon, { backgroundColor: theme.card2 }]}>
          <Ionicons name={item.deviceType === 'laptop' ? 'laptop-outline' : 'desktop-outline'} size={26} color={theme.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.text, fontWeight: '700', fontSize: 15 }}>{item.alias}</Text>
          <Text style={{ color: theme.muted, fontSize: 12 }}>
            {item.deviceType === 'laptop' ? 'Laptop' : 'PC'} · {item.ip}
            {item.manual ? ' · manual' : ''}
          </Text>
        </View>
        <Ionicons name="send" size={20} color={selection.length ? theme.accent : theme.border} />
      </Pressable>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme, selection]
  )

  if (!settings) return <SafeAreaView style={[styles.fill, { backgroundColor: theme.bg }]} />

  /* ── Sin Wi-Fi: no escaneamos (evita usar datos móviles) ── */
  if (netKnown && !onWifi) {
    return (
      <SafeAreaView style={[styles.fill, styles.center, { backgroundColor: theme.bg, padding: 32 }]}>
        <StatusBar style={theme.dark ? 'light' : 'dark'} />
        <Ionicons name="wifi-outline" size={64} color={theme.muted} />
        <Text style={[styles.h1, { color: theme.text, textAlign: 'center', marginTop: 16 }]}>Conectate a una red Wi-Fi</Text>
        <Text style={{ color: theme.muted, textAlign: 'center', marginTop: 8 }}>
          LocalSend sólo funciona dentro de una red local. Con datos móviles no se puede encontrar a la PC (y gastarías datos).
        </Text>
        {selection.length > 0 && (
          <Text style={{ color: theme.accent, marginTop: 16 }}>Tu selección de {selection.length} archivo(s) se conserva.</Text>
        )}
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: theme.bg }]} edges={['top', 'left', 'right']}>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />

      {/* Encabezado */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.muted, fontSize: 12 }}>Este celular</Text>
          <Text style={[styles.h1, { color: theme.text }]}>{settings.alias}</Text>
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: discovery.listening ? theme.ok : theme.warn }]} />
            <Text style={{ color: theme.muted, fontSize: 12 }}>
              {discovery.listening ? 'Visible en la red' : discovery.error || 'Iniciando…'}
              {localIp ? ` · ${localIp}` : ''}
            </Text>
          </View>
        </View>
        <Pressable onPress={() => setShowSettings(true)} style={[styles.iconBtn, { borderColor: theme.border }]}>
          <Ionicons name="settings-outline" size={22} color={theme.text} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }}>
        {/* Paso 1: selección */}
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.h2, { color: theme.text }]}>1. Elegí qué enviar</Text>
          <View style={styles.pickRow}>
            <PickButton theme={theme} icon="images-outline" label="Fotos y videos" onPress={pickMedia} />
            <PickButton theme={theme} icon="folder-open-outline" label="Archivos" onPress={pickFiles} />
          </View>
          {selection.length > 0 && (
            <>
              <ScrollView horizontal contentContainerStyle={{ gap: 8 }} style={{ marginTop: 10 }}>
                {selection.map((f) => (
                  <Pressable key={f.uri} onLongPress={() => setSelection((s) => s.filter((x) => x.uri !== f.uri))}>
                    <View style={[styles.thumb, { backgroundColor: theme.card2 }]}>
                      {f.kind === 'image' ? (
                        <Image source={{ uri: f.uri }} style={styles.thumb} />
                      ) : (
                        <Ionicons name={f.kind === 'video' ? 'videocam-outline' : 'document-outline'} size={26} color={theme.muted} />
                      )}
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
              <View style={styles.selFooter}>
                <Text style={{ color: theme.muted, fontSize: 12 }}>
                  {selection.length} archivo(s) · {formatBytes(selectionSize)} · mantené presionado para quitar
                </Text>
                <Pressable onPress={() => setSelection([])}>
                  <Text style={{ color: theme.accent, fontWeight: '600' }}>Limpiar</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>

        {/* Paso 2: radar + dispositivos */}
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.h2, { color: theme.text }]}>2. Tocá la PC destino</Text>
          <View style={{ alignItems: 'center', marginVertical: 8 }}>
            <Radar theme={theme} size={devices.length ? 120 : 180} active={discovery.listening} />
            {devices.length === 0 && (
              <Text style={{ color: theme.muted, textAlign: 'center', marginTop: 8 }}>
                {isNativeAvailable
                  ? 'Buscando PCs en tu red… Abrí LocalSend en la computadora.'
                  : 'Estás en Expo Go: sin descubrimiento automático. Usá Ajustes > Conectar por IP.'}
              </Text>
            )}
          </View>
          <FlatList data={devices} keyExtractor={(d) => d.id} renderItem={renderDevice} scrollEnabled={false} contentContainerStyle={{ gap: 8 }} />
        </View>

        {/* Transferencias */}
        {visible.length > 0 && (
          <View style={{ gap: 10 }}>
            <View style={styles.selFooter}>
              <Text style={[styles.h2, { color: theme.text }]}>Transferencias</Text>
              <Pressable
                onPress={() => {
                  nodeRef.current.clearFinished()
                  setTransfers((prev) => Object.fromEntries(Object.entries(prev).filter(([, t]) => !FINAL.includes(t.status))))
                }}
              >
                <Text style={{ color: theme.accent, fontWeight: '600' }}>Limpiar</Text>
              </Pressable>
            </View>
            {visible.map((t) => (
              <TransferCard
                key={t.id}
                t={t}
                theme={theme}
                onCancel={(id) => nodeRef.current.cancel(id)}
                onRetry={retry}
                onSave={saveToGallery}
                onShare={share}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <ConfirmSheet theme={theme} device={target} files={selection} onConfirm={confirmSend} onClose={() => setTarget(null)} />
      <IncomingSheet theme={theme} request={incoming} onRespond={(id, ok) => nodeRef.current.respond(id, ok)} />
      <SettingsSheet
        theme={theme}
        visible={showSettings}
        settings={settings}
        onClose={() => setShowSettings(false)}
        onSaveAlias={async (alias) => {
          const s = await saveSettings({ ...settingsRef.current, alias })
          settingsRef.current = s
          setSettings(s)
          nodeRef.current?.announce()
          toast('Nombre guardado')
        }}
        onConnectIp={(ip) => nodeRef.current.connectIp(ip)}
      />
    </SafeAreaView>
  )
}

function PickButton({ theme, icon, label, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.pick, { backgroundColor: theme.card2, opacity: pressed ? 0.7 : 1 }]}
    >
      <Ionicons name={icon} size={26} color={theme.accent} />
      <Text style={{ color: theme.text, fontWeight: '600', marginTop: 6 }}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  h1: { fontSize: 22, fontWeight: '800' },
  h2: { fontSize: 16, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  iconBtn: { borderWidth: 1, borderRadius: 12, padding: 8 },
  card: { borderRadius: 18, padding: 16, borderWidth: 1 },
  pickRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  pick: { flex: 1, alignItems: 'center', paddingVertical: 18, borderRadius: 14 },
  thumb: { width: 64, height: 64, borderRadius: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  selFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
  device: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1 },
  deviceIcon: { width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }
})
