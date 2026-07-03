import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Video from 'react-native-video';
import { clipStore } from '../../core/ClipStore';
import { entitlementStore } from '../../core/EntitlementStore';
import type { RootStackParamList } from '../navigation';
import { colors, radius, spacing } from '../theme';
import { shareClip } from './LibraryScreen';

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>;

export function PlayerScreen({ route, navigation }: Props) {
  const { clip } = route.params;
  const [name, setName] = useState(clip.name);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(clip.name);
  const [isPro, setIsPro] = useState(false);

  useEffect(() => {
    entitlementStore.isPro().then(setIsPro);
    return entitlementStore.subscribe(setIsPro);
  }, []);

  const publish = () => {
    if (isPro) {
      navigation.navigate('Publish', { clip });
    } else {
      navigation.navigate('Paywall');
    }
  };

  const saveRename = async () => {
    const trimmed = draft.trim();
    if (trimmed) {
      await clipStore.rename(clip.id, trimmed);
      setName(trimmed);
    }
    setRenaming(false);
  };

  const confirmDelete = () => {
    Alert.alert('Delete clip?', `“${name}” will be removed permanently.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await clipStore.remove(clip.id);
          navigation.goBack();
        },
      },
    ]);
  };

  return (
    <View style={styles.root}>
      <Video
        source={{ uri: `file://${clip.filePath}` }}
        style={styles.video}
        controls
        resizeMode="contain"
      />

      <View style={styles.meta}>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.sub}>
          {Math.round(clip.durationSec)}s ·{' '}
          {new Date(clip.capturedAt).toLocaleString()} · {clip.sourceKind}
        </Text>
      </View>

      <View style={styles.actions}>
        <ActionButton label="Share" onPress={() => shareClip(clip)} primary />
        <ActionButton
          label={isPro ? 'Publish' : '🔒 Publish'}
          onPress={publish}
        />
        <ActionButton label="Rename" onPress={() => setRenaming(true)} />
        <ActionButton label="Delete" onPress={confirmDelete} destructive />
      </View>

      <Modal visible={renaming} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename clip</Text>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              autoFocus
              selectTextOnFocus
              placeholderTextColor={colors.textDim}
            />
            <View style={styles.modalActions}>
              <ActionButton label="Cancel" onPress={() => setRenaming(false)} />
              <ActionButton label="Save" onPress={saveRename} primary />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  primary,
  destructive,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      style={[
        styles.action,
        primary && { backgroundColor: colors.accent },
        destructive && { backgroundColor: colors.accentSoft },
      ]}
      onPress={onPress}>
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  video: { flex: 1, backgroundColor: '#000' },
  meta: { padding: spacing.m },
  name: { color: colors.text, fontSize: 18, fontWeight: '700' },
  sub: { color: colors.textDim, fontSize: 13, marginTop: spacing.xs },
  actions: {
    flexDirection: 'row',
    gap: spacing.s,
    padding: spacing.m,
    paddingBottom: spacing.xl,
  },
  action: {
    flex: 1,
    backgroundColor: colors.surfaceHigh,
    borderRadius: radius.m,
    paddingVertical: spacing.m,
    alignItems: 'center',
  },
  actionText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    padding: spacing.l,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.m,
    padding: spacing.m,
    gap: spacing.m,
  },
  modalTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  input: {
    backgroundColor: colors.surfaceHigh,
    borderRadius: radius.s,
    color: colors.text,
    padding: spacing.m,
    fontSize: 16,
  },
  modalActions: { flexDirection: 'row', gap: spacing.s },
});
