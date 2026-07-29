import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { mwdatAvailable, mwdatEvents, type MWDATPreviewFrameEvent } from '../native/MWDATNative';
import { colors } from './theme';

/**
 * Live wearer's-eye view: renders the throttled JPEG preview frames the
 * native bridge emits while the glasses stream is open (preview or armed).
 */
export function GlassesPreview({ style }: { style?: ViewStyle }) {
  const [frameUri, setFrameUri] = useState<string | null>(null);

  useEffect(() => {
    if (!mwdatAvailable()) {
      return;
    }
    const sub = mwdatEvents().addListener(
      'MWDATPreviewFrame',
      (event: MWDATPreviewFrameEvent) => {
        setFrameUri(`data:image/jpeg;base64,${event.base64}`);
      },
    );
    return () => sub.remove();
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
