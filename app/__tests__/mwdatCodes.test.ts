import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MWDAT_CODES,
  describeCode,
  isInternalBug,
  isRetryable,
  mwdatSlug,
} from '../src/native/mwdatCodes';

/**
 * The glasses failure taxonomy is defined twice — once in Swift so the bridge
 * can throw it, once in TS so the UI can branch on it. These tests exist to
 * make sure the two never drift, because a code that means different things on
 * each side of the bridge is worse than no code at all.
 */

const SWIFT_SOURCE = readFileSync(
  join(__dirname, '..', 'ios', 'Jarvis', 'MWDATDiag.swift'),
  'utf8',
);

/** `case sessionAlreadyExists = 103` → { sessionAlreadyExists: 103 } */
function parseSwiftRawValues(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of SWIFT_SOURCE.matchAll(/^\s*case (\w+) = (\d+)$/gm)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

/** The `var slug` switch only — guidance arms span lines and are skipped. */
function parseSwiftSlugs(): Record<string, string> {
  const start = SWIFT_SOURCE.indexOf('var slug: String {');
  const end = SWIFT_SOURCE.indexOf('var guidance: String {');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = SWIFT_SOURCE.slice(start, end);

  const out: Record<string, string> = {};
  for (const m of block.matchAll(/case \.(\w+): return "([a-z0-9_]+)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

describe('MWDAT code taxonomy stays in sync with Swift', () => {
  const rawValues = parseSwiftRawValues();
  const slugs = parseSwiftSlugs();

  it('parses a non-trivial number of cases out of the Swift source', () => {
    // Guards against a regex that silently matches nothing, which would make
    // every assertion below vacuously pass.
    expect(Object.keys(rawValues).length).toBeGreaterThanOrEqual(30);
    expect(Object.keys(slugs).length).toBe(Object.keys(rawValues).length);
  });

  it('defines exactly the same code numbers on both sides', () => {
    const swiftCodes = Object.values(rawValues).sort((a, b) => a - b);
    const tsCodes = Object.keys(MWDAT_CODES)
      .map(Number)
      .sort((a, b) => a - b);
    expect(tsCodes).toEqual(swiftCodes);
  });

  it('maps every code to the same slug on both sides', () => {
    for (const [caseName, code] of Object.entries(rawValues)) {
      expect(slugs[caseName]).toBeDefined();
      expect(mwdatSlug(code)).toBe(slugs[caseName]);
    }
  });

  it('has no duplicate code numbers', () => {
    const codes = Object.values(rawValues);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('has no duplicate slugs', () => {
    const values = Object.values(MWDAT_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('MWDAT code taxonomy covers the pinned SDK 0.8.0 error surface', () => {
  // Verbatim from the 0.8.0 .swiftinterface. If an SDK bump adds a case, the
  // Swift switch stops compiling and this list tells us what to add here too.
  const DEVICE_SESSION_ERROR_CASES = [
    'noEligibleDevice',
    'sessionAlreadyStopped',
    'sessionAlreadyExists',
    'sessionIdle',
    'capabilityAlreadyActive',
    'capabilityNotFound',
    'unexpectedError',
    'thermalCritical',
    'thermalEmergency',
    'peakPowerShutdown',
    'batteryCritical',
    'datAppOnTheGlassesUpdateRequired',
    'dwaUnavailable',
  ];

  const STREAM_ERROR_CASES = [
    'internalError',
    'deviceNotFound',
    'deviceNotConnected',
    'timeout',
    'videoStreamingError',
    'permissionDenied',
    'hingesClosed',
    'thermalCritical',
    'thermalEmergency',
    'peakPowerShutdown',
    'batteryCritical',
  ];

  function mappingBlock(signature: string): string {
    const start = SWIFT_SOURCE.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const end = SWIFT_SOURCE.indexOf('\n  }', start);
    return SWIFT_SOURCE.slice(start, end);
  }

  it('maps every DeviceSessionError case', () => {
    const block = mappingBlock('static func from(_ error: DeviceSessionError)');
    for (const name of DEVICE_SESSION_ERROR_CASES) {
      expect(block).toContain(`case .${name}`);
    }
  });

  it('maps every StreamError case', () => {
    const block = mappingBlock('static func from(_ error: StreamError)');
    for (const name of STREAM_ERROR_CASES) {
      expect(block).toContain(`case .${name}`);
    }
  });

  it('gives session and stream errors distinct codes for shared conditions', () => {
    // thermalCritical exists on both enums; conflating them would hide which
    // subsystem actually failed.
    expect(mwdatSlug(108)).toBe('session_thermal_critical');
    expect(mwdatSlug(208)).toBe('stream_thermal_critical');
  });
});

describe('code classification helpers', () => {
  it('flags session_already_exists as an internal bug', () => {
    // This code can only appear if two createSession calls raced, i.e. the
    // single-flight guard in openPipelineIfNeeded failed.
    expect(isInternalBug(103)).toBe(true);
    expect(describeCode(103)).toBe('103 session_already_exists');
  });

  it('does not blame the user for conditions they cannot fix by retrying', () => {
    expect(isRetryable(207)).toBe(false); // hinges closed
    expect(isRetryable(206)).toBe(false); // permission denied
    expect(isRetryable(112)).toBe(false); // glasses need an update
    expect(isRetryable(302)).toBe(false); // incompatible
  });

  it('treats transient link failures as retryable', () => {
    expect(isRetryable(204)).toBe(true); // stream timeout
    expect(isRetryable(303)).toBe(true); // session start timeout
    expect(isRetryable(307)).toBe(true); // stream never started
    expect(isRetryable(301)).toBe(true); // no device yet
  });

  it('returns unknown for codes it does not recognise', () => {
    expect(mwdatSlug(999)).toBe('unknown');
    expect(describeCode(999)).toBe('999 unknown');
  });
});
