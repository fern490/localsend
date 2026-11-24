import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

/** Animación de "escaneo": tres ondas que se expanden desde el centro. */
export default function Radar({ theme, size = 180, active = true }) {
  const waves = useRef([0, 1, 2].map(() => new Animated.Value(0))).current

  useEffect(() => {
    if (!active) return
    const loops = waves.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 900),
          Animated.timing(v, { toValue: 1, duration: 2700, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true })
        ])
      )
    )
    loops.forEach((l) => l.start())
    return () => loops.forEach((l) => l.stop())
  }, [active, waves])

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {waves.map((v, i) => (
        <Animated.View
          key={i}
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: size / 2,
              borderWidth: 2,
              borderColor: theme.accent,
              opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.8, 0] }),
              transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) }]
            }
          ]}
        />
      ))}
      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="phone-portrait-outline" size={30} color={theme.accentInk} />
      </View>
    </View>
  )
}
