import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { createLogger } from '../../core/Logger';
import { describe } from '../../core/errors';
import { useGlassesLease } from '../../device/glassesLease';
import {
  MWDATNative,
  mwdatAvailable,
  mwdatEvents,
  mwdatIsSimulator,
} from '../../native/MWDATNative';
import { GlassesPreview } from '../GlassesPreview';
import { useGlassesDiagnostics } from '../hooks/useGlassesDiagnostics';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

const log = createLogger('connect');

/** Simulator dev builds run against MockDeviceKit glasses automatically. */
const AUTO_MOCK = __DEV__ && mwdatIsSimulator();

type Props = NativeStackScreenProps<RootStackParamList, 'Connect'>;

/**
 * Boot gate: nothing else happens until the glasses are linked and streaming.
 * Shows the raw SDK truth (registration, devices, link, compatibility) so a
 * failed connection says exactly which stage is broken, then a live wearer's
 * view before handing off to the Armed screen.
 */
export function ConnectScreen({ navigation }: Props) {
  const {
    diagnostics: diag,
    error,
    setError,
    refresh,
  } = useGlassesDiagnostics();
  const [busy, setBusy] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewStarted = useRef(false);
  /** Set when the user leaves Connect so the auto-advance timer cannot yank them back. */
  const leftConnect = useRef(false);
  const isFocused = useIsFocused();
  useGlassesLease(isFocused);

  // The lease closes the glasses session once no screen holds it, so leaving
  // this screen must also clear the "already opened" latch — otherwise coming
  // back would find `previewStarted` still true and never reopen the feed.
  useEffect(() => {
    if (isFocused) {
      return;
    }
    previewStarted.current = false;
    setPreviewing(false);
  }, [isFocused]);
  /** Bumped when native tears the stream down so the auto-open effect re-runs. */
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [mockReady, setMockReady] = useState(!AUTO_MOCK);

  useEffect(() => {
    if (!AUTO_MOCK) {
      return;
    }
    MWDATNative.mockEnable()
      .then(() => log.info('mock glasses paired'))
      .catch(err => setError(describe(err)))
      .finally(() => setMockReady(true));
  }, [setError]);

  useEffect(() => {
    if (!mwdatAvailable()) {
      return;
    }
    const emitter = mwdatEvents();
    const subs = [
      emitter.addListener(
        'MWDATStreamState',
        (e: { state: string; reason?: string }) => {
          refresh();
          // Background/terminate releases the glasses session. Clear the
          // latch; AppState 'active' below reopens the feed once foregrounded.
          // Do not bump previewEpoch here — that would reopen while still
          // backgrounded and recreate the start/stop chime loop.
          if (
            previewStarted.current &&
            (e.state === 'stopped' || e.state === 'none')
          ) {
            previewStarted.current = false;
            setPreviewing(false);
            if (e.reason) {
              setError(
                `Glasses feed released (${e.reason}). Reopening when you return…`,
              );
            }
          }
        },
      ),
    ];
    return () => subs.forEach(s => s.remove());
  }, [refresh, setError]);

  const registered = diag?.registration === 'registered';
  /**
   * Meta AI was handed control and has not handed it back.
   *
   * The SDK enters this the moment `startRegistration()` returns and leaves it
   * only on the callback, so a Meta AI that fails on its own side leaves the
   * app here with nothing to time it out. Coming back to a screen that looks
   * idle is the whole reported symptom, so it is named.
   */
  const registering = diag?.registration === 'registering';
  const device = diag?.devices[0] ?? null;
  const streaming = diag?.streamState === 'streaming';

  // A failed link reports itself from the native URL callback and the message
  // stays put on purpose — the wearer is coming back from the Meta AI app and
  // needs to read it. Once the link actually completes it is contradicting the
  // status rows above it, so it goes. Keyed on the transition, not on every
  // render, so a genuine failure raised *while* registered still stands.
  useEffect(() => {
    if (registered) {
      setError(null);
    }
  }, [registered, setError]);

  // Returning to the app still in `registering` means Meta AI did not finish.
  // Nothing else reports it: no state changed, so no listener fires, and the
  // callback that would have carried the error never arrived.
  useEffect(() => {
    if (!registering) {
      return;
    }
    setError(
      'Meta AI did not finish linking — it never handed control back. ' +
        'Open Meta AI → Settings → App connections and remove Clypso if it is ' +
        'listed, check Developer Mode is on for your glasses, then tap ' +
        '“Reset the Meta AI link” below and connect again.',
    );
  }, [registering, setError]);

  // Native tears the session down on background. When we come back, reopen.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        return;
      }
      if (previewStarted.current || previewing) {
        return;
      }
      if ((!registered && !AUTO_MOCK) || !device) {
        return;
      }
      setError(null);
      setPreviewEpoch(n => n + 1);
    });
    return () => sub.remove();
  }, [registered, device, previewing, setError]);

  // As soon as we're registered with a device in sight, open the live view.
  useEffect(() => {
    if (
      (!registered && !AUTO_MOCK) ||
      !mockReady ||
      !device ||
      !isFocused ||
      previewStarted.current
    ) {
      return;
    }
    previewStarted.current = true;
    (async () => {
      try {
        setBusy('Opening the glasses camera…');
        await MWDATNative.prepare();
        await MWDATNative.startPreview();
        setPreviewing(true);
        setError(null);
      } catch (err) {
        setError(describe(err));
        previewStarted.current = false; // allow retry
      } finally {
        setBusy(null);
      }
    })();
  }, [registered, device, mockReady, previewEpoch, isFocused, setError]);

  // Once the glasses feed is live, go straight into the always-on live view.
  // Buffering starts there automatically — no separate "start recording" step.
  useEffect(() => {
    if (!streaming || (!registered && !AUTO_MOCK) || leftConnect.current) {
      return;
    }
    const t = setTimeout(() => {
      if (leftConnect.current) {
        return;
      }
      leftConnect.current = true;
      // Give the stream a beat to settle before Live attaches the writer —
      // jumping too early was racing a teardown and shutting the glasses off.
      navigation.reset({ index: 0, routes: [{ name: 'Armed' }] });
    }, AUTO_MOCK ? 1200 : 1600);
    return () => clearTimeout(t);
  }, [streaming, registered, navigation]);

  const connect = async () => {
    setBusy('Waiting for Meta AI…');
    setError(null);
    try {
      await MWDATNative.startRegistration();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(null);
    }
  };

  // The link can stall in `registering` — Meta AI was handed control and never
  // handed it back. Nothing about that state expires, and "Connect through
  // Meta AI" only re-enters it, so the wearer needs a way to start over. Kept
  // next to Skip rather than in the main flow: it is a repair, not a step.
  const resetLink = async () => {
    setBusy('Resetting the Meta AI link…');
    setError(null);
    try {
      await MWDATNative.unregister();
      refresh();
      setError('Link reset. Tap “Connect through Meta AI” to link again.');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(null);
    }
  };

  const retryPreview = () => {
    previewStarted.current = false;
    setPreviewing(false);
    setError(null);
    setPreviewEpoch(n => n + 1);
    refresh();
  };

  const proceed = () => {
    leftConnect.current = true;
    navigation.reset({ index: 0, routes: [{ name: 'Armed' }] });
  };

  const skipToLibrary = () => {
    leftConnect.current = true;
    navigation.reset({ index: 0, routes: [{ name: 'Library' }] });
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>● CLYPSO</Text>
      <Text style={styles.title}>Link your{'\n'}Meta glasses.</Text>

      <View style={styles.previewBox}>
        {/* Mounted unconditionally: GlassesPreview attaches the frame listener
            on mount, so gating it on `previewing` would only subscribe *after*
            the native stream had already started and dropped its first frames. */}
        <GlassesPreview style={styles.preview} />
        {!previewing && (
          <View style={[styles.previewPlaceholder, StyleSheet.absoluteFill]}>
            <Text style={styles.placeholderText}>
              {busy ?? 'The wearer’s view appears here once linked.'}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.statusCard}>
        <StatusRow
          label="Meta AI link"
          value={diag?.registration ?? '…'}
          good={registered}
        />
        <StatusRow
          label="Glasses"
          value={
            device
              ? `${device.name} · ${device.linkState}`
              : 'none found'
          }
          good={device?.linkState === 'connected'}
        />
        {device ? (
          <StatusRow
            label="Compatibility"
            value={device.compatibility}
            good={device.compatibility.toLowerCase() === 'compatible'}
          />
        ) : null}
        <StatusRow
          label="Glasses camera"
          value={diag?.cameraPermission ?? '…'}
          good={diag?.cameraPermission === 'granted'}
        />
        <StatusRow
          label="Camera stream"
          value={diag?.streamState ?? '…'}
          good={streaming}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!registered ? (
        <Pressable
          style={[styles.cta, busy != null && styles.ctaDisabled]}
          disabled={busy != null}
          onPress={connect}>
          <Text style={styles.ctaText}>
            {busy ?? 'Connect through Meta AI'}
          </Text>
        </Pressable>
      ) : streaming ? (
        <Pressable style={styles.cta} onPress={proceed}>
          <Text style={styles.ctaText}>Continue to live view</Text>
        </Pressable>
      ) : (
        <Pressable
          style={[styles.cta, busy != null && styles.ctaDisabled]}
          disabled={busy != null}
          onPress={retryPreview}>
          <Text style={styles.ctaText}>{busy ?? 'Retry glasses feed'}</Text>
        </Pressable>
      )}

      <Text style={styles.hint}>
        Glasses unfolded and on your head · paired in Meta AI · Developer Mode
        on (Meta AI → Settings → App Info → tap App version 5×) · Clypso
        enabled under Meta AI → Settings → App connections.
        {streaming ? '\n\nOpening live view…' : ''}
      </Text>

      {!registered ? (
        <Pressable onPress={resetLink} disabled={busy != null}>
          <Text style={styles.skip}>Reset the Meta AI link</Text>
        </Pressable>
      ) : null}

      <Pressable onPress={skipToLibrary}>
        <Text style={styles.skip}>Skip to library</Text>
      </Pressable>
    </ScrollView>
  );
}

