import { NativeModules, Platform } from 'react-native';
import type { CaptionBurnStyle } from '../phase2/captionStyles';
import type { CaptionCue, TimedWord } from '../phase2/captionTimeline';
import type { EditSegment } from '../phase2/climaxEdit';
import type { FeatureGrid } from '../phase2/climaxScoring';

/**
 * Bridges to the on-device engines (both live in the clip-stitcher local
 * package). iOS only: transcription is Apple's Speech framework, the analysis
 * is Accelerate + AVAssetReader, and the render is AVFoundation. Android still
 * goes through the HTTP captioning service.
 *
 * `CaptionEngine` is deliberately separate from `SpeechWakeWord` even though
 * both transcribe. The wake word biases the recognizer toward "Clipso" via
 * contextualStrings and falls back to Apple's servers when on-device finds
 * nothing — both wrong here. Brand biasing corrupts ordinary speech, and
 * captioning that silently uploaded the wearer's audio would defeat the point
 * of doing this on the phone.
 */
export interface TranscribeResult {
  transcript: string;
  words: TimedWord[];
}

export interface RenderResult {
  outputPath: string;
  durationSec: number;
  /** Cues actually drawn — 0 means the clip had no speech. */
  cues: number;
}

interface CaptionEngineModule {
  isAvailable(): Promise<boolean>;
  transcribeClip(path: string): Promise<TranscribeResult>;
  renderEdit(
    sourcePath: string,
    outputPath: string,
    segments: EditSegment[],
    cues: CaptionCue[],
    style: CaptionBurnStyle,
  ): Promise<RenderResult>;
}

interface ClimaxEngineModule {
  /** Audio + visual signals on one uniform grid, for the hook scorer. */
  extractFeatures(path: string): Promise<FeatureGrid>;
}

const captionNative: CaptionEngineModule | undefined = NativeModules.CaptionEngine;
const climaxNative: ClimaxEngineModule | undefined = NativeModules.ClimaxEngine;

export function captionEngineAvailable(): boolean {
  return Platform.OS === 'ios' && captionNative != null;
}

export function climaxEngineAvailable(): boolean {
  return Platform.OS === 'ios' && climaxNative != null;
}

function requireCaption(): CaptionEngineModule {
  if (captionNative == null) {
    throw new Error(
      'CaptionEngine native module not linked — rebuild the app (pod install).',
    );
  }
  return captionNative;
}

export function transcribeClip(path: string): Promise<TranscribeResult> {
  return requireCaption().transcribeClip(path);
}

export function renderEdit(
  sourcePath: string,
  outputPath: string,
  segments: EditSegment[],
  cues: CaptionCue[],
  style: CaptionBurnStyle,
): Promise<RenderResult> {
  return requireCaption().renderEdit(sourcePath, outputPath, segments, cues, style);
}

export function extractFeatures(path: string): Promise<FeatureGrid> {
  if (climaxNative == null) {
    throw new Error(
      'ClimaxEngine native module not linked — rebuild the app (pod install).',
    );
  }
  return climaxNative.extractFeatures(path);
}

export function captionEngineUsable(): Promise<boolean> {
  return captionEngineAvailable()
    ? requireCaption().isAvailable()
    : Promise.resolve(false);
}
