"""Caption styling and timing.

Pure stdlib on purpose: no FastAPI, no faster-whisper, no ffmpeg. Everything
that decides *what a caption looks like* and *when each word lights up* lives
here so it can be tested without a GPU or a model download (see
test_captions.py). `main.py` is transport only.

The app sends a style key; the registry below is the single source of truth
for what that key means. Keep `app/src/captions/captionStyles.ts` in step with
it — that file only mirrors these for the Settings preview.
"""
from __future__ import annotations

from dataclasses import dataclass

# How long a caption lingers after its last word finishes. Cutting exactly on
# the last word reads as a flicker; anything much longer and the caption is
# still up while the next phrase is already being spoken.
CAPTION_HOLD_SECONDS = 0.12
# Floor for a caption that would otherwise flash by (one fast word).
MIN_VISIBLE_SECONDS = 0.30


@dataclass(frozen=True)
class CaptionStyle:
    key: str
    label: str
    description: str

    font: str
    bold: bool
    # ASS colours, AABBGGRR (alpha 00 = opaque). ass_inline() slices the alpha
    # off for the mid-line override tags.
    primary: str
    #: Colour of the word currently being spoken, or None for no word tracking.
    highlight: str | None
    outline_colour: str
    back_colour: str
    #: 1 = outline + drop shadow, 3 = opaque box behind the text.
    border_style: int

    #: Sizes are fractions, not pixels — a clip off the glasses is not
    #: necessarily 1080x1920, and a caption sized for the wrong canvas is the
    #: difference between "designed" and "burned in by a script".
    font_scale: float  # of frame height
    outline_scale: float  # of font size
    shadow_scale: float  # of font size
    margin_v_scale: float  # of frame height, measured from the bottom

    uppercase: bool
    #: Chunking — how many words are on screen at once, and what forces a break.
    max_words: int
    max_seconds: float
    #: A silence this long ends the caption instead of leaving it hanging.
    max_gap: float
    #: Soft wrap width; the chunk breaks onto a second line past this.
    max_chars: int


CLASSIC = CaptionStyle(
    key="classic",
    label="Hormozi",
    description="Big bold uppercase, one to three words, gold on the word being said.",
    # Must be installed on the render host. The iOS build bundles the same
    # family so both paths lay text out at identical widths.
    font="Montserrat ExtraBold",
    bold=True,
    primary="00FFFFFF",
    highlight="0000D4FF",  # #FFD400
    outline_colour="00000000",
    back_colour="80000000",
    border_style=1,
    font_scale=0.065,
    outline_scale=0.06,
    shadow_scale=0.03,
    margin_v_scale=0.18,
    uppercase=True,
    max_words=3,
    max_seconds=1.2,
    max_gap=0.6,
    max_chars=12,
)

CLEAN = CaptionStyle(
    key="clean",
    label="Clean",
    description="Plain white sentence case. No shouting.",
    font="Arial",
    bold=True,
    primary="00FFFFFF",
    highlight=None,
    outline_colour="00000000",
    back_colour="60000000",
    border_style=1,
    font_scale=0.034,
    outline_scale=0.0,
    shadow_scale=0.045,
    margin_v_scale=0.12,
    uppercase=False,
    max_words=5,
    max_seconds=2.0,
    max_gap=0.8,
    max_chars=32,
)

BOXED = CaptionStyle(
    key="boxed",
    label="Boxed",
    description="Uppercase in a solid black bar, gold on the live word.",
    font="Arial",
    bold=True,
    primary="00FFFFFF",
    highlight="0000D4FF",
    # BorderStyle 3: OutlineColour paints the box, Outline is its padding.
    outline_colour="00000000",
    back_colour="00000000",
    border_style=3,
    font_scale=0.042,
    outline_scale=0.14,
    shadow_scale=0.0,
    margin_v_scale=0.15,
    uppercase=True,
    max_words=4,
    max_seconds=1.6,
    max_gap=0.7,
    max_chars=26,
)

