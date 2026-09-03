"""The early-warning engine and the response workflow behind it.

The rule the specification sets
-------------------------------
Below 60 no major alert is raised. 60-80 raises a HIGH alert. Above 80 raises
a CRITICAL one. Every alert carries the location, the score, the factors that
drove it and a recommended action, then moves through
NEW -> ACKNOWLEDGED -> IN PROGRESS -> RESOLVED as an officer works it.

Why alerts are de-duplicated
----------------------------
A dashboard polling every sixty seconds would raise sixty alerts an hour for a
district that is simply still dangerous, and an officer facing a wall of
identical rows stops reading them. So an open alert for a region is updated in
place while conditions persist. A *new* alert is raised only when something
changed that an officer needs to see: the severity escalated from HIGH to
CRITICAL, the score moved by more than eight points, or the previous alert was
resolved and the danger has returned.

Escalation is never silent - a HIGH alert that becomes CRITICAL is resolved
and superseded by a new CRITICAL row, so the audit trail shows both.

Recommended actions
-------------------
Written from the standard NDMA / district-administration response ladder and
tailored by the dominant driver, so "restrict traffic on the ghat road" appears
when rainfall is the driver and "inspect the cut slope" when the driver is
terrain. They are decision support, not orders: the officer decides.
"""
from __future__ import annotations

import logging
from typing import Any, Iterable, Mapping, Sequence
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..clock import utcnow
from ..config import settings
from ..models import Alert, Region, RiskPrediction
from . import risk_engine
from . import scenario as scenario_module

LOG = logging.getLogger("app.alerts")

OPEN_STATUSES = ("NEW", "ACKNOWLEDGED", "IN PROGRESS")

# A new alert is raised rather than an existing one updated when the score has
# moved by more than this. Below it, conditions are "the same emergency".
RESCORE_DELTA = 8.0


# ------------------------------------------------------------------ wording

def _cause(payload: Mapping[str, Any]) -> str:
    """Why this alert exists, in one sentence, from the model's own factors."""
    factors = payload.get("top_factors") or []
    score = float(payload["risk_score"])
    level = payload["risk_level"]
    if not factors:
        return (
            f"Model risk score {score:.0f}/100 ({level}) for {payload.get('region_name')}."
        )
    named = ", ".join(
        f"{f['label'].lower()} ({f['share_percent']:.0f}%)" for f in factors[:3]
    )
    lead = factors[0].get("evidence")
    sentence = (
        f"Risk {score:.0f}/100 ({level}) driven by {named}."
    )
    return f"{sentence} Observed: {lead}." if lead else sentence


def _dominant(payload: Mapping[str, Any]) -> str:
    factors = payload.get("top_factors") or []
    return str(factors[0]["label"]) if factors else "Heavy rainfall"


_ACTION_BY_DRIVER = {
    "Heavy rainfall": (
        "Restrict traffic on hill roads and ghat sections in the region. Position "
        "clearing equipment at known slip points."
    ),
    "Antecedent rainfall": (
        "Treat the ground as already saturated - assume a short burst of rain can "
        "trigger movement. Check drainage on cut slopes above habitation."
    ),
    "Soil moisture": (
        "Inspect drainage, seepage points and any new springs on slopes above "
        "settlements; saturated ground fails with little further rain."
    ),
    "Slope steepness": (
        "Prioritise inspection of steep cut slopes above roads and habitation, "
        "including retaining structures."
    ),
    "Historical activity": (
        "Re-inspect previously affected slopes in this region first - repeat "
        "failure at known sites is the most common pattern."
    ),
    "Soil and land cover": (
        "Inspect plantation and cleared slopes where root reinforcement is weak, "
        "especially above roads and dwellings."
    ),
    "Terrain relief": (
        "Check upper catchment slopes and stream banks for scour and undercutting."
    ),
    "Weather conditions": (
        "Maintain close weather watch and review the position again at the next "
        "forecast update."
    ),
}

