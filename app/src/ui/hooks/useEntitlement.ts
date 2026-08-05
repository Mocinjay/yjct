import { useCallback, useEffect, useState } from 'react';
import { entitlementStore } from '../../core/EntitlementStore';
import { createLogger } from '../../core/Logger';
import { ErrorCode } from '../../core/errors';

const log = createLogger('entitlement');

export interface Entitlement {
  isPro: boolean;
  /** Dev-only unlock, until StoreKit / Play Billing replaces it. */
  unlock: () => Promise<void>;
  /** Drop back to the free tier — used to exercise the free path in dev. */
  clear: () => Promise<void>;
  /**
   * The stored value has been read at least once.
   *
   * Distinguishing "not Pro" from "not known yet" matters: the library picks a
   * default tab from it, and treating the initial `false` as an answer made a
   * Pro user's first render land on a tab that is always empty for them.
   */
  ready: boolean;
}

/**
 * Pro entitlement, kept in sync with the store.
 *
 * Four screens each re-implemented this `isPro() + subscribe()` pair, and
 * three of them leaked the subscription's initial read across an unmount.
 */
export function useEntitlement(): Entitlement {
  const [isPro, setIsPro] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    entitlementStore
      .isPro()
      .then(pro => {
        if (active) {
          setIsPro(pro);
          setReady(true);
        }
      })
      .catch(err => {
        log.error('could not read entitlement', err, ErrorCode.StorageIndexUnreadable);
        if (active) {
          // Fail closed: a read error must not hand out Pro.
          setReady(true);
        }
      });
    const unsubscribe = entitlementStore.subscribe(pro => {
      if (active) {
        setIsPro(pro);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const unlock = useCallback(async () => {
    try {
      await entitlementStore.devUnlock();
    } catch (err) {
      log.error('could not unlock Pro', err, ErrorCode.StorageWriteFailed);
    }
  }, []);

  const clear = useCallback(async () => {
    try {
      await entitlementStore.clear();
    } catch (err) {
      log.error('could not clear entitlement', err, ErrorCode.StorageWriteFailed);
    }
  }, []);

  return { isPro, ready, unlock, clear };
}
