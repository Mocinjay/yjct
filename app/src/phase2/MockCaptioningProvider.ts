import RNFS from 'react-native-fs';
import type { CaptioningProvider } from './CaptioningProvider';
import type { CaptionStyleKey } from './captionStyles';
import { DEFAULT_CAPTION_STYLE } from './captionStyles';

/**
 * Dev stand-in captioner (dev builds only; see captioner.ts). Copies the clip
 * untouched after a delay so the Pro pipeline (clip → caption → publish) can
 * be exercised with no captioning engine. Its name, 'mock', is recorded on
 * the clip, and the library labels those clips as mock rather than showing a
 * captions badge that isn't true.
 */
export class MockCaptioningProvider implements CaptioningProvider {
  readonly name = 'mock';

  async caption(
    clipFilePath: string,
    options?: { style?: CaptionStyleKey },
  ): Promise<{ captionedFilePath: string }> {
    await new Promise<void>(resolve => setTimeout(resolve, 800));
    const style = options?.style ?? DEFAULT_CAPTION_STYLE;
    const captionedFilePath = clipFilePath.replace(
      /\.mp4$/,
      `.captioned.${style}.mp4`,
    );
    // copyFile will not overwrite on iOS; a same-style re-run (Recaption, or
    // a job resumed after the app was killed mid-copy) must replace the old
    // copy rather than fail on it.
    await RNFS.unlink(captionedFilePath).catch(() => {});
    await RNFS.copyFile(clipFilePath, captionedFilePath);
    return { captionedFilePath };
  }
}