_ACTION_BY_SEVERITY = {
    "HIGH": (
        "HIGH ALERT: alert the district control room, warn residents of slopes and "
        "low-lying areas below them, and keep response teams on standby."
    ),
    "CRITICAL": (
        "CRITICAL ALERT: initiate evacuation of households directly below unstable "
        "slopes, close affected roads, activate the district emergency operations "
        "centre and inform the SDRF/NDRF unit."
    ),
}


def recommended_action(payload: Mapping[str, Any], severity: str) -> str:
    driver = _dominant(payload)
    return (
        f"{_ACTION_BY_SEVERITY[severity]} {_ACTION_BY_DRIVER.get(driver, '')} "
        "This is decision support from a model; the final decision rests with the "
        "district administration."
    ).strip()


def severity_for(score: float) -> str | None:
    """HIGH, CRITICAL, or None when the score is below the alerting threshold."""
    if score >= settings.alert_critical_threshold:
        return "CRITICAL"
    if score >= settings.alert_high_threshold:
        return "HIGH"
    return None


def _alert_code(region: Region, alert_id: int) -> str:
    """Human-readable, sortable, unique: ``ALT-2026-WYD-0007``.

    The number is the alert's own primary key rather than a per-region
    ``COUNT(*) + 1``. The count reads well but collides: a sweep that raises two
    alerts for the same region inside one transaction, or two officers raising one
    at the same moment, both compute the same code and the second insert fails on
    the unique index. The key is unique by construction, so the code is stamped
    after the insert.
    """
    suffix = "".join(ch for ch in region.code if ch.isalnum())[-6:].upper()
    return f"ALT-{utcnow().year}-{suffix}-{alert_id:04d}"


# ------------------------------------------------------------------ queries

def open_alert_for(db: Session, region_id: int) -> Alert | None:
    return db.scalars(
        select(Alert)
        .where(Alert.region_id == region_id, Alert.status.in_(OPEN_STATUSES))
        .order_by(Alert.created_at.desc())
        .limit(1)
    ).first()


def listing(
    db: Session,
    *,
    status: str | None = None,
    severity: str | None = None,
    region_id: int | None = None,
    limit: int = 200,
) -> list[Alert]:
    stmt = (
        select(Alert)
        .options(selectinload(Alert.region))
        .order_by(Alert.created_at.desc())
        .limit(max(1, min(limit, 1000)))
    )
    if status:
        stmt = stmt.where(Alert.status == status.upper())
    if severity:
        stmt = stmt.where(Alert.severity == severity.upper())
    if region_id:
        stmt = stmt.where(Alert.region_id == region_id)
    return list(db.scalars(stmt).all())


def stats(db: Session) -> dict[str, int]:
    rows = db.execute(
        select(Alert.status, Alert.severity, func.count(Alert.id)).group_by(
            Alert.status, Alert.severity
        )
    ).all()
    out = {
        "total": 0, "new": 0, "acknowledged": 0, "in_progress": 0,
        "resolved": 0, "high": 0, "critical": 0,
    }
    key = {
        "NEW": "new", "ACKNOWLEDGED": "acknowledged",
        "IN PROGRESS": "in_progress", "RESOLVED": "resolved",
    }
    for status, severity, count in rows:
        out["total"] += count
        out[key[status]] += count
        if status != "RESOLVED":
            out["high" if severity == "HIGH" else "critical"] += count
    return out


# ------------------------------------------------------------- evaluation

