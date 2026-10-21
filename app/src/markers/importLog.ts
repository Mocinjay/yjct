import { GlassesMediaLibraryNative } from '../native/GlassesMediaLibraryNative';

/**
 * Logs a full-resolution import decision to the console in dev builds and to
 * Documents/clypso-diagnostics.log always. The import runs minutes or hours
 * after the moment, usually backgrounded, so the diagnostics file is the only
 * place its decisions can be read afterwards.
 */
export function importLog(message: string, context?: Record<string, unknown>): void {
  const line = context === undefined ? message : `${message} ${JSON.stringify(context)}`;
  if (__DEV__) {
    console.log(`[glasses-import] ${line}`);
  }
  GlassesMediaLibraryNative.log(line);
}

/** The message of anything thrown. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