function StatusRow({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good: boolean;
}) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={[styles.statusValue, good ? styles.good : styles.bad]}>
        {good ? '● ' : '○ '}
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.l, paddingTop: 72, gap: spacing.m },
  kicker: { color: colors.accent, fontSize: 13, fontWeight: '800', letterSpacing: 2 },
  title: { color: colors.text, fontSize: 40, fontWeight: '800', lineHeight: 44 },
  previewBox: {
    height: 260,
    borderRadius: radius.m,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#000',
  },
  preview: { flex: 1 },
  previewPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: colors.textFaint, fontSize: 13, textAlign: 'center', padding: spacing.m },
  statusCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.m,
    padding: spacing.m,
    gap: spacing.s,
  },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.m },
  statusLabel: { color: colors.textDim, fontSize: 14 },
  statusValue: { fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  good: { color: '#3ADC84' },
  bad: { color: colors.warning },
  error: { color: colors.warning, fontSize: 13, lineHeight: 18 },
  cta: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: spacing.m,
    alignItems: 'center',
  },
  ctaDisabled: { opacity: 0.5 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  hint: { color: colors.textFaint, fontSize: 12, lineHeight: 17 },
  skip: {
    color: colors.textDim,
    fontSize: 13,
    textAlign: 'center',
    textDecorationLine: 'underline',
    paddingVertical: spacing.s,
  },
});
