"""Timing and layout tests for captions.py.

Stdlib only — no fastapi, no faster-whisper, no ffmpeg — so the part that is
easy to get subtly wrong (when each word lights up) is covered without a
model download.

    cd server/captioning && python3 -m unittest
"""
import re
import unittest

from captions import (
    CAPTION_STYLES,
    build_ass,
    build_events,
    chunk_words,
    get_style,
    layout_lines,
    sanitize,
    word_spans,
    ass_inline,
    ass_ts,
)

CLASSIC = get_style("classic")
CLEAN = get_style("clean")
BOXED = get_style("boxed")


def words(*spec):
    """(text, start, end) triples -> the shape transcribe_words() returns."""
    return [{"text": t, "start": s, "end": e} for t, s, e in spec]


SPEECH = words(
    ("this", 0.00, 0.30),
    ("happened", 0.32, 0.80),
    ("at", 0.84, 0.95),
    ("a", 0.97, 1.05),
    ("public", 1.08, 1.60),
    ("beach", 1.65, 2.10),
    # A pause long enough that the caption should not hang through it.
    ("unbelievable", 4.00, 4.90),
)


def plain(text):
    """The words a viewer actually reads, with every override tag stripped."""
    return re.sub(r"\{[^}]*\}", "", text).replace("\\N", " ").split()


def highlighted(text, style):
    """The word rendered in the highlight colour, or None."""
    marker = ass_inline(style.highlight)
    if marker not in text:
        return None
    after = text.split(marker, 1)[1]
    return after.split("{", 1)[0]


class Chunking(unittest.TestCase):
    def test_caption_never_starts_before_its_first_word(self):
        for style in CAPTION_STYLES.values():
            for chunk in chunk_words(SPEECH, style):
                self.assertAlmostEqual(chunk["start"], chunk["words"][0]["start"])

    def test_chunks_never_overlap(self):
        for style in CAPTION_STYLES.values():
            chunks = chunk_words(SPEECH, style)
            for a, b in zip(chunks, chunks[1:]):
                self.assertLessEqual(
                    a["end"], b["start"], f"{style.key} caption outlives the next"
                )

    def test_a_long_silence_ends_the_caption(self):
        # "unbelievable" is 1.9s after the previous word: it must open a new
        # caption rather than leaving the old one on screen through the pause.
        chunks = chunk_words(SPEECH, CLASSIC)
        last = chunks[-1]
        self.assertEqual([w["text"] for w in last["words"]], ["UNBELIEVABLE"])
        self.assertLess(chunks[-2]["end"], 4.00)

    def test_word_and_duration_limits_are_honoured(self):
        for style in CAPTION_STYLES.values():
            for chunk in chunk_words(SPEECH, style):
                self.assertLessEqual(len(chunk["words"]), style.max_words)

    def test_a_single_fast_word_still_stays_readable(self):
        chunks = chunk_words(words(("go", 0.0, 0.05)), CLASSIC)
        self.assertGreaterEqual(chunks[0]["end"] - chunks[0]["start"], 0.29)

    def test_case_follows_the_style(self):
        self.assertEqual(chunk_words(SPEECH, CLASSIC)[0]["words"][0]["text"], "THIS")
        self.assertEqual(chunk_words(SPEECH, CLEAN)[0]["words"][0]["text"], "this")

    def test_empty_speech_produces_nothing(self):
        self.assertEqual(chunk_words([], CLASSIC), [])


