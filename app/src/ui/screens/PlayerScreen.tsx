import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Video from 'react-native-video';
import { clipStore, deliverablePath, isCaptioning } from '../../core/ClipStore';
import { entitlementStore } from '../../core/EntitlementStore';
import { captionQueue } from '../../phase2/CaptionQueue';
import { captionStyleLabel } from '../../phase2/captionStyles';
import type { Clip } from '../../types';
import { Button, ProBadge } from '../components';
import { formatDuration, relativeDate } from '../format';
import type { RootStackParamList } from '../navigation';
import { shareClip } from '../shareClip';
import { colors, radius, spacing, type } from '../theme';
import { useLiveClip } from '../useLiveClip';

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>;

export function PlayerScreen({ route, navigation }: Props) {
  const { clip: openedClip } = route.params;
  // The live copy, so captions landing or a rename show while the screen is open.
  const clip = useLiveClip(openedClip);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(openedClip.name);
  const [isPro, setIsPro] = useState(false);

  // Our own transport, because `controls` cannot be used — see the <Video>
  // below. `userPaused` is ONLY ever set by a tap. Nothing the player emits
  // feeds back into it, which is what makes this safe.
  const videoRef = useRef<React.ComponentRef<typeof Video>>(null);
  const [userPaused, setUserPaused] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  // Progress events (4 a second) go straight to the scrub bar, so playback
  // does not re-render this whole screen and the <Video> wrapper on each one.
  const scrubRef = useRef<ScrubBarHandle>(null);
  const durationRef = useRef(0);

  // Memoized on the path: a new source object makes react-native-video
  // re-initialize the player, and repeated rebuilds pile up AVPlayers until
  // iOS kills the app for memory. The path changes only when the captioned
  // cut replaces the raw one.
  const playbackPath = deliverablePath(clip);
  const source = useMemo(() => ({ uri: `file://${playbackPath}` }), [playbackPath]);

  // native-stack keeps this screen mounted under Publish and Paywall; pause
  // whenever it is not focused.
  const isFocused = useIsFocused();

  useEffect(() => {
    entitlementStore.isPro().then(setIsPro);
    return entitlementStore.subscribe(setIsPro);
  }, []);

  const togglePlayback = () => {
    if (atEnd) {
      // At the end AVPlayer will not resume without a seek.
      videoRef.current?.seek(0);
      setAtEnd(false);
      setUserPaused(false);
      return;
    }
    setUserPaused(p => !p);
  };

  const publish = () => {
    if (isPro) {
      navigation.navigate('Publish', { clip });
    } else {
      navigation.navigate('Paywall');
    }
  };

  // Captions are burned automatically on capture; this re-runs the job in
  // place, which is how you apply a style you have since changed in Settings.
  // It deliberately replaces the clip's captioned cut rather than adding a
  // second library entry — auto-captioning would otherwise breed duplicates.
  const recaption = async () => {
    if (!isPro) {
      navigation.navigate('Paywall');
      return;
    }
    await captionQueue.retry(clip.id);
  };

  const startRename = () => {
    // Start from the current name, not whatever a cancelled edit left behind.
    setDraft(clip.name);
    setRenaming(true);
  };

  // The store notifies once the rename is written, and useLiveClip picks the
  // new name up from there.
  const saveRename = async () => {
    const trimmed = draft.trim();
    if (trimmed) {
      await clipStore.rename(clip.id, trimmed);
    }
    setRenaming(false);
  };

  const confirmDelete = () => {
    Alert.alert('Delete clip?', `“${clip.name}” will be removed permanently.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await clipStore.remove(clip.id);
          if (navigation.canGoBack()) {
            navigation.goBack();
          } else {
            navigation.reset({ index: 0, routes: [{ name: 'Library' }] });
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      <View style={styles.videoFrame}>
        <Video
          ref={videoRef}
          source={source}
          style={styles.video}
          // `controls` MUST stay off. With it, RNV mounts an
          // AVPlayerViewController whose scrubber pre-renders filmstrip
          // thumbnails as CoreGraphics images (VM tag 54) until iOS kills the
          // app; the main thread is stuck in CoreGraphics, so the UI freezes
          // first. Without it RNV draws into a bare AVPlayerLayer. Build any
          // scrubber from `onProgress` + `seek()`, never by turning this on.
          controls={false}
          // Derived from focus and an explicit tap only. No player event feeds
          // this, so there is no cycle.
          paused={!isFocused || userPaused}
          onLoad={(d: { duration: number }) => {
            durationRef.current = d.duration;
            scrubRef.current?.setFraction(0);
            // A new source (captions landing) starts over; drop a stale
            // replay badge.
            setAtEnd(false);
          }}
          onEnd={() => setAtEnd(true)}
          onProgress={(d: { currentTime: number; seekableDuration: number }) => {
            const total = d.seekableDuration || durationRef.current;
            scrubRef.current?.setFraction(total > 0 ? d.currentTime / total : 0);
          }}
          resizeMode="contain"
          ignoreSilentSwitch="ignore"
          playInBackground={false}
          playWhenInactive={false}
        />

        {/* Transport. Replaces AVKit's controls, which cannot be used here. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={togglePlayback}
          accessibilityRole="button"
          accessibilityLabel={
            atEnd ? 'Replay' : userPaused ? 'Play' : 'Pause'
          }>
          {atEnd || userPaused ? (
            <View style={styles.playOverlay}>
              <View style={styles.playBadge}>
                <Text style={styles.playGlyph}>{atEnd ? '↻' : '▶'}</Text>
              </View>
            </View>
          ) : null}
        </Pressable>

        <ScrubBar ref={scrubRef} />
      </View>

      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {clip.name}
        </Text>
        <Text style={styles.sub}>
          {formatDuration(clip.durationSec)} · {relativeDate(clip.capturedAt)} ·{' '}
          {clip.sourceKind === 'mock' ? 'phone camera' : 'glasses'}
        </Text>
        <CaptionStatus clip={clip} />
      </View>

      <View style={styles.actions}>
        <View style={styles.primaryRow}>
          <Button label="Share" tone="accent" onPress={() => shareClip(clip)} style={styles.grow} />
          <ProAction label="Publish" isPro={isPro} onPress={publish} />
          <ProAction
            label={clip.captionState === 'ready' ? 'Restyle' : 'Caption'}
            isPro={isPro}
            busy={isCaptioning(clip)}
            onPress={recaption}
          />
        </View>
        <View style={styles.primaryRow}>
          <Button label="Rename" onPress={startRename} style={styles.grow} />
          <Button label="Delete" tone="danger" onPress={confirmDelete} style={styles.grow} />
        </View>
      </View>

      <Modal
        visible={renaming}
        transparent
        animationType="fade"
        // The Android back button closes it without saving.
        onRequestClose={() => setRenaming(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename clip</Text>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              autoFocus
              selectTextOnFocus
              placeholderTextColor={colors.textDim}
            />
            <View style={styles.modalActions}>
              <Button label="Cancel" onPress={() => setRenaming(false)} style={styles.grow} />
              <Button label="Save" tone="accent" onPress={saveRename} style={styles.grow} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

type ScrubBarHandle = { setFraction: (fraction: number) => void };

/** Thin progress line along the bottom of the video. Owns its own state. */
function ScrubBar({ ref }: { ref: React.Ref<ScrubBarHandle> }) {
  const [fraction, setFraction] = useState(0);
  useImperativeHandle(ref, () => ({ setFraction }), []);
  return (
    <View style={styles.scrubTrack} pointerEvents="none">
      <View
        style={[
          styles.scrubFill,
          { width: `${Math.min(100, Math.max(0, fraction * 100))}%` },
        ]}
      />
    </View>
  );
}

/** What is (or isn't) burned into the clip playing above. */
function CaptionStatus({ clip }: { clip: Clip }) {
  if (isCaptioning(clip)) {
    return (
      <Text style={styles.captionPending}>
        {clip.captionState === 'queued'
          ? 'Captions queued — playing the raw cut'
          : 'Captioning — playing the raw cut'}
      </Text>
    );
  }
  if (clip.captionState === 'failed') {
    return (
      <Text style={styles.captionFailed} numberOfLines={2}>
        Captions failed: {clip.captionError ?? 'unknown error'}
      </Text>
    );
  }
  if (clip.captionState === 'ready') {
    return clip.captionProvider === 'mock' ? (
      // The mock captioner returns the clip untouched. Saying "captioned"
      // here would be describing something that isn't on the screen.
      <Text style={styles.captionPending}>
        Mock captioner — nothing burned in. Set a captioning URL in Settings.
      </Text>
    ) : (
      <Text style={styles.captionReady}>
        Captions · {captionStyleLabel(clip.captionStyle)}
      </Text>
    );
  }
  return null;
}

function ProAction({
  label,
  isPro,
  onPress,
  busy,
}: {
  label: string;
  isPro: boolean;
  onPress: () => void;
  busy?: boolean;
}) {
  return (
    <Pressable
      onPress={busy ? undefined : onPress}
      style={({ pressed }) => [styles.proAction, pressed && styles.pressed]}>
      <Text style={styles.proActionText}>{busy ? '…' : label}</Text>
      {!isPro ? <ProBadge locked /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.9 },
  grow: { flex: 1 },
  videoFrame: {
    flex: 1,
    margin: spacing.m,
    borderRadius: radius.m,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: colors.border,
  },
  video: { flex: 1 },
  playOverlay: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  playBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: { color: colors.text, fontSize: 26, marginLeft: 2 },
  scrubTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: colors.border,
  },
  scrubFill: { height: 3, backgroundColor: colors.accent },
  meta: { paddingHorizontal: spacing.m, gap: 2 },
  name: { ...type.heading, color: colors.text },
  sub: { ...type.caption, color: colors.textFaint },
  captionReady: { ...type.caption, color: colors.gold, fontWeight: '700' },
  captionPending: { ...type.caption, color: colors.textDim },
  captionFailed: { ...type.caption, color: colors.accent },
  actions: { padding: spacing.m, paddingBottom: spacing.xl, gap: spacing.s },
  primaryRow: { flexDirection: 'row', gap: spacing.s },
  proAction: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    backgroundColor: colors.surfaceHigh,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.l,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  proActionText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'center',
    padding: spacing.l,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderBright,
    borderRadius: radius.m,
    padding: spacing.m,
    gap: spacing.m,
  },
  modalTitle: { ...type.heading, color: colors.text },
  input: {
    backgroundColor: colors.surfaceHigh,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.s,
    color: colors.text,
    padding: spacing.m,
    fontSize: 16,
  },
  modalActions: { flexDirection: 'row', gap: spacing.s },
});
