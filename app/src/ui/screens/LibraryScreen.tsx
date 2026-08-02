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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Share from 'react-native-share';
import { clipStore } from '../../core/ClipStore';
import { entitlementStore } from '../../core/EntitlementStore';
import type { Clip } from '../../types';
import { bump } from '../../debug/jsProbe';
import { ProBadge, RecDot, RecRings } from '../components';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing, type } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Library'>;

export function LibraryScreen({ navigation }: Props) {
  bump('render.Library');
  const [clips, setClips] = useState<Clip[]>([]);
  const [isPro, setIsPro] = useState(false);
  const insets = useSafeAreaInsets();

  const reload = useCallback(() => {
    clipStore.list().then(setClips);
  }, []);

  useFocusEffect(reload);
  useEffect(() => clipStore.subscribe(reload), [reload]);
  useEffect(() => {
    entitlementStore.isPro().then(setIsPro);
    return entitlementStore.subscribe(setIsPro);
  }, []);

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.s }]}>
      <View style={styles.brandRow}>
        <View style={styles.brand}>
          <RecDot size={9} live={false} />
          <Text style={styles.brandName}>Jarvis</Text>
          {isPro ? (
            <ProBadge />
          ) : (
            <Pressable onPress={() => navigation.navigate('Paywall')} hitSlop={8}>
              <ProBadge locked />
            </Pressable>
          )}
        </View>
        <Pressable
          onPress={() => navigation.navigate('Settings')}
          hitSlop={8}
          style={({ pressed }) => [styles.settingsPill, pressed && styles.pressed]}>
          <Text style={styles.settingsText}>Settings</Text>
        </Pressable>
      </View>

      <View style={styles.titleBlock}>
        <Text style={styles.title}>Your clips</Text>
        <Text style={styles.subtitle}>
          {clips.length === 0
            ? 'say “yo Jarvis, clip that”'
            : `${clips.length} ${clips.length === 1 ? 'moment' : 'moments'} saved`}
        </Text>
      </View>

      {clips.length === 0 ? (
        <View style={styles.empty}>
          <RecRings size={130} />
          <Text style={styles.emptyTitle}>Nothing clipped yet</Text>
          <Text style={styles.emptyBody}>
            Start recording, live your life, and say the magic words when
            something fire happens. The last 30 seconds are already saved.
          </Text>
        </View>
      ) : (
        <FlatList
          data={clips}
          numColumns={2}
          keyExtractor={c => c.id}
          columnWrapperStyle={{ gap: spacing.m }}
          contentContainerStyle={{
            paddingHorizontal: spacing.m,
            paddingBottom: 120,
            gap: spacing.m,
          }}
          renderItem={({ item }) => (
            <ClipCard
              clip={item}
              onOpen={() => navigation.navigate('Player', { clip: item })}
              onShare={() => shareClip(item)}
            />
          )}
        />
      )}

      <View style={[styles.recordDock, { paddingBottom: insets.bottom + spacing.m }]}>
        <Pressable
          onPress={() => navigation.navigate('Armed')}
          style={({ pressed }) => [styles.recordButton, pressed && styles.pressed]}>
          <View style={styles.recordDot} />
          <View>
            <Text style={styles.recordLabel}>Record</Text>
            <Text style={styles.recordSub}>“yo Jarvis, clip that”</Text>
          </View>
        </Pressable>
      </View>
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
    <Pressable
      onPress={onOpen}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}>
      <Image
        source={{ uri: `file://${clip.thumbnailPath}` }}
        style={styles.thumb}
      />
      <View style={styles.durationChip}>
        <Text style={styles.durationText}>{formatDuration(clip.durationSec)}</Text>
      </View>
      <View style={styles.cardMeta}>
        <Text style={styles.cardName} numberOfLines={1}>
          {clip.name}
        </Text>
        <Text style={styles.cardSub}>{relativeDate(clip.capturedAt)}</Text>
      </View>
      <Pressable
        onPress={onShare}
        hitSlop={8}
        style={({ pressed }) => [styles.shareChip, pressed && styles.pressed]}>
        <Text style={styles.shareChipText}>Share</Text>
      </Pressable>
    </Pressable>
  );
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function relativeDate(epochMs: number): string {
  const d = new Date(epochMs);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.9 },
  brandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.m,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.s },
  brandName: { color: colors.text, fontSize: 17, fontWeight: '800', letterSpacing: 0.3 },
  settingsPill: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: 6,
  },
  settingsText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  titleBlock: { paddingHorizontal: spacing.m, paddingTop: spacing.l, paddingBottom: spacing.m },
  title: { ...type.title, color: colors.text },
  subtitle: { ...type.caption, color: colors.textFaint, marginTop: 2 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.m,
    paddingBottom: 140,
  },
  emptyTitle: { ...type.heading, color: colors.text, marginTop: spacing.s },
  emptyBody: {
    ...type.body,
    color: colors.textDim,
    textAlign: 'center',
    maxWidth: 300,
  },
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.m,
    overflow: 'hidden',
  },
  cardPressed: { transform: [{ scale: 0.98 }], opacity: 0.92 },
  thumb: { width: '100%', aspectRatio: 9 / 16, backgroundColor: colors.surfaceHigh },
  durationChip: {
    position: 'absolute',
    left: spacing.s,
    bottom: 58,
    backgroundColor: colors.scrim,
    borderRadius: radius.s,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  durationText: { color: colors.text, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  cardMeta: { padding: spacing.s, gap: 1 },
  cardName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  cardSub: { color: colors.textFaint, fontSize: 12 },
  shareChip: {
    position: 'absolute',
    top: spacing.s,
    right: spacing.s,
    backgroundColor: colors.scrim,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.s + 2,
    paddingVertical: 4,
  },
  shareChipText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  recordDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.m,
    paddingTop: spacing.m,
    backgroundColor: colors.scrimLight,
  },
  recordButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.m,
    backgroundColor: colors.accent,
    borderRadius: radius.xl,
    paddingVertical: spacing.m,
    shadowColor: colors.accent,
    shadowOpacity: 0.45,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  recordDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.text,
  },
  recordLabel: { color: colors.text, fontSize: 17, fontWeight: '800' },
  recordSub: { color: 'rgba(245,245,248,0.75)', fontSize: 12 },
});
