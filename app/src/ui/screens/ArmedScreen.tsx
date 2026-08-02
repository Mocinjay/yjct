import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import type { CaptureStatus } from '../../core/CaptureController';
import { bump } from '../../debug/jsProbe';
import { useGlassesLease } from '../../device/glassesLease';
import type { CaptureSession } from '../../services/capture';
import { buildCaptureSession } from '../../services/capture';
import { GlassesPreview } from '../GlassesPreview';
import { RecDot } from '../components';
import type { RootStackParamList } from '../navigation';
import { formatDuration } from './LibraryScreen';
import { colors, radius, spacing, type } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Armed'>;

export function ArmedScreen({ navigation }: Props) {
  bump('render.Armed');
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [status, setStatus] = useState<CaptureStatus>({
    state: 'idle',
    bufferedSeconds: 0,
  });
  const [now, setNow] = useState(Date.now());
  const armedRef = useRef(false);
  /** Sticky, unlike `armedRef`: stays true across a disarm. */
  const hasArmedOnce = useRef(false);
  const isFocused = useIsFocused();
  useGlassesLease(isFocused);
  const insets = useSafeAreaInsets();
  const device = useCameraDevice('back');
  const toast = useRef(new Animated.Value(0)).current;
  const lastToastClip = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    buildCaptureSession().then(s => {
      if (!cancelled) {
        setSession(s);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }
    const unsubscribe = session.controller.subscribe(setStatus);
    return () => {
      unsubscribe();
      session.controller.disarm().catch(() => {});
    };
  }, [session]);

  // Slide-up "saved" toast whenever a new clip lands.
  useEffect(() => {
    if (!status.lastClip || status.lastClip.id === lastToastClip.current) {
      return;
    }
    lastToastClip.current = status.lastClip.id;
    toast.setValue(0);
    Animated.sequence([
      Animated.timing(toast, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.back(1.4)),
        useNativeDriver: true,
      }),
      Animated.delay(2200),
      Animated.timing(toast, {
        toValue: 0,
        duration: 300,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, [status.lastClip, toast]);

  // Tick the elapsed-recording clock.
  useEffect(() => {
    if (status.state !== 'recording') {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status.state]);

  const arm = useCallback(() => {
    if (!session || armedRef.current) {
      return;
    }
    armedRef.current = true;
    hasArmedOnce.current = true;
    session.controller.arm().catch(() => {
      // status listener already reflects the error
    });
  }, [session]);

  // Capture follows FOCUS, not mount. React Navigation keeps this screen
  // mounted underneath the Library and the clip player, so arming on mount left
  // the glasses camera, the Bluetooth link, the H.264 writer, the mic and
  // per-segment speech recognition all running the entire time the user was
  // browsing or watching a clip. Nothing up there needs the wearer's feed.
  //
  // On blur: stop capturing. On return: arm again. `useGlassesLease` handles
  // tearing the underlying glasses session down once no screen holds it.
  useEffect(() => {
    if (!session) {
      return;
    }
    if (isFocused) {
      // The mock path arms from the viewfinder's `onInitialized` instead, so on
      // the FIRST visit leave it alone — arming before the camera is ready
      // fails. On a return visit that callback has already fired and will not
      // fire again, so re-arm here. `hasArmedOnce` is what distinguishes the
      // two; `armedRef` cannot, since disarming resets it to false.
      if (!session.mockSource || hasArmedOnce.current) {
        arm();
      }
      return;
    }
    // Never interrupt a manual extended recording or an in-flight save — those
    // own the writer and the user is deliberately capturing.
    if (status.state === 'recording' || status.state === 'saving') {
      return;
    }
    armedRef.current = false;
    session.controller.disarm().catch(() => {});
  }, [isFocused, session, arm, status.state]);

  const clipNow = () => {
    session?.controller.captureNow().catch(() => {});
  };
  const startExtended = () => session?.controller.startClip();
  const stop = () => {
    session?.controller.stopClip().catch(() => {});
  };

  const live = status.state === 'armed';
  const recording = status.state === 'recording';
  const saving = status.state === 'saving';
  const recordingSecs = status.recordingSince
    ? Math.max(0, Math.round((now - status.recordingSince) / 1000))
    : 0;

  return (
    <View style={styles.root}>
      {session?.mockSource && device ? (
        <Camera
          ref={ref => session.mockSource?.attachCamera(ref)}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive
          video
          audio
          onInitialized={arm}
        />
      ) : session && !session.mockSource ? (
        <GlassesPreview style={StyleSheet.absoluteFill} />
      ) : null}

      {/* Top chrome */}
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.s }]}>
        <Pressable
          onPress={() => {
            // Armed is reached two ways: pushed from Library, or replacing
            // Connect on boot (ConnectScreen uses `replace`). In the second
            // case it is the only screen on the stack, so goBack() has no
            // target and React Navigation logs "The action 'GO_BACK' was not
            // handled by any navigator". Closing belongs in the Library either
            // way, so fall through to it.
            if (navigation.canGoBack()) {
              navigation.goBack();
            } else {
              navigation.navigate('Library');
            }
          }}
          hitSlop={12}
          style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
          <Text style={styles.closeGlyph}>✕</Text>
        </Pressable>

        <View style={[styles.statusPill, recording && styles.statusPillRec]}>
          <RecDot size={8} live={live || recording} />
          <Text style={styles.statusText}>{statusLabel(status, recordingSecs)}</Text>
        </View>

        {/* spacer to balance the close button */}
        <View style={styles.closeButton} />
      </View>

      {status.lastError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{status.lastError}</Text>
        </View>
      ) : null}

      {/* Saved toast */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.toast,
          {
            opacity: toast,
            transform: [
              {
                translateY: toast.interpolate({
                  inputRange: [0, 1],
                  outputRange: [24, 0],
                }),
              },
            ],
          },
        ]}>
        <Text style={styles.toastCheck}>✓</Text>
        <Text style={styles.toastText}>Saved to library</Text>
      </Animated.View>

      {/* Bottom control deck */}
      <View style={[styles.deck, { paddingBottom: insets.bottom + spacing.l }]}>
        {live || saving ? (
          <Text style={styles.hint}>
            {session?.mockWakeWord
              ? 'mock mode — tap the ring to clip'
              : '🎙 say “yo Jarvis, clip that”'}
          </Text>
        ) : null}
        {recording ? (
          <Text style={styles.hint}>extended clip — tap to stop & save</Text>
        ) : null}

        <View style={styles.deckRow}>
          {/* Extended-clip toggle (left) */}
          {!recording ? (
            <Pressable
              onPress={startExtended}
              disabled={!live}
              style={({ pressed }) => [
                styles.sideButton,
                pressed && styles.pressed,
                !live && styles.dimmed,
              ]}>
              <View style={styles.extendedGlyph} />
              <Text style={styles.sideLabel}>Extended</Text>
            </Pressable>
          ) : (
            <View style={styles.sideButton}>
              <Text style={styles.elapsed}>{formatDuration(recordingSecs)}</Text>
              <Text style={styles.sideLabel}>+ look-back</Text>
            </View>
          )}

          {/* Main ring button (center) */}
          <Pressable
            onPress={recording ? stop : session?.mockWakeWord ? () => session.mockWakeWord?.fire() : clipNow}
            disabled={saving || (!live && !recording)}
            style={({ pressed }) => [
              styles.ring,
              pressed && styles.ringPressed,
              saving && styles.dimmed,
            ]}>
            {recording ? (
              <View style={styles.stopSquare} />
            ) : (
              <View style={styles.ringInner} />
            )}
          </Pressable>

          {/* Clip-now (right, redundant with voice) */}
          {!recording ? (
            <Pressable
              onPress={clipNow}
              disabled={!live}
              style={({ pressed }) => [
                styles.sideButton,
                pressed && styles.pressed,
                !live && styles.dimmed,
              ]}>
              <Text style={styles.scissorGlyph}>✂</Text>
              <Text style={styles.sideLabel}>Clip now</Text>
            </Pressable>
          ) : (
            <View style={styles.sideButton} />
          )}
        </View>

        <Text style={styles.deckCaption}>
          {recording
            ? 'everything since you started — plus the look-back — becomes one clip'
            : `clips reach back ${Math.round(status.bufferedSeconds)}s`}
        </Text>
      </View>
    </View>
  );
}

