import { NativeModules, Platform } from 'react-native';
import { createLogger } from './Logger';

const log = createLogger('telemetry');

interface DiagnosticWriter {
  writeDiagnostic(line: string): void;
}

/**
 * Machine-parseable field events for the 10v10 Meta View nudge experiment
 * and Shadow Proxy latency. Written to `Documents/clypso-diagnostics.log`
 * even at info level (the normal JS→native sink only mirrors warn/error).
 *
 * Line shape (one JSON object):
 *   ISO8601 [TELEMETRY] {"event":"T_MARK","runId":"...","variant":"control",...}
 */
export type TelemetryEvent =
  | 'T_MARK'
  | 'T_NUDGE'
  | 'T_PHOTOS_INSERT'
  | 'T_MASTER_READY'
  | 'MIC_SUSPEND'
  | 'MIC_RESUME'
  | 'SHADOW_TIMEOUT'
  | 'SHADOW_RECOVERED';

export type NudgeVariant = 'control' | 'nudge';

export function emitTelemetry(
  event: TelemetryEvent,
  fields: Record<string, string | number | boolean | null | undefined>,
): void {
  const payload = {
    event,
    atMs: Date.now(),
    ...fields,
  };
  const iso = new Date(payload.atMs).toISOString();
  const line = `${iso} [TELEMETRY] ${JSON.stringify(payload)}`;
  log.info(event, payload as Record<string, unknown>);

  if (Platform.OS !== 'ios') {
    return;
  }
  const native = NativeModules.MWDATBridge as DiagnosticWriter | undefined;
  try {
    native?.writeDiagnostic?.(line);
  } catch {
    // Diagnostics must never take down the mark path.
  }
}
