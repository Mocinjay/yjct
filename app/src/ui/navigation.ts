import type { Clip } from '../types';

export type RootStackParamList = {
  Onboarding: undefined;
  Library: undefined;
  Armed: undefined;
  Player: { clip: Clip };
  Settings: undefined;
};