def evaluate(
    db: Session,
    region: Region,
    payload: Mapping[str, Any],
    *,
    prediction: RiskPrediction | None = None,
) -> Alert | None:
    """Apply the warning rule to one scored region.

    Returns the alert that is now current for the region, or None when the
    score is below the threshold and nothing was raised.
    """
    score = float(payload["risk_score"])
    severity = severity_for(score)
    existing = open_alert_for(db, region.id)

    if severity is None:
        # Conditions have eased. Close the open alert rather than leaving a
        # stale warning on the officer's screen, and record why it closed.
        if existing is not None:
            existing.status = "RESOLVED"
            existing.resolved_at = utcnow()
            existing.note = (
                (existing.note + " | " if existing.note else "")
                + f"Auto-resolved: risk fell to {score:.0f}/100 "
                f"({payload['risk_level']})."
            )
            db.flush()
            LOG.info("alert %s auto-resolved (score %.0f)", existing.alert_code, score)
        return None

    cause = _cause(payload)
    action = recommended_action(payload, severity)

    if existing is not None:
        escalated = existing.severity == "HIGH" and severity == "CRITICAL"
        moved = abs(float(existing.risk_score) - score) > RESCORE_DELTA
        if not escalated and not moved:
            # Same emergency, refreshed. Update in place so the officer's
            # acknowledgement and assignment survive.
            existing.risk_score = score
            existing.cause = cause
            existing.recommended_action = action
            existing.updated_at = utcnow()
            db.flush()
            return existing
        # Something an officer needs to see changed - supersede the old row so
        # both appear in the audit trail.
        existing.status = "RESOLVED"
        existing.resolved_at = utcnow()
        existing.note = (
            (existing.note + " | " if existing.note else "")
            + f"Superseded: risk moved to {score:.0f}/100 ({severity})."
        )
        db.flush()

    alert = Alert(
        alert_code=uuid4().hex,
        region_id=region.id,
        prediction_id=prediction.id if prediction is not None else None,
        severity=severity,
        risk_score=score,
        status="NEW",
        cause=cause,
        recommended_action=action,
        scenario=str(payload.get("scenario", "NORMAL")),
        data_mode=str(payload.get("data_mode", "DEMO")),
    )
    db.add(alert)
    db.flush()
    alert.alert_code = _alert_code(region, alert.id)
    db.flush()
    LOG.info(
        "%s alert %s raised for %s at %.0f/100",
        severity, alert.alert_code, region.name, score,
    )
    return alert


def evaluate_many(
    db: Session,
    regions: Sequence[Region],
    payloads: Sequence[Mapping[str, Any]],
    *,
    predictions: Mapping[int, RiskPrediction] | None = None,
) -> list[Alert]:
    """Run the warning rule across a scored set - the map-refresh path."""
    by_id = {r.id: r for r in regions}
    raised: list[Alert] = []
    for payload in payloads:
        region = by_id.get(int(payload["region_id"]))
        if region is None:
            continue
        alert = evaluate(
            db,
            region,
            payload,
            prediction=(predictions or {}).get(region.id),
        )
        if alert is not None and alert.status == "NEW":
            raised.append(alert)
    return raised


def sweep(db: Session, *, scenario_key: str | None = None) -> dict[str, Any]:
    """Score every region, store what changed, and raise or clear alerts.

    This is what the demo's SIMULATE EXTREME RAINFALL button ultimately calls,
    and what a scheduled job would call every few minutes in production.
    """
    scn = scenario_module.get(scenario_key)
    regions = risk_engine.regions_query(db)
    payloads = risk_engine.score_regions(regions, scenario_key=scn.key)

    stored = 0
    records: dict[int, RiskPrediction] = {}
    for payload in payloads:
        record, created = risk_engine.persist(db, payload)
        if record is not None:
            records[int(payload["region_id"])] = record
        stored += int(created)
    db.flush()

    raised = evaluate_many(db, regions, payloads, predictions=records)
    summary = risk_engine.summarise(payloads)
    return {
        "scenario": scn.key,
        "data_mode": scn.data_mode,
        "regions_scored": len(payloads),
        "predictions_stored": stored,
        "alerts_raised": len(raised),
        "alerts": raised,
        **summary,
    }


# -------------------------------------------------------------- workflow

_ALLOWED_TRANSITIONS = {
    "NEW": {"NEW", "ACKNOWLEDGED", "IN PROGRESS", "RESOLVED"},
    "ACKNOWLEDGED": {"IN PROGRESS", "RESOLVED", "ACKNOWLEDGED"},
    "IN PROGRESS": {"RESOLVED", "IN PROGRESS", "ACKNOWLEDGED"},
    "RESOLVED": {"IN PROGRESS", "RESOLVED"},
}


