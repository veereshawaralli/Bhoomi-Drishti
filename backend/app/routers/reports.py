"""Citizen reports and photograph screening.

Filing is open. A person who has just seen a crack open across a road should
not have to create an account before they can say so - the report is worth
more than the friction is worth saving. Reading and triaging the queue needs
the OFFICER role, because that is where the reports turn into decisions.

The photograph screening is a transparent heuristic, not a trained network,
and every response says so. It exists to help an officer sort a queue of
fifty photographs, not to decide anything on its own.
"""
from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status as http,
)
from pydantic import ValidationError

from ..config import settings
from ..models import CitizenReport
from ..schemas import CitizenReportIn, ReportStatusUpdate
from ..security import Principal, current_principal, require_officer
from ..services import image_analysis, report_service
from .deps import DbSession

LOG = logging.getLogger("app.api.reports")

router = APIRouter(tags=["citizen reports"])

_MAX_IMAGE_NOTE = (
    "Attach a photograph if you have one - it is the single most useful thing "
    "you can add to a report."
)

# 256 KB at a time: small enough that an oversized body is refused early, large
# enough that a normal phone photograph is two or three reads.
_CHUNK_BYTES = 256 * 1024


async def _read_upload(image: UploadFile | None) -> tuple[bytes | None, str | None]:
    """Pull an upload into memory, refusing it as soon as it exceeds the limit.

    Read in chunks rather than with a single `await image.read()`. The one-shot read
    is shorter but it buffers the whole body before anything can object, so a
    multi-gigabyte POST costs the server that memory and only then earns its `413`.
    Streaming means the limit is enforced on the way in: the moment the running
    total passes `MAX_UPLOAD_MB` the rest of the body is never held.
    """
    if image is None or not image.filename:
        return None, None

    limit = int(settings.max_upload_mb * 1024 * 1024)
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await image.read(_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            await image.close()
            raise HTTPException(
                status_code=http.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Image is larger than the {settings.max_upload_mb:.0f} MB limit.",
            )
        chunks.append(chunk)
    await image.close()

    content = b"".join(chunks)
    if not content:
        return None, None
    return content, image.filename


@router.post(
    "/citizen-report",
    status_code=http.HTTP_201_CREATED,
    summary="File a report (open to everyone)",
)
async def submit_report(
    db: DbSession,
    principal: Annotated[Principal, Depends(current_principal)],
    location_text: Annotated[str, Form(min_length=4, max_length=200)],
    latitude: Annotated[float, Form(ge=-90, le=90)],
    longitude: Annotated[float, Form(ge=-180, le=180)],
    observation_type: Annotated[str, Form()],
    severity: Annotated[str, Form()],
    description: Annotated[str, Form(min_length=10, max_length=3000)],
    reporter_name: Annotated[str | None, Form(max_length=128)] = None,
    reporter_phone: Annotated[str | None, Form(max_length=24)] = None,
    observed_on: Annotated[str | None, Form()] = None,
    region_id: Annotated[int | None, Form()] = None,
    image: Annotated[UploadFile | None, File()] = None,
) -> dict[str, Any]:
    """Store a report, screen any photograph, and place it in the queue.

    Multipart rather than JSON because a photograph is part of the report, not
    a follow-up step. The text fields are validated through the same Pydantic
    model the JSON endpoint would use, so a form submission cannot slip past
    the constraints that a JSON body is held to.

    The report is snapped to the nearest monitored region within 60 km so it
    lands in the right officer's queue and appears on the map. If it is further
    out than that it is still stored, with no region - an unmatched report is
    better than a discarded one.
    """
    raw: dict[str, Any] = {
        "location_text": location_text,
        "latitude": latitude,
        "longitude": longitude,
        "observation_type": (observation_type or "").strip().upper(),
        "severity": (severity or "").strip().upper(),
        "description": description,
        "reporter_name": reporter_name or None,
        "reporter_phone": reporter_phone or None,
        "observed_on": observed_on or None,
        "region_id": region_id,
    }
    try:
        payload = CitizenReportIn.model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(
            status_code=http.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.errors()
        ) from exc

    content, filename = await _read_upload(image)

    try:
        report = report_service.create(
            db,
            payload.model_dump(),
            image_bytes=content,
            image_name=filename,
            user=None,
        )
    except ValueError as exc:  # oversized image
        raise HTTPException(
            status_code=http.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(exc)
        ) from exc

    db.commit()
    db.refresh(report)

    matched = report.region_id is not None
    LOG.info(
        "report %s filed by %s (region=%s, image=%s)",
        report.report_code,
        principal.username if principal.is_authenticated else "anonymous",
        report.region_id,
        bool(content),
    )
    return {
        **report_service.to_dict(report),
        "acknowledgement": (
            f"Report {report.report_code} received. It is now in the officer "
            "queue for review."
            if matched
            else f"Report {report.report_code} received. It is outside every "
            "monitored region, so it has been queued for manual routing."
        ),
    }


@router.get("/citizen-report", summary="The report queue (officer)")
def list_reports(
    db: DbSession,
    principal: Annotated[Principal, Depends(require_officer)],
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    region_id: Annotated[int | None, Query()] = None,
    severity: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> dict[str, Any]:
    """Everything the officer dashboard shows in its reports panel."""
    reports = report_service.listing(
        db, status=status_filter, region_id=region_id, severity=severity, limit=limit
    )
    return {
        "count": len(reports),
        "reports": report_service.many_to_dict(reports),
        "stats": report_service.stats(db),
    }


@router.put("/citizen-report/{report_id}", summary="Triage a report (officer)")
def triage_report(
    report_id: int,
    payload: ReportStatusUpdate,
    db: DbSession,
    principal: Annotated[Principal, Depends(require_officer)],
) -> dict[str, Any]:
    """Move a report to UNDER REVIEW, VERIFIED or DISMISSED.

    The officer's note is appended to the report's ``officer_note`` trail with a
    timestamp and their name. It is a separate column from ``description`` on
    purpose: the citizen's original words are the evidence, and nothing in this
    application rewrites them after the report is filed.
    """
    report = db.get(CitizenReport, report_id)
    if report is None:
        raise HTTPException(
            status_code=http.HTTP_404_NOT_FOUND,
            detail=f"No report with id {report_id}.",
        )
    try:
        report_service.set_status(
            report, payload.status, actor=principal.username, note=payload.note
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=http.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    db.commit()
    db.refresh(report)
    LOG.info(
        "report %s -> %s by %s", report.report_code, report.status, principal.username
    )
    return report_service.to_dict(report)


@router.post("/image-analysis", summary="Screen a photograph")
async def analyse_image(image: Annotated[UploadFile, File()]) -> dict[str, Any]:
    """Categorise a terrain photograph and say why.

    Returns one of five categories, a confidence, the measurements behind the
    verdict in plain language, and a recommendation. Confidence is capped at
    80% by construction, because a colour-and-texture heuristic should never
    present itself as certain about a hillside.

    This is decision support. It does not replace professional geotechnical
    assessment, and the disclaimer travels with every response so that stays
    true wherever the result is displayed.
    """
    content, _ = await _read_upload(image)
    if not content:
        raise HTTPException(
            status_code=http.HTTP_400_BAD_REQUEST,
            detail="No image received.",
        )

    try:
        result = image_analysis.analyse_bytes(content)
    except ValueError as exc:
        raise HTTPException(
            status_code=http.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=str(exc)
        ) from exc

    LOG.info(
        "image screened: %s at %.0f%%",
        result.get("category"),
        # Already a percentage, capped at 80 by `image_analysis.analyse`.
        float(result.get("confidence") or 0.0),
    )
    return result


@router.get("/citizen-report/options", summary="Form options for the portal")
def report_options() -> dict[str, Any]:
    """What the report form offers, served from one place.

    The portal reads its dropdowns from here rather than hardcoding them, so
    the form and the validator can never drift apart.
    """
    return {
        "observation_types": [
            {"value": "GROUND CRACK", "label": "Ground crack",
             "hint": "A crack opening in soil or rock on a slope"},
            {"value": "ROAD CRACK", "label": "Road crack",
             "hint": "Cracking, subsidence or bulging in a road surface"},
            {"value": "ROCKFALL", "label": "Rockfall",
             "hint": "Loose rock or boulders that have come down"},
            {"value": "SOIL MOVEMENT", "label": "Soil movement",
             "hint": "Slumping, creep, or soil that has visibly shifted"},
            {"value": "POSSIBLE LANDSLIDE", "label": "Possible landslide",
             "hint": "A slope failure that has already happened"},
            {"value": "OTHER", "label": "Something else",
             "hint": "Anything else that looks wrong on a slope"},
        ],
        "severities": [
            {"value": "LOW", "label": "Low - worth recording"},
            {"value": "MEDIUM", "label": "Medium - getting worse"},
            {"value": "HIGH", "label": "High - people or road at risk now"},
        ],
        "statuses": ["NEW", "UNDER REVIEW", "VERIFIED", "DISMISSED"],
        "image_note": _MAX_IMAGE_NOTE,
        "accepted_image_types": sorted(report_service.ALLOWED_IMAGE_SUFFIXES),
        "snap_radius_km": report_service.MAX_SNAP_KM,
        "screening_disclaimer": image_analysis.DISCLAIMER,
    }
