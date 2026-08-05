/**
 * The climax-first re-cut: rebuild a clip as
 * `[best 3-7s] -> [0.5s black] -> [complete original]`.
 *
 * Scoring is TypeScript because it is arithmetic, and arithmetic belongs where
 * it can be tested — `server/climax/` stays the reference implementation, and
 * `climaxScoring.test.ts` asserts agreement against a fixture exported from it
 * so the two cannot drift silently. Feature *extraction* is native; this layer
 * only decides where the hook is and how the segments are laid out.
 *
 * Depends on `captions/` for cue layout, and on nothing else in the app.
 */
export type { EditSegment } from './climaxEdit';
export { buildClimaxCaptionCues, planSegments } from './climaxEdit';

export { findHook } from './climaxScoring';

export { runTestRender } from './testRender';
