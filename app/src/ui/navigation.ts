import type { Clip } from '../types';

export type RootStackParamList = {
  Connect: undefined;
  Onboarding: undefined;
  Library: undefined;
  Armed: undefined;
  Player: { clip: Clip };
  Settings: undefined;
  Paywall: undefined;
  Publish: { clip: Clip };
};
