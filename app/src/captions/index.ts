/**
 * What a caption *is*: the style presets and the cue timeline.
 *
 * The bottom layer of the caption stack, and deliberately free of dependencies
 * — no native modules, no stores, no I/O. Both `captioning/` (which produces
 * captions) and `editing/` (which lays them out on a re-cut timeline) build on
 * this, and keeping it dependency-free is what stops those two from having to
 * import each other.
 *
 * The timing rules live here rather than in the native renderer because they
 * are the part that is easy to get subtly wrong — chunking, per-word highlight
 * spans, the non-overlap clamp, line layout — and they belong somewhere
 * testable without a device. Native draws what it is told.
 */
export type {
  CaptionBurnStyle,
  CaptionPreview,
  CaptionStyleKey,
  CaptionStylePreset,
} from './captionStyles';
export {
  CAPTION_STYLES,
  DEFAULT_CAPTION_STYLE,
  captionStyleLabel,
  captionStylePreset,
} from './captionStyles';

export type { CaptionCue, TimedWord } from './captionTimeline';
export { buildCaptionCues } from './captionTimeline';
