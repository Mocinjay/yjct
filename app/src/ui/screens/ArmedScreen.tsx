import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import type { CaptureStatus } from '../../core/CaptureController';
import type { CaptureSession } from '../../services/capture';
import { buildCaptureSession } from '../../services/capture';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Armed'>;

export function ArmedScreen({ navigation }: Props) {
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [status, setStatus] = useState<CaptureStatus>({
    state: 'idle',
    bufferedSeconds: 0,
  });
  const [now, setNow] = useState(Date.now());
  const armedRef = useRef(false);
  const device = useCameraDevice('back');

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
    session.controller.arm().catch(() => {
      // status listener already reflects the error
    });
  }, [session]);

  // MWDAT (no viewfinder to wait for): arm as soon as the session exists.
  useEffect(() => {
    if (session && !session.mockSource) {
      arm();
    }
  }, [session, arm]);

  const sayWakePhrase = () => session?.mockWakeWord?.fire();
  const startExtended = () => session?.controller.startClip();
  const stop = () => {
    session?.controller.stopClip().catch(() => {});
  };

  const recording = status.state === 'recording';
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
      ) : null}

      <View style={styles.overlay}>
        <View style={[styles.statusPill, recording && styles.statusPillRec]}>
          <Text style={styles.statusText}>
            {statusLabel(status, recordingSecs)}
          </Text>
        </View>

        {status.lastError ? (
          <Text style={styles.error}>{status.lastError}</Text>
        ) : null}

        {status.lastClip && !recording ? (
          <Text style={styles.saved}>Saved “{status.lastClip.name}”</Text>
        ) : null}

        <View style={styles.controls}>
          {recording ? (
            <Pressable style={styles.stopButton} onPress={stop}>
              <Text style={styles.triggerText}>■ Stop & save clip</Text>
            </Pressable>
          ) : (
            <>
              {session?.mockWakeWord ? (
                <Pressable style={styles.triggerButton} onPress={sayWakePhrase}>
                  <Text style={styles.triggerText}>
                    “Yo Jarvis, clip that” (mock) — save last 30s
                  </Text>
                </Pressable>
              ) : (
                <Text style={styles.listening}>
                  Say “Jarvis” to clip the last moments…
                </Text>
              )}
              <Pressable style={styles.extendedButton} onPress={startExtended}>
                <Text style={styles.triggerText}>⦿ Extended clip (record on)</Text>
              </Pressable>
            </>
          )}
          {recording && session?.mockWakeWord ? (
            <Text style={styles.listening}>
              (or say “Jarvis” again to stop)
            </Text>
          ) : null}
          <Pressable
            style={styles.disarmButton}
            onPress={() => navigation.goBack()}>
            <Text style={styles.disarmText}>Disarm</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function statusLabel(status: CaptureStatus, recordingSecs: number): string {
  switch (status.state) {
    case 'idle':
      return 'Starting…';
    case 'arming':
      return 'Arming…';
    case 'armed':
      return `● Armed — ${Math.round(status.bufferedSeconds)}s buffered`;
    case 'recording':
      return `⦿ REC ${formatElapsed(recordingSecs)} (+ look-back)`;
    case 'saving':
      return 'Saving clip…';
    case 'error':
      return 'Error';
  }
}

function formatElapsed(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'space-between',
    padding: spacing.l,
    paddingTop: spacing.xl * 2,
  },
  statusPill: {
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: radius.l,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s,
  },
  statusPillRec: {
    backgroundColor: colors.accent,
  },
  statusText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  error: {
    color: colors.warning,
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: radius.s,
    padding: spacing.s,
  },
  saved: {
    color: colors.success,
    textAlign: 'center',
    fontWeight: '600',
  },
  controls: { gap: spacing.m },
  triggerButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.l,
    paddingVertical: spacing.m,
    alignItems: 'center',
  },
  stopButton: {
    backgroundColor: '#B3132F',
    borderRadius: radius.l,
    paddingVertical: spacing.m,
    alignItems: 'center',
  },
  extendedButton: {
    backgroundColor: colors.surfaceHigh,
    borderRadius: radius.l,
    paddingVertical: spacing.m,
    alignItems: 'center',
  },
  triggerText: { color: colors.text, fontSize: 16, fontWeight: '800' },
  listening: { color: colors.textDim, textAlign: 'center', fontSize: 14 },
  disarmButton: {
    backgroundColor: colors.surfaceHigh,
    borderRadius: radius.l,
    paddingVertical: spacing.m,
    alignItems: 'center',
  },
  disarmText: { color: colors.text, fontSize: 16, fontWeight: '700' },
});
