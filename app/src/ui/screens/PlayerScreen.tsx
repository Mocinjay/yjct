import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import RNFS from 'react-native-fs';
import Video from 'react-native-video';
import { clipStore } from '../../core/ClipStore';
import { entitlementStore } from '../../core/EntitlementStore';
import { publishService } from '../../phase2/PublishService';
import { Button, ProBadge } from '../components';
import type { RootStackParamList } from '../navigation';
import { formatDuration, relativeDate, shareClip } from './LibraryScreen';
import { colors, radius, spacing, type } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>;

export function PlayerScreen({ route, navigation }: Props) {
  const { clip } = route.params;
  const [name, setName] = useState(clip.name);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(clip.name);
  const [isPro, setIsPro] = useState(false);
  const [captioning, setCaptioning] = useState(false);
  const [ended, setEnded] = useState(false);

  // A fresh `{ uri }` object on every render makes react-native-video treat the
  // source as changed and re-initialize the player. This screen re-renders on
  // rename, the entitlement check and the captioning flag, so the player was
  // being rebuilt repeatedly and the old AVPlayers were what pushed the app
  // into "Terminated due to memory issue".
  const source = useMemo(
    () => ({ uri: `file://${clip.filePath}` }),
    [clip.filePath],
  );

  // Leaving the screen (Publish, Paywall, or back to the Library) leaves this
  // screen mounted underneath, so without this the video kept decoding in the
  // background.
  const isFocused = useIsFocused();

  useEffect(() => {
    entitlementStore.isPro().then(setIsPro);
    return entitlementStore.subscribe(setIsPro);
  }, []);

  const publish = () => {
    if (isPro) {
      navigation.navigate('Publish', { clip });
    } else {
      navigation.navigate('Paywall');
    }
  };

  const captionClip = async () => {
    if (!isPro) {
      navigation.navigate('Paywall');
      return;
    }
    setCaptioning(true);
    try {
      const captioner = await publishService.getCaptioner();
      const { captionedFilePath } = await captioner.caption(clip.filePath);
      // The captioned version becomes its own library entry.
      const id = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const thumbnailPath = captionedFilePath.replace(/\.mp4$/, '.jpg');
      await RNFS.copyFile(clip.thumbnailPath, thumbnailPath);
      await clipStore.add({
        ...clip,
        id,
        name: `${name} · captioned`,
        filePath: captionedFilePath,
        thumbnailPath,
        capturedAt: Date.now(),
      });
      Alert.alert('Captioned', 'The captioned clip was added to your library.');
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.reset({ index: 0, routes: [{ name: 'Library' }] });
      }
    } catch (e) {
      Alert.alert('Captioning failed', e instanceof Error ? e.message : String(e));
    } finally {
      setCaptioning(false);
    }
  };

  const saveRename = async () => {
    const trimmed = draft.trim();
    if (trimmed) {
      await clipStore.rename(clip.id, trimmed);
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
          source={source}
          style={styles.video}
          // Native transport controls: play/pause, scrubbing, and skip.
          controls
          paused={!isFocused || ended}
          onEnd={() => setEnded(true)}
          onLoad={() => setEnded(false)}
          resizeMode="contain"
          ignoreSilentSwitch="ignore"
          playInBackground={false}
          playWhenInactive={false}
        />
      </View>

      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.sub}>
          {formatDuration(clip.durationSec)} · {relativeDate(clip.capturedAt)} ·{' '}
          {clip.sourceKind === 'mock' ? 'phone camera' : 'glasses'}
        </Text>
      </View>

      <View style={styles.actions}>
        <View style={styles.primaryRow}>
          <Button label="Share" tone="accent" onPress={() => shareClip(clip)} style={styles.grow} />
          <ProAction label="Publish" isPro={isPro} onPress={publish} />
          <ProAction
            label="Caption"
            isPro={isPro}
            busy={captioning}
            onPress={captionClip}
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
  meta: { paddingHorizontal: spacing.m, gap: 2 },
  name: { ...type.heading, color: colors.text },
  sub: { ...type.caption, color: colors.textFaint },
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
