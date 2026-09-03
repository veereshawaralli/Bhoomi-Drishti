"""Citizen reports: submission, screening, triage.

A citizen sees a crack in the road above their village and photographs it.
That observation is often earlier and more specific than anything a model can
infer from rainfall - so this path matters, and it is deliberately open: a
report can be filed without an account, because requiring a login before
someone can warn you about a slope is a way of not being warned.

What happens to a report
------------------------
1. It is stored with its location, description, type, severity and date.
2. If a photograph was attached it is saved and screened by
   ``image_analysis`` - a transparent heuristic whose reasoning is stored
   alongside the verdict. The screening never changes the report's status.
3. It is snapped to the nearest monitored region within 60 km, so the officer
   dashboard can show it in context, and so it appears on the map.
4. It sits in the officer queue as NEW until a human moves it to UNDER REVIEW,
   VERIFIED or DISMISSED. Whatever the officer writes is stored in
   ``officer_note``; the citizen's ``description`` is written once, at insert,
   and is never edited by anything in this application.

Nothing auto-verifies and nothing auto-alerts. A report is evidence for an
officer, not an input to the model - and treating an unverified photograph as
ground truth is exactly how an early-warning system loses its credibility.
"""
from __future__ import annotations

import logging
import math
import re
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Mapping
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..clock import utcnow
from ..config import settings
from ..models import CitizenReport, Region, User
from . import image_analysis

LOG = logging.getLogger("app.reports")

MAX_SNAP_KM = 60.0
ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def _report_code(report_id: int) -> str:
    """Human-readable, sortable, unique: ``CR-2026-00007``.

    The sequence number is the row's own primary key, not ``COUNT(*) + 1``. The
    count is the obvious implementation and it is wrong under concurrency: two
    reports filed in the same instant read the same count, build the same code and
    the second one dies on the unique index. Two citizens filing at once is not a
    rare event, and a 503 is a terrible answer to somebody reporting a crack in a
    road. The primary key is unique by construction, which is why the code is
    stamped after the insert rather than before it.
    """
    return f"CR-{utcnow().year}-{report_id:05d}"


def nearest_region(db: Session, latitude: float, longitude: float) -> tuple[Region | None, float]:
    """Closest monitored region and its distance in km.

    Bounding box then exact distance, same approach as the historical
    proximity search - and the same PostGIS upgrade path.
    """
    delta_lat = MAX_SNAP_KM / 111.0
    delta_lon = MAX_SNAP_KM / max(1e-6, 111.0 * math.cos(math.radians(latitude)))
    candidates = db.scalars(
        select(Region).where(
            Region.latitude.between(latitude - delta_lat, latitude + delta_lat),
            Region.longitude.between(longitude - delta_lon, longitude + delta_lon),
        )
    ).all()
    best: Region | None = None
    best_km = float("inf")
    for region in candidates:
        dy = (region.latitude - latitude) * 111.0
        dx = (region.longitude - longitude) * 111.0 * math.cos(math.radians(latitude))
        km = math.hypot(dx, dy)
        if km < best_km:
            best, best_km = region, km
    if best is None or best_km > MAX_SNAP_KM:
        return None, best_km if best is not None else float("inf")
    return best, best_km


def _safe_name(original: str, code: str) -> str:
    """A filename derived from the report code, never from user input.

    The uploaded name is used only for its extension, and even that is checked
    against an allow-list. Accepting a user-supplied path here is how directory
    traversal happens.
    """
    suffix = Path(original or "").suffix.lower()
    if suffix not in ALLOWED_IMAGE_SUFFIXES:
        suffix = ".jpg"
    slug = re.sub(r"[^A-Za-z0-9_-]", "", code) or "report"
    return f"{slug}{suffix}"


def save_image(content: bytes, original_name: str, code: str) -> Path | None:
    """Write an uploaded photograph to the uploads directory."""
    if not content:
        return None
    limit = int(settings.max_upload_mb * 1024 * 1024)
    if len(content) > limit:
        raise ValueError(f"image exceeds the {settings.max_upload_mb:g} MB limit")

    directory = settings.resolved_upload_dir
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / _safe_name(original_name, code)
    target.write_bytes(content)
    return target


def create(
    db: Session,
    payload: Mapping[str, Any],
    *,
    image_bytes: bytes | None = None,
    image_name: str | None = None,
    user: User | None = None,
) -> CitizenReport:
    """Store a report, screen its photograph, and place it in the queue."""
    latitude = float(payload["latitude"])
    longitude = float(payload["longitude"])

    region_id = payload.get("region_id")
    if region_id is None:
        region, _ = nearest_region(db, latitude, longitude)
        region_id = region.id if region else None

    report = CitizenReport(
        report_code=uuid4().hex,
        region_id=region_id,
        reporter_name=(payload.get("reporter_name") or None),
        reporter_phone=(payload.get("reporter_phone") or None),
        user_id=user.id if user is not None else None,
        location_text=str(payload["location_text"]).strip(),
        latitude=latitude,
        longitude=longitude,
        observation_type=str(payload["observation_type"]).upper(),
        severity=str(payload["severity"]).upper(),
        description=str(payload["description"]).strip(),
        observed_on=payload.get("observed_on") or date.today(),
        status="NEW",
    )
    db.add(report)
    db.flush()

    # The insert comes first so the code can be the primary key, and so a failed
    # insert cannot leave an orphan photograph on disk. The placeholder above is a
    # uuid only because the column is NOT NULL UNIQUE and something has to occupy
    # it for the length of one flush.
    report.report_code = _report_code(report.id)

    if image_bytes:
        image_path = save_image(image_bytes, image_name or "", report.report_code)
        if image_path is not None:
            report.image_path = str(image_path)
            report.image_analysis = image_analysis.analyse(image_path)
    db.flush()

    LOG.info(
        "citizen report %s filed for region %s (%s)",
        report.report_code, region_id, report.observation_type,
    )
    return report


