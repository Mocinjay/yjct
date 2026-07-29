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
import { FREE_BUFFER_SECONDS_MAX } from '../../config';
import { MWDATNative, mwdatAvailable, mwdatEvents } from '../../native/MWDATNative';
import { entitlementStore } from '../../core/EntitlementStore';
import { settingsStore } from '../../core/SettingsStore';
import type { ConnectorConfig } from '../../phase2/ConnectorConfig';
import { connectorConfigStore } from '../../phase2/ConnectorConfig';
import type { Settings } from '../../types';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const BUFFER_CHOICES = [30, 60, 90];

export function SettingsScreen({ navigation }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [connectors, setConnectors] = useState<ConnectorConfig>({});

  useEffect(() => {
    settingsStore.get().then(setSettings);
    entitlementStore.isPro().then(setIsPro);
    connectorConfigStore.get().then(setConnectors);
    const unsubSettings = settingsStore.subscribe(setSettings);
    const unsubPro = entitlementStore.subscribe(setIsPro);
    const unsubConnectors = connectorConfigStore.subscribe(setConnectors);
    return () => {
      unsubSettings();
      unsubPro();
      unsubConnectors();
    };
  }, []);

  if (!settings) {
    return <View style={styles.root} />;
  }

  const pickBuffer = (secs: number) => {
    if (secs > FREE_BUFFER_SECONDS_MAX && !isPro) {
      navigation.navigate('Paywall');
      return;
    }
    settingsStore.update({ bufferSeconds: secs });
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Section title="Look-back length">
        <Text style={styles.hint}>
          How far back the clip reaches when you trigger. Recording continues
          until you stop it. 60s and 90s are part of Pro.
        </Text>
        <View style={styles.row}>
          {BUFFER_CHOICES.map(secs => (
            <Choice
              key={secs}
              label={
                secs > FREE_BUFFER_SECONDS_MAX && !isPro
                  ? `🔒 ${secs}s`
                  : `${secs}s`
              }
              selected={settings.bufferSeconds === secs}
              onPress={() => pickBuffer(secs)}
            />
          ))}
        </View>
      </Section>

      <Section title="Meta glasses">
        <Text style={styles.hint}>
          Jarvis records from your glasses' camera and microphone. Keep them
          paired and connected in the Meta AI app.
        </Text>
        <GlassesConnection />
      </Section>

      <Section title="Voice trigger — “yo Jarvis, clip that”">
        <View style={styles.row}>
          <Choice
            label="Built-in (no key)"
            selected={settings.wakeWord.provider === 'speech'}
            onPress={() =>
              settingsStore.update({
                wakeWord: { ...settings.wakeWord, provider: 'speech' },
              })
            }
          />
          <Choice
            label="Porcupine (needs key)"
            selected={settings.wakeWord.provider === 'porcupine'}
            onPress={() =>
              settingsStore.update({
                wakeWord: { ...settings.wakeWord, provider: 'porcupine' },
              })
            }
          />
          <Choice
            label="Manual button"
            selected={settings.wakeWord.provider === 'mock'}
            onPress={() =>
              settingsStore.update({
                wakeWord: { ...settings.wakeWord, provider: 'mock' },
              })
            }
          />
        </View>
        {settings.wakeWord.provider === 'speech' ? (
          <Text style={styles.hint}>
            Uses your phone's own speech recognition — free, on-device, no
            account. Detection lands a few seconds after you say it; the clip
            still contains the moment. Porcupine reacts faster if you ever
            want to upgrade.
          </Text>
        ) : null}
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

      <Section title="Connections (Phase 2 · developer)">
        <Text style={styles.hint}>
          Paste sandbox/dev credentials to light up a connector. Production
          user-facing OAuth replaces this before any store release.
        </Text>

        <Text style={styles.fieldLabel}>Clip hosting — presign endpoint URL</Text>
        <TextInput
          style={styles.input}
          value={connectors.hostingPresignUrl ?? ''}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://…/presign (blank = mock hosting)"
          placeholderTextColor={colors.textDim}
          onChangeText={hostingPresignUrl =>
            connectorConfigStore.update({ hostingPresignUrl })
          }
        />

        <Text style={styles.fieldLabel}>Captioning service URL (Pro)</Text>
        <TextInput
          style={styles.input}
          value={connectors.captioningUrl ?? ''}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="http://<mac-ip>:8787 (blank = mock captioner)"
          placeholderTextColor={colors.textDim}
          onChangeText={captioningUrl =>
            connectorConfigStore.update({ captioningUrl })
          }
        />

        <Text style={styles.fieldLabel}>Instagram — Graph access token</Text>
        <TextInput
          style={styles.input}
          value={connectors.meta?.accessToken ?? ''}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="needs instagram_content_publish"
          placeholderTextColor={colors.textDim}
          onChangeText={accessToken =>
            connectorConfigStore.update({ meta: { accessToken } })
          }
        />
        <Text style={styles.fieldLabel}>Instagram — IG user id</Text>
        <TextInput
          style={styles.input}
          value={connectors.meta?.igUserId ?? ''}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Business/Creator account id"
          placeholderTextColor={colors.textDim}
          onChangeText={igUserId =>
            connectorConfigStore.update({ meta: { igUserId } })
          }
        />

        <Text style={styles.fieldLabel}>Facebook — Page id</Text>
        <TextInput
          style={styles.input}
          value={connectors.meta?.pageId ?? ''}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={pageId => connectorConfigStore.update({ meta: { pageId } })}
        />
        <Text style={styles.fieldLabel}>Facebook — Page access token</Text>
        <TextInput
          style={styles.input}
          value={connectors.meta?.pageAccessToken ?? ''}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="needs pages_manage_posts"
          placeholderTextColor={colors.textDim}
          onChangeText={pageAccessToken =>
            connectorConfigStore.update({ meta: { pageAccessToken } })
          }
        />

        <Text style={styles.fieldLabel}>TikTok — Content Posting access token</Text>
        <TextInput
          style={styles.input}
          value={connectors.tiktok?.accessToken ?? ''}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="sandbox token until audit clears"
          placeholderTextColor={colors.textDim}
          onChangeText={accessToken =>
            connectorConfigStore.update({ tiktok: { accessToken } })
          }
        />
        <View style={styles.row}>
          <Choice
            label={
              connectors.tiktok?.auditCleared
                ? '✓ TikTok audit cleared'
                : 'TikTok audit NOT cleared'
            }
            selected={Boolean(connectors.tiktok?.auditCleared)}
            onPress={() =>
              connectorConfigStore.update({
                tiktok: { auditCleared: !connectors.tiktok?.auditCleared },
              })
            }
          />
        </View>
        <Text style={styles.warning}>
          Only flip the audit flag on written confirmation from TikTok. While
          off, every TikTok post is reported as private — because it is.
        </Text>
      </Section>

      <Section title="Jarvis Pro">
        <View style={styles.rowBetween}>
          <Text style={styles.hint}>
            {isPro
              ? 'Active — longer look-back, captions, publishing.'
              : 'Not subscribed. 30s look-back, share sheet only.'}
          </Text>
          <Choice
            label={isPro ? 'Manage' : 'Upgrade'}
            selected={!isPro}
            onPress={() => navigation.navigate('Paywall')}
          />
        </View>
        {isPro ? (
          <Pressable
            onPress={() => entitlementStore.clear()}
            hitSlop={8}
            style={styles.devClear}>
            <Text style={styles.devClearText}>Dev: clear entitlement</Text>
          </Pressable>
        ) : null}
      </Section>

      <Text style={styles.footer}>
        Jarvis · “yo Jarvis, clip that” · clips stay on this phone until you
        share them
      </Text>
    </ScrollView>
  );
}

