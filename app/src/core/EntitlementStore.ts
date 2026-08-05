import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'entitlement.v1';

/**
 * Pro subscription entitlement ($15/mo tier).
 *
 * ⚠️ Placeholder persistence only. Real gating must validate App Store /
 * Play Store receipts client-side (per the project spec — never gate on
 * captioning-provider auth alone, that infra is swappable). StoreKit /
 * Play Billing integration replaces `devUnlock()` when payments land.
 */
export class EntitlementStore {
  private cached: boolean | null = null;
  private listeners = new Set<(isPro: boolean) => void>();

  async isPro(): Promise<boolean> {
    if (this.cached !== null) {
      return this.cached;
    }
    // Debug builds are Pro. Auto-captioning is Pro-gated at the queue, so a
    // dev build with no entitlement drops every clip on the floor before a
    // job is ever created — which reads as "captions are broken" rather than
    // "captions are paywalled". `clear()` still forces the free path when
    // that is what you want to exercise.
    this.cached = __DEV__ || (await AsyncStorage.getItem(KEY)) === 'pro';
    return this.cached;
  }

  /** Dev-only unlock until real billing is integrated. */
  async devUnlock(): Promise<void> {
    this.cached = true;
    await AsyncStorage.setItem(KEY, 'pro');
    this.listeners.forEach(l => l(true));
  }

  async clear(): Promise<void> {
    this.cached = false;
    await AsyncStorage.removeItem(KEY);
    this.listeners.forEach(l => l(false));
  }

  subscribe(listener: (isPro: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const entitlementStore = new EntitlementStore();