def listing(
    db: Session,
    *,
    status: str | None = None,
    region_id: int | None = None,
    severity: str | None = None,
    limit: int = 200,
) -> list[CitizenReport]:
    stmt = (
        select(CitizenReport)
        .options(selectinload(CitizenReport.region))
        .order_by(CitizenReport.created_at.desc())
        .limit(max(1, min(limit, 1000)))
    )
    if status:
        stmt = stmt.where(CitizenReport.status == status.upper())
    if region_id:
        stmt = stmt.where(CitizenReport.region_id == region_id)
    if severity:
        stmt = stmt.where(CitizenReport.severity == severity.upper())
    return list(db.scalars(stmt).all())


_ALLOWED_STATUS = {"NEW", "UNDER REVIEW", "VERIFIED", "DISMISSED"}


def set_status(
    report: CitizenReport, status: str, *, actor: str | None = None, note: str | None = None
) -> CitizenReport:
    """Move a report through triage and record the officer's note.

    The note is appended to ``officer_note``, never to ``description``. That
    separation is the point: ``description`` is the citizen's own account of
    what they saw, and a review process that edits the evidence it is
    reviewing leaves nobody able to tell the observation from the
    interpretation. Officer notes accumulate with a timestamp and a name, so
    the sequence of decisions is legible too.
    """
    target = status.upper()
    if target not in _ALLOWED_STATUS:
        raise ValueError(f"unknown status {status!r}")
    report.status = target
    if note:
        stamp = utcnow().strftime("%Y-%m-%d %H:%M UTC")
        who = f" by {actor}" if actor else ""
        entry = f"[{stamp}{who}] {note.strip()}"
        report.officer_note = (
            f"{report.officer_note} | {entry}" if report.officer_note else entry
        )
    return report


def stats(db: Session) -> dict[str, int]:
    rows = db.execute(
        select(CitizenReport.status, func.count(CitizenReport.id)).group_by(
            CitizenReport.status
        )
    ).all()
    out = {"total": 0, "new": 0, "under_review": 0, "verified": 0, "dismissed": 0}
    key = {
        "NEW": "new", "UNDER REVIEW": "under_review",
        "VERIFIED": "verified", "DISMISSED": "dismissed",
    }
    for status, count in rows:
        out["total"] += count
        out[key[status]] += count
    return out


def to_dict(report: CitizenReport) -> dict[str, Any]:
    analysis = report.image_analysis or None
    if analysis:
        # `measurements` and `alternatives` are diagnostic detail; the API
        # returns the officer-facing summary.
        analysis = {
            "category": analysis.get("category"),
            "category_label": analysis.get("category_label"),
            "confidence": analysis.get("confidence"),
            "features": analysis.get("features") or [],
            "recommendation": analysis.get("recommendation"),
            "method": analysis.get("method"),
            "disclaimer": analysis.get("disclaimer"),
        }
    return {
        "id": report.id,
        "report_code": report.report_code,
        "region_id": report.region_id,
        "region_name": report.region.name if report.region else None,
        "reporter_name": report.reporter_name,
        "location_text": report.location_text,
        "latitude": report.latitude,
        "longitude": report.longitude,
        "observation_type": report.observation_type,
        "severity": report.severity,
        "description": report.description,
        # Written once, at insert, and never touched again. Officer notes live in
        # their own column so triage cannot rewrite the citizen's account.
        "officer_note": report.officer_note,
        "has_image": bool(report.image_path),
        # Served from the /uploads mount by basename only. The stored value is an
        # absolute filesystem path and must never be handed to a browser - what
        # goes out is the filename, which was itself derived from the report code
        # rather than from anything the uploader chose.
        "image_url": (
            f"/uploads/{Path(report.image_path).name}" if report.image_path else None
        ),
        "image_analysis": analysis,
        "observed_on": report.observed_on,
        "status": report.status,
        "created_at": report.created_at,
    }


def many_to_dict(reports: Iterable[CitizenReport]) -> list[dict[str, Any]]:
    return [to_dict(r) for r in reports]


__all__ = [
    "ALLOWED_IMAGE_SUFFIXES",
    "MAX_SNAP_KM",
    "create",
    "listing",
    "many_to_dict",
    "nearest_region",
    "save_image",
    "set_status",
    "stats",
    "to_dict",
]
