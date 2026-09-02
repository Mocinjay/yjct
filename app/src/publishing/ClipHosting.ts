import { sleep } from '../core/sleep';

/**
 * PHASE 2 — cloud storage + CDN seam.
 *
 * Instagram and TikTok both require the clip at a public HTTPS URL before
 * their publish APIs will touch it. This interface is the seam for that
 * infra (S3+CloudFront, R2, whatever) — the app never hardcodes a storage
 * vendor.
 */
export interface ClipHosting {
  readonly name: string;

  /**
   * Uploads the clip and resolves to a CDN-fronted HTTPS URL. Implementations
   * should return URLs that stay valid at least long enough for the platform
   * to fetch (IG container polling can take minutes).
   */
  upload(localFilePath: string): Promise<{ hostedUrl: string }>;

  /** Best-effort cleanup after the platform has ingested the clip. */
  remove(hostedUrl: string): Promise<void>;
}

/** Dev stand-in: pretends to host, returns a fake URL after a short delay. */
export class MockClipHosting implements ClipHosting {
  readonly name = 'mock';

  async upload(localFilePath: string): Promise<{ hostedUrl: string }> {
    await sleep(600);
    const file = localFilePath.split('/').pop();
    return { hostedUrl: `https://cdn.fadeaway.invalid/${file}` };
  }

  async remove(_hostedUrl: string): Promise<void> {
    // nothing hosted, nothing to remove
  }
}
