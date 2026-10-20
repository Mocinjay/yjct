import RNFS from 'react-native-fs';
import type { ClipHosting } from './ClipHosting';

/**
 * Real hosting behind the ClipHosting seam, vendor-neutral: any backend
 * (S3+CloudFront, R2, GCS…) that exposes a presign endpoint works.
 *
 *   POST presignUrl  {fileName, contentType}
 *   →                {uploadUrl, publicUrl}
 *
 * The app PUTs the clip to `uploadUrl` and hands `publicUrl` (CDN-fronted,
 * public HTTPS — required by Instagram/TikTok) to the connector. Nothing is
 * deleted app-side; expiring uploads is left to the bucket's lifecycle rules.
 */
export class PresignedUrlClipHosting implements ClipHosting {
  constructor(private presignUrl: string) {}

  async upload(localFilePath: string): Promise<{ hostedUrl: string }> {
    const fileName = localFilePath.split('/').pop() ?? 'clip.mp4';
    const res = await fetch(this.presignUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, contentType: 'video/mp4' }),
    });
    if (!res.ok) {
      throw new Error(`Presign request failed: HTTP ${res.status}`);
    }
    const { uploadUrl, publicUrl } = (await res.json()) as {
      uploadUrl: string;
      publicUrl: string;
    };
    if (!uploadUrl || !publicUrl) {
      throw new Error('Presign endpoint must return {uploadUrl, publicUrl}.');
    }

    const upload = await RNFS.uploadFiles({
      toUrl: uploadUrl,
      files: [
        {
          name: 'file',
          filename: fileName,
          filepath: localFilePath,
          filetype: 'video/mp4',
        },
      ],
      method: 'PUT',
      binaryStreamOnly: true,
      headers: { 'Content-Type': 'video/mp4' },
    }).promise;
    if (upload.statusCode < 200 || upload.statusCode >= 300) {
      throw new Error(`Clip upload failed: HTTP ${upload.statusCode}`);
    }
    return { hostedUrl: publicUrl };
  }
}
