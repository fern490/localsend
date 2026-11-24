import { useEffect, useRef } from 'react'
import { Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { formatBytes, formatSpeed, formatEta, exactBytes, STATUS_TEXT } from './format'

/** Tarjeta de progreso con miniatura del archivo (si es imagen). */
export default function TransferCard({ t, theme, onCancel, onRetry, onSave, onShare }) {
  const pct = t.totalBytes > 0 ? Math.min(100, (t.bytesDone / t.totalBytes) * 100) : t.status === 'done' ? 100 : 0
  const anim = useRef(new Animated.Value(pct)).current
  useEffect(() => {
    // Animamos entre actualizaciones para que la barra no "salte".
    Animated.timing(anim, { toValue: pct, duration: 220, useNativeDriver: false }).start()
  }, [pct, anim])

  const first = t.files.find((f) => f.status !== 'skipped') || t.files[0]
  const thumbUri = t.direction === 'out' ? first?.uri : first?.savedUri
  const isImage = first?.mime?.startsWith('image/')
  const color =
    { done: theme.ok, interrupted: theme.warn, error: theme.danger, rejected: theme.danger, cancelled: theme.danger }[t.status] ||
    theme.accent
  const active = t.status === 'transferring'

  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border, borderLeftColor: color }]}>
      <View style={styles.row}>
        <View style={[styles.thumb, { backgroundColor: theme.card2 }]}>
          {isImage && thumbUri ? (
            <Image source={{ uri: thumbUri }} style={styles.thumbImg} />
          ) : (
            <Ionicons name={first?.mime?.startsWith('video/') ? 'videocam-outline' : 'document-outline'} size={24} color={theme.muted} />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
            {t.direction === 'out' ? '↑ ' : '↓ '}
            {first?.name}
            {t.files.length > 1 ? ` +${t.files.length - 1}` : ''}
          </Text>
          <Text style={{ color: theme.muted, fontSize: 12 }} numberOfLines={1}>
            {t.direction === 'out' ? 'a' : 'de'} {t.peerAlias} · {STATUS_TEXT[t.status] || t.status}
          </Text>
        </View>
      </View>

      <View style={[styles.track, { backgroundColor: theme.card2 }]}>
        <Animated.View
          style={[styles.bar, { backgroundColor: color, width: anim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }) }]}
        />
      </View>

      <View style={styles.stats}>
        <Text style={{ color: theme.text, fontSize: 12, fontVariant: ['tabular-nums'] }}>
          {pct.toFixed(1)}% · {formatBytes(t.bytesDone)} / {formatBytes(t.totalBytes)}
        </Text>
        {active && (
          <Text style={{ color: theme.muted, fontSize: 12, fontVariant: ['tabular-nums'] }}>
            {formatSpeed(t.speed)} · {formatEta(t.eta)}
          </Text>
        )}
      </View>

      {t.status === 'done' &&
        t.files
          .filter((f) => f.finalSize != null)
          .map((f) => (
            <Text key={f.fileId} style={{ color: theme.ok, fontSize: 11 }} numberOfLines={1}>
              ✓ {f.name}: {exactBytes(f.finalSize)} bytes verificados
            </Text>
          ))}

      {t.error ? <Text style={{ color: t.status === 'interrupted' ? theme.warn : theme.danger, fontSize: 12 }}>{t.error}</Text> : null}

      <View style={styles.actions}>
        {['waiting', 'transferring'].includes(t.status) && <Btn theme={theme} label="Cancelar" onPress={() => onCancel(t.id)} />}
        {t.direction === 'out' && ['interrupted', 'error'].includes(t.status) && (
          <Btn theme={theme} primary label={t.resumable ? 'Reintentar (reanudar)' : 'Reintentar'} onPress={() => onRetry(t.id)} />
        )}
        {t.direction === 'in' && t.status === 'done' && (
          <>
            {t.files.some((f) => /^(image|video)\//.test(f.mime)) && <Btn theme={theme} label="Guardar en galería" onPress={() => onSave(t)} />}
            <Btn theme={theme} label="Compartir" onPress={() => onShare(t)} />
          </>
        )}
      </View>
    </View>
  )
}

function Btn({ theme, label, onPress, primary }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: primary ? theme.accent : theme.card2, opacity: pressed ? 0.7 : 1 }
      ]}
    >
      <Text style={{ color: primary ? theme.accentInk : theme.text, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 12, gap: 8, borderWidth: 1, borderLeftWidth: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  thumb: { width: 46, height: 46, borderRadius: 10, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  thumbImg: { width: 46, height: 46 },
  title: { fontWeight: '600', fontSize: 14 },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  bar: { height: 8, borderRadius: 4 },
  stats: { flexDirection: 'row', justifyContent: 'space-between' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' },
  btn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10 }
})
