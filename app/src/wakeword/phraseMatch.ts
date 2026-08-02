/**
 * Wake-phrase matching over noisy speech-to-text output.
 *
 * Trigger word: "Clipso" (clip + so). Recognizers rarely know it, so they
 * split, soften, or substitute — "clip so", "clips oh", "clipse o", "calypso".
 * Match it alone or buried in a sentence.
 *
 * The brand is the ONLY trigger. "clip that / it / this / now" used to fire as
 * an alternate, which meant the retired "yo Jarvis, clip that" still worked and
 * — worse — that ordinary shop talk from the exact people this app is for
 * ("somebody clip that", "I want to clip that moment") silently burned a clip.
 *
 * Deliberately does NOT fire on bare "clip" / "clips" (too common in video
 * talk) or on "eclipse" (contains "clipse" as a substring).
 */

function normalize(transcript: string): string {
  return transcript
    .toLowerCase()
    // clipso's / clipso’s → clipso (before stripping apostrophes)
    .replace(/[''`]s\b/g, '')
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesWakePhrase(transcript: string): boolean {
  const text = normalize(transcript);
  if (!text) {
    return false;
  }

  // Whole-word brand forms — works alone or mid-sentence.
  if (
    /\bclipso+h?\b/.test(text) ||
    /\bklipso+h?\b/.test(text) ||
    /\bclipzo+\b/.test(text) ||
    /\bclipsaw\b/.test(text) ||
    /\bcalypso\b/.test(text)
  ) {
    return true;
  }

  // Spaced / broken "clip so" family (ASR splitting an unknown word).
  // Optional short filler: "clip uh so", "clips oh".
  if (
    /\b(?:clip|klip|clips|clipse)\s+(?:(?:uh|um|a|the|oh)\s+)?(?:so+|oh+|o|sow|show)\b/.test(
      text,
    )
  ) {
    return true;
  }

  // Slogan openers even when the brand token got mangled nearby.
  if (/\b(?:yo|hey|okay|ok|aye|oi)\s+clips?o+\b/.test(text)) {
    return true;
  }

  // Glued ASR with no spaces between neighboring words ("saidclipso" /
  // "clipsoplease"). Require a non-letter edge so "eclipse" stays out.
  const compact = ` ${text.replace(/\s/g, '')} `;
  if (
    /[^a-z]clipso+h?[^a-z]/.test(compact) ||
    /[^a-z]klipso+h?[^a-z]/.test(compact) ||
    /[^a-z]clipzo+[^a-z]/.test(compact) ||
    /[^a-z]calypso[^a-z]/.test(compact)
  ) {
    return true;
  }

  return false;
}
