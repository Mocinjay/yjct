import RNFS from 'react-native-fs';
import { AppError, ErrorCode } from '../core/errors';
import {
  httpJson,
  readString,
  requireHttpsRedirectTarget,
  requireHttpsUrl,
} from '../core/http';
import type { ClipHosting } from './ClipHosting';

/**
 * Real hosting behind the ClipHosting seam, vendor-neutral: any backend
 * (S3+CloudFront, R2, GCS…) that exposes a presign endpoint works.
 *
 *   POST presignUrl  {fileName, contentType}
 *   →                {uploadUrl, publicUrl}
 *
 * The app PUTs the clip to `uploadUrl` and hands `publicUrl` (CDN-fronted,
 * public HTTPS — required by Instagram/TikTok) to the connector.
 */
export class PresignedUrlClipHosting implements ClipHosting {
  readonly name = 'presigned';

  constructor(private presignUrl: string) {}

  async upload(localFilePath: string): Promise<{ hostedUrl: string }> {
    // Validated per call rather than in the constructor: targets are rebuilt
    // from stored config on every listTargets(), so a bad value pasted into
    // Settings would otherwise throw while merely *listing* the connectors and
    // take the whole publish screen down with it.
    const presignUrl = requireHttpsUrl(
      this.presignUrl,
      ErrorCode.HostingNotConfigured,
      'Clip hosting presign URL',
    );
    const fileName = localFilePath.split('/').pop() ?? 'clip.mp4';
    const { ok, status, body } = await httpJson(presignUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, contentType: 'video/mp4' }),
      networkCode: ErrorCode.HostingUploadFailed,
      label: 'Presign request',
    });
    if (!ok) {
      throw new AppError(
        ErrorCode.HostingUploadFailed,
        `Presign request failed: HTTP ${status}`,
      );
    }
    const uploadUrl = readString(body, 'uploadUrl');
    const publicUrl = readString(body, 'publicUrl');
    if (!uploadUrl || !publicUrl) {
      throw new AppError(
        ErrorCode.HostingUploadFailed,
        'Presign endpoint must return {uploadUrl, publicUrl}.',
        { context: { keys: Object.keys(body) } },
      );
    }

    const upload = await RNFS.uploadFiles({
      // The server chose this destination and the clip is about to be sent
      // there, so it gets the same scheme check a typed URL does.
      toUrl: requireHttpsRedirectTarget(uploadUrl, 'Presigned upload URL'),
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
      throw new AppError(
        ErrorCode.HostingUploadFailed,
        `Clip upload failed: HTTP ${upload.statusCode}`,
      );
    }
    return {
      hostedUrl: requireHttpsRedirectTarget(publicUrl, 'Hosted clip URL'),
    };
  }

  async remove(_hostedUrl: string): Promise<void> {
    // Lifecycle rules on the bucket handle cleanup; nothing to do app-side.
  }
}
