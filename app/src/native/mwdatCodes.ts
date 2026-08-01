/**
 * Mirror of the `MWDATCode` taxonomy in `ios/Jarvis/MWDATDiag.swift`.
 *
 * Each glasses failure gets its own code so a field report names one cause
 * instead of collapsing into a generic timeout. Codes are append-only — they
 * appear in user-pasted diagnostic traces, so never renumber one.
 *
 * `__tests__/mwdatCodes.test.ts` asserts this table stays in sync with the
 * Swift enum; if that test fails, the two have drifted.
 */

/** 1xx session, 2xx stream, 3xx our own pipeline logic. */
export const MWDAT_CODES = {
  // 1xx — DeviceSessionError
  101: 'session_no_eligible_device',
  102: 'session_already_stopped',
  103: 'session_already_exists',
  104: 'session_idle',
  105: 'session_capability_already_active',
  106: 'session_capability_not_found',
  107: 'session_unexpected',
  108: 'session_thermal_critical',
  109: 'session_thermal_emergency',
  110: 'session_peak_power_shutdown',
  111: 'session_battery_critical',
  112: 'session_dat_app_update_required',
  113: 'session_dwa_unavailable',

  // 2xx — StreamError
  201: 'stream_internal',
  202: 'stream_device_not_found',
  203: 'stream_device_not_connected',
  204: 'stream_timeout',
  205: 'stream_video_error',
  206: 'stream_permission_denied',
  207: 'stream_hinges_closed',
  208: 'stream_thermal_critical',
  209: 'stream_thermal_emergency',
  210: 'stream_peak_power_shutdown',
  211: 'stream_battery_critical',

  // 3xx — pipeline logic in MWDATBridge
  301: 'pipeline_no_device',
  302: 'pipeline_incompatible',
  303: 'pipeline_session_start_timeout',
  304: 'pipeline_session_stopped_during_start',
  305: 'pipeline_session_paused_stall',
  306: 'pipeline_addstream_returned_nil',
  307: 'pipeline_stream_never_started',
  308: 'pipeline_selector_unresolved',
} as const;

export type MWDATCode = keyof typeof MWDAT_CODES;
export type MWDATSlug = (typeof MWDAT_CODES)[MWDATCode];

/**
 * Codes that mean "this is a Jarvis bug", not something the wearer can fix.
 * `session_already_exists` is the direct signature of a re-entrant pipeline
 * open — if it shows up in the field, the single-flight guard has a hole.
 */
export const MWDAT_INTERNAL_BUG_CODES: readonly MWDATCode[] = [103, 306];

/** Codes where retrying immediately cannot help — the glasses must change state. */
export const MWDAT_NON_RETRYABLE_CODES: readonly MWDATCode[] = [
  108, 109, 110, 111, 112, // session thermal / power / needs update
  206, 207, 208, 209, 210, 211, // stream permission / hinges / thermal / power
  302, // incompatible device
];

export function mwdatSlug(code: number): MWDATSlug | 'unknown' {
  return (MWDAT_CODES as Record<number, MWDATSlug>)[code] ?? 'unknown';
}

export function isRetryable(code: number): boolean {
  return !MWDAT_NON_RETRYABLE_CODES.includes(code as MWDATCode);
}

export function isInternalBug(code: number): boolean {
  return MWDAT_INTERNAL_BUG_CODES.includes(code as MWDATCode);
}

/** Formats a code for a bug report: "307 pipeline_stream_never_started". */
export function describeCode(code: number): string {
  return `${code} ${mwdatSlug(code)}`;
}
