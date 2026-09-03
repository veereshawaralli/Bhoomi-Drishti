"""Calibration tests for the photograph screening heuristic.

The fixtures are drawn, not photographed. They are not a benchmark and passing
them does not mean the screening is accurate on real phone photographs - only
that the measurements separate the five categories the way the module claims,
and that the two failure modes worth designing against are actually handled:

* a **dry ploughed field** - almost entirely bare earth, crossed by many
  shallow parallel furrows. A colour-only rule calls this a landslide; a
  linearity-only rule calls it a crack. It is neither.
* a **concrete retaining wall** - uniformly grey and featureless. A rule that
  keys on "not vegetated" calls this rockfall.

Both must come back as normal terrain, and both do - the field because a scar
has to interrupt vegetation to count as a scar, the wall because rockfall has
to have texture.

Run with ``pytest backend/tests/test_image_analysis.py``. Requires Pillow and
NumPy, which the screening path needs anyway; the fixtures are generated at
test time so nothing binary is committed.
"""
from __future__ import annotations

import numpy as np
import pytest

PIL = pytest.importorskip("PIL", reason="Pillow is required for image screening")
from PIL import Image, ImageDraw, ImageFilter  # noqa: E402

from app.services import image_analysis as ia  # noqa: E402

SIZE = 320


def _noise(base: np.ndarray, amp: float, rng: np.random.Generator) -> np.ndarray:
    return np.clip(base + rng.normal(0, amp, (SIZE, SIZE, 3)), 0, 255).astype(np.uint8)


def _fixtures(tmp_path) -> dict[str, str]:
    """Eight drawn scenes covering the five categories plus two traps."""
    rng = np.random.default_rng(11)  # fixtures only; the product uses no RNG
    out: dict[str, str] = {}

    def save(arr: np.ndarray, name: str) -> None:
        path = tmp_path / f"{name}.png"
        Image.fromarray(arr).save(path)
        out[name] = str(path)

    # 1. Intact vegetated hillside.
    veg = np.zeros((SIZE, SIZE, 3))
    veg[..., 0], veg[..., 1], veg[..., 2] = 46, 108, 38
    img = Image.fromarray(_noise(veg, 20, rng))
    draw = ImageDraw.Draw(img)
    for _ in range(160):
        x, y, s = rng.uniform(0, SIZE), rng.uniform(0, SIZE), rng.uniform(6, 22)
        draw.ellipse(
            [x, y, x + s, y + s],
            fill=(int(rng.uniform(30, 70)), int(rng.uniform(90, 140)), 34),
        )
    save(np.asarray(img), "normal_vegetation")

    # 2. An open crack across a bare track.
    ground = np.zeros((SIZE, SIZE, 3))
    ground[..., 0], ground[..., 1], ground[..., 2] = 122, 110, 84
    img = Image.fromarray(_noise(ground, 12, rng))
    draw = ImageDraw.Draw(img)
    for off in range(-4, 5):
        draw.line([(18, 96 + off), (302, 196 + off)], fill=(26, 22, 18), width=2)
    save(np.asarray(img.filter(ImageFilter.GaussianBlur(0.6))), "ground_crack")

    # 3. A thinner crack through grass - the hard positive.
    img = Image.fromarray(_noise(veg, 18, rng))
    draw = ImageDraw.Draw(img)
    for off in range(-4, 5):
        draw.line([(30, 240 + off), (290, 70 + off)], fill=(30, 24, 18), width=2)
    save(np.asarray(img.filter(ImageFilter.GaussianBlur(0.6))), "crack_in_grass")

    # 4. Rockfall debris: grey, blocky, edges in every direction.
    rock = np.zeros((SIZE, SIZE, 3)) + 126
    img = Image.fromarray(_noise(rock, 10, rng))
    draw = ImageDraw.Draw(img)
    for _ in range(110):
        x, y = rng.uniform(0, SIZE - 40), rng.uniform(0, SIZE - 40)
        s, v = rng.uniform(10, 36), int(rng.uniform(64, 205))
        draw.polygon(
            [(x, y), (x + s, y + rng.uniform(-6, 6)),
             (x + s * 0.8, y + s), (x + rng.uniform(-5, 5), y + s * 0.9)],
            fill=(v, v, int(v * 0.96)), outline=(38, 38, 38),
        )
    save(np.asarray(img), "rockfall")

    # 5. A scar cut into vegetation.
    img = Image.fromarray(_noise(veg, 18, rng))
    draw = ImageDraw.Draw(img)
    draw.polygon([(150, 12), (196, 120), (240, 300), (96, 300), (118, 120)],
                 fill=(126, 86, 54))
    arr = np.asarray(img).astype(float)
    save(np.clip(arr + rng.normal(0, 12, arr.shape), 0, 255).astype(np.uint8),
         "possible_landslide")

    # 6. A severe failure: most of the frame is dark scar.
    sev = np.zeros((SIZE, SIZE, 3))
    sev[..., 0], sev[..., 1], sev[..., 2] = 88, 58, 38
    sev[0:20, :] = np.array([44, 96, 36])
    img = Image.fromarray(_noise(sev, 26, rng))
    draw = ImageDraw.Draw(img)
    for _ in range(50):
        x, y = rng.uniform(0, SIZE), rng.uniform(24, SIZE)
        draw.ellipse([x, y, x + rng.uniform(10, 34), y + rng.uniform(8, 28)],
                     fill=(40, 28, 20))
    save(np.asarray(img), "severe_landslide")

    # 7. Trap: a dry ploughed field. Bare and lined, but nothing has moved.
    dry = np.zeros((SIZE, SIZE, 3))
    dry[..., 0], dry[..., 1], dry[..., 2] = 168, 142, 106
    img = Image.fromarray(_noise(dry, 14, rng))
    draw = ImageDraw.Draw(img)
    for y in range(10, SIZE, 18):
        draw.line([(0, y), (SIZE, y + 6)], fill=(140, 118, 88), width=3)
    save(np.asarray(img), "adversarial_dry_field")

    # 8. Trap: a concrete retaining wall. Not vegetation, not a hazard.
    con = np.zeros((SIZE, SIZE, 3)) + 150
    save(_noise(con, 6, rng), "adversarial_concrete")
    return out


