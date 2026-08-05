import RNFS from 'react-native-fs';
import { clipStore } from '../core/ClipStore';
import { createLogger } from '../core/Logger';
import { ErrorCode } from '../core/errors';
import { settingsStore } from '../core/SettingsStore';

const log = createLogger('test-render');
import {
  climaxEngineAvailable,
  extractFeatures,
  renderEdit,
  transcribeClip,
} from '../native/CaptionEngineNative';
import { captionStylePreset } from '../captions/captionStyles';
import { buildCaptionCues } from '../captions/captionTimeline';
import { buildClimaxCaptionCues, outputDuration, planSegments } from './climaxEdit';
import { findHook } from './climaxScoring';

/**
 * DEV ONLY — runs the whole on-device pipeline against the sample clip bundled
 * for the mock glasses feed, and drops the result into the library.
 *
 * Exists because the app is glasses-only: without hardware paired there is no
 * way to produce a clip, and therefore no way to see whether transcription,
 * scoring and the render actually work on a real phone. This gives that a
 * single tap.
 *
 * The bundled feed has no audio track, so it exercises the video-only path —
 * visual features, hook scoring, the restructure and the export — but produces
 * no captions, because nothing is said. That is the honest result, not a bug.
 */
export interface TestRenderReport {
  lines: string[];
  outputPath: string;
  clipId: string;
}

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
  await RNFS.copyFile(source, working);
  say('Copied the sample clip out of the bundle.');

  const settings = await settingsStore.get();
  const style = captionStylePreset(settings.captionStyle).burn;

  let t = Date.now();
  const { words } = await transcribeClip(working);
  say(`Transcribed: ${words.length} words in ${lap(t)}.`);

  let segments = null;
  let cues;
  if (settings.climaxEdit && climaxEngineAvailable()) {
    t = Date.now();
    const grid = await extractFeatures(working);
    const signalNames = Object.keys(grid.signals);
    say(
      `Analysed ${grid.duration.toFixed(1)}s in ${lap(t)}: ` +
        `${signalNames.length} signals (${signalNames.join(', ')}).`,
    );

    t = Date.now();
    const hook = findHook(grid, words);
    say(
      `Hook ${hook.start.toFixed(2)}–${hook.end.toFixed(2)}s ` +
        `score ${hook.score.toFixed(3)} confidence ${hook.confidence.toFixed(3)} (${lap(t)}).`,
    );
    say(
      'Why: ' +
        Object.entries(hook.reason)
          .map(([k, v]) => `${k} ${v.toFixed(2)}`)
          .join(' · '),
    );

    segments = planSegments({
      hookStart: hook.start,
      hookEnd: hook.end,
      sourceDuration: grid.duration,
    });
    cues = buildClimaxCaptionCues(words, segments, style);
    say(`Output timeline: ${outputDuration(segments).toFixed(1)}s, ${cues.length} captions.`);
  } else {
    cues = buildCaptionCues(words, style);
    say(`Chronological: ${cues.length} captions.`);
  }

  t = Date.now();
  const outputPath = working.replace(/\.mp4$/, '.rendered.mp4');
  const result = await renderEdit(working, outputPath, segments ?? [], cues, style);
  say(`Rendered ${result.durationSec.toFixed(1)}s in ${lap(t)}.`);

  const thumbnailPath = outputPath.replace(/\.mp4$/, '.jpg');
  // No stitcher run here, so there is no poster frame; reuse nothing rather
  // than fabricating one. The card shows a blank tile and still plays.
  await RNFS.writeFile(thumbnailPath, '', 'utf8').catch(err =>
    log.expected('could not write placeholder thumbnail', err, ErrorCode.StorageWriteFailed),
  );

  await clipStore.add({
    id,
    name: `Test render ${new Date().toLocaleTimeString()}`,
    filePath: outputPath,
    thumbnailPath,
    capturedAt: Date.now(),
    durationSec: result.durationSec,
    sourceKind: 'mock',
    savedAt: Date.now(),
    expiresAt: null,
    captionState: 'ready',
    captionedFilePath: outputPath,
    captionStyle: settings.captionStyle,
    captionProvider: settings.climaxEdit ? 'on-device+hook' : 'on-device',
    captionError: null,
  });

  say(`Done in ${lap(started)} — open it from the library.`);
  return { lines, outputPath, clipId: id };
}
