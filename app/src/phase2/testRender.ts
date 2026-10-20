import RNFS from 'react-native-fs';
import { clipStore } from '../core/ClipStore';
import { settingsStore } from '../core/SettingsStore';
import { renderEdit, transcribeClip } from '../native/CaptionEngineNative';
import { captionStylePreset } from './captionStyles';
import { outputDuration } from './climaxEdit';
import { planEdit } from './OnDeviceCaptioningProvider';

export interface TestRenderReport {
  /** The progress log, one line per step. */
  lines: string[];
}

/**
 * DEV ONLY — runs the on-device pipeline against the sample clip bundled for
 * the mock glasses feed, and drops the result into the library (kept, not
 * temporary).
 *
 * Exists because the app is glasses-only: without hardware paired there is no
 * other way to produce a clip, and therefore no way to see whether
 * transcription, scoring and the render actually work on a real phone. It
 * goes through the captioner's own `planEdit`, so it tests what ships.
 *
 * The bundled feed has no audio track, so it exercises the video-only path —
 * visual features, hook scoring, the restructure and the export — and
 * produces no captions, because nothing is said.
 */
export async function runTestRender(
  onProgress?: (message: string) => void,
): Promise<TestRenderReport> {
  const lines: string[] = [];
  const say = (message: string) => {
    lines.push(message);
    onProgress?.(message);
  };
  const started = Date.now();
  const lap = (from: number) => `${((Date.now() - from) / 1000).toFixed(1)}s`;

  const source = `${RNFS.MainBundlePath}/MockFeed.mp4`;
  if (!(await RNFS.exists(source))) {
    throw new Error('MockFeed.mp4 is not in the app bundle.');
  }

  const dir = await clipStore.ensureDir();
  const id = `test_${Date.now()}`;
  const working = `${dir}/${id}.mp4`;
  const outputPath = `${dir}/${id}.rendered.mp4`;
  const settings = await settingsStore.get();
  const style = captionStylePreset(settings.captionStyle).burn;

  await RNFS.copyFile(source, working);
  say('Copied the sample clip out of the bundle.');

  let durationSec: number;
  let hooked: boolean;
  try {
    let t = Date.now();
    const { words } = await transcribeClip(working);
    say(`Transcribed: ${words.length} words in ${lap(t)}.`);

    t = Date.now();
    const { segments, cues } = await planEdit(
      working,
      words,
      style,
      settings.climaxEdit,
      say,
    );
    hooked = segments !== null;
    say(
      segments
        ? `Output timeline: ${outputDuration(segments).toFixed(1)}s, ` +
            `${cues.length} captions (planned in ${lap(t)}).`
        : `Chronological: ${cues.length} captions.`,
    );

    t = Date.now();
    const result = await renderEdit(working, outputPath, segments ?? [], cues, style);
    durationSec = result.durationSec;
    say(`Rendered ${durationSec.toFixed(1)}s in ${lap(t)}.`);
  } finally {
    // Only the render goes into the library. No clip points at the working
    // copy, so ClipStore would never delete it: ~3 MB leaked per run,
    // including a run that fails part-way.
    await RNFS.unlink(working).catch(() => {});
  }

  const thumbnailPath = outputPath.replace(/\.mp4$/, '.jpg');
  // No stitcher run here, so there is no poster frame. The card shows a blank
  // tile and still plays.
  await RNFS.writeFile(thumbnailPath, '', 'utf8').catch(() => {});

  await clipStore.add({
    id,
    name: `Test render ${new Date().toLocaleTimeString()}`,
    filePath: outputPath,
    thumbnailPath,
    capturedAt: Date.now(),
    durationSec,
    sourceKind: 'mock',
    savedAt: Date.now(),
    expiresAt: null,
    captionState: 'ready',
    captionedFilePath: outputPath,
    captionStyle: settings.captionStyle,
    // What actually ran: hook-first falls back to chronological when the
    // analysis is unavailable or fails.
    captionProvider: hooked ? 'on-device+hook' : 'on-device',
    captionError: null,
  });

  say(`Done in ${lap(started)} — open it from the library.`);
  return { lines };
}