class WordSync(unittest.TestCase):
    """The claim the whole feature rests on: while a word is being spoken, it
    is the word that is lit."""

    def test_the_spoken_word_is_the_highlighted_one(self):
        for style in (CLASSIC, BOXED):
            for chunk in chunk_words(SPEECH, style):
                events = build_events([chunk], style)
                for word in chunk["words"]:
                    midpoint = (word["start"] + word["end"]) / 2
                    live = [e for e in events if e.start <= midpoint < e.end]
                    self.assertEqual(
                        len(live), 1, f"{style.key}: {word['text']} at {midpoint}"
                    )
                    self.assertEqual(
                        highlighted(live[0].text, style),
                        word["text"],
                        f"{style.key}: wrong word lit at {midpoint}",
                    )

    def test_highlight_holds_through_the_gap_between_words(self):
        # Nothing between two words may render with no word lit — that reads
        # as a blink.
        chunk = chunk_words(SPEECH, CLASSIC)[0]
        for event in build_events([chunk], CLASSIC):
            self.assertIsNotNone(highlighted(event.text, CLASSIC))
        spans = word_spans(chunk)
        for a, b in zip(spans, spans[1:]):
            self.assertEqual(a[1], b[0])

    def test_the_last_word_stays_lit_until_the_caption_leaves(self):
        chunk = chunk_words(SPEECH, CLASSIC)[0]
        self.assertEqual(word_spans(chunk)[-1][1], chunk["end"])

    def test_every_event_shows_the_whole_caption(self):
        # Highlighting redraws the entire caption with one word recoloured —
        # it must never reduce to just the live word.
        chunk = chunk_words(SPEECH, CLASSIC)[0]
        expected = [w["text"] for w in chunk["words"]]
        for event in build_events([chunk], CLASSIC):
            self.assertEqual(plain(event.text), expected)

    def test_a_style_without_highlighting_emits_one_event_per_caption(self):
        chunks = chunk_words(SPEECH, CLEAN)
        self.assertEqual(len(build_events(chunks, CLEAN)), len(chunks))

    def test_events_are_ordered_and_never_overlap(self):
        for style in CAPTION_STYLES.values():
            events = build_events(chunk_words(SPEECH, style), style)
            for a, b in zip(events, events[1:]):
                self.assertLessEqual(a.end, b.start, style.key)
                self.assertLess(a.start, a.end, style.key)

    def test_fades_only_at_the_edges_of_a_caption(self):
        chunk = chunk_words(SPEECH, CLASSIC)[0]
        events = build_events([chunk], CLASSIC)
        self.assertTrue(events[0].fade_in)
        self.assertTrue(events[-1].fade_out)
        for middle in events[1:-1]:
            self.assertFalse(middle.fade_in)
            self.assertFalse(middle.fade_out)


class Layout(unittest.TestCase):
    def test_line_breaks_do_not_move_while_a_caption_is_up(self):
        # Recomputing the wrap per word is what makes highlighted captions
        # judder, so the layout is derived once from the chunk.
        long_chunk = chunk_words(
            words(("extraordinarily", 0.0, 0.5), ("complicated", 0.5, 1.0)), CLASSIC
        )[0]
        lines = layout_lines(long_chunk, CLASSIC)
        breaks = [len(line) for line in lines]
        for event in build_events([long_chunk], CLASSIC):
            self.assertEqual(event.text.count("\\N"), len(breaks) - 1)

    def test_every_word_appears_exactly_once_in_the_layout(self):
        for style in CAPTION_STYLES.values():
            for chunk in chunk_words(SPEECH, style):
                flat = [i for line in layout_lines(chunk, style) for i in line]
                self.assertEqual(flat, list(range(len(chunk["words"]))))


class Rendering(unittest.TestCase):
    def test_transcribed_text_cannot_inject_ass_override_tags(self):
        self.assertEqual(sanitize("{\\an8}drop"), "an8drop")

    def test_timestamps_use_ass_centisecond_format(self):
        self.assertEqual(ass_ts(0), "0:00:00.00")
        self.assertEqual(ass_ts(61.5), "0:01:01.50")
        self.assertEqual(ass_ts(3661.234), "1:01:01.23")
        self.assertEqual(ass_ts(-5), "0:00:00.00")

    def test_caption_size_follows_the_frame_not_a_fixed_canvas(self):
        chunks = chunk_words(SPEECH, CLASSIC)
        portrait = build_ass(chunks, CLASSIC, 1080, 1920)
        landscape = build_ass(chunks, CLASSIC, 1920, 1080)
        self.assertIn("PlayResY: 1080", landscape)
        self.assertIn(f"Arial Black,{round(1920 * CLASSIC.font_scale)}", portrait)
        self.assertIn(f"Arial Black,{round(1080 * CLASSIC.font_scale)}", landscape)

    def test_each_style_writes_its_own_dialogue_lines(self):
        for style in CAPTION_STYLES.values():
            ass = build_ass(chunk_words(SPEECH, style), style)
            self.assertIn(f"Style: Cap,{style.font},", ass)
            self.assertEqual(
                ass.count("Dialogue:"),
                len(build_events(chunk_words(SPEECH, style), style)),
            )

    def test_unknown_styles_are_rejected(self):
        with self.assertRaises(KeyError):
            get_style("hormozi")
        self.assertEqual(get_style(None).key, "classic")


if __name__ == "__main__":
    unittest.main()