CAPTION_STYLES: dict[str, CaptionStyle] = {s.key: s for s in (CLASSIC, CLEAN, BOXED)}
DEFAULT_STYLE_KEY = CLASSIC.key


def get_style(key: str | None) -> CaptionStyle:
    """Resolve a style key. Unknown keys raise rather than silently defaulting —
    the app would otherwise show one style and the burn-in would be another."""
    resolved = (key or DEFAULT_STYLE_KEY).strip().lower()
    if resolved not in CAPTION_STYLES:
        raise KeyError(resolved)
    return CAPTION_STYLES[resolved]


# --------------------------------- chunking ---------------------------------


def chunk_words(words: list[dict], style: CaptionStyle) -> list[dict]:
    """Group transcribed words into on-screen captions.

    Each chunk keeps its individual word timings — that is what the per-word
    highlight is driven from, and flattening them into one string (as this
    used to) is what made highlighting impossible.
    """
    chunks: list[dict] = []
    current: list[dict] = []
    for word in words:
        if current and (
            len(current) >= style.max_words
            or word["end"] - current[0]["start"] > style.max_seconds
            or word["start"] - current[-1]["end"] > style.max_gap
        ):
            chunks.append(_close(current, style))
            current = []
        current.append(word)
    if current:
        chunks.append(_close(current, style))
    return _apply_hold(chunks)


def _close(words: list[dict], style: CaptionStyle) -> dict:
    cased = [
        {
            "start": float(w["start"]),
            "end": float(w["end"]),
            "text": w["text"].upper() if style.uppercase else w["text"],
        }
        for w in words
    ]
    return {"start": cased[0]["start"], "end": cased[-1]["end"], "words": cased}


def _apply_hold(chunks: list[dict]) -> list[dict]:
    held: list[dict] = []
    for i, chunk in enumerate(chunks):
        end = chunk["end"] + CAPTION_HOLD_SECONDS
        if end - chunk["start"] < MIN_VISIBLE_SECONDS:
            end = chunk["start"] + MIN_VISIBLE_SECONDS
        if i + 1 < len(chunks):
            # Never let a caption outlive the next one's entrance: two
            # overlapping Dialogue lines render stacked on top of each other.
            end = min(end, chunks[i + 1]["start"])
        held.append({**chunk, "end": max(end, chunk["start"] + 0.01)})
    return held


def word_spans(chunk: dict) -> list[tuple[float, float]]:
    """When each word of a chunk is the highlighted one.

    A word stays lit until the *next* word starts, not until it stops being
    spoken — otherwise the highlight blinks off in every pause between words.
    The last word holds to the end of the chunk.
    """
    words = chunk["words"]
    spans: list[tuple[float, float]] = []
    for i, word in enumerate(words):
        start = chunk["start"] if i == 0 else word["start"]
        end = words[i + 1]["start"] if i + 1 < len(words) else chunk["end"]
        spans.append((start, max(end, start)))
    return spans


# ------------------------------- line layout --------------------------------


def layout_lines(chunk: dict, style: CaptionStyle) -> list[list[int]]:
    """Break the chunk into display lines, as lists of word indices.

    Computed once per chunk and reused for every word of it. Re-wrapping per
    word is what makes highlighted captions jitter as the line reflows.
    """
    lines: list[list[int]] = []
    current: list[int] = []
    width = 0
    for i, word in enumerate(chunk["words"]):
        length = len(word["text"])
        if current and width + 1 + length > style.max_chars:
            lines.append(current)
            current, width = [], 0
        current.append(i)
        width += length + (1 if width else 0)
    if current:
        lines.append(current)
    return lines


# ------------------------------ event building ------------------------------


@dataclass(frozen=True)
class CaptionEvent:
    """One ASS Dialogue line. A no-highlight style emits one per chunk; a
    highlighting style emits one per word, each redrawing the whole chunk with
    a different word lit."""

    start: float
    end: float
    text: str
    fade_in: bool
    fade_out: bool


