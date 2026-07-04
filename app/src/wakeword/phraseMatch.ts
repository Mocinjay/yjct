/**
 * Wake-phrase matching over noisy speech-to-text output.
 *
 * The canonical phrase is "yo jarvis, clip that" but recognizers mangle
 * names, so we accept "jarvis" (and close mis-hearings) or a bare
 * "clip that/it" anywhere in the transcript.
 */
const PATTERNS: RegExp[] = [
  /\bjarvis\b/,
  // Common recognizer mis-hearings of "jarvis"
  /\bjarvis+e?\b/,
  /\bjarves\b/,
  /\bjar\s?vis\b/,
  /\bjervis\b/,
  /\bclip (that|it)\b/,
];

export function matchesWakePhrase(transcript: string): boolean {
  const normalized = transcript.toLowerCase().replace(/[^a-z\s]/g, ' ');
  return PATTERNS.some(p => p.test(normalized));
}
