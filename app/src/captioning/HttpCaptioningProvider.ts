import RNFS from 'react-native-fs';
import { AppError, ErrorCode } from '../core/errors';
import { parseJsonObject, readString, requireHttpsUrl } from '../core/http';
import type { CaptioningProvider } from './CaptioningProvider';
import type { CaptionStyleKey } from '../captions/captionStyles';
import { DEFAULT_CAPTION_STYLE } from '../captions/captionStyles';

/**
 * Talks to the self-hosted captioning service (server/captioning) — or any
 * vendor implementing the same two-endpoint contract:
 *
 *   POST {baseUrl}/caption               multipart "file" + "style" → {id}
 *   GET  {baseUrl}/caption/{id}/download → captioned MP4
 *
 * The app never knows what's behind the URL; captioning stays swappable.
 */
export class HttpCaptioningProvider implements CaptioningProvider {
  readonly name = 'http';
  readonly burnsCaptions = true;

  constructor(private baseUrl: string) {}

  async caption(
    clipFilePath: string,
    options?: { style?: CaptionStyleKey },
  ): Promise<{ captionedFilePath: string }> {
    // The clip's audio and video both leave the device here, so the transport
    // is checked before any of it does. Loopback over http is allowed so the
    // Python service can be developed against.
    const base = requireHttpsUrl(
      this.baseUrl,
      ErrorCode.CaptionJobFailed,
      'Captioning service URL',
    ).replace(/\/+$/, '');
    const style = options?.style ?? DEFAULT_CAPTION_STYLE;

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
      fields: { style },
      method: 'POST',
    }).promise;
    if (upload.statusCode < 200 || upload.statusCode >= 300) {
      throw new AppError(
        ErrorCode.CaptionJobFailed,
        `Captioning service error: HTTP ${upload.statusCode}`,
      );
    }
    // Was a bare destructure off `JSON.parse`: an HTML error page from a proxy
    // threw a SyntaxError about `<`, and a 200 with the wrong shape produced
    // `undefined` that was then interpolated into the download URL.
    const id = readString(parseJsonObject(upload.body), 'id');
    if (!id) {
      throw new AppError(
        ErrorCode.CaptionJobFailed,
        'Captioning service accepted the clip but returned no job id.',
      );
    }

    // The style is part of the filename so re-captioning in a different style
    // writes a new file. Overwriting one path would leave the player showing
    // the old, already-decoded video.
    const captionedFilePath = clipFilePath.replace(
      /\.mp4$/,
      `.captioned.${style}.mp4`,
    );
    const download = await RNFS.downloadFile({
      fromUrl: `${base}/caption/${encodeURIComponent(id)}/download`,
      toFile: captionedFilePath,
    }).promise;
    if (download.statusCode < 200 || download.statusCode >= 300) {
      throw new AppError(
        ErrorCode.CaptionJobFailed,
        `Captioned clip download failed: HTTP ${download.statusCode}`,
      );
    }
    return { captionedFilePath };
  }
}
