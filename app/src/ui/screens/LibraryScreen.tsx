import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { FREE_RETENTION_HOURS } from '../../config';
import { clipStore, isPending, msUntilExpiry } from '../../core/ClipStore';
import { entitlementStore } from '../../core/EntitlementStore';
import type { Clip } from '../../types';
import { bump } from '../../debug/jsProbe';
import { ProBadge, RecDot, RecRings } from '../components';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing, type } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Library'>;

type Tab = 'recent' | 'saved';

export function LibraryScreen({ navigation }: Props) {
  bump('render.Library');
  const [clips, setClips] = useState<Clip[]>([]);
  const [isPro, setIsPro] = useState(false);
  const [tab, setTab] = useState<Tab>('recent');
  const [expiredCount, setExpiredCount] = useState(0);
  // Drives the countdown chips; the clips themselves do not change every tick.
  const [now, setNow] = useState(() => Date.now());
  /** Set once the user picks a tab, so the Pro default never overrides them. */
  const tabChosen = useRef(false);
  const insets = useSafeAreaInsets();

  const chooseTab = useCallback((next: Tab) => {
    tabChosen.current = true;
    setTab(next);
  }, []);

  const reload = useCallback(() => {
    clipStore.list().then(setClips);
  }, []);

  // Expiry is evaluated here and at launch — iOS gives no dependable
  // background execution, so a clip outlives its deadline until the user
  // opens the app, and the sweep reports what it took rather than having
  // clips disappear without explanation.
  useFocusEffect(
    useCallback(() => {
      clipStore.sweepExpired().then(expired => {
        if (expired.length > 0) {
          setExpiredCount(expired.length);
        }
        reload();
      });
    }, [reload]),
  );

  useEffect(() => clipStore.subscribe(reload), [reload]);
  useEffect(() => {
    entitlementStore.isPro().then(pro => {
      setIsPro(pro);
      // Pro clips are born saved, so Recent would always be empty for them.
      if (pro && !tabChosen.current) {
        setTab('saved');
      }
    });
    return entitlementStore.subscribe(setIsPro);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const recent = useMemo(() => clips.filter(isPending), [clips]);
  const saved = useMemo(() => clips.filter(c => !isPending(c)), [clips]);
  const shown = tab === 'recent' ? recent : saved;

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.s }]}>
      <View style={styles.brandRow}>
        <View style={styles.brand}>
          <RecDot size={9} live={false} />
          <Text style={styles.brandName}>Clipso</Text>
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
            ? 'say “Clipso”'
            : `${saved.length} saved · ${recent.length} temporary`}
        </Text>
      </View>

      <View style={styles.tabs}>
        <TabButton
          label={`Recent${recent.length ? ` (${recent.length})` : ''}`}
          active={tab === 'recent'}
          onPress={() => chooseTab('recent')}
        />
        <TabButton
          label={`Saved${saved.length ? ` (${saved.length})` : ''}`}
          active={tab === 'saved'}
          onPress={() => chooseTab('saved')}
        />
      </View>

      {expiredCount > 0 && (
        <Pressable onPress={() => setExpiredCount(0)} style={styles.notice}>
          <Text style={styles.noticeText}>
            {expiredCount} unsaved {expiredCount === 1 ? 'clip' : 'clips'} expired
            and {expiredCount === 1 ? 'was' : 'were'} deleted. Tap to dismiss.
          </Text>
        </Pressable>
      )}

      {shown.length === 0 ? (
        <View style={styles.empty}>
          <RecRings size={130} />
          <Text style={styles.emptyTitle}>
            {tab === 'recent' ? 'Nothing clipped yet' : 'Nothing saved yet'}
          </Text>
          <Text style={styles.emptyBody}>
            {tab === 'recent'
              ? 'Go live, live your life, and say the magic words when something fire happens. The last 30 seconds are already buffered.'
              : `Clips you save are kept forever. Everything else clears itself after ${FREE_RETENTION_HOURS} hours.`}
          </Text>
        </View>
      ) : (
        <FlatList
          data={shown}
          numColumns={2}
          keyExtractor={c => c.id}
          columnWrapperStyle={{ gap: spacing.m }}
          contentContainerStyle={{
            paddingHorizontal: spacing.m,
            paddingBottom: 120,
            gap: spacing.m,
          }}
          // Defaults keep ~80 cards mounted at 2 columns; each decoded
          // thumbnail is ~0.9 MB, which is how the grid used to run the app
          // out of memory on a large library.
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={5}
          removeClippedSubviews
          renderItem={({ item }) => (
            <ClipCard
              clip={item}
              now={now}
              onOpen={() => navigation.navigate('Player', { clip: item })}
              onShare={() => shareClip(item)}
              onSave={() => clipStore.save(item.id)}
            />
          )}
        />
      )}

      <View style={[styles.recordDock, { paddingBottom: insets.bottom + spacing.m }]}>
        <Pressable
          onPress={() =>
            navigation.reset({ index: 0, routes: [{ name: 'Armed' }] })
          }
          style={({ pressed }) => [styles.recordButton, pressed && styles.pressed]}>
          <View style={styles.recordDot} />
          <View>
            <Text style={styles.recordLabel}>Go live</Text>
            <Text style={styles.recordSub}>“Clipso”</Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.tab,
        active && styles.tabActive,
        pressed && styles.pressed,
      ]}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function ClipCard({
  clip,
  now,
  onOpen,
  onShare,
  onSave,
}: {
  clip: Clip;
  now: number;
  onOpen: () => void;
  onShare: () => void;
  onSave: () => void;
}) {
  const remaining = msUntilExpiry(clip, now);
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
      {remaining !== null && (
        <View style={[styles.expiryChip, remaining < 3600_000 && styles.expiryChipSoon]}>
          <Text style={styles.expiryText}>{formatRemaining(remaining)}</Text>
        </View>
      )}
      <View style={styles.cardMeta}>
        <Text style={styles.cardName} numberOfLines={1}>
          {clip.name}
        </Text>
        <Text style={styles.cardSub}>{relativeDate(clip.capturedAt)}</Text>
      </View>
      <Pressable
        onPress={remaining !== null ? onSave : onShare}
        hitSlop={8}
        style={({ pressed }) => [styles.shareChip, pressed && styles.pressed]}>
        <Text style={styles.shareChipText}>
          {remaining !== null ? 'Save' : 'Share'}
        </Text>
      </Pressable>
    </Pressable>
  );
}

/** "23h left" / "42m left" / "expiring" once the clock has run out. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) {
    return 'expiring';
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m left`;
  }
  return `${Math.floor(minutes / 60)}h left`;
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
  tabs: {
    flexDirection: 'row',
    gap: spacing.s,
    paddingHorizontal: spacing.m,
    paddingBottom: spacing.m,
  },
  tab: {
    paddingHorizontal: spacing.m,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabActive: { backgroundColor: colors.surfaceHigh, borderColor: colors.textFaint },
  tabText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: colors.text },
  notice: {
    marginHorizontal: spacing.m,
    marginBottom: spacing.m,
    padding: spacing.s + 2,
    borderRadius: radius.s,
    backgroundColor: colors.surfaceHigh,
    borderWidth: 1,
    borderColor: colors.border,
  },
  noticeText: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
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
  expiryChip: {
    position: 'absolute',
    right: spacing.s,
    bottom: 58,
    backgroundColor: colors.scrim,
    borderRadius: radius.s,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  expiryChipSoon: { backgroundColor: colors.accent },
  expiryText: { color: colors.text, fontSize: 11, fontWeight: '700' },
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
