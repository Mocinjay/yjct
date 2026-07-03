import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

export const ONBOARDED_KEY = 'onboarded.v1';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

export function OnboardingScreen({ navigation }: Props) {
  const done = async () => {
    await AsyncStorage.setItem(ONBOARDED_KEY, 'true');
    navigation.replace('Library');
  };

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Never miss a fire moment.</Text>
      <Text style={styles.body}>
        Say your trigger phrase and the last 30 seconds are already in the
        clip — then it keeps recording until you say stop. Hands free, saved
        locally, yours to share.
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>🎥 What Fade Away needs access to</Text>
        <Text style={styles.cardBody}>
          • Camera — fills the rolling look-back buffer while armed{'\n'}
          • Microphone — records clip audio and hears your trigger phrase
          {'\n'}
          You'll be asked the first time you arm capture. Nothing is recorded
          or kept unless you trigger a clip.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>⚡ Real talk about battery</Text>
        <Text style={styles.cardBody}>
          While armed, this app keeps the camera and microphone session open
          continuously and listens for your trigger phrase on-device. That
          costs meaningful battery on both your glasses and your phone —
          expect noticeably faster drain during long armed sessions. Disarm
          when you're not capturing.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>🔒 Private by default</Text>
        <Text style={styles.cardBody}>
          Wake-word detection runs entirely on this phone — no audio leaves
          the device. Clips stay in your local library until you choose to
          share them.
        </Text>
      </View>

      <Pressable style={styles.cta} onPress={done}>
        <Text style={styles.ctaText}>Got it — let's clip</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.l,
    justifyContent: 'center',
  },
  title: {
    color: colors.text,
    fontSize: 32,
    fontWeight: '800',
    marginBottom: spacing.m,
  },
  body: {
    color: colors.textDim,
    fontSize: 16,
    lineHeight: 22,
    marginBottom: spacing.l,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    padding: spacing.m,
    marginBottom: spacing.m,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.s,
  },
  cardBody: {
    color: colors.textDim,
    fontSize: 14,
    lineHeight: 20,
  },
  cta: {
    backgroundColor: colors.accent,
    borderRadius: radius.l,
    paddingVertical: spacing.m,
    alignItems: 'center',
    marginTop: spacing.l,
  },
  ctaText: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
});
