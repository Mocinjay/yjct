import { NativeModules, Platform } from 'react-native';
import { createLogger } from '../core/Logger';
import { ErrorCode } from '../core/errors';

const log = createLogger('meta-view-nudge');

interface MetaViewNudgeModule {
  probeSchemes(): Promise<{ url: string; canOpen: boolean }[]>;
  openCompanion(): Promise<{
    opened: string | null;
    ok: boolean;
    reason?: string;
  }>;
}

const native = NativeModules.MetaViewNudge as MetaViewNudgeModule | undefined;

/**
 * Experimental: open Meta View / Meta AI after a mark to test sync latency.
 * See docs/LATERAL-WORKAROUNDS.md — not a sync API.
 */
export const MetaViewNudge = {
  async probeSchemes(): Promise<{ url: string; canOpen: boolean }[]> {
    if (Platform.OS !== 'ios' || !native?.probeSchemes) {
      return [];
    }
    return native.probeSchemes();
  },

  async openCompanion(): Promise<boolean> {
    if (Platform.OS !== 'ios' || !native?.openCompanion) {
      return false;
    }
    try {
      const result = await native.openCompanion();
      log.info('companion open attempt', result);
      return Boolean(result.ok);
    } catch (err) {
      log.expected('companion open failed', err, ErrorCode.GlassesSessionFailed);
      return false;
    }
  },
};
