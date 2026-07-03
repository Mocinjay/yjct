import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Share from 'react-native-share';
import { clipStore } from '../../core/ClipStore';
import type { Clip } from '../../types';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Library'>;

export function LibraryScreen({ navigation }: Props) {
  const [clips, setClips] = useState<Clip[]>([]);

  const reload = useCallback(() => {
    clipStore.list().then(setClips);
  }, []);

  useFocusEffect(reload);
  useEffect(() => clipStore.subscribe(reload), [reload]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Library</Text>
        <Pressable onPress={() => navigation.navigate('Settings')} hitSlop={12}>
          <Text style={styles.headerAction}>⚙︎</Text>
        </Pressable>
      </View>

      {clips.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No clips yet</Text>
          <Text style={styles.emptyBody}>
            Arm capture, live your life, and say the trigger phrase when
            something fire happens.
          </Text>
        </View>
      ) : (
        <FlatList
          data={clips}
          numColumns={2}
          keyExtractor={c => c.id}
          columnWrapperStyle={{ gap: spacing.m }}
          contentContainerStyle={{ padding: spacing.m, gap: spacing.m }}
          renderItem={({ item }) => (
            <ClipCard
              clip={item}
              onOpen={() => navigation.navigate('Player', { clip: item })}
              onShare={() => shareClip(item)}
            />
          )}
        />
      )}

      <Pressable style={styles.armButton} onPress={() => navigation.navigate('Armed')}>
        <Text style={styles.armButtonText}>● Arm capture</Text>
      </Pressable>
    </View>
  );
}

function ClipCard({
  clip,
  onOpen,
  onShare,
}: {
  clip: Clip;
  onOpen: () => void;
  onShare: () => void;
}) {
  return (
    <Pressable style={styles.card} onPress={onOpen}>
      <Image
        source={{ uri: `file://${clip.thumbnailPath}` }}
        style={styles.thumb}
      />
      <View style={styles.cardMeta}>
        <Text style={styles.cardName} numberOfLines={1}>
          {clip.name}
        </Text>
        <Text style={styles.cardSub}>
          {Math.round(clip.durationSec)}s · {new Date(clip.capturedAt).toLocaleDateString()}
        </Text>
      </View>
      <Pressable style={styles.shareChip} onPress={onShare} hitSlop={8}>
        <Text style={styles.shareChipText}>Share</Text>
      </Pressable>
    </Pressable>
  );
}

export async function shareClip(clip: Clip): Promise<void> {
  try {
    // Free tier: raw footage via the native OS share sheet. Not an API
    // integration — same mechanism as sharing a Camera Roll video.
    await Share.open({
      url: `file://${clip.filePath}`,
      type: 'video/mp4',
      failOnCancel: false,
    });
  } catch (e) {
    Alert.alert('Share failed', e instanceof Error ? e.message : String(e));
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.m,
    paddingTop: spacing.xl,
    paddingBottom: spacing.s,
  },
  title: { color: colors.text, fontSize: 28, fontWeight: '800' },
  headerAction: { color: colors.textDim, fontSize: 24 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: spacing.s },
  emptyBody: { color: colors.textDim, fontSize: 15, textAlign: 'center', lineHeight: 21 },
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    overflow: 'hidden',
  },
  thumb: { width: '100%', aspectRatio: 9 / 16, backgroundColor: colors.surfaceHigh },
  cardMeta: { padding: spacing.s },
  cardName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  cardSub: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  shareChip: {
    position: 'absolute',
    top: spacing.s,
    right: spacing.s,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radius.s,
    paddingHorizontal: spacing.s,
    paddingVertical: spacing.xs,
  },
  shareChipText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  armButton: {
    margin: spacing.m,
    backgroundColor: colors.accent,
    borderRadius: radius.l,
    paddingVertical: spacing.m,
    alignItems: 'center',
  },
  armButtonText: { color: colors.text, fontSize: 17, fontWeight: '800' },
});
