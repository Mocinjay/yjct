import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { colors, radius, spacing, type } from './theme';

/* ---------------------------------- Buttons --------------------------------- */

type ButtonTone = 'accent' | 'blue' | 'ghost' | 'danger' | 'success';

const TONE_BG: Record<ButtonTone, string> = {
  accent: colors.accent,
  blue: colors.blue,
  ghost: colors.surfaceHigh,
  danger: colors.accentSoft,
  success: colors.successSoft,
};

export function Button({
  label,
  sublabel,
  onPress,
  tone = 'ghost',
  disabled,
  busy,
  style,
}: {
  label: string;
  sublabel?: string;
  onPress: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        btn.base,
        { backgroundColor: TONE_BG[tone] },
        tone === 'ghost' && btn.ghostBorder,
        pressed && btn.pressed,
        (disabled || busy) && btn.disabled,
        style,
      ]}>
      {busy ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <>
          <Text
            style={[
              btn.label,
              tone === 'danger' && { color: colors.accent },
              tone === 'success' && { color: colors.success },
            ]}>
            {label}
          </Text>
          {sublabel ? <Text style={btn.sublabel}>{sublabel}</Text> : null}
        </>
      )}
    </Pressable>
  );
}

const btn = StyleSheet.create({
  base: {
    borderRadius: radius.l,
    paddingVertical: spacing.m,
    paddingHorizontal: spacing.m,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  ghostBorder: { borderWidth: 1, borderColor: colors.border },
  pressed: { transform: [{ scale: 0.98 }], opacity: 0.92 },
  disabled: { opacity: 0.4 },
  label: { color: colors.text, fontSize: 16, fontWeight: '800' },
  sublabel: { color: 'rgba(245,245,248,0.72)', fontSize: 12, marginTop: 2 },
});

/* ----------------------------------- Chips ---------------------------------- */

export function Chip({
  label,
  selected,
  onPress,
  dim,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  dim?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        chip.base,
        selected && chip.selected,
        pressed && btn.pressed,
      ]}>
      <Text style={[chip.text, selected && chip.textSelected, dim && chip.textDim]}>
        {label}
      </Text>
    </Pressable>
  );
}

const chip = StyleSheet.create({
  base: {
    backgroundColor: colors.surfaceHigh,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s + 2,
  },
  selected: { backgroundColor: colors.accent, borderColor: colors.accent },
  text: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  textSelected: { color: colors.text },
  textDim: { color: colors.textFaint },
});

/* ----------------------------------- Cards ---------------------------------- */

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[card.base, style]}>{children}</View>;
}

const card = StyleSheet.create({
  base: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.m,
    padding: spacing.m,
    gap: spacing.s,
  },
});

export function SectionLabel({ children }: { children: string }) {
  return <Text style={sectionLabel.text}>{children}</Text>;
}

const sectionLabel = StyleSheet.create({
  text: { ...type.label, color: colors.textFaint, marginTop: spacing.s },
});

/* ------------------------------- Brand pieces ------------------------------- */

/** Pulsing red recording dot. */
export function RecDot({ size = 10, live = true }: { size?: number; live?: boolean }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!live) {
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.25,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [live, pulse]);

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.accent,
        opacity: live ? pulse : 1,
      }}
    />
  );
}

export function ProBadge({ locked }: { locked?: boolean }) {
  return (
    <View style={[pro.badge, locked && pro.locked]}>
      <Text style={[pro.text, locked && pro.lockedText]}>PRO</Text>
    </View>
  );
}

const pro = StyleSheet.create({
  badge: {
    backgroundColor: colors.goldSoft,
    borderWidth: 1,
    borderColor: colors.gold,
    borderRadius: radius.s,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  text: { color: colors.gold, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  locked: { borderColor: colors.textFaint, backgroundColor: 'transparent' },
  lockedText: { color: colors.textFaint },
});

/* --------------------------------- Empty state ------------------------------ */

/** Concentric REC rings used by empty states — pure Views, no assets. */
export function RecRings({ size = 120 }: { size?: number }) {
  const ring = (d: number, opacity: number) => (
    <View
      style={{
        position: 'absolute',
        width: d,
        height: d,
        borderRadius: d / 2,
        borderWidth: 1.5,
        borderColor: colors.accent,
        opacity,
      }}
    />
  );
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {ring(size, 0.15)}
      {ring(size * 0.72, 0.35)}
      {ring(size * 0.45, 0.7)}
      <View
        style={{
          width: size * 0.2,
          height: size * 0.2,
          borderRadius: size * 0.1,
          backgroundColor: colors.accent,
        }}
      />
    </View>
  );
}
