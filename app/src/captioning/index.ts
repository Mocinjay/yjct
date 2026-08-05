/**
 * Producing captions: the provider seam, its implementations, and the queue
 * that runs a job per captured clip.
 *
 * `CaptioningProvider` is `(clipFile, {style}) → captionedClipFile`, and that
 * seam is what let captioning move on-device without touching anything above
 * it. `resolveCaptioner()` picks the implementation — on-device first, the
 * self-hosted HTTP service second, the mock last and self-labelled.
 *
 * Depends on `captions/` for cue layout and `editing/` for the hook-first
 * re-cut (the on-device provider does both in a single export, because cutting
 * first and captioning after would cost two encode generations). Nothing here
 * depends on `publishing/`.
 */
export type { CaptioningProvider } from './CaptioningProvider';
export { resolveCaptioner } from './resolveCaptioner';
export { captionQueue } from './CaptionQueue';
export { OnDeviceCaptioningProvider } from './OnDeviceCaptioningProvider';
export { HttpCaptioningProvider } from './HttpCaptioningProvider';
export { MockCaptioningProvider } from './MockCaptioningProvider';
