import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import {
  MWDATNative,
  mwdatAvailable,
  mwdatEvents,
  type MWDATPreviewFrameEvent,
} from '../native/MWDATNative';
import { colors } from './theme';

/**
 * Live wearer's-eye view: renders the throttled JPEG preview frames the
 * native bridge emits while the glasses stream is open (preview or armed).
 */
/**
 * Both ConnectScreen and ArmedScreen mount a preview, and during
 * `replace('Armed')` both are briefly mounted at once. A plain enable-on-mount /
 * disable-on-unmount pair would let the outgoing screen's cleanup switch the
 * feed off underneath the incoming one, so count mounts instead.
 */
let previewMounts = 0;

export function GlassesPreview({ style }: { style?: ViewStyle }) {
  const [frameUri, setFrameUri] = useState<string | null>(null);

  useEffect(() => {
    if (!mwdatAvailable()) {
      return;
    }
    // Native encodes a preview frame only while this view is mounted. Without
    // this the pipeline kept converting, JPEG-encoding and base64'ing ~7
    // frames/second on every screen — including while a clip was playing,
    // which flooded the JS thread (the player UI stopped responding to taps)
    // and grew memory until the OS terminated the app.
    previewMounts += 1;
    if (previewMounts === 1) {
      MWDATNative.setPreviewEnabled(true).catch(() => {});
    }
    const sub = mwdatEvents().addListener(
      'MWDATPreviewFrame',
      (event: MWDATPreviewFrameEvent) => {
        setFrameUri(`data:image/jpeg;base64,${event.base64}`);
      },
    );
    return () => {
      sub.remove();
      previewMounts -= 1;
      if (previewMounts === 0) {
        MWDATNative.setPreviewEnabled(false).catch(() => {});
      }
    };
  }, []);

  return (
    <View style={[styles.root, style]}>
      {frameUri ? (
        <Image source={{ uri: frameUri }} style={styles.frame} resizeMode="cover" />
      ) : (
        <View style={styles.waiting}>
          <Text style={styles.waitingText}>Waiting for the glasses feed…</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#000', overflow: 'hidden' },
  frame: { width: '100%', height: '100%' },
  waiting: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  waitingText: { color: colors.textFaint, fontSize: 13 },
});
