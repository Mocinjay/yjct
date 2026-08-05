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
import { FREE_BUFFER_SECONDS_MAX, WAKE_PHRASE } from '../../config';
import { MWDATNative, mwdatAvailable, mwdatEvents } from '../../native/MWDATNative';
import type { ConnectorConfig } from '../../core/ConnectorConfig';
import { connectorConfigStore } from '../../core/ConnectorConfig';
import type {
  CaptionPreview,
  CaptionStyleKey,
  CaptionStylePreset,
} from '../../captions/captionStyles';
import { CAPTION_STYLES } from '../../captions/captionStyles';
import { runTestRender } from '../../editing/testRender';
import { useEntitlement } from '../hooks/useEntitlement';
import { useSettings } from '../hooks/useSettings';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const BUFFER_CHOICES = [30, 60, 90];

export function SettingsScreen({ navigation }: Props) {
  const { settings, update: updateSettings } = useSettings();
  const { isPro, clear: clearEntitlement } = useEntitlement();
  const [connectors, setConnectors] = useState<ConnectorConfig>({});

  useEffect(() => {
    connectorConfigStore.get().then(setConnectors);
    return connectorConfigStore.subscribe(setConnectors);
  }, []);

  if (!settings) {
    return <View style={styles.root} />;
  }

  const pickBuffer = (secs: number) => {
    if (secs > FREE_BUFFER_SECONDS_MAX && !isPro) {
      navigation.navigate('Paywall');
      return;
    }
    updateSettings({ bufferSeconds: secs });
  };

  const pickCaptionStyle = (captionStyle: CaptionStyleKey) => {
    if (!isPro) {
      navigation.navigate('Paywall');
      return;
    }
    updateSettings({ captionStyle });
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

      <Section title="Caption style">
        <Text style={styles.hint}>
          Every clip is captioned automatically as soon as it lands — on this
          phone, offline, with nothing uploaded. Captions are part of Pro.
          This picks the look. Clips already captioned keep the style they were
          burned with; open one and hit Restyle to redo it.
        </Text>
        {CAPTION_STYLES.map(preset => (
          <CaptionStyleOption
            key={preset.key}
            preset={preset}
            selected={settings.captionStyle === preset.key}
            onPress={() => pickCaptionStyle(preset.key)}
          />
        ))}
      </Section>

      <Section title="Hook-first edit">
        <Text style={styles.hint}>
          Rebuilds each clip so its strongest moment plays first: best 3–7
          seconds, a beat of black, then the whole clip from the top. The
          strongest moment is found from loudness, movement and how you're
          talking — not from what you say.
        </Text>
        <View style={styles.row}>
          <Choice
            label="Hook first"
            selected={settings.climaxEdit}
            onPress={() => updateSettings({ climaxEdit: true })}
          />
          <Choice
            label="Chronological"
            selected={!settings.climaxEdit}
            onPress={() => updateSettings({ climaxEdit: false })}
          />
        </View>
        <Text style={styles.hint}>
          The original is never trimmed — the hook is an extra few seconds on
          the front, so the clip you captured is still there in full.
        </Text>
        <TestRender />
      </Section>

      <Section title="Meta glasses">
        <Text style={styles.hint}>
          Clypso records from your glasses' camera and microphone. Keep them
          paired and connected in the Meta AI app.
        </Text>
        <GlassesConnection />
        <Text style={styles.hint}>
          Capture tone: the glasses sound when a trigger lands and again once
          the clip is saved, so you know it worked without pulling your phone
          out. It uses the glasses' own photo-capture tone — the only sound the
          Meta toolkit can play on them. Turn it off if the feed stalls when it
          fires.
        </Text>
        <View style={styles.row}>
          <Choice
            label="Tone on"
            selected={settings.glassesChime}
            onPress={() => updateSettings({ glassesChime: true })}
          />
          <Choice
            label="Silent"
            selected={!settings.glassesChime}
            onPress={() => updateSettings({ glassesChime: false })}
          />
        </View>
      </Section>

      <Section title={`Voice trigger — “${WAKE_PHRASE}”`}>
        <View style={styles.row}>
          <Choice
            label="Voice"
            selected={settings.wakeWord.provider === 'speech'}
            onPress={() => updateSettings({ wakeWord: { provider: 'speech' } })}
          />
          <Choice
            label="Manual button"
            selected={settings.wakeWord.provider === 'mock'}
            onPress={() => updateSettings({ wakeWord: { provider: 'mock' } })}
          />
        </View>
        {settings.wakeWord.provider === 'speech' ? (
          <Text style={styles.hint}>
            Uses your phone's own speech recognition — free, on-device, no
            account, no setup. Detection lands a few seconds after you say
            “{WAKE_PHRASE}”; the look-back window still contains the moment.
          </Text>
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

        <Text style={styles.fieldLabel}>Captioning service URL — fallback only</Text>
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
        <Text style={styles.hint}>
          Unused on this phone while on-device captioning works. It is the
          Android path, and the fallback if offline dictation is missing for
          your language.
        </Text>

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

      <Section title="Clypso Pro">
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
            onPress={() => clearEntitlement()}
            hitSlop={8}
            style={styles.devClear}>
            <Text style={styles.devClearText}>Dev: clear entitlement</Text>
          </Pressable>
        ) : null}
      </Section>

      <Text style={styles.footer}>
        Clypso · say “Clypso” · clips stay on this phone until you
        share them
      </Text>
    </ScrollView>
  );
}