/**
 * One-time pairing of the app with Meta AI (Wearables Device Access Toolkit).
 * Registration bounces through the Meta AI app and returns via jarvis://.
 */
function GlassesConnection() {
  const [regState, setRegState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mwdatAvailable()) {
      setError('Meta glasses support is iOS-only for now.');
      return;
    }
    MWDATNative.getRegistrationState().then(setRegState).catch(e => setError(String(e?.message ?? e)));
    const sub = mwdatEvents().addListener(
      'MWDATRegistrationState',
      (event: { state: string }) => setRegState(event.state),
    );
    return () => sub.remove();
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      setRegState(await MWDATNative.startRegistration());
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const registered = regState === 'registered';
  return (
    <View style={styles.glassesBox}>
      <Text style={registered ? styles.hint : styles.warning}>
        {registered
          ? '✓ Glasses connected through Meta AI.'
          : `Glasses link: ${regState ?? '…'}. Pair your glasses in the Meta AI app and turn on Developer Mode (Meta AI → Settings → App Info → tap App version 5×), then connect.`}
      </Text>
      {error ? <Text style={styles.warning}>{error}</Text> : null}
      {!registered ? (
        <Pressable
          style={[styles.choice, busy && { opacity: 0.5 }]}
          disabled={busy}
          onPress={connect}>
          <Text style={styles.choiceText}>
            {busy ? 'Connecting…' : 'Connect Meta glasses'}
          </Text>
        </Pressable>
      ) : null}
    </View>
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
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.m,
    padding: spacing.m,
    gap: spacing.s,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.m,
  },
  devClear: { alignSelf: 'flex-start' },
  devClearText: { color: colors.textFaint, fontSize: 12, textDecorationLine: 'underline' },
  footer: {
    color: colors.textFaint,
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: spacing.l,
    lineHeight: 18,
  },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  hint: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  fieldLabel: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '700',
    marginTop: spacing.s,
  },
  warning: { color: colors.warning, fontSize: 13, lineHeight: 18 },
  glassesBox: { gap: spacing.s, marginTop: spacing.s },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s },
  choice: {
    backgroundColor: colors.surfaceHigh,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s,
  },
  choiceSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
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
