import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useMemo, useRef, useState } from 'react';
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
import { deliverablePath, isCaptioning } from '../../core/ClipStore';
import { captionStyleLabel } from '../../captions/captionStyles';
import type { Clip } from '../../types';
import { Button, ProBadge } from '../components';
import { useClipActions } from '../hooks/useClipActions';
import { useClip } from '../hooks/useClips';
import { useEntitlement } from '../hooks/useEntitlement';
import type { RootStackParamList } from '../navigation';
import { formatDuration, relativeDate } from '../format';
import { shareClip } from '../shareClip';
import { colors, radius, spacing, type } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>;

export function PlayerScreen({ route, navigation }: Props) {
  const { clip: openedClip } = route.params;
  // The route param is a snapshot from the moment the card was tapped. The
  // captioning job for this clip may still be running, so the live copy is
  // read from the store instead — that is what makes the state below move
  // while the screen is open.
  //
  // Falling back to the snapshot matters on the way out: deleting a clip
  // removes it from the store a frame before the screen unwinds, and a null
  // here would blank the player mid-navigation.
  const clip = useClip(openedClip.id) ?? openedClip;
  const [name, setName] = useState(openedClip.name);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(openedClip.name);
  const { isPro } = useEntitlement();
  const { rename, remove, recaption: queueRecaption } = useClipActions();

  // Our own transport, because `controls` cannot be used — see the <Video>
  // below. `userPaused` is ONLY ever set by a tap. Nothing the player emits
  // feeds back into it, which is what makes this safe.
  const videoRef = useRef<React.ComponentRef<typeof Video>>(null);
  const [userPaused, setUserPaused] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  // A fresh `{ uri }` object on every render makes react-native-video treat the
  // source as changed and re-initialize the player. This screen re-renders on
  // rename, the entitlement check and the captioning flag, so the player was
  // being rebuilt repeatedly and the old AVPlayers were what pushed the app
  // into "Terminated due to memory issue".
  //
  // Keying on the path means the one time it *does* rebuild is when captions
  // land and the captioned cut replaces the raw one.
  const playbackPath = deliverablePath(clip);
  const source = useMemo(() => ({ uri: `file://${playbackPath}` }), [playbackPath]);

  // Leaving the screen (Publish, Paywall, or back to the Library) leaves this
  // screen mounted underneath, so without this the video kept decoding in the
  // background.
  const isFocused = useIsFocused();

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
    await queueRecaption(clip.id);
  };

  const saveRename = async () => {
    const trimmed = draft.trim();
    if (trimmed) {
      await rename(clip.id, trimmed);
      setName(trimmed);
    }
    setRenaming(false);
  };

  const confirmDelete = () => {
    Alert.alert('Delete clip?', `“${name}” will be removed permanently.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await remove(clip.id);
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
          // `controls` MUST stay off. It makes react-native-video mount an
          // AVPlayerViewController (`usePlayerViewController()`), and AVKit
          // pre-generates the scrubber's filmstrip thumbnails for the item as
          // CGImages. That is the memory leak: VM tag 54,
          // VM_MEMORY_COREGRAPHICS_DATA, climbing 0 -> 1889MB in ~20s while
          // every other region stayed flat, until iOS killed the app. With
          // `controls` false, RNV uses a bare AVPlayerLayer
          // (`usePlayerLayer()`) with no AVKit chrome and no image generation.
          //
          // It also explains the symptom that never fit: the UI froze while the
          // JS thread was provably IDLE (the probe's 1s interval kept firing on
          // schedule). It was the MAIN thread stuck in CoreGraphics.
          //
          // Our own transport is below. If a scrubber is wanted later it must be
          // built from `onProgress` + `seek()`, never by turning `controls` back
          // on.
          controls={false}
          // Derived from focus and an explicit tap only. No player event feeds
          // this, so there is no cycle.
          paused={!isFocused || userPaused}
          onLoad={(d: { duration: number }) => {
            setProgress({ current: 0, total: d.duration });
          }}
          onEnd={() => {
            setAtEnd(true);
          }}
          onProgress={(d: { currentTime: number; seekableDuration: number }) => {
            setProgress({ current: d.currentTime, total: d.seekableDuration });
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

        <View style={styles.scrubTrack} pointerEvents="none">
          <View
            style={[
              styles.scrubFill,
              {
                width: `${
                  progress.total > 0
                    ? Math.min(100, (progress.current / progress.total) * 100)
                    : 0
                }%`,
              },
            ]}
          />
        </View>
      </View>

      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
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
          <Button label="Rename" onPress={() => setRenaming(true)} style={styles.grow} />
          <Button label="Delete" tone="danger" onPress={confirmDelete} style={styles.grow} />
        </View>
      </View>

      <Modal visible={renaming} transparent animationType="fade">
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
