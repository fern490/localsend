import { useState } from 'react'
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { formatBytes } from './format'

/** Hoja inferior genérica. */
function Sheet({ visible, onClose, theme, children }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: theme.card, borderColor: theme.border }]} onPress={() => {}}>
          <View style={[styles.handle, { backgroundColor: theme.border }]} />
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function Button({ theme, label, onPress, primary, style }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: primary ? theme.accent : theme.card2, opacity: pressed ? 0.75 : 1 },
        style
      ]}
    >
      <Text style={{ color: primary ? theme.accentInk : theme.text, fontWeight: '700', fontSize: 15 }}>{label}</Text>
    </Pressable>
  )
}

/** Paso 3 de la "regla de los 3 clics": confirmar el envío. */
export function ConfirmSheet({ theme, device, files, onConfirm, onClose }) {
  const total = files.reduce((a, f) => a + (f.size || 0), 0)
  return (
    <Sheet visible={!!device} onClose={onClose} theme={theme}>
      <Text style={[styles.h, { color: theme.text }]}>¿Enviar a {device?.alias}?</Text>
      <Text style={{ color: theme.muted }}>
        {files.length} archivo{files.length === 1 ? '' : 's'} · {formatBytes(total)}
      </Text>
      <ScrollView horizontal style={{ marginVertical: 12 }} contentContainerStyle={{ gap: 8 }}>
        {files.map((f) => (
          <View key={f.uri} style={[styles.chip, { backgroundColor: theme.card2 }]}>
            {f.kind === 'image' ? (
              <Image source={{ uri: f.uri }} style={styles.chipImg} />
            ) : (
              <Ionicons name={f.kind === 'video' ? 'videocam-outline' : 'document-outline'} size={26} color={theme.muted} />
            )}
          </View>
        ))}
      </ScrollView>
      <View style={styles.row}>
        <Button theme={theme} label="Cancelar" onPress={onClose} style={{ flex: 1 }} />
        <Button theme={theme} label="Enviar" primary onPress={onConfirm} style={{ flex: 1 }} />
      </View>
    </Sheet>
  )
}

/** La PC quiere mandarnos archivos. */
export function IncomingSheet({ theme, request, onRespond }) {
  const total = request ? request.files.reduce((a, f) => a + f.size, 0) : 0
  return (
    <Sheet visible={!!request} onClose={() => onRespond(request.id, false)} theme={theme}>
      {request && (
        <>
          <Ionicons name="download-outline" size={34} color={theme.accent} />
          <Text style={[styles.h, { color: theme.text }]}>{request.peerAlias} quiere enviarte</Text>
          <Text style={{ color: theme.muted, marginBottom: 10 }}>
            {request.files.length} archivo{request.files.length === 1 ? '' : 's'} · {formatBytes(total)}
          </Text>
          <ScrollView style={{ maxHeight: 220, marginBottom: 12 }}>
            {request.files.map((f) => (
              <View key={f.fileId} style={[styles.fileRow, { borderColor: theme.border }]}>
                <Text style={{ color: theme.text, flex: 1 }} numberOfLines={1}>
                  {f.name}
                </Text>
                <Text style={{ color: theme.muted }}>{formatBytes(f.size)}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.row}>
            <Button theme={theme} label="Rechazar" onPress={() => onRespond(request.id, false)} style={{ flex: 1 }} />
            <Button theme={theme} label="Aceptar" primary onPress={() => onRespond(request.id, true)} style={{ flex: 1 }} />
          </View>
        </>
      )}
    </Sheet>
  )
}

/** Conexión manual por IP + cambio de alias. */
export function SettingsSheet({ theme, visible, settings, onClose, onSaveAlias, onConnectIp }) {
  const [alias, setAlias] = useState(settings?.alias || '')
  const [ip, setIp] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  const connect = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const info = await onConnectIp(ip)
      setMsg({ ok: true, text: `Conectado a ${info.alias}` })
      setIp('')
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} theme={theme}>
      <Text style={[styles.h, { color: theme.text }]}>Ajustes</Text>
      <Text style={[styles.label, { color: theme.muted }]}>Nombre de este celular</Text>
      <View style={styles.row}>
        <TextInput
          value={alias}
          onChangeText={setAlias}
          maxLength={40}
          style={[styles.input, { color: theme.text, backgroundColor: theme.card2, borderColor: theme.border }]}
          placeholderTextColor={theme.muted}
        />
        <Button theme={theme} label="Guardar" onPress={() => alias.trim() && onSaveAlias(alias.trim())} />
      </View>

      <Text style={[styles.label, { color: theme.muted, marginTop: 16 }]}>¿No aparece tu PC? Conectar por IP</Text>
      <View style={styles.row}>
        <TextInput
          value={ip}
          onChangeText={setIp}
          placeholder="192.168.1.20"
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          style={[styles.input, { color: theme.text, backgroundColor: theme.card2, borderColor: theme.border }]}
          placeholderTextColor={theme.muted}
        />
        <Button theme={theme} label={busy ? '…' : 'Conectar'} primary onPress={connect} />
      </View>
      {msg && <Text style={{ color: msg.ok ? theme.ok : theme.danger, marginTop: 6 }}>{msg.text}</Text>}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 36, borderWidth: 1, gap: 4 },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 12 },
  h: { fontSize: 20, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  button: { paddingVertical: 13, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center' },
  chip: { width: 64, height: 64, borderRadius: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  chipImg: { width: 64, height: 64 },
  fileRow: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  label: { fontSize: 13, marginBottom: 6 },
  input: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 }
})
