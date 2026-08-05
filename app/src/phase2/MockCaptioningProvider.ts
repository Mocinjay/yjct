import RNFS from 'react-native-fs';
import type { CaptioningProvider } from './CaptioningProvider';
import type { CaptionStyleKey } from './captionStyles';
import { DEFAULT_CAPTION_STYLE } from './captionStyles';

/**
 * Dev stand-in for the external captioning infra. Copies the clip untouched
 * after a delay so the Pro pipeline (clip → caption → publish) can be
 * exercised with no vendor. The real provider is external infra plugged in
 * behind CaptioningProvider — never hardcoded here.
 *
 * `burnsCaptions` is false: nothing is drawn on these frames, and the library
 * labels them as mock rather than showing a captions badge that isn't true.
 */
export class MockCaptioningProvider implements CaptioningProvider {
  readonly name = 'mock';
  readonly burnsCaptions = false;

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
    await RNFS.copyFile(clipFilePath, captionedFilePath);
    return { captionedFilePath };
  }
}
