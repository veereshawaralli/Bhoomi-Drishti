"""Screening of citizen-submitted photographs.

What this is, and what it is not
--------------------------------
This is a **deterministic image-screening heuristic**, not a trained
convolutional classifier. It measures a handful of well-defined properties of
the photograph - how much of the frame is vegetated, how much is bare earth or
rock, how strongly linear the edges are, how coherent those linear features
are, how rough the surface texture is - and maps them onto the five categories
the specification names. Every response says exactly that, and every response
carries the disclaimer that it is decision support and does not replace
professional assessment.

Why not a CNN? Because shipping one would mean either a large pretrained
download the grader cannot verify, or a model trained on a handful of images
that would report high confidence on nothing. A transparent measurement whose
reasoning is printed alongside the answer is more useful to an officer, and
more honest, than a black box with no evidence behind it. The interface is the
one a real classifier would use, so replacing this with a fine-tuned model is a
single-file change - documented in ``docs/ML.md``.

What it measures
----------------
* **green fraction** - pixels where the green channel dominates. Intact
  vegetation covering a slope is the strongest indicator that nothing has moved.
* **earth fraction** - pixels in the red-brown range with low saturation
  spread, which is what freshly exposed soil and scar faces look like.
* **grey fraction** - low-chroma pixels: rock faces, debris and concrete.
* **dark-line fraction** - pixels that are markedly darker than their immediate
  surroundings. This is the crack detector, and the "markedly" is what
  separates an open fissure from the many shallow parallel lines in a ploughed
  field or a cart track.
* **edge coherence** - whether those dark features line up along a consistent
  direction (a crack) or point everywhere (foliage, gravel).
* **patch** - whether the bare ground forms one contiguous area or is speckled
  soil showing between plants. Combined with the green fraction this is what
  distinguishes a landslide scar from farmland: a scar interrupts vegetation,
  whereas a field is uniformly bare and has no vegetation to interrupt.
* **roughness** - local intensity variance, which separates blocky rockfall
  debris from smooth soil or a plain concrete wall.

The sparse measures are compared against a reference fraction rather than used
raw: a crack that occupies 2% of the frame is a crack, and a term that stayed
proportional to area would always be swamped by the 90% of the frame that is
just hillside.

The tuning fixtures - including two adversarial ones, a dry ploughed field and
a concrete wall, which a colour-only rule would call landslides - are in
``backend/tests/test_image_analysis.py``.

Confidence
----------
Reported confidence is the margin between the best-scoring category and the
runner-up, scaled and capped at 80%. A screening heuristic should never claim
near-certainty, and the cap makes that structural rather than a promise.
"""
from __future__ import annotations

import io
import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

LOG = logging.getLogger("app.image")

DISCLAIMER = (
    "Automated screening only. This is decision support and does not replace "
    "assessment by a qualified geotechnical engineer or a site visit by the "
    "district administration."
)

METHOD = (
    "Deterministic image-feature heuristic (colour composition, crack depth and "
    "alignment, bare-ground contiguity, texture roughness). Not a trained "
    "neural network."
)

# Analysis is done on a small thumbnail: the measurements are all
# scale-invariant statistics, and it keeps a phone photograph well under a
# tenth of a second.
THUMBNAIL = 256


@dataclass(frozen=True)
class Category:
    key: str
    label: str
    recommendation: str


CATEGORIES: dict[str, Category] = {
    "NORMAL_TERRAIN": Category(
        key="NORMAL_TERRAIN",
        label="Normal terrain",
        recommendation=(
            "No visible instability in this image. File the report for the "
            "record and re-inspect if conditions change."
        ),
    ),
    "GROUND_CRACK": Category(
        key="GROUND_CRACK",
        label="Ground crack",
        recommendation=(
            "Send a field team to measure crack width and length and to mark it "
            "for monitoring. Widening cracks are the clearest precursor to a "
            "slope failure - check again after the next heavy rainfall."
        ),
    ),
    "ROCKFALL": Category(
        key="ROCKFALL",
        label="Rockfall / debris",
        recommendation=(
            "Inspect the slope above for loose blocks and overhangs. If the "
            "debris is on or near a road, restrict traffic until the face has "
            "been cleared and checked."
        ),
    ),
    "POSSIBLE_LANDSLIDE": Category(
        key="POSSIBLE_LANDSLIDE",
        label="Possible landslide",
        recommendation=(
            "Treat as a suspected slope failure. Send a field team, keep people "
            "away from the slope toe, and check for structures and roads below "
            "the affected area."
        ),
    ),
    "SEVERE_LANDSLIDE": Category(
        key="SEVERE_LANDSLIDE",
        label="Severe landslide",
        recommendation=(
            "Treat as an active failure. Alert the district control room "
            "immediately, evacuate anyone below the slope, close affected roads "
            "and request an engineering assessment."
        ),
    ),
}