/**
 * One-time pairing of the app with Meta AI (Wearables Device Access Toolkit).
 * Registration bounces through the Meta AI app and returns via clypso://.
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

/**
 * DEV — runs the whole pipeline against the bundled sample clip.
 *
 * The app only records from glasses, so without hardware paired there is no
 * other way to see transcription, scoring and the render actually work on a
 * phone. The sample has no audio, so it exercises the video-only path and
 * produces no captions; that is the honest result for a silent clip.
 */
function TestRender() {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const run = async () => {
    setBusy(true);
    setLog([]);
    try {
      const report = await runTestRender(line =>
        setLog(previous => [...previous, line]),
      );
      setLog(report.lines);
    } catch (e) {
      setLog(previous => [
        ...previous,
        `Failed: ${e instanceof Error ? e.message : String(e)}`,
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.glassesBox}>
      <Pressable
        style={[styles.choice, busy && styles.choiceBusy]}
        disabled={busy}
        onPress={run}>
        <Text style={styles.choiceText}>
          {busy ? 'Rendering…' : 'Dev: test render on the sample clip'}
        </Text>
      </Pressable>
      {log.map((line, i) => (
        <Text key={i} style={styles.logLine}>
          {line}
        </Text>
      ))}
    </View>
  );
}

/**
 * One pickable caption look, with a sample of it.
 *
 * The sample is an approximation drawn in RN — the real thing is burned in by
 * ffmpeg server-side, and matching it exactly here is not worth a second
 * rendering path. It is close enough to choose between, which is its job.
 */
function CaptionStyleOption({
  preset,
  selected,
  onPress,
}: {
  preset: CaptionStylePreset;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.styleCard, selected && styles.styleCardSelected]}>
      <View style={styles.stylePreview}>
        <CaptionSample preview={preset.preview} />
      </View>
      <View style={styles.styleMeta}>
        <Text style={styles.styleLabel}>
          {selected ? `✓ ${preset.label}` : preset.label}
        </Text>
        <Text style={styles.styleDescription}>{preset.description}</Text>
      </View>
    </Pressable>
  );
}

function CaptionSample({ preview }: { preview: CaptionPreview }) {
  const words = preview.uppercase
    ? ['AT', 'A', 'PUBLIC']
    : ['At', 'a', 'public'];
  // Index 2 stands in for "the word being spoken" in the styles that track it.
  const base = {
    fontFamily: preview.fontFamily,
    fontSize: preview.fontSize,
    fontWeight: preview.fontWeight,
    letterSpacing: preview.letterSpacing,
    color: preview.color,
  } as const;
  return (
    <View style={[styles.sampleRow, preview.boxed && styles.sampleBoxed]}>
      {words.map((word, i) => (
        <Text
          key={word}
          style={[
            base,
            preview.outlined && styles.sampleOutlined,
            i === 2 && preview.highlightColor
              ? { color: preview.highlightColor }
              : null,
          ]}>
          {word}
        </Text>
      ))}
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
  choiceBusy: { opacity: 0.5 },
  logLine: { color: colors.textDim, fontSize: 11, lineHeight: 16, fontVariant: ['tabular-nums'] },
  styleCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.s,
    overflow: 'hidden',
    marginTop: spacing.s,
  },
  styleCardSelected: { borderColor: colors.accent },
  stylePreview: {
    // Mid-grey rather than black: real footage is mid-tone, and on black the
    // Boxed style's bar would be invisible against the plate.
    backgroundColor: '#3A3A44',
    paddingVertical: spacing.l,
    paddingHorizontal: spacing.m,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sampleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  sampleBoxed: {
    backgroundColor: '#000',
    paddingHorizontal: spacing.s,
    paddingVertical: 4,
  },
  sampleOutlined: {
    textShadowColor: '#000',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
  styleMeta: { padding: spacing.m, gap: 2, backgroundColor: colors.surfaceHigh },
  styleLabel: { color: colors.text, fontSize: 15, fontWeight: '700' },
  styleDescription: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
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
