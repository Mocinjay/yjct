import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  MWDATNative,
  mwdatAvailable,
  mwdatEvents,
  mwdatIsSimulator,
  type MWDATDiagnostics,
} from '../../native/MWDATNative';

/** Simulator dev builds run against MockDeviceKit glasses automatically. */
const AUTO_MOCK = __DEV__ && mwdatIsSimulator();
import { GlassesPreview } from '../GlassesPreview';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

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

  const refresh = useCallback(() => {
    if (!mwdatAvailable()) {
      setError('Meta glasses support is iOS-only for now.');
      return;
    }
    MWDATNative.getDiagnostics()
      .then(setDiag)
      .catch(e => setError(String(e?.message ?? e)));
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
    ];
    return () => {
      clearInterval(timer);
      subs.forEach(s => s.remove());
    };
  }, [refresh]);

  const registered = diag?.registration === 'registered';
  const device = diag?.devices[0] ?? null;
  const streaming = diag?.streamState === 'streaming';

  // As soon as we're registered with a device in sight, open the live view.
  useEffect(() => {
    if ((!registered && !AUTO_MOCK) || !mockReady || !device || previewStarted.current) {
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
  }, [registered, device, mockReady]);

  // Dev/simulator: once mock frames flow, walk into the Armed screen so the
  // whole record pipeline can be exercised hands-free.
  useEffect(() => {
    if (!AUTO_MOCK || !streaming) {
      return;
    }
    const t = setTimeout(() => {
      console.log('[connect] mock streaming — auto-advancing to Armed');
      navigation.replace('Armed');
    }, 5000);
    return () => clearTimeout(t);
  }, [streaming, navigation]);

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
    setError(null);
    refresh();
  };

  const proceed = () => {
    navigation.replace('Armed');
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>● JARVIS</Text>
      <Text style={styles.title}>Link your{'\n'}Meta glasses.</Text>

      <View style={styles.previewBox}>
        {previewing ? (
          <GlassesPreview style={styles.preview} />
        ) : (
          <View style={styles.previewPlaceholder}>
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
          <Text style={styles.ctaText}>Start clipping</Text>
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
        on (Meta AI → Settings → App Info → tap App version 5×) · Jarvis
        enabled under Meta AI → Settings → App connections.
      </Text>

      <Pressable onPress={() => navigation.replace('Library')}>
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
