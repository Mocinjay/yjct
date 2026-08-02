import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import type { CaptureStatus } from '../../core/CaptureController';
import type { CaptureSession } from '../../services/capture';
import { buildCaptureSession } from '../../services/capture';
import { MWDATNative, mwdatAvailable } from '../../native/MWDATNative';
import { GlassesPreview } from '../GlassesPreview';
import { RecDot } from '../components';
import type { RootStackParamList } from '../navigation';
import { formatDuration } from './LibraryScreen';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Armed'>;

/**
 * Always-on live view: the rolling buffer arms as soon as the session is
 * ready. Voice (“Clipso”) is the primary trigger; the on-screen
 * controls are a quiet clip / extended affordance, not a camera shutter.
 */
export function ArmedScreen({ navigation }: Props) {
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [status, setStatus] = useState<CaptureStatus>({
    state: 'idle',
    bufferedSeconds: 0,
  });
  const [now, setNow] = useState(Date.now());
  const armedRef = useRef(false);
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

  const arm = useCallback(() => {
    if (!session || armedRef.current) {
      return;
    }
    armedRef.current = true;
    session.controller.arm().catch(() => {
      armedRef.current = false;
    });
  }, [session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const unsubscribe = session.controller.subscribe(setStatus);
    return () => {
      unsubscribe();
      armedRef.current = false;
      session.controller.disarm().catch(() => {});
    };
  }, [session]);

  // Glasses (and mock once the viewfinder is ready): buffer immediately —
  // there is no separate "press to start recording" step.
  useEffect(() => {
    if (session && !session.mockSource) {
      arm();
    }
  }, [session, arm]);

  // After a background release, the native session is gone — re-arm on return.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active' || !session || session.mockSource) {
        return;
      }
      if (
        status.state === 'armed' ||
        status.state === 'recording' ||
        status.state === 'arming'
      ) {
        return;
      }
      armedRef.current = false;
      arm();
    });
    return () => sub.remove();
  }, [session, status.state, arm]);

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

  useEffect(() => {
    if (status.state !== 'recording') {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status.state]);

  const goLibrary = () => {
    // Leaving Live for good: release the glasses capture slot entirely.
    armedRef.current = false;
    const release = async () => {
      try {
        await session?.controller.disarm();
      } catch {
        // ignore
      }
      if (mwdatAvailable()) {
        await MWDATNative.stop().catch(() => {});
      }
      navigation.reset({ index: 0, routes: [{ name: 'Library' }] });
    };
    release();
  };

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

      <View style={[styles.topBar, { paddingTop: insets.top + spacing.s }]}>
        <Pressable
          onPress={goLibrary}
          hitSlop={12}
          style={({ pressed }) => [styles.chromeButton, pressed && styles.pressed]}>
          <Text style={styles.chromeGlyph}>←</Text>
          <Text style={styles.chromeLabel}>Library</Text>
        </Pressable>

        <View style={[styles.statusPill, recording && styles.statusPillRec]}>
          <RecDot size={8} live={live || recording} />
          <Text style={styles.statusText}>{statusLabel(status, recordingSecs)}</Text>
        </View>

        <Pressable
          onPress={() => navigation.navigate('Settings')}
          hitSlop={12}
          style={({ pressed }) => [styles.chromeButton, pressed && styles.pressed]}>
          <Text style={styles.chromeLabel}>Settings</Text>
        </Pressable>
      </View>

      {status.lastError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{status.lastError}</Text>
          <Pressable
            onPress={() => {
              armedRef.current = false;
              arm();
            }}
            hitSlop={8}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

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

      <View style={[styles.deck, { paddingBottom: insets.bottom + spacing.l }]}>
        <Text style={styles.voiceHint}>
          {recording
            ? 'extended clip — tap Stop when you’re done'
            : session?.mockWakeWord
              ? 'mock mode — tap Clip to save the look-back'
              : 'say “Clipso”'}
        </Text>

        <View style={styles.actions}>
          {!recording ? (
            <Pressable
              onPress={startExtended}
              disabled={!live}
              style={({ pressed }) => [
                styles.secondaryBtn,
                pressed && styles.pressed,
                !live && styles.dimmed,
              ]}>
              <Text style={styles.secondaryLabel}>Extended</Text>
            </Pressable>
          ) : (
            <View style={styles.secondaryBtn}>
              <Text style={styles.elapsed}>{formatDuration(recordingSecs)}</Text>
            </View>
          )}

          <Pressable
            onPress={
              recording
                ? stop
                : session?.mockWakeWord
                  ? () => session.mockWakeWord?.fire()
                  : clipNow
            }
            disabled={saving || (!live && !recording)}
            style={({ pressed }) => [
              styles.primaryBtn,
              recording && styles.primaryBtnStop,
              pressed && styles.pressed,
              saving && styles.dimmed,
            ]}>
            <Text style={styles.primaryLabel}>
              {saving ? 'Saving…' : recording ? 'Stop' : 'Clip'}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.deckCaption}>
          {recording
            ? 'look-back plus everything since you started'
            : live
              ? `listening · ${Math.round(status.bufferedSeconds)}s buffered`
              : 'opening the glasses feed…'}
        </Text>
      </View>
    </View>
  );
}

function statusLabel(status: CaptureStatus, recordingSecs: number): string {
  switch (status.state) {
    case 'idle':
    case 'arming':
      return 'Starting…';
    case 'armed':
      return `LIVE · ${Math.round(status.bufferedSeconds)}s`;
    case 'recording':
      return `REC ${formatDuration(recordingSecs)}`;
    case 'saving':
      return 'Saving…';
    case 'error':
      return 'Error';
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pressed: { opacity: 0.85 },
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
    gap: spacing.s,
  },
  chromeButton: {
    minWidth: 72,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: colors.scrim,
    paddingHorizontal: spacing.m,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  chromeGlyph: { color: colors.text, fontSize: 16, fontWeight: '700' },
  chromeLabel: { color: colors.text, fontSize: 13, fontWeight: '700' },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s,
    backgroundColor: colors.scrim,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s + 2,
    flexShrink: 1,
  },
  statusPillRec: { backgroundColor: colors.accent },
  statusText: {
    color: colors.text,
    fontSize: 13,
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.m,
  },
  errorText: { color: colors.warning, fontSize: 13, flex: 1 },
  retryText: { color: colors.text, fontSize: 13, fontWeight: '800' },
  toast: {
    position: 'absolute',
    bottom: 200,
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
    paddingHorizontal: spacing.m,
    backgroundColor: colors.scrimLight,
  },
  voiceHint: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    opacity: 0.95,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.m,
    width: '100%',
  },
  secondaryBtn: {
    minWidth: 100,
    height: 48,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.m,
  },
  secondaryLabel: { color: colors.text, fontSize: 14, fontWeight: '700' },
  primaryBtn: {
    minWidth: 140,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.l,
  },
  primaryBtnStop: { backgroundColor: colors.text },
  primaryLabel: { color: '#fff', fontSize: 17, fontWeight: '800' },
  elapsed: {
    color: colors.accent,
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  deckCaption: { color: colors.textDim, fontSize: 12, textAlign: 'center' },
});
