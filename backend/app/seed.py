"""Populate the database.

Idempotent: safe to run on every start-up. Regions and terrain are upserted
by ``code``, users and events by their natural key, so re-running updates the
reference data in place instead of duplicating it.

What gets seeded, and how honest it is
--------------------------------------
* **Regions and terrain** come from ``ml/data/regions_seed.py`` - documented
  approximate values, tagged ``DEMO``. They are the same numbers the model was
  trained against, which is what keeps a served prediction comparable to the
  training distribution.
* **Historical events** are in two clearly separated groups. A small set of
  well-documented Indian landslide disasters, each carrying
  ``source = "Compiled from public reports (approximate)"``; and modelled
  minor events generated deterministically per region so the inventory has the
  volume and seasonality a history page needs. Every modelled row says
  ``source = "DEMO modelled event"``. Neither group is presented as an
  official inventory - swap in the GSI National Landslide Susceptibility
  Mapping database and this function is the only thing that changes.
* **Users** are demo accounts with published passwords, created only when
  ``SEED_DEMO_USERS=true``. They exist so a reviewer can sign in as each role
  without a registration flow.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import ensure_ml_importable, settings
from .models import LandslideEvent, Region, TerrainData, User
from .security import hash_password

ensure_ml_importable()

from ml.data.regions_seed import REGIONS  # noqa: E402  (path set above)

LOG = logging.getLogger("app.seed")

# Demo accounts. Passwords are printed in the README on purpose: this is a
# demonstration platform, and a reviewer needs to be able to sign in as each
# role. A real deployment removes them by setting SEED_DEMO_USERS=false.
DEMO_USERS = [
    {
        "username": "admin",
        "password": "admin123",
        "full_name": "Dr. A. Nair",
        "role": "ADMIN",
        "organisation": "National Disaster Management Authority",
    },
    {
        "username": "officer",
        "password": "officer123",
        "full_name": "S. Menon",
        "role": "OFFICER",
        "organisation": "Wayanad District Disaster Management Authority",
    },
    {
        "username": "officer2",
        "password": "officer123",
        "full_name": "R. Thapa",
        "role": "OFFICER",
        "organisation": "Darjeeling District Disaster Management Authority",
    },
    {
        "username": "citizen",
        "password": "citizen123",
        "full_name": "K. Joseph",
        "role": "CITIZEN",
        "organisation": None,
    },
]

# ---------------------------------------------------------------------------
# Documented events.
#
# These are real, widely reported Indian landslide disasters. Dates and places
# are as reported; casualty figures are approximate and were revised over time
# in several cases, so `fatalities` is left unset where the published range was
# wide. The `source` column says exactly this, and the history page renders it.
#
#  (region_code, date, place, severity, trigger, rainfall_24h_mm, fatalities,
#   description)
# ---------------------------------------------------------------------------
DOCUMENTED_EVENTS: list[tuple] = [
    ("KL-WAY", "2024-07-30", "Chooralmala - Mundakkai, Wayanad", "SEVERE",
     "Extreme rainfall", 372.0, None,
     "Debris flow through Punnapuzha valley after an exceptional overnight "
     "cloudburst on already saturated laterite slopes. One of the deadliest "
     "landslide disasters recorded in Kerala; casualty figures were revised "
     "for months afterwards."),
    ("KL-NIL", "2019-08-08", "Kavalappara, Nilambur, Malappuram", "SEVERE",
     "Extreme rainfall", 320.0, 59,
     "Hillside failure during the 2019 Kerala floods after several days of "
     "continuous heavy rain."),
    ("KL-WAY", "2019-08-08", "Puthumala, Meppadi, Wayanad", "MAJOR",
     "Extreme rainfall", 300.0, 17,
     "Tea-plantation slope failed during the same August 2019 rainfall spell "
     "that triggered Kavalappara."),
    ("KL-IDU", "2020-08-06", "Pettimudi, Rajamala, Idukki", "SEVERE",
     "Extreme rainfall", 280.0, 66,
     "Night-time failure above a tea estate labour settlement during an "
     "intense south-west monsoon spell."),
    ("KL-IDU", "2018-08-16", "Idukki district (multiple sites)", "MAJOR",
     "Extreme rainfall", 250.0, None,
     "Widespread slope failures across the district during the 2018 Kerala "
     "floods, the state's heaviest monsoon in nearly a century."),
    ("KA-KOD", "2018-08-17", "Madikeri - Makkandur, Kodagu", "MAJOR",
     "Extreme rainfall", 240.0, None,
     "Hundreds of shallow failures on coffee-plantation slopes after a week "
     "of continuous rainfall in August 2018."),
    ("MH-AMB", "2014-07-30", "Malin, Ambegaon, Pune", "SEVERE",
     "Extreme rainfall", 108.0, 151,
     "A hillside above the village collapsed in the early morning after "
     "prolonged monsoon rain on a modified slope."),
    ("MH-MAH", "2021-07-22", "Taliye, Mahad, Raigad", "SEVERE",
     "Extreme rainfall", 500.0, 87,
     "Slope failure during an extreme rainfall event that produced over "
     "500 mm in 24 hours across parts of coastal Maharashtra."),
    ("MH-MAH", "2023-07-19", "Irshalwadi, Khalapur, Raigad", "MAJOR",
     "Heavy rainfall", 200.0, 27,
     "Night-time debris slide onto a hamlet on the Irshalgad hill slope."),
    ("HP-MAN", "2017-08-13", "Kotropi, Mandi", "MAJOR",
     "Heavy rainfall", 120.0, 46,
     "A large slope failure buried a section of the Mandi - Pathankot "
     "highway together with two buses."),
    ("UK-PIT", "1998-08-18", "Malpa, Pithoragarh", "SEVERE",
     "Heavy rainfall", 150.0, 221,
     "Rockfall and debris flow destroyed the Malpa halting station on the "
     "Kailash - Mansarovar pilgrimage route."),
    ("UK-RUD", "2013-06-16", "Kedarnath valley, Rudraprayag", "SEVERE",
     "Cloudburst and glacial lake outburst", 325.0, None,
     "Cloudburst, moraine-dammed lake breach and widespread slope failures in "
     "the Mandakini valley during the 2013 Uttarakhand disaster."),
    ("MN-NON", "2022-06-30", "Tupul railway construction site, Noney", "SEVERE",
     "Heavy rainfall", 180.0, 61,
     "Failure of an excavated slope at a railway construction camp after "
     "prolonged pre-monsoon rain."),
    ("MZ-AIZ", "2024-05-28", "Melthum and Hlimen, Aizawl", "MAJOR",
     "Cyclone Remal rainfall", 200.0, None,
     "Multiple failures in and around Aizawl, including a stone quarry, "
     "during rainfall associated with Cyclone Remal."),
    ("WB-DAR", "2015-07-01", "Mirik - Darjeeling hills", "MAJOR",
     "Heavy rainfall", 190.0, None,
     "Numerous slides across the Darjeeling hills after an intense monsoon "
     "burst on tea-garden slopes."),
    ("SK-GAN", "2011-09-18", "North and East Sikkim", "SEVERE",
     "Earthquake (M6.9)", 20.0, None,
     "Co-seismic landslides across Sikkim triggered by the M6.9 Sikkim "
     "earthquake - the one event in this list not driven by rainfall, kept "
     "here because it shows the model's rainfall-only scope."),
    ("JK-RAM", "2023-08-21", "NH-44, Ramban", "MODERATE",
     "Heavy rainfall", 110.0, None,
     "Recurrent slope failures on the Jammu - Srinagar national highway "
     "corridor, a chronically unstable stretch."),
    ("UK-JOS", "2023-01-08", "Joshimath, Chamoli", "MAJOR",
     "Ground subsidence", 0.0, None,
     "Progressive ground subsidence and structural cracking in Joshimath "
     "town. Included as slope instability that was not rainfall-triggered."),
    ("ML-SOH", "2022-06-17", "Sohra (Cherrapunji) area", "MODERATE",
     "Extreme rainfall", 811.0, None,
     "Slope failures and road blockages during the record June 2022 rainfall "
     "in the East Khasi Hills."),
    ("TN-NIL", "2009-11-09", "Coonoor - Ooty, Nilgiris", "MAJOR",
     "Cyclonic rainfall", 220.0, None,
     "Widespread failures in the Nilgiris during heavy November 2009 rainfall."),
]

# Modelled events use these severity weights and the region's own monsoon
# season, so the generated inventory has realistic seasonality without any
# run-time randomness.
SEVERITY_WEIGHTS = (("MINOR", 0.55), ("MODERATE", 0.30), ("MAJOR", 0.12), ("SEVERE", 0.03))
TRIGGERS = ("Heavy rainfall", "Prolonged monsoon rainfall", "Cloudburst",
            "Road cutting and rainfall", "Toe erosion by river")

ZONE_PEAK_MONTH = {
    "WESTERN_GHATS": 7,
    "HIMALAYA_WEST": 7,
    "HIMALAYA_CENTRAL": 7,
    "HIMALAYA_EAST": 7,
    "NORTHEAST": 6,
    "EASTERN_GHATS": 8,
}


def _unit(*parts: object) -> float:
    """Deterministic value in [0, 1) from any key - no run-time randomness."""
    key = "|".join(str(p) for p in parts)
    digest = hashlib.sha256(key.encode("utf-8")).digest()
    return int.from_bytes(digest[:6], "big") / float(1 << 48)


def _pick(options: tuple, u: float):
    return options[min(len(options) - 1, int(u * len(options)))]


def _weighted(u: float) -> str:
    running = 0.0
    for name, weight in SEVERITY_WEIGHTS:
        running += weight
        if u < running:
            return name
    return SEVERITY_WEIGHTS[-1][0]


# ------------------------------------------------------------------- users

def seed_users(db: Session) -> int:
    if not settings.seed_demo_users:
        LOG.info("SEED_DEMO_USERS=false - skipping demo accounts")
        return 0
    created = 0
    for spec in DEMO_USERS:
        exists = db.execute(
            select(User).where(User.username == spec["username"])
        ).scalar_one_or_none()
        if exists is not None:
            continue
        db.add(
            User(
                username=spec["username"],
                full_name=spec["full_name"],
                password_hash=hash_password(spec["password"]),
                role=spec["role"],
                organisation=spec["organisation"],
            )
        )
        created += 1
    db.commit()
    if created:
        LOG.info("seeded %d demo users", created)
    return created


# ----------------------------------------------------------------- regions

def seed_regions(db: Session) -> tuple[int, int]:
    """Upsert regions and their terrain rows. Returns (created, updated)."""
    existing = {r.code: r for r in db.execute(select(Region)).scalars()}
    created = updated = 0

    for spec in REGIONS:
        region = existing.get(spec["code"])
        if region is None:
            region = Region(code=spec["code"])
            db.add(region)
            created += 1
        else:
            updated += 1

        region.name = spec["name"]
        region.district = spec["district"]
        region.state = spec["state"]
        region.zone = spec["zone"]
        region.latitude = spec["latitude"]
        region.longitude = spec["longitude"]
        region.area_km2 = spec["area_km2"]
        region.population_exposed = spec["population_exposed"]
        region.annual_rainfall_mm = spec["annual_rainfall_mm"]
        region.monsoon_index = spec["monsoon_index"]
        region.historical_landslide_count = spec["historical_landslide_count"]
        region.data_source = "DEMO reference dataset (ml/data/regions_seed.py)"

        db.flush()  # region.id is needed for the terrain row

        terrain = region.terrain
        if terrain is None:
            terrain = TerrainData(region_id=region.id)
            db.add(terrain)
        terrain.elevation_m = spec["elevation_m"]
        terrain.slope_deg = spec["slope_deg"]
        terrain.aspect_deg = spec["aspect_deg"]
        terrain.relief_m = spec["relief_m"]
        terrain.curvature = spec["curvature"]
        terrain.soil_type = spec["soil_type"]
        terrain.soil_depth_m = spec["soil_depth_m"]
        terrain.land_cover = spec["land_cover"]
        terrain.vegetation_index = spec["vegetation_index"]
        terrain.distance_to_river_km = spec["distance_to_river_km"]
        terrain.distance_to_road_km = spec["distance_to_road_km"]
        terrain.lithology = spec.get("lithology")
        terrain.dem_source = "DEMO (approximate public values, not a DEM extraction)"
        terrain.data_mode = "DEMO"

    db.commit()
    LOG.info("regions: %d created, %d updated", created, updated)
    return created, updated


# ------------------------------------------------------------------ events

def _documented_events(regions: dict[str, Region]) -> list[LandslideEvent]:
    rows: list[LandslideEvent] = []
    for i, spec in enumerate(DOCUMENTED_EVENTS, start=1):
        code, iso_date, place, severity, trigger, rain, deaths, description = spec
        region = regions.get(code)
        if region is None:
            continue
        terrain = region.terrain
        # Nudge the point off the region centroid so co-located events do not
        # stack into one marker on the map.
        jitter_lat = (_unit(code, iso_date, "lat") - 0.5) * 0.09
        jitter_lon = (_unit(code, iso_date, "lon") - 0.5) * 0.09
        rows.append(
            LandslideEvent(
                event_id=f"LS-DOC-{i:03d}",
                region_id=region.id,
                event_date=date.fromisoformat(iso_date),
                location=place,
                district=region.district,
                state=region.state,
                latitude=round(region.latitude + jitter_lat, 5),
                longitude=round(region.longitude + jitter_lon, 5),
                rainfall_mm=rain,
                slope_deg=terrain.slope_deg if terrain else None,
                elevation_m=terrain.elevation_m if terrain else None,
                severity=severity,
                trigger=trigger,
                fatalities=deaths,
                description=description,
                source="Compiled from public reports (approximate figures)",
                data_mode="DEMO",
            )
        )
    return rows


def _modelled_events(regions: dict[str, Region]) -> list[LandslideEvent]:
    """Deterministic minor-event inventory, one batch per region.

    Count follows the region's ``historical_landslide_count`` so the map,
    the per-year chart and the model's own history feature all tell the same
    story. Dates cluster around the zone's monsoon peak.
    """
    rows: list[LandslideEvent] = []
    counter = 0
    for code, region in sorted(regions.items()):
        terrain = region.terrain
        target = max(0, int(region.historical_landslide_count))
        peak_month = ZONE_PEAK_MONTH.get(region.zone, 7)
        annual = float(region.annual_rainfall_mm or 2000.0)

        for k in range(target):
            u_year = _unit(code, k, "year")
            u_month = _unit(code, k, "month")
            u_day = _unit(code, k, "day")
            u_sev = _unit(code, k, "sev")
            u_rain = _unit(code, k, "rain")

            # 2009-2025, weighted slightly towards recent years because
            # reporting coverage improved over the period.
            year = 2009 + int(u_year**0.75 * 17)
            month_offset = int(round((u_month - 0.5) * 3.0))
            month = min(12, max(1, peak_month + month_offset))
            day = 1 + int(u_day * 27)

            severity = _weighted(u_sev)
            # Heavier rainfall for the more damaging events, scaled by how wet
            # the region is normally.
            base = 55.0 + 0.045 * annual
            multiplier = {"MINOR": 0.7, "MODERATE": 1.0, "MAJOR": 1.35, "SEVERE": 1.8}[severity]
            rainfall = round(base * multiplier * (0.7 + 0.6 * u_rain), 1)

            counter += 1
            rows.append(
                LandslideEvent(
                    event_id=f"LS-{code}-{k + 1:02d}",
                    region_id=region.id,
                    event_date=date(year, month, day),
                    location=f"{region.name} area, {region.district}",
                    district=region.district,
                    state=region.state,
                    latitude=round(region.latitude + (_unit(code, k, "jlat") - 0.5) * 0.16, 5),
                    longitude=round(region.longitude + (_unit(code, k, "jlon") - 0.5) * 0.16, 5),
                    rainfall_mm=rainfall,
                    slope_deg=(
                        round(terrain.slope_deg + (_unit(code, k, "slope") - 0.5) * 8.0, 1)
                        if terrain else None
                    ),
                    elevation_m=(
                        round(terrain.elevation_m * (0.85 + 0.3 * _unit(code, k, "elev")), 0)
                        if terrain else None
                    ),
                    severity=severity,
                    trigger=_pick(TRIGGERS, _unit(code, k, "trig")),
                    fatalities=(
                        0 if severity in ("MINOR", "MODERATE")
                        else int(1 + _unit(code, k, "fat") * (8 if severity == "MAJOR" else 30))
                    ),
                    description=(
                        f"DEMO modelled {severity.lower()} slope failure near {region.name} "
                        f"following {rainfall:.0f} mm of rainfall. Generated deterministically "
                        "for demonstration; not an observed event."
                    ),
                    source="DEMO modelled event",
                    data_mode="DEMO",
                )
            )
    LOG.info("generated %d modelled events", counter)
    return rows


def seed_events(db: Session) -> int:
    """Insert the historical inventory if it is not already there."""
    present = db.execute(select(func.count(LandslideEvent.id))).scalar_one()
    if present:
        LOG.info("landslide inventory already holds %d events - skipping", present)
        return 0

    regions = {r.code: r for r in db.execute(select(Region)).scalars()}
    if not regions:
        LOG.warning("no regions present; seed regions before events")
        return 0

    rows = _documented_events(regions) + _modelled_events(regions)
    db.add_all(rows)
    db.commit()
    LOG.info("seeded %d landslide events", len(rows))
    return len(rows)


# --------------------------------------------------------------------- all

def seed_all(db: Session) -> dict[str, int]:
    """Everything, in dependency order. Safe to call on every start-up."""
    users = seed_users(db)
    created, updated = seed_regions(db)
    events = seed_events(db)
    return {
        "users_created": users,
        "regions_created": created,
        "regions_updated": updated,
        "events_created": events,
    }


def main() -> int:  # pragma: no cover - CLI helper
    """``python -m app.seed`` - initialise and populate the database."""
    import sys

    logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
    from .database import init_db, session_scope

    init_db()
    db = session_scope()
    try:
        summary = seed_all(db)
    finally:
        db.close()

    print("\nSeed complete")
    for key, value in summary.items():
        print(f"  {key:<18}{value}")
    print("\nDEMO DATA - regions, terrain and the landslide inventory are")
    print("demonstration values, not an official dataset.")
    return 0 if sys.maxsize else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