def build_events(chunks: list[dict], style: CaptionStyle) -> list[CaptionEvent]:
    events: list[CaptionEvent] = []
    for chunk in chunks:
        lines = layout_lines(chunk, style)
        if style.highlight is None:
            events.append(
                CaptionEvent(
                    start=chunk["start"],
                    end=chunk["end"],
                    text=_render(chunk, lines, style, active=None),
                    fade_in=True,
                    fade_out=True,
                )
            )
            continue
        spans = word_spans(chunk)
        last = len(spans) - 1
        for i, (start, end) in enumerate(spans):
            if end - start < 0.01:
                # Below ASS's centisecond resolution — it would render as a
                # zero-length line, so fold it into the neighbouring word.
                continue
            events.append(
                CaptionEvent(
                    start=start,
                    end=end,
                    text=_render(chunk, lines, style, active=i),
                    # Fade only at the edges of the chunk; fading every word
                    # would strobe the whole caption.
                    fade_in=i == 0,
                    fade_out=i == last,
                )
            )
    return events


def _render(
    chunk: dict, lines: list[list[int]], style: CaptionStyle, active: int | None
) -> str:
    rendered_lines = []
    for line in lines:
        parts = []
        for index in line:
            text = sanitize(chunk["words"][index]["text"])
            if active is not None and index == active and style.highlight:
                parts.append(
                    f"{ass_inline(style.highlight)}{text}{ass_inline(style.primary)}"
                )
            else:
                parts.append(text)
        rendered_lines.append(" ".join(parts))
    return "\\N".join(rendered_lines)


def sanitize(text: str) -> str:
    """Transcribed speech is untrusted input to the ASS parser — braces and
    backslashes there would be read as override tags."""
    cleaned = text.replace("\\", "").replace("{", "").replace("}", "")
    return " ".join(cleaned.split())


def ass_inline(colour: str) -> str:
    """AABBGGRR style colour -> mid-line `\\c` override (which takes BBGGRR)."""
    return f"{{\\c&H{colour[2:]}&}}"


def ass_ts(seconds: float) -> str:
    centis = max(0, int(round(seconds * 100)))
    hours, rem = divmod(centis, 360000)
    minutes, rem = divmod(rem, 6000)
    secs, centis = divmod(rem, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{centis:02d}"


def build_ass(
    chunks: list[dict], style: CaptionStyle, width: int = 1080, height: int = 1920
) -> str:
    """Full ASS subtitle file for these chunks, laid out for a width x height
    frame. Sizes are resolved from the frame here so the same style looks the
    same on landscape glasses footage and a vertical export."""
    font_size = max(12, round(height * style.font_scale))
    outline = round(font_size * style.outline_scale, 1)
    shadow = round(font_size * style.shadow_scale, 1)
    margin_v = round(height * style.margin_v_scale)
    bold = -1 if style.bold else 0

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
        "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        "MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Cap,{style.font},{font_size},&H{style.primary},&H{style.primary},"
        f"&H{style.outline_colour},&H{style.back_colour},{bold},0,0,0,100,100,0,0,"
        f"{style.border_style},{outline},{shadow},2,{round(width * 0.06)},"
        f"{round(width * 0.06)},{margin_v},1\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text\n"
    )

    lines = [header]
    for event in build_events(chunks, style):
        fade = _fade_tag(event)
        lines.append(
            f"Dialogue: 0,{ass_ts(event.start)},{ass_ts(event.end)},Cap,,0,0,0,,"
            f"{fade}{event.text}\n"
        )
    return "".join(lines)


def _fade_tag(event: CaptionEvent) -> str:
    fade_in = 60 if event.fade_in else 0
    fade_out = 40 if event.fade_out else 0
    return f"{{\\fad({fade_in},{fade_out})}}" if fade_in or fade_out else ""


def describe_styles() -> list[dict]:
    """Style catalogue for the app, so the picker reflects what this server
    actually supports instead of a hardcoded client-side guess."""
    return [
        {
            "key": s.key,
            "label": s.label,
            "description": s.description,
            "highlightsSpokenWord": s.highlight is not None,
        }
        for s in CAPTION_STYLES.values()
    ]
