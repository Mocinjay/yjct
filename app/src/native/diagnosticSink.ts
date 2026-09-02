import { NativeModules, Platform } from 'react-native';
import type { LogEntry, LogSink } from '../core/Logger';
import { formatEntry, logger } from '../core/Logger';

interface DiagnosticWriter {
  writeDiagnostic(line: string): void;
}

const native: DiagnosticWriter | undefined = NativeModules.MWDATBridge;

/**
 * Mirrors JS log entries into the native on-device diagnostics file.
 *
 * The two halves of a capture run were previously unreadable together: the
 * glasses handshake went to a file that can be pulled off the device after the
 * fact, while everything above the bridge went only to a Metro console that is
 * not attached during field testing — which is the only time the interesting
 * failures happen. A dropped link produces evidence on both sides, and
 * correlating them meant guessing at the ordering.
 *
 * Warnings and errors only. Debug lines are per-segment and would bury the
 * handshake they are meant to explain, and the file is size-capped, so noise
 * costs signal directly.
 */
function format(entry: LogEntry): string {
  const line = formatEntry(entry, 'js:');
  if (!entry.context) {
    return line;
  }
  try {
    return `${line} ${JSON.stringify(entry.context)}`;
  } catch {
    // A context that will not serialise is not worth losing the line over.
    return line;
  }
}

export const nativeDiagnosticSink: LogSink = {
  write(entry) {
    if (entry.level !== 'warn' && entry.level !== 'error') {
      return;
    }
    native?.writeDiagnostic(format(entry));
  },
};

/**
 * Attach the sink if the platform has one. Returns a detach function, or null
 * when there is nothing to attach to (Android, or an iOS build without the
 * bridge compiled in).
 */
export function installNativeDiagnosticSink(): (() => void) | null {
  if (Platform.OS !== 'ios' || !native?.writeDiagnostic) {
    return null;
  }
  return logger.addSink(nativeDiagnosticSink);
}
