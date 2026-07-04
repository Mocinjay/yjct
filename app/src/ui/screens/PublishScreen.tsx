import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Video from 'react-native-video';
import { publishService } from '../../phase2/PublishService';
import type {
  PublishPrivacy,
  PublishStatus,
  PublishTarget,
} from '../../phase2/PublishTarget';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Publish'>;

type Phase =
  | { step: 'compose' }
  | { step: 'publishing' }
  | { step: 'status'; target: PublishTarget; publishId: string; status: PublishStatus };

const PRIVACY_CHOICES: PublishPrivacy[] = ['public', 'unlisted', 'private'];

export function PublishScreen({ route }: Props) {
  const { clip } = route.params;
  const [targets, setTargets] = useState<Array<{ target: PublishTarget; ready: boolean }>>([]);
  const [selected, setSelected] = useState<PublishTarget | null>(null);
  const [caption, setCaption] = useState('');
  const [privacy, setPrivacy] = useState<PublishPrivacy>('public');
  const [withCaptions, setWithCaptions] = useState(true);
  const [phase, setPhase] = useState<Phase>({ step: 'compose' });
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    publishService
      .listTargets()
      .then(list =>
        Promise.all(
          list.map(async target => ({
            target,
            ready: await target.isConfigured(),
          })),
        ),
      )
      .then(setTargets);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
      }
    };
  }, []);

  const confirmAndPublish = () => {
    if (!selected) {
      return;
    }
    // Per-clip preview + explicit consent before anything leaves the device.
    // Required for the eventual TikTok path; applied to every target.
    Alert.alert(
      `Publish to ${selected.displayName}?`,
      `“${clip.name}” (${Math.round(clip.durationSec)}s) will leave this ` +
        `device and be uploaded${selected.requiresHostedUrl ? ' via cloud hosting' : ''}. ` +
        `Requested visibility: ${privacy}. The platform may override this — ` +
        'the actual visibility is shown after publishing.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Publish', onPress: () => void doPublish(selected) },
      ],
    );
  };

  const doPublish = async (target: PublishTarget) => {
    setPhase({ step: 'publishing' });
    try {
      const { publishId } = await publishService.publish(clip, target, {
        caption,
        privacy,
        withCaptions,
      });
      const status = await publishService.checkStatus(target, publishId);
      setPhase({ step: 'status', target, publishId, status });
      pollTimer.current = setInterval(async () => {
        const next = await publishService.checkStatus(target, publishId);
        setPhase({ step: 'status', target, publishId, status: next });
        if (next.state !== 'processing' && pollTimer.current) {
          clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
      }, 2000);
    } catch (err) {
      setPhase({ step: 'compose' });
      Alert.alert('Publish failed', err instanceof Error ? err.message : String(err));
    }
  };

  if (phase.step === 'status') {
    return <StatusView phase={phase} requestedPrivacy={privacy} />;
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Video
        source={{ uri: `file://${clip.filePath}` }}
        style={styles.preview}
        paused
        resizeMode="cover"
      />
      <Text style={styles.clipName}>{clip.name}</Text>

      <Text style={styles.label}>Platform</Text>
      <View style={styles.row}>
        {targets.map(({ target, ready }) => (
          <Pressable
            key={target.platform}
            style={[styles.choice, selected?.platform === target.platform && styles.choiceSelected]}
            onPress={() =>
              ready
                ? setSelected(target)
                : Alert.alert(
                    `${target.displayName} needs setup`,
                    'This connector is built but not configured yet (OAuth client / API review pending). Use the mock platform to test the flow.',
                  )
            }>
            <Text
              style={[
                styles.choiceText,
                selected?.platform === target.platform && styles.choiceTextSelected,
              ]}>
              {ready ? target.displayName : `🔧 ${target.displayName}`}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Caption</Text>
      <TextInput
        style={styles.input}
        value={caption}
        onChangeText={setCaption}
        placeholder="Say something…"
        placeholderTextColor={colors.textDim}
        multiline
      />

      <Text style={styles.label}>Visibility</Text>
      <View style={styles.row}>
        {PRIVACY_CHOICES.map(p => (
          <Pressable
            key={p}
            style={[styles.choice, privacy === p && styles.choiceSelected]}
            onPress={() => setPrivacy(p)}>
            <Text style={[styles.choiceText, privacy === p && styles.choiceTextSelected]}>
              {p}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={[styles.choice, withCaptions && styles.choiceSelected, styles.captionToggle]}
        onPress={() => setWithCaptions(v => !v)}>
        <Text style={[styles.choiceText, withCaptions && styles.choiceTextSelected]}>
          {withCaptions ? '✓ Auto-captions (Pro)' : 'Auto-captions off'}
        </Text>
      </Pressable>

      <Pressable
        style={[styles.cta, (!selected || phase.step === 'publishing') && styles.ctaDisabled]}
        disabled={!selected || phase.step === 'publishing'}
        onPress={confirmAndPublish}>
        <Text style={styles.ctaText}>
          {phase.step === 'publishing' ? 'Publishing…' : 'Publish'}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

function StatusView({
  phase,
  requestedPrivacy,
}: {
  phase: Extract<Phase, { step: 'status' }>;
  requestedPrivacy: PublishPrivacy;
}) {
  const { status, target } = phase;
  const overridden =
    status.actualPrivacy !== undefined && status.actualPrivacy !== requestedPrivacy;
  return (
    <View style={[styles.root, styles.statusRoot]}>
      <Text style={styles.statusEmoji}>
        {status.state === 'published' ? '✅' : status.state === 'failed' ? '❌' : '⏳'}
      </Text>
      <Text style={styles.statusTitle}>
        {status.state === 'published'
          ? `Published to ${target.displayName}`
          : status.state === 'failed'
            ? 'Publish failed'
            : `${target.displayName} is processing…`}
      </Text>
      {status.actualPrivacy ? (
        <Text style={[styles.statusDetail, overridden && styles.statusWarning]}>
          Actual visibility: {status.actualPrivacy}
          {overridden ? ` (you requested ${requestedPrivacy} — the platform overrode it)` : ''}
        </Text>
      ) : null}
      {status.url ? <Text style={styles.statusDetail}>{status.url}</Text> : null}
      {status.error ? <Text style={styles.statusWarning}>{status.error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.m, gap: spacing.s, paddingBottom: spacing.xl },
  preview: {
    width: '40%',
    aspectRatio: 9 / 16,
    borderRadius: radius.m,
    backgroundColor: colors.surfaceHigh,
    alignSelf: 'center',
  },
  clipName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: spacing.s,
  },
  label: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: '700',
    marginTop: spacing.s,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
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
  captionToggle: { alignSelf: 'flex-start', marginTop: spacing.s },
  input: {
    backgroundColor: colors.surfaceHigh,
    borderRadius: radius.s,
    color: colors.text,
    padding: spacing.m,
    fontSize: 15,
    minHeight: 72,
    textAlignVertical: 'top',
  },
  cta: {
    backgroundColor: colors.accent,
    borderRadius: radius.l,
    paddingVertical: spacing.m,
    alignItems: 'center',
    marginTop: spacing.l,
  },
  ctaDisabled: { opacity: 0.4 },
  ctaText: { color: colors.text, fontSize: 17, fontWeight: '800' },
  statusRoot: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.m },
  statusEmoji: { fontSize: 48 },
  statusTitle: { color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  statusDetail: { color: colors.textDim, fontSize: 14, textAlign: 'center' },
  statusWarning: { color: colors.warning, fontSize: 14, textAlign: 'center', fontWeight: '600' },
});
