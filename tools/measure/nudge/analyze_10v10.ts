#!/usr/bin/env node
/**
 * 10v10 Meta View nudge experiment analyzer.
 *
 * Ingests `clypso-diagnostics.log` (device pull) and compares Control vs Nudge
 * sync latency. PASS requires >20% reduction in p50 mark→Photos (or mark→master).
 *
 * Usage (Node 22+ strip-types, or any Node with this repo's TS tooling):
 *   node --experimental-strip-types tools/measure/nudge/analyze_10v10.ts <log>
 *   node --experimental-strip-types tools/measure/nudge/analyze_10v10.ts --fixture
 *
 * Expected TELEMETRY lines (ISO8601 [TELEMETRY] {...json...}):
 *   T_MARK, T_NUDGE, T_PHOTOS_INSERT, T_MASTER_READY, MIC_SUSPEND, MIC_RESUME
 */

import * as fs from 'fs';
import * as path from 'path';

type Variant = 'control' | 'nudge';

interface TelemetryRow {
  event: string;
  atMs: number;
  runId?: string;
  variant?: Variant;
  markerId?: string;
  clipId?: string;
  reason?: string;
}

interface Run {
  runId: string;
  variant: Variant;
  tMark?: number;
  tNudge?: number;
  tPhotos?: number;
  tMaster?: number;
  micSuspend?: boolean;
  micResumeAfterNudge?: boolean;
}

const PASS_PCT = 20;

