import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import type { CaptureStatus } from '../../core/CaptureController';
import type { CaptureSession } from '../../services/capture';
import { useGlassesLease } from '../../device/glassesLease';
import { LiveActivity } from '../../native/LiveActivity';
import { GlassesPreview } from '../GlassesPreview';
import { RecDot } from '../components';
import { useCaptureSession } from '../hooks/useCaptureSession';
import type { RootStackParamList } from '../navigation';
import { formatDuration } from './LibraryScreen';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Armed'>;

/**
 * The live feed, isolated behind `React.memo`.
 *
 * The screen re-renders once a second to move its clocks. Text nodes are cheap
 * to reconcile; a `<Camera>` and the preview surface are not, and re-rendering
 * them on a 1 Hz timer meant the viewfinder was being reconciled 60 times a
 * minute for readouts it has nothing to do with.
 *
 * The camera ref matters just as much: an inline `ref={r => ...}` is a new
 * function identity every render, and React responds by calling the old one
 * with null and the new one with the instance — detaching and reattaching the
 * camera every single second.
 */
const Viewfinder = React.memo(function ViewfinderInner({
  session,
  onCameraReady,
}: {
  session: CaptureSession | null;
  onCameraReady: () => void;
}) {
  const device = useCameraDevice('back');
  const mockSource = session?.mockSource;
  const attachCamera = useCallback(
    (ref: Camera | null) => mockSource?.attachCamera(ref),
    [mockSource],
  );

  if (mockSource && device) {
    return (
      <Camera
        ref={attachCamera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        video
        audio
        // Arming before the phone camera has initialised fails, so the manager
        // waits to be told rather than guessing.
        onInitialized={onCameraReady}
      />
    );
  }
  if (session && !mockSource) {
    return <GlassesPreview style={StyleSheet.absoluteFill} />;
  }
  return null;
});
Viewfinder.displayName = 'Viewfinder';

/**
 * Always-on live view: the rolling buffer arms as soon as the session is
 * ready. Voice (“Clypso”) is the primary trigger; the on-screen
 * controls are a quiet clip / extended affordance, not a camera shutter.
 */
export function ArmedScreen({ navigation }: Props) {
  const isFocused = useIsFocused();
  const {
    status,
    session,
    recoveryExhausted,
    clipNow,
    startExtended,
    stopExtended,
    retry,
    notifySourceReady,
    lookBackSeconds,
  } = useCaptureSession(isFocused);
  const [now, setNow] = useState(Date.now());
  useGlassesLease(isFocused);
  const insets = useSafeAreaInsets();
  const toast = useRef(new Animated.Value(0)).current;
  const lastToastClip = useRef<string | null>(null);

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
  // so leaving the app does not mean losing sight of whether Clypso is armed.
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
    // Blurring is what releases capture — the manager reconciles on it, and
    // `useGlassesLease` closes the glasses session — so this only has to
    // navigate. Armed is reached two ways: pushed from Library, or replacing
    // Connect on boot. In the second case it is the only screen on the stack,
    // so goBack() has no target and React Navigation logs "The action
    // 'GO_BACK' was not handled by any navigator". Closing belongs in the
    // Library either way.
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('Library');
    }
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
        lookBackSeconds ?? status.bufferedSeconds,
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
          <Viewfinder session={session} onCameraReady={notifySourceReady} />

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
          <Text style={styles.errorText}>
            {recoveryExhausted
              ? // Automatic recovery is over, so the banner has to stop implying
                // something is still happening. Until now it showed the same
                // text whether a retry was seconds away or never coming.
                `${status.lastError} Capture is stopped.`
              : status.lastError}
          </Text>
          <Pressable onPress={retry} hitSlop={8}>
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
              : 'say “Clypso”'}
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
                ? stopExtended
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
