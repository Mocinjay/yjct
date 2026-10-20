/**
 * Cloud storage + CDN seam.
 *
 * Instagram, Facebook and TikTok pull the clip from a public HTTPS URL rather
 * than taking an upload (`PublishTarget.requiresHostedUrl`). This interface is
 * the seam for that infra (S3+CloudFront, R2, whatever) — the app never
 * hardcodes a storage vendor.
 */
export interface ClipHosting {
  /**
   * Uploads the clip and resolves to a CDN-fronted HTTPS URL. Implementations
   * should return URLs that stay valid at least long enough for the platform
   * to fetch (IG container polling can take minutes).
   */
  upload(localFilePath: string): Promise<{ hostedUrl: string }>;
}

/**
 * Dev stand-in: pretends to host and returns a fake `.invalid` URL after a
 * short delay. PublishService only uses it for the dev mock platform; a real
 * platform handed this URL would fail to fetch it.
 */
export class MockClipHosting implements ClipHosting {
  async upload(localFilePath: string): Promise<{ hostedUrl: string }> {
    await sleep(600);
    const file = localFilePath.split('/').pop();
    return { hostedUrl: `https://cdn.fadeaway.invalid/${file}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
