/**
 * Jarvis design tokens — cinematic OLED dark, REC-red brand.
 * One system across every screen; no per-screen ad-hoc colors.
 */
export const colors = {
  bg: '#0A0A0E',
  surface: '#15151C',
  surfaceHigh: '#1F1F2A',
  border: 'rgba(255,255,255,0.07)',
  borderBright: 'rgba(255,255,255,0.14)',

  text: '#F5F5F8',
  textDim: '#9A9AA6',
  textFaint: '#606069',

  accent: '#FF3B5C',
  accentPressed: '#E02348',
  accentSoft: 'rgba(255,59,92,0.14)',
  blue: '#3B82F6',
  blueSoft: 'rgba(59,130,246,0.16)',
  success: '#30D158',
  successSoft: 'rgba(48,209,88,0.14)',
  warning: '#FFD60A',
  gold: '#F5C518',
  goldSoft: 'rgba(245,197,24,0.14)',

  scrim: 'rgba(8,8,12,0.72)',
  scrimLight: 'rgba(8,8,12,0.45)',
};

export const spacing = {
  xs: 4,
  s: 8,
  m: 16,
  l: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  s: 10,
  m: 14,
  l: 20,
  xl: 28,
  pill: 999,
};

/** Shared type scale (system font, Inter-like weights). */
export const type = {
  hero: { fontSize: 40, fontWeight: '800' as const, letterSpacing: -1, lineHeight: 44 },
  title: { fontSize: 28, fontWeight: '800' as const, letterSpacing: -0.5 },
  heading: { fontSize: 18, fontWeight: '700' as const },
  body: { fontSize: 15, lineHeight: 22 },
  caption: { fontSize: 13, lineHeight: 18 },
  label: {
    fontSize: 12,
    fontWeight: '700' as const,
    letterSpacing: 1.2,
    textTransform: 'uppercase' as const,
  },
};
