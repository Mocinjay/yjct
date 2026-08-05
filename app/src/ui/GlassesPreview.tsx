import { useIsFocused } from '@react-navigation/native';
import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { createLogger } from '../core/Logger';
import { ErrorCode } from '../core/errors';
import {
  MWDATNative,
  mwdatAvailable,
  mwdatEvents,
  type MWDATPreviewFrameEvent,
  type MWDATStreamHealthEvent,
} from '../native/MWDATNative';
import { colors } from './theme';

const log = createLogger('glasses-preview');

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

/**
 * Seconds without a frame before the picture on screen is called what it is: a
 * still, not a live feed. Below the native watchdog's stall threshold on
 * purpose — the wearer should see the feed go soft a beat before an error
 * banner appears, and see it recover without one if it was only a hiccup.
 */
const STALE_SECONDS = 2;

export function GlassesPreview({ style }: { style?: ViewStyle }) {
  const [frameUri, setFrameUri] = useState<string | null>(null);
  const [stalledFor, setStalledFor] = useState(0);
  /**
   * Health events arrive once a second, so logging on every stalled one would
   * be a line per second for as long as the link is down. Log the edges — went
   * stale, came back — which is what actually reads as an incident.
   */
  const wasStalled = useRef(false);
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
      MWDATNative.setPreviewEnabled(true).catch(err =>
        log.error('could not enable preview', err, ErrorCode.GlassesPreviewFailed),
      );
    }
    const emitter = mwdatEvents();
    const sub = emitter.addListener(
      'MWDATPreviewFrame',
      (event: MWDATPreviewFrameEvent) => {
        setFrameUri(`data:image/jpeg;base64,${event.base64}`);
      },
    );
    // The stream can sit in `.streaming` over a link that has stopped
    // delivering, so the last frame would otherwise stay on screen looking
    // live indefinitely.
    const healthSub = emitter.addListener(
      'MWDATStreamHealth',
      (event: MWDATStreamHealthEvent) => {
        const stalled = event.secondsSinceFrame >= STALE_SECONDS;
        if (stalled && !wasStalled.current) {
          log.warn('glasses feed stalled — no frames arriving', {
            secondsSinceFrame: event.secondsSinceFrame,
            fps: event.fps,
            recording: event.recording,
          });
        } else if (!stalled && wasStalled.current) {
          log.info('glasses feed recovered', { fps: event.fps });
        }
        wasStalled.current = stalled;
        setStalledFor(stalled ? event.secondsSinceFrame : 0);
      },
    );
    return () => {
      sub.remove();
      healthSub.remove();
      previewViewers -= 1;
      if (previewViewers === 0) {
        // Defer: Connect → Live uses navigation.reset, so the outgoing preview
        // unmounts before the incoming one mounts. Disabling synchronously
        // left a frame where emission was off and the handoff looked dead.
        setTimeout(() => {
          if (previewViewers === 0) {
            MWDATNative.setPreviewEnabled(false).catch(err =>
              log.expected(
                'could not disable preview',
                err,
                ErrorCode.GlassesPreviewFailed,
              ),
            );
          }
        }, 0);
      }
      // Drop the retained frame so its decoded bitmap is not held while the
      // screen is off-view.
      setFrameUri(null);
      setStalledFor(0);
    };
  }, [isFocused]);

  return (
    <View style={[styles.root, style]}>
      {frameUri ? (
        <Image
          source={{ uri: frameUri }}
          style={[styles.frame, stalledFor > 0 && styles.frameStalled]}
          resizeMode="cover"
        />
      ) : (
        <View style={styles.waiting}>
          <Text style={styles.waitingText}>Waiting for the glasses feed…</Text>
        </View>
      )}
      {stalledFor > 0 ? (
        <View style={styles.stallBadge} pointerEvents="none">
          <Text style={styles.stallText}>
            feed stalled · {Math.round(stalledFor)}s
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#000', overflow: 'hidden' },
  frame: { width: '100%', height: '100%' },
  frameStalled: { opacity: 0.45 },
  waiting: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  waitingText: { color: colors.textFaint, fontSize: 13 },
  stallBadge: {
    position: 'absolute',
    top: 8,
    alignSelf: 'center',
    backgroundColor: colors.scrim,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  stallText: { color: colors.warning, fontSize: 12, fontWeight: '700' },
});
