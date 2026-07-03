import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { entitlementStore } from '../../core/EntitlementStore';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Paywall'>;

export function PaywallScreen({ navigation }: Props) {
  const subscribe = () => {
    // TODO(billing): replace with StoreKit / Play Billing purchase +
    // receipt validation. Until then this is an explicit dev unlock so the
    // Pro path is testable.
    Alert.alert(
      'Payments not wired up yet',
      'Real App Store / Play Store billing lands with the Phase 2 work. ' +
        'Unlock Pro locally for testing?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Dev unlock',
          onPress: async () => {
            await entitlementStore.devUnlock();
            navigation.goBack();
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>FADE AWAY PRO</Text>
      <Text style={styles.title}>Longer look-back.{'\n'}Bigger moments.</Text>
      <Text style={styles.price}>$15/month</Text>

      <View style={styles.card}>
        <Feature emoji="⏪" title="60s & 90s look-back" body="Free tier clips the last 30 seconds. Pro reaches further back — the whole play, not just the ending." />
        <Feature emoji="💬" title="Auto-captions" body="Coming with Pro: clips come back captioned, ready to post." soon />
        <Feature emoji="🚀" title="One-tap publish" body="Coming with Pro: push straight to YouTube Shorts, Instagram, Facebook, TikTok." soon />
      </View>

      <Pressable style={styles.cta} onPress={subscribe}>
        <Text style={styles.ctaText}>Continue — $15/mo</Text>
      </Pressable>
      <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
        <Text style={styles.dismiss}>Not now</Text>
      </Pressable>
    </ScrollView>
  );
}

function Feature({
  emoji,
  title,
  body,
  soon,
}: {
  emoji: string;
  title: string;
  body: string;
  soon?: boolean;
}) {
  return (
    <View style={styles.feature}>
      <Text style={styles.featureEmoji}>{emoji}</Text>
      <View style={styles.featureText}>
        <Text style={styles.featureTitle}>
          {title}
          {soon ? <Text style={styles.soon}>  COMING SOON</Text> : null}
        </Text>
        <Text style={styles.featureBody}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.l, gap: spacing.m },
  kicker: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 2,
  },
  title: { color: colors.text, fontSize: 30, fontWeight: '800', lineHeight: 36 },
  price: { color: colors.textDim, fontSize: 17, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    padding: spacing.m,
    gap: spacing.m,
    marginTop: spacing.s,
  },
  feature: { flexDirection: 'row', gap: spacing.m },
  featureEmoji: { fontSize: 24 },
  featureText: { flex: 1, gap: 2 },
  featureTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  soon: { color: colors.warning, fontSize: 10, fontWeight: '800' },
  featureBody: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  cta: {
    backgroundColor: colors.accent,
    borderRadius: radius.l,
    paddingVertical: spacing.m,
    alignItems: 'center',
    marginTop: spacing.m,
  },
  ctaText: { color: colors.text, fontSize: 17, fontWeight: '800' },
  dismiss: {
    color: colors.textDim,
    textAlign: 'center',
    fontSize: 15,
    padding: spacing.s,
  },
});
