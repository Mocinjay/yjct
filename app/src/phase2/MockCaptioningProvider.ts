import RNFS from 'react-native-fs';
import type { CaptioningProvider } from './CaptioningProvider';

/**
 * Dev stand-in for the external captioning infra. Copies the clip untouched
 * after a delay so the Pro pipeline (clip → caption → publish) can be
 * exercised end-to-end with no vendor. The real provider is external infra
 * plugged in behind CaptioningProvider — never hardcoded here.
 */
export class MockCaptioningProvider implements CaptioningProvider {
  readonly name = 'mock';

  async caption(clipFilePath: string): Promise<{ captionedFilePath: string }> {
    await new Promise<void>(resolve => setTimeout(resolve, 800));
    const captionedFilePath = clipFilePath.replace(/\.mp4$/, '.captioned.mp4');
    await RNFS.copyFile(clipFilePath, captionedFilePath);
    return { captionedFilePath };
  }
}