def transition(
    alert: Alert,
    status: str,
    *,
    actor: str | None = None,
    assigned_to: str | None = None,
    note: str | None = None,
) -> Alert:
    """Move an alert through the response workflow.

    Raises ``ValueError`` on an illegal transition so the router can return 409
    rather than silently accepting an impossible state change.
    """
    target = status.upper()
    if target not in _ALLOWED_TRANSITIONS:
        raise ValueError(f"unknown status {status!r}")
    if target not in _ALLOWED_TRANSITIONS[alert.status]:
        raise ValueError(f"cannot move an alert from {alert.status} to {target}")

    now = utcnow()
    alert.status = target
    alert.updated_at = now
    if target == "ACKNOWLEDGED" and alert.acknowledged_at is None:
        alert.acknowledged_at = now
    if target == "IN PROGRESS" and alert.acknowledged_at is None:
        alert.acknowledged_at = now
    if target == "RESOLVED":
        alert.resolved_at = now
    elif alert.resolved_at is not None:
        alert.resolved_at = None  # reopened

    if assigned_to is not None:
        alert.assigned_to = assigned_to.strip() or None
    if note:
        stamp = now.strftime("%Y-%m-%d %H:%M UTC")
        who = f" by {actor}" if actor else ""
        entry = f"[{stamp}{who}] {note.strip()}"
        alert.note = f"{alert.note} | {entry}" if alert.note else entry
    return alert


def create_manual(
    db: Session,
    region: Region,
    *,
    severity: str,
    risk_score: float,
    cause: str,
    recommended_action: str,
    scenario: str = "MANUAL",
    actor: str | None = None,
) -> Alert:
    """An officer raising a warning from a field observation.

    Marked ``data_mode='LIVE'`` because it records a human observation, not a
    model output - and tagged with who raised it.
    """
    alert = Alert(
        alert_code=uuid4().hex,
        region_id=region.id,
        severity=severity.upper(),
        risk_score=float(risk_score),
        status="NEW",
        cause=cause,
        recommended_action=recommended_action,
        scenario=scenario,
        data_mode="LIVE",
        note=f"Raised manually by {actor}" if actor else "Raised manually",
    )
    db.add(alert)
    db.flush()
    alert.alert_code = _alert_code(region, alert.id)
    db.flush()
    return alert


def recent_for_region(db: Session, region_id: int, limit: int = 5) -> list[Alert]:
    return list(
        db.scalars(
            select(Alert)
            .where(Alert.region_id == region_id)
            .order_by(Alert.created_at.desc())
            .limit(limit)
        ).all()
    )


def to_dict(alert: Alert) -> dict[str, Any]:
    """Alert row plus the region names the UI needs, ready for AlertOut."""
    return {
        "id": alert.id,
        "alert_code": alert.alert_code,
        "region_id": alert.region_id,
        "region_name": alert.region.name if alert.region else None,
        "region_code": alert.region.code if alert.region else None,
        "severity": alert.severity,
        "risk_score": alert.risk_score,
        "status": alert.status,
        "cause": alert.cause,
        "recommended_action": alert.recommended_action,
        "scenario": alert.scenario,
        "data_mode": alert.data_mode,
        "assigned_to": alert.assigned_to,
        "note": alert.note,
        "created_at": alert.created_at,
        "updated_at": alert.updated_at,
        "acknowledged_at": alert.acknowledged_at,
        "resolved_at": alert.resolved_at,
    }


def many_to_dict(alerts: Iterable[Alert]) -> list[dict[str, Any]]:
    return [to_dict(a) for a in alerts]


__all__ = [
    "OPEN_STATUSES",
    "create_manual",
    "evaluate",
    "evaluate_many",
    "listing",
    "many_to_dict",
    "open_alert_for",
    "recent_for_region",
    "recommended_action",
    "severity_for",
    "stats",
    "sweep",
    "to_dict",
    "transition",
]
