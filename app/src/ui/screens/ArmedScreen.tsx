import { useIsFocused } from '@react-navigation/native';
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
import { bump } from '../../debug/jsProbe';
import { useGlassesLease } from '../../device/glassesLease';
import type { CaptureSession } from '../../services/capture';
import { buildCaptureSession } from '../../services/capture';
import { LiveActivity } from '../../native/LiveActivity';
import { GlassesPreview } from '../GlassesPreview';
import { RecDot } from '../components';
import type { RootStackParamList } from '../navigation';
import { formatDuration } from './LibraryScreen';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Armed'>;

const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_DELAY_MS = 4000;

/**
 * Always-on live view: the rolling buffer arms as soon as the session is
 * ready. Voice (“Clipso”) is the primary trigger; the on-screen
 * controls are a quiet clip / extended affordance, not a camera shutter.
 */
export function ArmedScreen({ navigation }: Props) {
  bump('render.Armed');
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [status, setStatus] = useState<CaptureStatus>({
    state: 'idle',
    bufferedSeconds: 0,
    bufferedAsOf: Date.now(),
  });
  const [now, setNow] = useState(Date.now());
  const armedRef = useRef(false);
  /** Sticky, unlike `armedRef`: stays true across a disarm. */
  const hasArmedOnce = useRef(false);
  const recoveryAttempts = useRef(0);
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
      armedRef.current = false;
      session.controller.disarm().catch(() => {});
    };
  }, [session]);

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

  // One 1 Hz clock drives both readouts. It has to run while merely `armed`
  // too, not just while recording: `bufferedSeconds` is only re-measured when a
  // segment closes, so without a tick the "Xs buffered" readout sat frozen at
  // its last value for a whole SEGMENT_SECONDS and then jumped.
  useEffect(() => {
    if (status.state !== 'recording' && status.state !== 'armed') {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status.state]);

  // The Live Activity mirrors capture onto the Lock Screen and Dynamic Island,
  // so leaving the app does not mean losing sight of whether Clipso is armed.
  //
  // ActivityKit only allows a *start* from the foreground, which is exactly
  // when arming happens; updates and the end continue to work backgrounded.
  const capturing =
    status.state === 'armed' ||
    status.state === 'recording' ||
    status.state === 'saving';

  useEffect(() => {
    if (!capturing) {
      return;
    }
    LiveActivity.start('Meta glasses');
    // Ending here (rather than on unmount) keeps the banner alive exactly as
    // long as capture is: the screen stays mounted under the Library, and the
    // wearer backgrounding the app must NOT dismiss it.
    return () => {
      LiveActivity.end();
    };
  }, [capturing]);

  useEffect(() => {
    if (!capturing) {
      return;
    }
    LiveActivity.update(
      status.bufferedSeconds,
      status.sessionClipCount ?? 0,
      status.state === 'recording',
      status.recordingSince ?? 0,
    );
  }, [
    capturing,
    status.bufferedSeconds,
    status.sessionClipCount,
    status.state,
    status.recordingSince,
  ]);

  const goLibrary = () => {
    // Blur tears capture down (see the focus effect below) and `useGlassesLease`
    // closes the session, so this only has to navigate. Armed is reached two
    // ways: pushed from Library, or replacing Connect on boot. In the second
    // case it is the only screen on the stack, so goBack() has no target and
    // React Navigation logs "The action 'GO_BACK' was not handled by any
    // navigator". Closing belongs in the Library either way.
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('Library');
    }
  };

  const arm = useCallback(() => {
    if (!session || armedRef.current) {
      return;
    }
    armedRef.current = true;
    hasArmedOnce.current = true;
    session.controller.arm().catch(() => {
      // Status listener already surfaces the error; clear the latch so
      // refocusing can retry instead of sitting there permanently unarmed.
      armedRef.current = false;
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

  // A stalled or dropped glasses link leaves capture in `error`, and until now
  // the only way out was the wearer noticing the banner and tapping Retry —
  // which is exactly what they cannot do, because the phone is in a pocket and
  // the whole point is that Clipso keeps listening. Re-arm on its own, but a
  // bounded number of times: if the glasses are folded, flat or out of range,
  // renegotiating forever means a stop/start chime every few seconds and a
  // session that never settles. After the last attempt the banner stands and
  // Retry is the wearer's call.
  useEffect(() => {
    if (status.state === 'armed') {
      recoveryAttempts.current = 0;
      return;
    }
    if (
      status.state !== 'error' ||
      !isFocused ||
      !session ||
      recoveryAttempts.current >= MAX_RECOVERY_ATTEMPTS
    ) {
      return;
    }
    recoveryAttempts.current += 1;
    const timer = setTimeout(() => {
      armedRef.current = false;
      arm();
    }, RECOVERY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status.state, isFocused, session, arm]);

  // Coming back from the background: iOS may have torn the native session
  // down while we were away, so re-arm. Focus still gates it — if the user
  // backgrounded the app from the Library, nothing here should wake capture.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active' || !isFocused || !session || session.mockSource) {
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
  }, [isFocused, session, status.state, arm]);

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
  // How long this session has been listening. Free-running: it is a clock, not
  // a gauge, so it must NOT be capped at the look-back window the way
  // `bufferedSecs` is. Showing the capped number here made capture look like it
  // stopped after 30s when it was in fact still running.
  const armedSecs = status.armedSince
    ? Math.max(0, Math.round((now - status.armedSince) / 1000))
    : 0;
  // What is really in the look-back window right now: the last measurement plus
  // the time since, capped at the window the buffer actually keeps. This is the
  // one that is *meant* to plateau — it is how much a trigger would clip.
  const bufferedSecs = live
    ? Math.min(
        session?.controller.lookBackSeconds ?? status.bufferedSeconds,
        status.bufferedSeconds + (now - status.bufferedAsOf) / 1000,
      )
    : status.bufferedSeconds;

  return (
    <View style={styles.root}>
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
          <Text style={styles.statusText}>
            {statusLabel(status, recordingSecs, armedSecs)}
          </Text>
        </View>

        <Pressable
          onPress={() => navigation.navigate('Settings')}
          hitSlop={12}
          style={({ pressed }) => [styles.chromeButton, pressed && styles.pressed]}>
          <Text style={styles.chromeLabel}>Settings</Text>
        </Pressable>
      </View>

      {/* The feed is a framed viewfinder, not a full-bleed wall of video: this
          screen is a monitor for what the glasses see, and the frame keeps the
          eye on the status/deck chrome rather than the footage. */}
      <View style={styles.stage}>
        <View style={[styles.viewfinder, recording && styles.viewfinderRec]}>
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
            <Text style={styles.toastText}>
              {status.sessionClipCount
                ? `Save #${status.sessionClipCount} — in your library`
                : 'Saved to library'}
            </Text>
          </Animated.View>
        </View>
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
              ? `listening · last ${Math.floor(bufferedSecs)}s ready to clip${
                  status.sessionClipCount
                    ? ` · ${status.sessionClipCount} saved this session`
                    : ''
                }`
              : 'opening the glasses feed…'}
        </Text>
      </View>
    </View>
  );
}

function statusLabel(
  status: CaptureStatus,
  recordingSecs: number,
  armedSecs: number,
): string {
  switch (status.state) {
    case 'idle':
    case 'arming':
      return 'Starting…';
    case 'armed':
      return `LIVE · ${formatDuration(armedSecs)}`;
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.m,
    paddingBottom: spacing.m,
    gap: spacing.s,
  },
  stage: {
    flex: 1,
    paddingHorizontal: spacing.m,
    justifyContent: 'center',
  },
  viewfinder: {
    flex: 1,
    borderRadius: radius.l,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#000',
  },
  viewfinderRec: { borderColor: colors.accent },
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
    marginHorizontal: spacing.m,
    marginTop: spacing.m,
    backgroundColor: colors.scrim,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    borderRadius: radius.s,
    padding: spacing.m,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.m,
  },
  errorText: { color: colors.warning, fontSize: 13, flex: 1 },
  retryText: { color: colors.text, fontSize: 13, fontWeight: '800' },
  toast: {
    position: 'absolute',
    bottom: spacing.m,
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
    alignItems: 'center',
    gap: spacing.m,
    paddingTop: spacing.l,
    paddingHorizontal: spacing.m,
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
