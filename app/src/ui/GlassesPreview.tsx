import { useIsFocused } from '@react-navigation/native';
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
 * Number of previews currently *visible*, not merely mounted.
 *
 * Both ConnectScreen and ArmedScreen render a preview, and during
 * `replace('Armed')` both are briefly live at once, so the outgoing screen's
 * cleanup must not switch the feed off underneath the incoming one. Counting
 * handles that overlap.
 */
let previewViewers = 0;

export function GlassesPreview({ style }: { style?: ViewStyle }) {
  const [frameUri, setFrameUri] = useState<string | null>(null);
  // Focus, NOT mount. React Navigation keeps every screen below the top of the
  // stack mounted so that going back restores its state, so ArmedScreen — and
  // its preview — is still mounted while the Library and the clip player sit on
  // top of it. Gating on mount therefore never turned the feed off: the bridge
  // kept converting, JPEG-encoding and base64-ing ~7 frames/second, and this
  // component kept calling setState on each one, the whole time a clip was
  // playing. That is what starved the JS thread (video kept playing on the
  // native side while every control went dead) and grew memory until iOS
  // terminated the app.
  const isFocused = useIsFocused();

  useEffect(() => {
    if (!mwdatAvailable() || !isFocused) {
      return;
    }
    previewViewers += 1;
    if (previewViewers === 1) {
      console.log('[GlassesPreview] visible -> enabling preview emission');
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
      previewViewers -= 1;
      if (previewViewers === 0) {
        console.log('[GlassesPreview] hidden -> disabling preview emission');
        MWDATNative.setPreviewEnabled(false).catch(() => {});
      }
      // Drop the retained frame so its decoded bitmap is not held while the
      // screen is off-view.
      setFrameUri(null);
    };
  }, [isFocused]);

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
