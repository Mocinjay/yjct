import { Platform } from 'react-native';

/**
 * The caption looks the wearer can pick between. The burn-in itself is done
 * server-side — `server/captioning/captions.py` owns the real definitions and
 * is the only thing that decides what lands in the pixels.
 *
 * What lives here is the key we send and an *approximation* of each look for
 * the Settings preview. Keep the keys in step with CAPTION_STYLES over there;
 * an unknown key is rejected by the service rather than silently swapped, so a
 * drift shows up as a failed job instead of the wrong captions.
 */
export type CaptionStyleKey = 'classic' | 'clean' | 'boxed';

export interface CaptionStylePreset {
  key: CaptionStyleKey;
  label: string;
  description: string;
  /** Whether the style tracks the word currently being spoken. */
  highlightsSpokenWord: boolean;
  preview: CaptionPreview;
  /** What the on-device burner actually draws. */
  burn: CaptionBurnStyle;
}

/**
 * Draw parameters for the on-device burner, mirroring the ASS styles in
 * `server/captioning/captions.py`. Sizes are fractions, never pixels — a clip
 * off the glasses is not necessarily 1080x1920, and a caption sized for the
 * wrong canvas is the difference between designed and burned in by a script.
 */
export interface CaptionBurnStyle {
  /** iOS font family name, resolved by Core Text. */
  fontName: string;
  /** Of frame height. */
  fontScale: number;
  /** Of font size. Becomes an NSAttributedString stroke width percentage. */
  outlineScale: number;
  /** Of font size. */
  shadowScale: number;
  /** Of frame height, measured from the bottom. */
  marginVScale: number;
  /** Of frame width, each side. */
  marginHScale: number;
  color: string;
  /** Colour of the live word, or null for styles that do not track it. */
  highlightColor: string | null;
  outlineColor: string;
  shadowColor: string;
  /** Solid bar behind the text instead of an outline. */
  boxed: boolean;
  boxColor: string;
  uppercase: boolean;
  maxWords: number;
  maxSeconds: number;
  maxGap: number;
  maxChars: number;
}

export interface CaptionPreview {
  fontFamily?: string;
  fontSize: number;
  fontWeight: '600' | '700' | '800' | '900';
  letterSpacing: number;
  color: string;
  /** Colour of the live word, for styles that track it. */
  highlightColor?: string;
  uppercase: boolean;
  /** Heavy outline, faked with a shadow — RN has no text stroke. */
  outlined: boolean;
  /** Solid bar behind the text. */
  boxed: boolean;
}

const HEAVY = Platform.select({
  ios: 'Arial Black',
  android: 'sans-serif-black',
  default: undefined,
});
const PLAIN = Platform.select({
  ios: 'Arial',
  android: 'sans-serif',
  default: undefined,
});

/** #FFD400 — the same gold the server burns in. */
export const CAPTION_HIGHLIGHT = '#FFD400';

export const CAPTION_STYLES: CaptionStylePreset[] = [
  {
    key: 'classic',
    label: 'Hormozi',
    description:
      'Big bold uppercase, one to three words, gold on the word being said.',
    highlightsSpokenWord: true,
    preview: {
      fontFamily: HEAVY,
      fontSize: 22,
      fontWeight: '900',
      letterSpacing: -0.3,
      color: '#FFFFFF',
      highlightColor: CAPTION_HIGHLIGHT,
      uppercase: true,
      outlined: true,
      boxed: false,
    },
    burn: {
      // Bundled with the app (see UIAppFonts) rather than picked from the
      // system: iOS ships no heavy geometric sans, and the burner falls back
      // to a serif when a family is missing.
      fontName: 'Montserrat-ExtraBold',
      fontScale: 0.065,
      // A tighter outline than the old style. This one is measured against
      // Montserrat's thick stems, where 7.5% closed up the counters.
      outlineScale: 0.06,
      shadowScale: 0.03,
      marginVScale: 0.18,
      marginHScale: 0.04,
      color: '#FFFFFF',
      highlightColor: CAPTION_HIGHLIGHT,
      outlineColor: '#000000',
      shadowColor: '#000000',
      boxed: false,
      boxColor: '#000000',
      uppercase: true,
      maxWords: 3,
      maxSeconds: 1.2,
      maxGap: 0.6,
      // Deliberately short. At this size three long words do not fit on one
      // line, and stacking them is the look — letting them run wide would
      // trip the burner's shrink-to-fit and change size caption to caption.
      maxChars: 12,
    },
  },
  {
    key: 'clean',
    label: 'Clean',
    description: 'Plain white sentence case. Readable, no shouting.',
    highlightsSpokenWord: false,
    preview: {
      fontFamily: PLAIN,
      fontSize: 16,
      fontWeight: '700',
      letterSpacing: 0,
      color: '#FFFFFF',
      uppercase: false,
      outlined: false,
      boxed: false,
    },
    burn: {
      fontName: 'Arial-BoldMT',
      fontScale: 0.034,
      outlineScale: 0,
      shadowScale: 0.045,
      marginVScale: 0.12,
      marginHScale: 0.06,
      color: '#FFFFFF',
      highlightColor: null,
      outlineColor: '#000000',
      shadowColor: '#000000',
      boxed: false,
      boxColor: '#000000',
      uppercase: false,
      maxWords: 5,
      maxSeconds: 2.0,
      maxGap: 0.8,
      maxChars: 32,
    },
  },
  {
    key: 'boxed',
    label: 'Boxed',
    description: 'Uppercase in a solid black bar, gold on the live word.',
    highlightsSpokenWord: true,
    preview: {
      fontFamily: PLAIN,
      fontSize: 18,
      fontWeight: '800',
      letterSpacing: 0,
      color: '#FFFFFF',
      highlightColor: CAPTION_HIGHLIGHT,
      uppercase: true,
      outlined: false,
      boxed: true,
    },
    burn: {
      fontName: 'Arial-BoldMT',
      fontScale: 0.042,
      outlineScale: 0,
      shadowScale: 0,
      marginVScale: 0.15,
      marginHScale: 0.06,
      color: '#FFFFFF',
      highlightColor: CAPTION_HIGHLIGHT,
      outlineColor: '#000000',
      shadowColor: '#000000',
      boxed: true,
      boxColor: '#000000',
      uppercase: true,
      maxWords: 4,
      maxSeconds: 1.6,
      maxGap: 0.7,
      maxChars: 26,
    },
  },
];

export const DEFAULT_CAPTION_STYLE: CaptionStyleKey = 'classic';

export function captionStylePreset(key: CaptionStyleKey): CaptionStylePreset {
  return (
    CAPTION_STYLES.find(s => s.key === key) ??
    CAPTION_STYLES.find(s => s.key === DEFAULT_CAPTION_STYLE)!
  );
}

export function captionStyleLabel(key: CaptionStyleKey | undefined): string {
  return key ? captionStylePreset(key).label : '—';
}
