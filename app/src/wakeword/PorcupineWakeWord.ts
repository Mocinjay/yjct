import { Platform } from 'react-native';
import {
  BuiltInKeywords,
  PorcupineManager,
} from '@picovoice/porcupine-react-native';
import type { WakeWordProvider } from './WakeWordProvider';

/**
 * Picovoice Porcupine keyword spotting — fully on-device, no audio leaves
 * the phone.
 *
 * The product trigger word "jarvis" is a Porcupine BUILT-IN keyword — it
 * works out of the box with just a (free) Picovoice AccessKey, no model
 * training needed.
 *
 * Custom phrases are still supported: train a .ppn per platform at
 * console.picovoice.ai and bundle it —
 *   Android: app/android/app/src/main/assets/wakewords/<slug>_android.ppn
 *   iOS:     add <slug>_ios.ppn to the Xcode project ("Copy items if
 *            needed") so it lands in the app bundle.
 */
export class PorcupineWakeWord implements WakeWordProvider {
  readonly name = 'porcupine';

  private manager: PorcupineManager | null = null;

  constructor(
    private accessKey: string,
    private keyword: string,
  ) {}

  static supportedBuiltIns(): string[] {
    return Object.values(BuiltInKeywords);
  }

  async start(onDetected: () => void): Promise<void> {
    const builtIn = toBuiltInKeyword(this.keyword);
    if (builtIn) {
      this.manager = await PorcupineManager.fromBuiltInKeywords(
        this.accessKey,
        [builtIn],
        () => onDetected(),
        error => {
          console.warn(`[PorcupineWakeWord] processing error: ${error.message}`);
        },
      );
    } else {
      try {
        this.manager = await PorcupineManager.fromKeywordPaths(
          this.accessKey,
          [customKeywordPath(this.keyword)],
          () => onDetected(),
          error => {
            console.warn(`[PorcupineWakeWord] processing error: ${error.message}`);
          },
        );
      } catch (err) {
        throw new Error(
          `Custom wake word "${this.keyword}" needs a Porcupine model file ` +
            `(${customKeywordPath(this.keyword)}). Train it free at ` +
            'console.picovoice.ai and bundle it, or use a built-in keyword ' +
            `for testing (${Object.values(BuiltInKeywords).join(', ')}). ` +
            `Original error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await this.manager.start();
  }

  async stop(): Promise<void> {
    if (this.manager) {
      await this.manager.stop();
      this.manager.delete();
      this.manager = null;
    }
  }
}

function toBuiltInKeyword(keyword: string): BuiltInKeywords | null {
  const match = Object.values(BuiltInKeywords).find(
    k => k.toLowerCase() === keyword.toLowerCase(),
  );
  return (match as BuiltInKeywords) ?? null;
}

/** Platform-conventional bundle path for a custom keyword model. */
function customKeywordPath(keyword: string): string {
  const slug = keyword.toLowerCase().replace(/\s+/g, '-');
  return Platform.OS === 'android'
    ? `wakewords/${slug}_android.ppn`
    : `${slug}_ios.ppn`;
}