EXPECTED = {
    "normal_vegetation": "NORMAL_TERRAIN",
    "ground_crack": "GROUND_CRACK",
    "crack_in_grass": "GROUND_CRACK",
    "rockfall": "ROCKFALL",
    "possible_landslide": "POSSIBLE_LANDSLIDE",
    "severe_landslide": "SEVERE_LANDSLIDE",
    "adversarial_dry_field": "NORMAL_TERRAIN",
    "adversarial_concrete": "NORMAL_TERRAIN",
}


@pytest.fixture(scope="module")
def scenes(tmp_path_factory):
    return _fixtures(tmp_path_factory.mktemp("scenes"))


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_category(scenes, name):
    result = ia.analyse(scenes[name])
    assert result["category"] == EXPECTED[name], (
        f"{name}: got {result['category']} at {result['confidence']}% "
        f"(runner-up {result['alternatives'][0]['category']})"
    )


def test_box_mean_matches_naive():
    """The summed-area shortcut must equal the obvious implementation."""
    rng = np.random.default_rng(0)
    a = rng.random((23, 19)).astype(np.float32)
    radius = 3
    pad = np.pad(a, radius, mode="edge")
    naive = np.array(
        [[pad[i:i + 2 * radius + 1, j:j + 2 * radius + 1].mean()
          for j in range(a.shape[1])] for i in range(a.shape[0])]
    )
    assert np.abs(naive - ia._box_mean(a, radius)).max() < 1e-5


def test_confidence_is_capped(scenes):
    """A screening heuristic must never report near-certainty."""
    for path in scenes.values():
        assert 0.0 <= ia.analyse(path)["confidence"] <= 80.0


def test_deterministic(scenes):
    """Same image in, same verdict out - no randomness anywhere."""
    path = scenes["ground_crack"]
    assert ia.analyse(path) == ia.analyse(path)


def test_unreadable_never_raises(tmp_path):
    """A missing or corrupt file yields a payload, not an exception."""
    assert ia.analyse(tmp_path / "absent.png")["category"] == "UNREADABLE"
    broken = tmp_path / "broken.png"
    broken.write_bytes(b"this is not a PNG")
    assert ia.analyse(broken)["category"] == "UNREADABLE"


def test_every_result_carries_the_disclaimer(scenes):
    """The specification requires it, and it is the honest thing to ship."""
    for path in scenes.values():
        result = ia.analyse(path)
        assert "does not replace" in result["disclaimer"]
        assert "Not a trained neural network" in result["method"]
        assert result["recommendation"]
        assert result["features"]


def test_severity_hint_covers_every_category():
    for key in ia.CATEGORIES:
        assert ia.severity_hint({"category": key}) in {"LOW", "MEDIUM", "HIGH"}
    assert ia.severity_hint({"category": "UNREADABLE"}) is None


def test_crack_measure_rejects_shallow_furrows(scenes):
    """The measurement, not just the verdict: furrows must not read as a crack.

    This is the regression guard for the threshold in ``measure``. A ploughed
    field's furrows are about 0.07 darker than their surroundings; a real crack
    is deeper than 0.10. If someone lowers that threshold to catch fainter
    cracks, this test tells them what it costs.
    """
    field = ia.measure(scenes["adversarial_dry_field"])
    crack = ia.measure(scenes["ground_crack"])
    assert field["crack"] < 0.05
    assert crack["crack"] > 0.5


def test_scar_requires_vegetation_to_interrupt(scenes):
    """A uniformly bare frame is not a scar, however bare it is."""
    field = ia.measure(scenes["adversarial_dry_field"])
    slide = ia.measure(scenes["possible_landslide"])
    # The field is barer than the landslide...
    assert field["earth"] > slide["earth"]
    # ...but has no vegetation, so the scar evidence is withdrawn.
    assert field["green"] < 0.02
    assert slide["green"] > 0.2