function statusLabel(status: CaptureStatus, recordingSecs: number): string {
  switch (status.state) {
    case 'idle':
      return 'Starting…';
    case 'arming':
      return 'Starting…';
    case 'armed':
      return `LIVE · ${Math.round(status.bufferedSeconds)}s buffered`;
    case 'recording':
      return `REC ${formatDuration(recordingSecs)}`;
    case 'saving':
      return 'Saving clip…';
    case 'error':
      return 'Something broke';
  }
}

const RING = 84;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pressed: { transform: [{ scale: 0.94 }], opacity: 0.9 },
  dimmed: { opacity: 0.35 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.m,
    zIndex: 2,
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeGlyph: { color: colors.text, fontSize: 16, fontWeight: '700' },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s,
    backgroundColor: colors.scrim,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s + 2,
  },
  statusPillRec: { backgroundColor: colors.accent },
  statusText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.3,
  },
  errorBanner: {
    position: 'absolute',
    top: 110,
    left: spacing.m,
    right: spacing.m,
    backgroundColor: colors.scrim,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    borderRadius: radius.s,
    padding: spacing.m,
    zIndex: 2,
  },
  errorText: { color: colors.warning, ...type.caption },
  toast: {
    position: 'absolute',
    bottom: 250,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s,
    backgroundColor: colors.scrim,
    borderWidth: 1,
    borderColor: colors.success,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s + 2,
    zIndex: 3,
  },
  toastCheck: { color: colors.success, fontSize: 15, fontWeight: '800' },
  toastText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  deck: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    gap: spacing.m,
    paddingTop: spacing.l,
    backgroundColor: colors.scrimLight,
  },
  hint: { color: colors.text, fontSize: 14, fontWeight: '600', opacity: 0.9 },
  deckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: spacing.xl,
  },
  ring: {
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 5,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringPressed: { transform: [{ scale: 0.93 }] },
  ringInner: {
    width: RING - 22,
    height: RING - 22,
    borderRadius: (RING - 22) / 2,
    backgroundColor: colors.accent,
  },
  stopSquare: {
    width: RING * 0.38,
    height: RING * 0.38,
    borderRadius: 6,
    backgroundColor: colors.accent,
  },
  sideButton: {
    width: 76,
    alignItems: 'center',
    gap: 6,
  },
  sideLabel: { color: colors.text, fontSize: 12, fontWeight: '600', opacity: 0.85 },
  extendedGlyph: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2.5,
    borderColor: colors.text,
  },
  scissorGlyph: { color: colors.text, fontSize: 20, fontWeight: '700' },
  elapsed: {
    color: colors.accent,
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  deckCaption: { color: colors.textDim, fontSize: 12 },
});