function parseLine(line: string): TelemetryRow | null {
  const m = line.match(
    /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+\[TELEMETRY\]\s+(\{.+\})\s*$/,
  );
  if (!m) {
    return null;
  }
  try {
    const obj = JSON.parse(m[2]) as TelemetryRow;
    if (typeof obj.atMs !== 'number') {
      obj.atMs = Date.parse(m[1]);
    }
    return obj;
  } catch {
    return null;
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function buildRuns(rows: TelemetryRow[]): Run[] {
  const marks = rows.filter(r => r.event === 'T_MARK');
  const nudges = rows.filter(r => r.event === 'T_NUDGE');
  const photos = rows
    .filter(r => r.event === 'T_PHOTOS_INSERT')
    .sort((a, b) => a.atMs - b.atMs);
  const masters = rows
    .filter(r => r.event === 'T_MASTER_READY')
    .sort((a, b) => a.atMs - b.atMs);
  const micSuspend = rows.filter(r => r.event === 'MIC_SUSPEND');
  const micResume = rows.filter(r => r.event === 'MIC_RESUME');

  const usedPhotos = new Set<number>();
  const usedMasters = new Set<number>();

  const runs: Run[] = marks.map((mark, i) => {
    const runId = mark.runId ?? mark.markerId ?? `mark_${mark.atMs}_${i}`;
    const nudge = nudges.find(
      n => n.runId === runId || n.markerId === mark.markerId,
    );
    const variant: Variant =
      mark.variant === 'nudge' || nudge ? 'nudge' : 'control';

    const nextMarkMs = marks[i + 1]?.atMs ?? Number.POSITIVE_INFINITY;
    const photo = photos.find(
      (p, idx) =>
        !usedPhotos.has(idx) && p.atMs >= mark.atMs && p.atMs < nextMarkMs,
    );
    if (photo) {
      usedPhotos.add(photos.indexOf(photo));
    }
    const master = masters.find(
      (m, idx) =>
        !usedMasters.has(idx) &&
        m.atMs >= mark.atMs &&
        (photo ? m.atMs >= photo.atMs : true) &&
        m.atMs < nextMarkMs + 120_000,
    );
    if (master) {
      usedMasters.add(masters.indexOf(master));
    }

    const suspended = micSuspend.some(
      s => s.runId === runId || (s.atMs >= mark.atMs && s.atMs < nextMarkMs),
    );
    const resumed =
      nudge != null &&
      micResume.some(
        r =>
          (r.runId === runId || r.atMs >= nudge.atMs) &&
          r.atMs < nextMarkMs + 60_000,
      );

    return {
      runId,
      variant,
      tMark: mark.atMs,
      tNudge: nudge?.atMs,
      tPhotos: photo?.atMs,
      tMaster: master?.atMs,
      micSuspend: suspended,
      micResumeAfterNudge: resumed,
    };
  });

  return runs;
}

function latencies(runs: Run[], key: 'photos' | 'master'): number[] {
  const out: number[] = [];
  for (const r of runs) {
    if (r.tMark == null) {
      continue;
    }
    const end = key === 'photos' ? r.tPhotos : r.tMaster;
    if (end == null || end < r.tMark) {
      continue;
    }
    out.push(end - r.tMark);
  }
  return out.sort((a, b) => a - b);
}

function fmtMs(ms: number | null): string {
  if (ms == null) {
    return 'n/a';
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function summarize(name: string, xs: number[]): string {
  const p50 = percentile(xs, 50);
  const p90 = percentile(xs, 90);
  return `${name}: n=${xs.length}  p50=${fmtMs(p50)}  p90=${fmtMs(p90)}`;
}

function pctDrop(control: number | null, variant: number | null): number | null {
  if (control == null || variant == null || control <= 0) {
    return null;
  }
  return ((control - variant) / control) * 100;
}

function analyze(text: string): void {
  const rows = text
    .split(/\r?\n/)
    .map(parseLine)
    .filter((r): r is TelemetryRow => r != null);

  const runs = buildRuns(rows);
  const control = runs.filter(r => r.variant === 'control');
  const nudge = runs.filter(r => r.variant === 'nudge');

  const cPhotos = latencies(control, 'photos');
  const nPhotos = latencies(nudge, 'photos');
  const cMaster = latencies(control, 'master');
  const nMaster = latencies(nudge, 'master');

  const micFlags = nudge.filter(r => r.micSuspend && !r.micResumeAfterNudge);

  console.log('=== Clypso 10v10 Meta View nudge ===\n');
  console.log(`TELEMETRY events parsed: ${rows.length}`);
  console.log(`Runs: control=${control.length}  nudge=${nudge.length}\n`);

  console.log('Mark → Photos insert');
  console.log(`  ${summarize('control', cPhotos)}`);
  console.log(`  ${summarize('nudge  ', nPhotos)}`);
  const photosDrop = pctDrop(percentile(cPhotos, 50), percentile(nPhotos, 50));
  console.log(
    `  p50 delta: ${photosDrop == null ? 'n/a' : `${photosDrop.toFixed(1)}%`}\n`,
  );

  console.log('Mark → MASTER_READY');
  console.log(`  ${summarize('control', cMaster)}`);
  console.log(`  ${summarize('nudge  ', nMaster)}`);
  const masterDrop = pctDrop(percentile(cMaster, 50), percentile(nMaster, 50));
  console.log(
    `  p50 delta: ${masterDrop == null ? 'n/a' : `${masterDrop.toFixed(1)}%`}\n`,
  );

  console.log('Mic daemon health (nudge arm)');
  if (micFlags.length === 0) {
    console.log('  OK — no unrecovered MIC_SUSPEND after nudge bounce\n');
  } else {
    console.log(
      `  FLAG — ${micFlags.length} run(s) suspended without MIC_RESUME after nudge:`,
    );
    for (const r of micFlags) {
      console.log(`    ${r.runId}`);
    }
    console.log('');
  }

  const primary = photosDrop ?? masterDrop;
  const enoughSamples = Math.min(cPhotos.length || cMaster.length, nPhotos.length || nMaster.length) >= 5;
  let verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  if (!enoughSamples || primary == null) {
    verdict = 'INCONCLUSIVE';
  } else if (primary > PASS_PCT && micFlags.length === 0) {
    verdict = 'PASS';
  } else {
    verdict = 'FAIL';
  }

  console.log(`Verdict: ${verdict}`);
  console.log(
    `  Rule: p50 latency reduction > ${PASS_PCT}% AND no unrecovered mic kills.`,
  );
  if (verdict === 'FAIL' && primary != null && primary <= PASS_PCT) {
    console.log(
      `  Nudge did not clear the ${PASS_PCT}% bar (got ${primary.toFixed(1)}%). Kill the experiment.`,
    );
  }
  if (verdict === 'PASS') {
    console.log('  Keep nudge as opt-in; re-measure on a larger n before default-on.');
  }
  if (verdict === 'INCONCLUSIVE') {
    console.log('  Need ≥5 timed runs per arm with T_MARK + T_PHOTOS_INSERT (or T_MASTER_READY).');
  }

  process.exit(verdict === 'PASS' ? 0 : 1);
}

function fixture(): string {
  const t0 = Date.parse('2026-09-17T18:00:00.000Z');
  const lines: string[] = [];
  // Control: slower sync ~90s p50-ish
  for (let i = 0; i < 10; i++) {
    const mark = t0 + i * 120_000;
    const photos = mark + 80_000 + i * 2_000;
    const master = photos + 5_000;
    const runId = `ctrl_${i}`;
    lines.push(
      `${new Date(mark).toISOString()} [TELEMETRY] ${JSON.stringify({ event: 'T_MARK', atMs: mark, runId, variant: 'control', markerId: runId })}`,
    );
    lines.push(
      `${new Date(photos).toISOString()} [TELEMETRY] ${JSON.stringify({ event: 'T_PHOTOS_INSERT', atMs: photos, runId, variant: 'control' })}`,
    );
    lines.push(
      `${new Date(master).toISOString()} [TELEMETRY] ${JSON.stringify({ event: 'T_MASTER_READY', atMs: master, runId, variant: 'control' })}`,
    );
  }
  // Nudge: ~40% faster photos (~50s) — should PASS
  for (let i = 0; i < 10; i++) {
    const mark = t0 + 1_500_000 + i * 120_000;
    const nudge = mark + 200;
    const photos = mark + 48_000 + i * 1_500;
    const master = photos + 4_000;
    const runId = `nudge_${i}`;
    lines.push(
      `${new Date(mark).toISOString()} [TELEMETRY] ${JSON.stringify({ event: 'T_MARK', atMs: mark, runId, variant: 'nudge', markerId: runId })}`,
    );
    lines.push(
      `${new Date(nudge).toISOString()} [TELEMETRY] ${JSON.stringify({ event: 'T_NUDGE', atMs: nudge, runId, variant: 'nudge' })}`,
    );
    lines.push(
      `${new Date(photos).toISOString()} [TELEMETRY] ${JSON.stringify({ event: 'T_PHOTOS_INSERT', atMs: photos, runId, variant: 'nudge' })}`,
    );
    lines.push(
      `${new Date(master).toISOString()} [TELEMETRY] ${JSON.stringify({ event: 'T_MASTER_READY', atMs: master, runId, variant: 'nudge' })}`,
    );
  }
  return lines.join('\n');
}

const arg = process.argv[2];
if (!arg || arg === '--help') {
  console.error(
    'usage: analyze_10v10.ts <clypso-diagnostics.log> | --fixture',
  );
  process.exit(2);
}
if (arg === '--fixture') {
  analyze(fixture());
} else {
  const file = path.resolve(arg);
  if (!fs.existsSync(file)) {
    console.error(`missing log file: ${file}`);
    console.error('Pull with: ./tools/measure/nudge/pull_diagnostics.sh --from <path>');
    process.exit(2);
  }
  analyze(fs.readFileSync(file, 'utf8'));
}
