import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Video from 'react-native-video';
import { clipStore } from '../../core/ClipStore';
import { publishService } from '../../phase2/PublishService';
import type {
  PublishPrivacy,
  PublishStatus,
  PublishTarget,
} from '../../phase2/PublishTarget';
import { Button, SectionLabel } from '../components';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing, type } from '../theme';

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
      // Publishing is an implicit save — a clip the user put on a platform
      // must not evaporate when its retention clock runs out.
      await clipStore.markPublished(clip.id, target.platform);
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

      <SectionLabel>Platform</SectionLabel>
      <View style={styles.row}>
        {targets.map(({ target, ready }) => {
          const isSelected = selected?.platform === target.platform;
          return (
            <Pressable
              key={target.platform}
              style={({ pressed }) => [
                styles.choice,
                isSelected && styles.choiceSelected,
                pressed && styles.pressedFx,
              ]}
              onPress={() =>
                ready
                  ? setSelected(target)
                  : Alert.alert(
                      `${target.displayName} needs setup`,
                      'This connector is built but not configured yet (OAuth client / API review pending). Use the mock platform to test the flow.',
                    )
              }>
              <View
                style={[styles.readyDot, { backgroundColor: ready ? colors.success : colors.textFaint }]}
              />
              <Text
                style={[
                  styles.choiceText,
                  isSelected && styles.choiceTextSelected,
                  !ready && { color: colors.textFaint },
                ]}>
                {target.displayName}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <SectionLabel>Caption</SectionLabel>
      <TextInput
        style={styles.input}
        value={caption}
        onChangeText={setCaption}
        placeholder="Say something…"
        placeholderTextColor={colors.textDim}
        multiline
      />

      <SectionLabel>Visibility</SectionLabel>
      <View style={styles.row}>
        {PRIVACY_CHOICES.map(p => (
          <Pressable
            key={p}
            style={({ pressed }) => [
              styles.choice,
              privacy === p && styles.choiceSelected,
              pressed && styles.pressedFx,
            ]}
            onPress={() => setPrivacy(p)}>
            <Text style={[styles.choiceText, privacy === p && styles.choiceTextSelected]}>
              {p}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.choice,
          withCaptions && styles.choiceSelected,
          styles.captionToggle,
          pressed && styles.pressedFx,
        ]}
        onPress={() => setWithCaptions(v => !v)}>
        <Text style={[styles.choiceText, withCaptions && styles.choiceTextSelected]}>
          {withCaptions ? '✓ Auto-captions' : 'Auto-captions off'}
        </Text>
      </Pressable>

      <Button
        label={phase.step === 'publishing' ? 'Publishing…' : 'Publish'}
        tone="accent"
        busy={phase.step === 'publishing'}
        disabled={!selected}
        onPress={confirmAndPublish}
        style={styles.cta}
      />
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
      {status.state === 'processing' || status.state === 'pending' ? (
        <ActivityIndicator size="large" color={colors.accent} />
      ) : (
        <View
          style={[
            styles.statusRing,
            { borderColor: status.state === 'published' ? colors.success : colors.accent },
          ]}>
          <Text
            style={[
              styles.statusGlyph,
              { color: status.state === 'published' ? colors.success : colors.accent },
            ]}>
            {status.state === 'published' ? '✓' : '✕'}
          </Text>
        </View>
      )}
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
  pressedFx: { transform: [{ scale: 0.97 }], opacity: 0.9 },
  preview: {
    width: '40%',
    aspectRatio: 9 / 16,
    borderRadius: radius.m,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceHigh,
    alignSelf: 'center',
  },
  clipName: {
    ...type.heading,
    color: colors.text,
    fontSize: 16,
    textAlign: 'center',
    marginBottom: spacing.s,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surfaceHigh,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.m,
    paddingVertical: spacing.s + 2,
  },
  choiceSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  choiceText: { color: colors.textDim, fontSize: 14, fontWeight: '600' },
  choiceTextSelected: { color: colors.text },
  readyDot: { width: 7, height: 7, borderRadius: 3.5 },
  captionToggle: { alignSelf: 'flex-start', marginTop: spacing.s },
  input: {
    backgroundColor: colors.surfaceHigh,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.s,
    color: colors.text,
    padding: spacing.m,
    fontSize: 15,
    minHeight: 72,
    textAlignVertical: 'top',
  },
  cta: { marginTop: spacing.l },
  statusRoot: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.m },
  statusRing: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusGlyph: { fontSize: 30, fontWeight: '800' },
  statusTitle: { color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  statusDetail: { color: colors.textDim, fontSize: 14, textAlign: 'center' },
  statusWarning: { color: colors.warning, fontSize: 14, textAlign: 'center', fontWeight: '600' },
});
