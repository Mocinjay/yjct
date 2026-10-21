import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { CaptureStatus } from '../../core/CaptureController';
import { useGlassesLease } from '../../device/glassesLease';
import type { CaptureSession } from '../../services/capture';
import { buildCaptureSession } from '../../services/capture';
import { LiveActivity } from '../../native/LiveActivity';
import { GlassesPreview } from '../GlassesPreview';
import { RecDot } from '../components';
import { formatDuration } from '../format';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Armed'>;

/** Automatic re-arms after capture drops into `error` (see the recovery effect). */
const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_DELAY_MS = 4000;

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
    bufferedAsOf: Date.now(),
  });
  const [now, setNow] = useState(Date.now());
  /** Set while an arm() is in flight or has succeeded; cleared by disarm or a failed arm. */
  const armedRef = useRef(false);
  /** Automatic re-arms made since capture was last live. */
  const recoveryAttempts = useRef(0);
  const isFocused = useIsFocused();
  useGlassesLease(isFocused);
  const insets = useSafeAreaInsets();
  const toast = useRef(new Animated.Value(0)).current;
  // Created once: a new interpolation node per render would make Animated
  // rebuild the toast's native animation graph on every 1 Hz clock tick.
  const toastY = useMemo(
    () => toast.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }),
    [toast],
  );
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

  // One 1 Hz clock drives the session/recording clocks and the buffered
  // readout. It runs while `armed` too: `bufferedSeconds` is only re-measured
  // when a segment closes, so the readout is extrapolated between segments.
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
  // ActivityKit only allows a *start* from the foreground; updates and the end
  // work from the background. The auto-recovery below re-arms from the
  // background (the phone is usually pocketed), so the activity is kept up
  // while a recovery is under way rather than ended and started again: that
  // second start would be refused and the banner lost for the rest of the
  // session. It ends when capture stops for good: blur, unmount, or recovery
  // giving up.
  //
  // `recoveryAttempts` is read during render on purpose. It changes only just
  // before an automatic arm(), whose 'arming' re-renders, so in 'error' it
  // says exactly what the recovery effect will do: retry, or give up.
  const recovering =
    isFocused &&
    session != null &&
    (status.state === 'arming' ||
      (status.state === 'error' &&
        recoveryAttempts.current < MAX_RECOVERY_ATTEMPTS));
  const capturing =
    status.state === 'armed' ||
    status.state === 'recording' ||
    status.state === 'saving' ||
    recovering;

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
    // Blur disarms capture (see the focus effects below) and `useGlassesLease`
    // closes the session, so this only navigates. Connect and the Library's
    // "Go live" both reset the stack to Armed, so there is normally nothing to
    // go back to and the Library is pushed on top.
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
    session.controller.arm().catch(() => {
      // The status listener already shows the error. Clearing the latch lets
      // the recovery effect, Retry, refocus or a return to the foreground
      // arm again.
      armedRef.current = false;
    });
  }, [session]);

  // Capture follows FOCUS, not mount: React Navigation keeps this screen
  // mounted under the Library and the clip player, and nothing up there needs
  // the wearer's feed. Arm when the screen gains focus; `useGlassesLease`
  // closes the glasses session once no screen holds it.
  //
  // Deliberately not keyed on the capture state: re-arming after an error is
  // the job of the bounded, delayed auto-recovery below. Re-running this on
  // state changes would retry a failed arm at once, without limit (a failed
  // arm clears `armedRef` before React renders its 'error').
  useEffect(() => {
    if (!session || !isFocused) {
      return;
    }
    arm();
  }, [isFocused, session, arm]);

  // Once blurred, disarm. Keyed on the state so that a manual extended
  // recording or an in-flight save, which own the writer and are never
  // interrupted, are disarmed as soon as they finish.
  useEffect(() => {
    if (!session || isFocused) {
      return;
    }
    if (status.state === 'recording' || status.state === 'saving') {
      return;
    }
    armedRef.current = false;
    session.controller.disarm().catch(() => {});
  }, [isFocused, session, status.state]);

  // A stalled or dropped glasses link (or a failed arm) leaves capture in
  // `error`. Re-arm automatically, since the phone is usually pocketed, but at
  // most MAX_RECOVERY_ATTEMPTS times, RECOVERY_DELAY_MS apart: with the
  // glasses folded, flat or out of range, retrying forever means a stop/start
  // chime every few seconds. After that the banner and its Retry button stay.
  //
  // An attempt is counted when it is made, not when it is scheduled, so a
  // timer cancelled by blur or by a foreground re-arm costs nothing. The Live
  // Activity's `recovering` relies on that (see above).
  useEffect(() => {
    // A re-arm during an extended recording resumes it, landing in 'recording'
    // rather than 'armed': still a recovery that worked.
    if (status.state === 'armed' || status.state === 'recording') {
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
    const timer = setTimeout(() => {
      recoveryAttempts.current += 1;
      armedRef.current = false;
      arm();
    }, RECOVERY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status.state, isFocused, session, arm]);

  // Coming back from the background: iOS may have torn the native session
  // down while we were away, so re-arm. Focus still gates it: if the user
  // backgrounded the app from the Library, nothing here should wake capture.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active' || !isFocused || !session) {
        return;
      }
      // Only a session that is down. Re-arming over a save in flight (a
      // "Clipso" said with the phone pocketed, then the app opened) would
      // reset the session's clip count and show "Starting…" over the save.
      if (status.state !== 'idle' && status.state !== 'error') {
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
  // How long this session has been listening: a clock, not a gauge, so unlike
  // `bufferedSecs` it is not capped at the look-back window.
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
          {/* Not gated on `session`, which is built asynchronously: mounting
              with the screen lets this preview claim the feed within the tick
              GlassesPreview waits after Connect's preview lets it go, so the
              Connect → Armed reset does not switch emission off and on again
              (which also resets the native preview decoder). */}
          <GlassesPreview style={StyleSheet.absoluteFill} />

          <Animated.View
            pointerEvents="none"
            style={[
              styles.toast,
              { opacity: toast, transform: [{ translateY: toastY }] },
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
          {/* Retry re-arms, so only while capture is down. A failed save
              leaves capture live with its error showing; re-arming then would
              restart the feed and do nothing for the save. */}
          {status.state === 'error' || status.state === 'idle' ? (
            <Pressable
              onPress={() => {
                armedRef.current = false;
                arm();
              }}
              hitSlop={8}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          ) : null}
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
