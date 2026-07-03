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
    this.cached = (await AsyncStorage.getItem(KEY)) === 'pro';
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