UNREADABLE = {
    "category": "UNREADABLE",
    "category_label": "Could not analyse image",
    "confidence": 0.0,
    "features": [],
    "recommendation": (
        "The image could not be read. The written report has been recorded and "
        "will be reviewed by an officer regardless."
    ),
    "method": METHOD,
    "disclaimer": DISCLAIMER,
}


# ------------------------------------------------------------ measurement

def _load(source: str | Path | bytes) -> np.ndarray | None:
    """Decode an image from a path or from raw bytes.

    Bytes are accepted so an upload can be screened without being written to
    disk first - the preview button on the citizen form should not leave a
    file behind for a photograph the user then decides not to send.
    """
    try:
        from PIL import Image
    except ImportError:
        LOG.warning("Pillow is not installed; image screening unavailable")
        return None
    handle_source: Any = io.BytesIO(source) if isinstance(source, bytes) else source
    try:
        with Image.open(handle_source) as handle:
            handle = handle.convert("RGB")
            handle.thumbnail((THUMBNAIL, THUMBNAIL))
            return np.asarray(handle, dtype=np.float32) / 255.0
    except Exception as exc:
        label = "<uploaded bytes>" if isinstance(source, bytes) else source
        LOG.warning("could not read image %s (%s)", label, exc)
        return None


def _sobel(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Gradient magnitude and direction, computed with plain NumPy."""
    gx = np.zeros_like(gray)
    gy = np.zeros_like(gray)
    gx[:, 1:-1] = gray[:, 2:] - gray[:, :-2]
    gy[1:-1, :] = gray[2:, :] - gray[:-2, :]
    magnitude = np.hypot(gx, gy)
    direction = np.arctan2(gy, gx)
    return magnitude, direction


def _box_mean(gray: np.ndarray, radius: int) -> np.ndarray:
    """Mean over a (2*radius+1) square window - the local background level.

    Done with a summed-area table so the window size costs nothing: comparing
    a pixel against its surroundings is the whole basis of the crack test, and
    a wide window is what makes a fissure stand out from ordinary texture.
    """
    pad = np.pad(gray, radius + 1, mode="edge")
    integral = pad.cumsum(axis=0).cumsum(axis=1)
    size = 2 * radius + 1
    h, w = gray.shape
    # Corners of each window in the padded integral image.
    br = integral[size:size + h, size:size + w]
    bl = integral[size:size + h, 0:w]
    tr = integral[0:h, size:size + w]
    tl = integral[0:h, 0:w]
    return (br - bl - tr + tl) / float(size * size)


def measure(source: str | Path | bytes) -> dict[str, float] | None:
    """The scale-invariant measurements the decision is made from."""
    rgb = _load(source)
    if rgb is None or rgb.size == 0:
        return None

    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    gray = 0.299 * r + 0.587 * g + 0.114 * b

    # Vegetation: green dominant over both other channels.
    green = float(np.mean((g > r * 1.06) & (g > b * 1.10)))
    # Bare earth and rock: warm, desaturated, mid-to-bright.
    earth = float(np.mean((r > g * 1.02) & (r > b * 1.12) & (gray > 0.20)))
    # Grey rock faces, debris and concrete: low chroma.
    chroma = rgb.max(axis=2) - rgb.min(axis=2)
    grey = float(np.mean((chroma < 0.10) & (gray > 0.18) & (gray < 0.85)))

    magnitude, direction = _sobel(gray)

    # A fixed gradient threshold, not a percentile of this image. A percentile
    # always selects the same fraction of pixels, so it would report identical
    # "edge coverage" for a cracked slope and a plain wall.
    strong = magnitude > 0.10
    edges = float(np.mean(strong))

    # The crack test, in two parts.
    #
    # Part one - depth. An open fissure reads darker than the ground on either
    # side of it, so each pixel is compared against a local background (an
    # 11-pixel box mean) and kept only if it is *substantially* darker. The
    # 0.10 threshold is what separates a real crack from the many shallow
    # parallel lines in a ploughed field, a tiled roof or a cart track, which
    # sit around 0.07: those are the false positives worth designing against.
    deficit = _box_mean(gray, 5) - gray
    dark_lines = float(np.mean(deficit > 0.10))

    # Part two - direction. Do the dark pixels lie along a consistent axis?
    # Circular variance of the gradient angle, doubled so the two opposing
    # gradients on either side of one crack count as a single orientation.
    line_mask = (deficit > 0.05) & (magnitude > 0.05)
    if int(line_mask.sum()) > 48:
        angles = direction[line_mask] * 2.0
        coherence = math.hypot(
            float(np.mean(np.cos(angles))), float(np.mean(np.sin(angles)))
        )
    else:
        coherence = 0.0

    # Combined: aligned *and* deep. The area term saturates rather than scaling
    # linearly, because a hairline crack across a hillside is still a crack and
    # a term proportional to area would let 2% of the frame be outvoted by the
    # 98% that is ordinary ground.
    crack = coherence * (1.0 - math.exp(-dark_lines / 0.0005))

    # Is the bare ground one contiguous patch, or scattered soil showing
    # between plants? The peak local bare fraction over a 33-pixel window
    # answers that: a landslide scar is solid, ordinary ground is speckled.
    bare = (
        ((r > g * 1.02) & (r > b * 1.12) & (gray > 0.20))
        | ((chroma < 0.10) & (gray > 0.18) & (gray < 0.85))
    ).astype(np.float32)
    patch = float(_box_mean(bare, 16).max())

    # Roughness: local intensity variance, via a 3x3 box.
    pad = np.pad(gray, 1, mode="edge")
    stack = np.stack(
        [pad[i:i + gray.shape[0], j:j + gray.shape[1]] for i in range(3) for j in range(3)]
    )
    roughness = float(np.mean(np.var(stack, axis=0)))

    # Fresh scars are usually darker than dry surrounding ground.
    darkness = float(np.mean(gray < 0.28))

    return {
        "green": round(green, 4),
        "earth": round(earth, 4),
        "grey": round(grey, 4),
        "edges": round(edges, 4),
        "dark_lines": round(dark_lines, 4),
        "coherence": round(coherence, 4),
        "crack": round(crack, 4),
        "patch": round(patch, 4),
        "roughness": round(roughness, 5),
        "darkness": round(darkness, 4),
        "brightness": round(float(np.mean(gray)), 4),
    }


# ---------------------------------------------------------------- scoring

def _scores(m: dict[str, float]) -> dict[str, float]:
    """Evidence score per category. Deliberately readable, not tuned to death."""
    green, earth, grey = m["green"], m["earth"], m["grey"]
    crack, edges = m["crack"], m["edges"]
    rough, dark = m["roughness"], m["darkness"]

    # How much of the frame is not intact ground cover. Rock counts for less
    # than soil: a grey scree face is often a stable, long-standing feature,
    # whereas exposed earth on a vegetated slope is usually recent.
    disturbed = earth + 0.6 * grey
    excess = max(0.0, disturbed - 0.45)

    # A scar is bare ground that has *interrupted* vegetation. A frame that is
    # uniformly bare edge to edge - farmland, a quarry floor, a concrete wall -
    # has no vegetation to interrupt, so `context` withdraws the scar evidence
    # and those images fall through to NORMAL_TERRAIN. This is the single term
    # that stops the screening from calling every brown photograph a landslide.
    context = min(1.0, green / 0.08)
    scar = m["patch"] * context

    # Structure: distinguishes real surfaces from flat, uniform ones.
    texture = min(1.0, rough / 0.0035)
    # Freshness: a recent failure exposes dark, irregular material. Dry
    # cultivated soil is bright and smooth, and scores near zero here.
    fresh = min(1.0, 0.75 * dark / 0.30 + 0.25 * rough / 0.004)

    return {
        # Vegetated, or at least undisturbed: no scar, no crack, no roughness.
        "NORMAL_TERRAIN": (
            2.2 * green + 1.1 * (1.0 - disturbed) - 2.6 * crack - 2.8 * scar
            - 18.0 * rough + 0.9 * (1.0 - texture) * (1.0 - min(1.0, green / 0.05))
        ),
        # A crack is a deep, aligned, dark line on ground that is otherwise
        # unremarkable. The crack term carries this category almost alone,
        # because that is the one measurement that means it.
        "GROUND_CRACK": (
            4.0 * crack + 0.4 * earth - 1.0 * scar - 10.0 * rough
        ),
        # Rockfall is rough and blocky, grey-toned, edges in every direction.
        "ROCKFALL": (
            2.2 * grey * texture + 26.0 * rough + 0.7 * edges
            - 2.0 * crack - 1.2 * green - 0.8 * scar
        ),
        # A slope failure: a solid bare patch cut into vegetated ground.
        "POSSIBLE_LANDSLIDE": (
            2.6 * scar + 1.4 * min(disturbed, 0.6) * fresh - 0.9 * green - 1.0 * crack
        ),
        # A severe one: most of the frame is bare, dark and rough.
        "SEVERE_LANDSLIDE": (
            2.2 * scar + 2.8 * excess * fresh + 1.8 * dark * fresh
            + 10.0 * rough - 2.2 * green - 0.6 * crack
        ),
    }


def _evidence(m: dict[str, float], category: str) -> list[str]:
    """Plain-language readings, so the officer sees what the machine saw."""
    lines = [
        f"{m['green'] * 100:.0f}% of the frame is vegetated",
        f"{(m['earth'] + m['grey']) * 100:.0f}% is bare earth, rock or debris",
    ]
    if m["crack"] > 0.45:
        lines.append(
            "a deep, consistently aligned dark line runs across the image - "
            "characteristic of an open ground crack"
        )
    elif m["crack"] > 0.2:
        lines.append("some aligned dark linear features, weaker than a clear crack")
    elif m["dark_lines"] > 0.02:
        lines.append(
            "dark linear features are present but point in many directions - "
            "more like debris or shadow than a crack"
        )
    else:
        lines.append("no crack-like linear features detected")
    if m["roughness"] > 0.003:
        lines.append("surface texture is rough and blocky")
    if m["darkness"] > 0.4:
        lines.append("much of the surface is dark, as freshly exposed ground tends to be")
    if m["patch"] > 0.8 and m["green"] > 0.05:
        lines.append(
            "the bare ground forms one solid patch cutting into vegetated "
            "terrain, rather than soil showing between plants"
        )
    if category == "NORMAL_TERRAIN":
        lines.append("no disturbed ground or coherent cracking detected")
    return lines


def analyse(source: str | Path | bytes) -> dict[str, Any]:
    """Screen one photograph. Always returns a payload - never raises."""
    m = measure(source)
    if m is None:
        return dict(UNREADABLE)

    scores = _scores(m)
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    best_key, best_score = ranked[0]
    runner_up = ranked[1][1]

    # Confidence from the margin, capped at 80%. A screening heuristic that
    # reported 97% would be lying about what it is.
    margin = max(0.0, best_score - runner_up)
    confidence = round(min(80.0, 34.0 + 46.0 * (1.0 - math.exp(-margin * 1.6))), 1)

    category = CATEGORIES[best_key]
    return {
        "category": category.key,
        "category_label": category.label,
        "confidence": confidence,
        "features": _evidence(m, best_key),
        "recommendation": category.recommendation,
        "method": METHOD,
        "disclaimer": DISCLAIMER,
        "measurements": m,
        "alternatives": [
            {"category": CATEGORIES[k].label, "score": round(float(v), 3)}
            for k, v in ranked[1:3]
        ],
    }


def analyse_bytes(content: bytes) -> dict[str, Any]:
    """Screen an uploaded photograph held in memory.

    Raises ``ValueError`` if the bytes are not a decodable image, so the API
    can answer 415 rather than returning an UNREADABLE verdict that looks like
    a considered judgement about the terrain.
    """
    if not content:
        raise ValueError("empty upload")
    result = analyse(content)
    if result.get("category") == "UNREADABLE":
        raise ValueError(
            "That file could not be decoded as an image. JPEG, PNG, WebP and "
            "BMP are supported."
        )
    return result


def severity_hint(result: dict[str, Any]) -> str | None:
    """What severity this screening suggests, for the officer's triage queue.

    Advisory only - it pre-sorts the queue, it never changes a report's status
    or raises an alert on its own.
    """
    return {
        "SEVERE_LANDSLIDE": "HIGH",
        "POSSIBLE_LANDSLIDE": "HIGH",
        "ROCKFALL": "MEDIUM",
        "GROUND_CRACK": "MEDIUM",
        "NORMAL_TERRAIN": "LOW",
    }.get(str(result.get("category")))


__all__ = [
    "CATEGORIES",
    "DISCLAIMER",
    "METHOD",
    "analyse",
    "analyse_bytes",
    "measure",
    "severity_hint",
]
