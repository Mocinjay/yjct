import {
  clipRangeForMarker,
  clipRangesForVideo,
  markerOffsetSec,
  markersWithin,
} from '../src/markers/markerMatching';
import type { GlassesVideo, WakeMarker } from '../src/markers/markerMatching';

/** The real recording this path was designed against. */
const RECORDING_START = Date.parse('2026-08-05T20:36:39Z');

function video(overrides: Partial<GlassesVideo> = {}): GlassesVideo {
  return {
    localIdentifier: 'ABC-123/L0/001',
    startedAtMs: RECORDING_START,
    durationSec: 17.67,
    width: 1520,
    height: 2032,
    ...overrides,
  };
}

/** A marker `atSec` seconds into the recording. Negative means before it. */
function markerAt(atSec: number, id = `m${atSec}`): WakeMarker {
  return { id, atMs: RECORDING_START + atSec * 1000 };
}

describe('markerOffsetSec', () => {
  it('measures from the start of the recording, not the phone', () => {
    expect(markerOffsetSec(markerAt(12), video())).toBeCloseTo(12);
  });
});

describe('markersWithin', () => {
  it('claims markers spoken during the recording', () => {
    const markers = [markerAt(1), markerAt(9), markerAt(17)];
    expect(markersWithin(markers, video()).map(m => m.id)).toEqual([
      'm1',
      'm9',
      'm17',
    ]);
  });

  it('claims a marker spoken after recording stopped, because the trigger is a reaction', () => {
    // Wearer stops at 17.67s, realises what just happened, says the word.
    const late = markerAt(24);
    expect(markersWithin([late], video()).map(m => m.id)).toEqual(['m24']);
  });

  it('does not claim a marker long after the recording ended', () => {
    expect(markersWithin([markerAt(120)], video())).toEqual([]);
  });

  it('absorbs small clock skew before the start but not a genuinely earlier marker', () => {
    expect(markersWithin([markerAt(-1)], video()).map(m => m.id)).toEqual(['m-1']);
    expect(markersWithin([markerAt(-60)], video())).toEqual([]);
  });

  it('returns oldest first regardless of input order', () => {
    const markers = [markerAt(9), markerAt(1), markerAt(5)];
    expect(markersWithin(markers, video()).map(m => m.id)).toEqual([
      'm1',
      'm5',
      'm9',
    ]);
  });

  it('ignores markers belonging to a different recording', () => {
    const earlier = video({
      localIdentifier: 'OTHER',
      startedAtMs: RECORDING_START - 10 * 60 * 1000,
      durationSec: 30,
    });
    expect(markersWithin([markerAt(5)], earlier)).toEqual([]);
  });
});

describe('clipRangeForMarker', () => {
  it('ends the clip on the trigger word and looks back from there', () => {
    const range = clipRangeForMarker(markerAt(15), video(), { lookbackSec: 10 });
    expect(range).not.toBeNull();
    expect(range!.endSec).toBeCloseTo(15);
    expect(range!.startSec).toBeCloseTo(5);
  });

  it('clamps the start to the beginning rather than running off the front', () => {
    const range = clipRangeForMarker(markerAt(4), video(), { lookbackSec: 30 });
    expect(range!.startSec).toBe(0);
    expect(range!.endSec).toBeCloseTo(4);
  });

  it('clamps a post-roll marker to the end of the footage', () => {
    // Spoken 6s after recording stopped: the clip still ends where the video does.
    const range = clipRangeForMarker(markerAt(24), video(), { lookbackSec: 10 });
    expect(range!.endSec).toBeCloseTo(17.67);
    expect(range!.startSec).toBeCloseTo(7.67);
  });

  it('honours a lead-out when the footage has room for it', () => {
    const range = clipRangeForMarker(markerAt(10), video(), {
      lookbackSec: 5,
      leadOutSec: 2,
    });
    expect(range!.endSec).toBeCloseTo(12);
    expect(range!.startSec).toBeCloseTo(7);
  });

  it('returns null when the marker points before any footage exists', () => {
    expect(clipRangeForMarker(markerAt(-1.5), video(), { lookbackSec: 10 })).toBeNull();
  });
});

describe('clipRangesForVideo', () => {
  it('produces one cut per distinct moment', () => {
    const long = video({ durationSec: 180 });
    const markers = [markerAt(20), markerAt(25), markerAt(100), markerAt(160)];

    const cuts = clipRangesForVideo(markers, long, { lookbackSec: 30 });

    // m25 is inside m20's look-back, so the two become one window.
    expect(cuts.map(c => c.markers.map(m => m.id))).toEqual([
      ['m20', 'm25'],
      ['m100'],
      ['m160'],
    ]);
    expect(cuts[0].range.startSec).toBe(0);
    expect(cuts[1].range.startSec).toBeCloseTo(70);
    expect(cuts[2].range.endSec).toBeCloseTo(160);
  });

  it('merges two markers inside a look-back into one window, not one clip each', () => {
    const long = video({ durationSec: 180 });

    const cuts = clipRangesForVideo([markerAt(50), markerAt(60)], long, {
      lookbackSec: 20,
    });

    expect(cuts).toHaveLength(1);
    // The union: back a look-back from the first, forward to the second.
    expect(cuts[0].range.startSec).toBeCloseTo(30);
    expect(cuts[0].range.endSec).toBeCloseTo(60);
    // Both are spent, so neither can produce a near-duplicate on a later pass.
    expect(cuts[0].markers.map(m => m.id)).toEqual(['m50', 'm60']);
  });

  it('keeps two markers further apart than the look-back as separate clips', () => {
    const long = video({ durationSec: 180 });

    const cuts = clipRangesForVideo([markerAt(50), markerAt(90)], long, {
      lookbackSec: 20,
    });

    expect(cuts.map(c => [c.range.startSec, c.range.endSec])).toEqual([
      [30, 50],
      [70, 90],
    ]);
  });

  it('caps the union at 30s on free, trimming the front and keeping the moment', () => {
    const long = video({ durationSec: 180 });
    // Exactly a look-back apart is the widest a union can get: 40s.
    const markers = [markerAt(50), markerAt(70)];

    const cuts = clipRangesForVideo(markers, long, {
      lookbackSec: 20,
      maxWindowSec: 30,
    });

    expect(cuts).toHaveLength(1);
    expect(cuts[0].range.endSec).toBeCloseTo(70);
    expect(cuts[0].range.startSec).toBeCloseTo(40);
  });

  it('leaves the same union alone on Pro, which has room for it', () => {
    const long = video({ durationSec: 180 });

    const cuts = clipRangesForVideo([markerAt(50), markerAt(70)], long, {
      lookbackSec: 20,
      maxWindowSec: 90,
    });

    expect(cuts[0].range.startSec).toBeCloseTo(30);
    expect(cuts[0].range.endSec).toBeCloseTo(70);
  });

  it('yields nothing for a recording nobody marked', () => {
    expect(clipRangesForVideo([], video(), { lookbackSec: 30 })).toEqual([]);
  });

  it('ignores markers from a neighbouring recording', () => {
    const markers = [markerAt(5), markerAt(600)];
    const cuts = clipRangesForVideo(markers, video(), { lookbackSec: 30 });
    expect(cuts.map(c => c.markers[0].id)).toEqual(['m5']);
  });
});
