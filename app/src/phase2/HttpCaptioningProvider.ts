import RNFS from 'react-native-fs';
import type { CaptioningProvider } from './CaptioningProvider';

/**
 * Talks to the self-hosted captioning service (server/captioning) — or any
 * vendor implementing the same two-endpoint contract:
 *
 *   POST {baseUrl}/caption               multipart "file" → {id}
 *   GET  {baseUrl}/caption/{id}/download → captioned MP4
 *
 * The app never knows what's behind the URL; captioning stays swappable.
 */
export class HttpCaptioningProvider implements CaptioningProvider {
  readonly name = 'http';

  constructor(private baseUrl: string) {}

  async caption(clipFilePath: string): Promise<{ captionedFilePath: string }> {
    const base = this.baseUrl.replace(/\/+$/, '');

    const upload = await RNFS.uploadFiles({
      toUrl: `${base}/caption`,
      files: [
        {
          name: 'file',
          filename: clipFilePath.split('/').pop() ?? 'clip.mp4',
          filepath: clipFilePath,
          filetype: 'video/mp4',
        },
      ],
      method: 'POST',
    }).promise;
    if (upload.statusCode < 200 || upload.statusCode >= 300) {
      throw new Error(`Captioning service error: HTTP ${upload.statusCode}`);
    }
    const { id } = JSON.parse(upload.body) as { id: string };

    const captionedFilePath = clipFilePath.replace(/\.mp4$/, '.captioned.mp4');
    const download = await RNFS.downloadFile({
      fromUrl: `${base}/caption/${id}/download`,
      toFile: captionedFilePath,
    }).promise;
    if (download.statusCode < 200 || download.statusCode >= 300) {
      throw new Error(`Captioned clip download failed: HTTP ${download.statusCode}`);
    }
    return { captionedFilePath };
  }
}
