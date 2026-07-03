import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  BUFFER_SECONDS_MAX,
  BUFFER_SECONDS_MIN,
} from '../../config';
import { settingsStore } from '../../core/SettingsStore';
import type { Settings } from '../../types';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const BUFFER_CHOICES = [30, 45, 60, 90];

export function SettingsScreen(_props: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    settingsStore.get().then(setSettings);
    return settingsStore.subscribe(setSettings);
  }, []);

  if (!settings) {
    return <View style={styles.root} />;
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Section title="Clip length">
        <Text style={styles.hint}>
          How much of the past gets captured when you trigger
          ({BUFFER_SECONDS_MIN}–{BUFFER_SECONDS_MAX}s).
        </Text>
        <View style={styles.row}>
          {BUFFER_CHOICES.map(secs => (
            <Choice
              key={secs}
              label={`${secs}s`}
              selected={settings.bufferSeconds === secs}
              onPress={() => settingsStore.update({ bufferSeconds: secs })}
            />
          ))}
        </View>
      </Section>

      <Section title="Device">
        <View style={styles.row}>
          <Choice
            label="Mock (phone camera)"
            selected={settings.deviceKind === 'mock'}
            onPress={() => settingsStore.update({ deviceKind: 'mock' })}
          />
          <Choice
            label="Meta glasses"
            selected={settings.deviceKind === 'mwdat'}
            onPress={() => settingsStore.update({ deviceKind: 'mwdat' })}
          />
        </View>
        {settings.deviceKind === 'mwdat' ? (
          <Text style={styles.warning}>
            Glasses support ships once the Meta Wearables Device Access
            Toolkit bridge lands — arming will fail until then.
          </Text>
        ) : null}
      </Section>

      <Section title="Wake word">
        <View style={styles.row}>
          <Choice
            label="Mock (button)"
            selected={settings.wakeWord.provider === 'mock'}
            onPress={() =>
              settingsStore.update({
                wakeWord: { ...settings.wakeWord, provider: 'mock' },
              })
            }
          />
          <Choice
            label="Porcupine (on-device)"
            selected={settings.wakeWord.provider === 'porcupine'}
            onPress={() =>
              settingsStore.update({
                wakeWord: { ...settings.wakeWord, provider: 'porcupine' },
              })
            }
          />
        </View>
        {settings.wakeWord.provider === 'porcupine' ? (
          <>
            <Text style={styles.hint}>
              Trigger phrase (Porcupine built-in keyword, e.g. “jarvis”,
              “computer”, “porcupine”):
            </Text>
            <TextInput
              style={styles.input}
              value={settings.wakeWord.keyword}
              autoCapitalize="none"
              onChangeText={keyword =>
                settingsStore.update({
                  wakeWord: { ...settings.wakeWord, keyword },
                })
              }
            />
            <Text style={styles.hint}>Picovoice access key:</Text>
            <TextInput
              style={styles.input}
              value={settings.wakeWord.picovoiceAccessKey ?? ''}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Get one free at console.picovoice.ai"
              placeholderTextColor={colors.textDim}
              onChangeText={picovoiceAccessKey =>
                settingsStore.update({
                  wakeWord: { ...settings.wakeWord, picovoiceAccessKey },
                })
              }
            />
          </>
        ) : null}
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Choice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.choice, selected && styles.choiceSelected]}
      onPress={onPress}>
      <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.m, gap: spacing.l },
  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    padding: spacing.m,
    gap: spacing.s,
  },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  hint: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  warning: { color: colors.warning, fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s },
  choice: {
    backgroundColor: colors.surfaceHigh,
    borderRadius: radius.l,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s,
  },
  choiceSelected: { backgroundColor: colors.accent },
  choiceText: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  choiceTextSelected: { color: colors.text },
  input: {
    backgroundColor: colors.surfaceHigh,
    borderRadius: radius.s,
    color: colors.text,
    padding: spacing.m,
    fontSize: 15,
  },
});
