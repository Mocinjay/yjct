import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useGlassesLease } from '../../device/glassesLease';
import {
  MWDATNative,
  mwdatAvailable,
  mwdatEvents,
  mwdatIsSimulator,
  type MWDATDiagnostics,
  type MWDATStateEvent,
} from '../../native/MWDATNative';
import { GlassesPreview } from '../GlassesPreview';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

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
  const [diag, setDiag] = useState<MWDATDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  /** Bumped to make the auto-open effect try again (Retry, return to the foreground). */
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [mockReady, setMockReady] = useState(!AUTO_MOCK);

  useEffect(() => {
    if (!AUTO_MOCK) {
      return;
    }
    MWDATNative.mockEnable()
      .then(() => console.log('[connect] mock glasses paired'))
      .catch(e => setError(String(e?.message ?? e)))
      .finally(() => setMockReady(true));
  }, []);

  // One getDiagnostics() at a time. It can take up to 3s (it checks the
  // camera permission with Meta AI) while the poll fires every 2s and every
  // SDK event asks too, so unchecked calls pile up and resolve out of order,
  // letting an old snapshot overwrite a newer one. Requests made while one is
  // running are answered by a single follow-up call.
  const diagInFlight = useRef(false);
  const diagQueued = useRef(false);
  const refresh = useCallback(() => {
    if (!mwdatAvailable()) {
      setError('Meta glasses support is iOS-only for now.');
      return;
    }
    if (diagInFlight.current) {
      diagQueued.current = true;
      return;
    }
    diagInFlight.current = true;
    const run = (): void => {
      MWDATNative.getDiagnostics()
        .then(setDiag)
        .catch(e => setError(String(e?.message ?? e)))
        .finally(() => {
          if (diagQueued.current) {
            diagQueued.current = false;
            run();
          } else {
            diagInFlight.current = false;
          }
        });
    };
    run();
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    if (!mwdatAvailable()) {
      return () => clearInterval(timer);
    }
    const emitter = mwdatEvents();
    const subs = [
      emitter.addListener('MWDATRegistrationState', refresh),
      emitter.addListener('MWDATDevices', refresh),
      emitter.addListener('MWDATError', (e: { message: string }) =>
        setError(e.message),
      ),
      emitter.addListener(
        'MWDATStreamState',
        (e: MWDATStateEvent) => {
          refresh();
          // Background/terminate releases the glasses session. Clear the
          // latch; AppState 'active' below reopens the feed once foregrounded.
          // Do not bump previewEpoch here: that would reopen while still
          // backgrounded and bring back the start/stop chime loop.
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
    return () => {
      clearInterval(timer);
      subs.forEach(s => s.remove());
    };
  }, [refresh]);

  const registered = diag?.registration === 'registered';
  const device = diag?.devices[0] ?? null;
  const streaming = diag?.streamState === 'streaming';
  // Every getDiagnostics() returns new objects, so effects key on these
  // primitives rather than `device`: a poll that changed nothing must not
  // re-run them.
  const hasDevice = device != null;
  const linkState = device?.linkState ?? null;

  // Native tears the session down on background. When we come back, reopen.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        return;
      }
      if (previewStarted.current || previewing) {
        return;
      }
      if ((!registered && !AUTO_MOCK) || !hasDevice) {
        return;
      }
      setError(null);
      setPreviewEpoch(n => n + 1);
    });
    return () => sub.remove();
  }, [registered, hasDevice, previewing]);

  // As soon as we're registered with a device in sight, open the live view.
  //
  // A failed open is retried when the glasses' link state changes, on Retry,
  // or on returning to the foreground; not on every poll. Never while
  // backgrounded: native releases a preview-only session on background, and
  // reopening it there brings back the start/stop chime loop. The check is
  // `=== 'background'`, not `!== 'active'`: early in launch, or under a
  // system sheet, currentState can read 'unknown' or 'inactive', and the open
  // must go ahead then.
  //
  // `linkState` is a dependency only as a retry trigger; the body does not
  // read it.
  useEffect(() => {
    if (
      (!registered && !AUTO_MOCK) ||
      !mockReady ||
      !hasDevice ||
      !isFocused ||
      previewStarted.current ||
      AppState.currentState === 'background'
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
      } catch (e: any) {
        setError(String(e?.message ?? e));
        previewStarted.current = false; // allow retry
      } finally {
        setBusy(null);
      }
    })();
  }, [registered, hasDevice, linkState, mockReady, previewEpoch, isFocused]);

  // Once the glasses feed is live, go straight into the always-on live view.
  // Buffering starts there automatically; there is no "start recording" step.
  useEffect(() => {
    if (!streaming || (!registered && !AUTO_MOCK) || leftConnect.current) {
      return;
    }
    const t = setTimeout(() => {
      if (leftConnect.current) {
        return;
      }
      leftConnect.current = true;
      // The delay lets the stream settle before Armed attaches the writer;
      // attaching at once can race a teardown and shut the glasses off.
      navigation.reset({ index: 0, routes: [{ name: 'Armed' }] });
    }, AUTO_MOCK ? 1200 : 1600);
    return () => clearTimeout(t);
  }, [streaming, registered, navigation]);

  const connect = async () => {
    setBusy('Waiting for Meta AI…');
    setError(null);
    try {
      await MWDATNative.startRegistration();
    } catch (e: any) {
      setError(String(e?.message ?? e));
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
