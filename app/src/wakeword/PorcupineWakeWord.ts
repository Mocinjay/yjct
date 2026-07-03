import {
  BuiltInKeywords,
  PorcupineManager,
} from '@picovoice/porcupine-react-native';
import type { WakeWordProvider } from './WakeWordProvider';

/**
 * Picovoice Porcupine keyword spotting — fully on-device, no audio leaves
 * the phone. Uses built-in keywords for now; a custom "clip that" model
 * (.ppn) can be dropped in later via PorcupineManager.fromKeywordPaths.
 */
export class PorcupineWakeWord implements WakeWordProvider {
  readonly name = 'porcupine';

  private manager: PorcupineManager | null = null;

  constructor(
    private accessKey: string,
    private keyword: string,
  ) {}

  static supportedKeywords(): string[] {
    return Object.values(BuiltInKeywords);
  }

  async start(onDetected: () => void): Promise<void> {
    const builtIn = toBuiltInKeyword(this.keyword);
    this.manager = await PorcupineManager.fromBuiltInKeywords(
      this.accessKey,
      [builtIn],
      () => onDetected(),
      error => {
        console.warn(`[PorcupineWakeWord] processing error: ${error.message}`);
      },
    );
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

function toBuiltInKeyword(keyword: string): BuiltInKeywords {
  const match = Object.values(BuiltInKeywords).find(
    k => k.toLowerCase() === keyword.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `Unknown wake word "${keyword}". Supported: ${Object.values(BuiltInKeywords).join(', ')}`,
    );
  }
  return match as BuiltInKeywords;
}
