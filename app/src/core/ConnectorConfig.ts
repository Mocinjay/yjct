import AsyncStorage from '@react-native-async-storage/async-storage';
import { createLogger } from './Logger';
import { ErrorCode } from './errors';

const log = createLogger('connectors');

/**
 * PHASE 2 — sandbox/live credentials for the connectors, entered in
 * Settings → Connections. Each connector reports isConfigured()=false until
 * its fields are present, so the publish UI never pretends a platform works.
 *
 * These are developer/sandbox credentials for now. Production auth flows
 * (user-facing OAuth) replace direct token entry before any store release.
 */
export interface ConnectorConfig {
  meta?: {
    /** Graph API user access token with instagram_content_publish. */
    accessToken?: string;
    /** Instagram professional account id (not the username). */
    igUserId?: string;
    /** Facebook Page id for /videos publishing. */
    pageId?: string;
    /** Page access token with pages_manage_posts etc. */
    pageAccessToken?: string;
  };
  tiktok?: {
    /** Content Posting API access token (sandbox until audit clears). */
    accessToken?: string;
    /**
     * Set true ONLY after TikTok's manual audit approval is confirmed.
     * While false, every post is forced private by the platform and the
     * UI reports that honestly.
     */
    auditCleared?: boolean;
  };
  /**
   * Presign endpoint for clip hosting: POST {fileName, contentType} →
   * {uploadUrl, publicUrl}. When unset, the mock hosting is used.
   */
  hostingPresignUrl?: string;
  /**
   * Base URL of the captioning service (see server/captioning). When unset,
   * the mock captioner is used.
   */
  captioningUrl?: string;
}

const KEY = 'connectorConfig.v1';

export class ConnectorConfigStore {
  private cached: ConnectorConfig | null = null;
  private listeners = new Set<(c: ConnectorConfig) => void>();

  async get(): Promise<ConnectorConfig> {
    if (this.cached) {
      return this.cached;
    }
    try {
      const raw = await AsyncStorage.getItem(KEY);
      this.cached = raw ? (JSON.parse(raw) as ConnectorConfig) : {};
    } catch (err) {
      // An empty config and an unreadable one look the same from the publish
      // screen — every connector reports "needs setup" — so credentials that
      // were entered and then lost presented as credentials never entered.
      log.error(
        'stored connector config could not be read — every connector will report unconfigured',
        err,
        ErrorCode.PublishNotConfigured,
      );
      this.cached = {};
    }
    return this.cached;
  }

  async update(patch: Partial<ConnectorConfig>): Promise<ConnectorConfig> {
    const current = await this.get();
    const next: ConnectorConfig = {
      ...current,
      ...patch,
      meta: patch.meta ? { ...current.meta, ...patch.meta } : current.meta,
      tiktok: patch.tiktok ? { ...current.tiktok, ...patch.tiktok } : current.tiktok,
    };
    this.cached = next;
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
    this.listeners.forEach(l => l(next));
    return next;
  }

  subscribe(listener: (c: ConnectorConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const connectorConfigStore = new ConnectorConfigStore();
