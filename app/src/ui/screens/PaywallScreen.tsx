import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card } from '../components';
import { useEntitlement } from '../hooks/useEntitlement';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing, type } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Paywall'>;

export function PaywallScreen({ navigation }: Props) {
  const { unlock } = useEntitlement();

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
            await unlock();
            navigation.goBack();
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.kicker}>CLYPSO PRO</Text>
      <Text style={styles.title}>Bigger moments.{'\n'}Zero busywork.</Text>
      <View style={styles.priceRow}>
        <Text style={styles.price}>$15</Text>
        <Text style={styles.priceUnit}>/ month</Text>
      </View>

      <Card style={styles.card}>
        <Feature
          title="60s & 90s look-back"
          body="Free reaches 30 seconds into the past. Pro gets the whole play — not just the ending."
        />
        <Feature
          title="Auto-captions"
          body="Clips come back with burned-in captions, ready to post."
        />
        <Feature
          title="One-tap publish"
          body="Straight to YouTube Shorts, Instagram, Facebook, TikTok — with honest visibility status."
          soon
        />
      </Card>

      <Button label="Continue — $15/mo" tone="accent" onPress={subscribe} style={styles.cta} />
      <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
        <Text style={styles.dismiss}>Not now</Text>
      </Pressable>
    </ScrollView>
  );
}

function Feature({ title, body, soon }: { title: string; body: string; soon?: boolean }) {
  return (
    <View style={styles.feature}>
      <View style={styles.featureBullet}>
        <Text style={styles.featureCheck}>✓</Text>
      </View>
      <View style={styles.featureText}>
        <View style={styles.featureTitleRow}>
          <Text style={styles.featureTitle}>{title}</Text>
          {soon ? (
            <View style={styles.soonChip}>
              <Text style={styles.soonText}>SOON</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.featureBody}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.l, gap: spacing.m, paddingBottom: spacing.xxl },
  kicker: { ...type.label, color: colors.gold },
  title: { ...type.hero, fontSize: 34, lineHeight: 38, color: colors.text },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  price: { color: colors.text, fontSize: 28, fontWeight: '800' },
  priceUnit: { color: colors.textDim, fontSize: 15 },
  card: { gap: spacing.m, marginTop: spacing.s },
  feature: { flexDirection: 'row', gap: spacing.m },
  featureBullet: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.goldSoft,
    borderWidth: 1,
    borderColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  featureCheck: { color: colors.gold, fontSize: 12, fontWeight: '800' },
  featureText: { flex: 1, gap: 2 },
  featureTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.s },
  featureTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  soonChip: {
    borderWidth: 1,
    borderColor: colors.textFaint,
    borderRadius: radius.s,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  soonText: { color: colors.textFaint, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  featureBody: { ...type.caption, color: colors.textDim },
  cta: { marginTop: spacing.m },
  dismiss: {
    color: colors.textDim,
    textAlign: 'center',
    fontSize: 15,
    padding: spacing.s,
  },
});
