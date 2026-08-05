import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, RecDot } from '../components';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing, type } from '../theme';

export const ONBOARDED_KEY = 'onboarded.v1';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

export function OnboardingScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const done = async () => {
    await AsyncStorage.setItem(ONBOARDED_KEY, 'true');
    navigation.reset({ index: 0, routes: [{ name: 'Connect' }] });
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.l },
      ]}>
      <View style={styles.kickerRow}>
        <RecDot size={9} live={false} />
        <Text style={styles.kicker}>CLYPSO</Text>
      </View>
      <Text style={styles.hero}>Say{'\n'}Clypso.</Text>
      <Text style={styles.lede}>
        The moment already happened — Clypso already has it. Say the word and
        the last 30 seconds are saved. No buttons, no fumbling.
      </Text>

      <View style={styles.features}>
        <Feature
          title="Voice is the trigger"
          body="Your phone's own speech recognition listens for the phrase. No accounts, nothing set up."
        />
        <Feature
          title="Always looking back"
          body="While recording, a rolling buffer keeps the recent past ready. Clip it as many times as you want."
        />
        <Feature
          title="Yours, locally"
          body="Clips land in your library on this phone. Share them anywhere with the normal share sheet."
        />
      </View>

      <Card>
        <Text style={styles.cardTitle}>What Clypso will ask for</Text>
        <Text style={styles.cardBody}>
          Camera and microphone — to fill the look-back buffer — and speech
          recognition, to hear the trigger phrase. You'll see the prompts the
          first time you record. Nothing is kept unless you clip it, and no
          audio leaves the device.
        </Text>
      </Card>

      <Card style={styles.batteryCard}>
        <Text style={styles.cardTitle}>Real talk about battery</Text>
        <Text style={styles.cardBody}>
          Recording keeps the camera and mic open continuously and transcribes
          on-device. Long sessions drain noticeably faster — stop recording
          when you're not capturing.
        </Text>
      </Card>

      <Button label="Let's clip" tone="accent" onPress={done} style={styles.cta} />
    </ScrollView>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.feature}>
      <View style={styles.featureBullet} />
      <View style={styles.featureText}>
        <Text style={styles.featureTitle}>{title}</Text>
        <Text style={styles.featureBody}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: spacing.l, gap: spacing.m },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.s },
  kicker: { ...type.label, color: colors.textDim },
  hero: { ...type.hero, color: colors.text },
  lede: { ...type.body, fontSize: 16, lineHeight: 24, color: colors.textDim },
  features: { gap: spacing.m, marginVertical: spacing.m },
  feature: { flexDirection: 'row', gap: spacing.m, alignItems: 'flex-start' },
  featureBullet: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
    marginTop: 5,
  },
  featureText: { flex: 1, gap: 2 },
  featureTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  featureBody: { ...type.caption, color: colors.textDim },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  cardBody: { ...type.caption, color: colors.textDim },
  batteryCard: {
    borderColor: 'rgba(255,214,10,0.25)',
    borderRadius: radius.m,
  },
  cta: { marginTop: spacing.m },
});
