"""Alerts: the warning list and the response workflow.

Reading alerts is public - a warning nobody can see is not a warning. Changing
one requires the OFFICER role, because acknowledging or resolving an alert is
an operational act with a name attached to it.

The status machine lives in ``alert_service.transition`` and rejects illegal
moves by raising ``ValueError``; this router turns that into a 409 so a client
that tries to resolve an already-resolved alert gets a clear answer instead of
a silent no-op.
"""
from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status as http

from ..config import settings
from ..models import Alert
from ..schemas import AlertUpdate, ManualAlertIn
from ..security import Principal, current_principal, require_officer
from ..services import alert_service
from ..services import scenario as scenario_module
from .deps import DbSession, ScenarioKey, resolve_region

LOG = logging.getLogger("app.api.alerts")

router = APIRouter(tags=["alerts"])


@router.get("/alerts", summary="Alert list with counts")
def list_alerts(
    db: DbSession,
    status_filter: Annotated[
        str | None, Query(alias="status", description="NEW, ACKNOWLEDGED, ...")
    ] = None,
    severity: Annotated[str | None, Query(description="HIGH or CRITICAL")] = None,
    region_id: Annotated[int | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> dict[str, Any]:
    """Every alert, newest first, with the counts the dashboard badges use."""
    alerts = alert_service.listing(
        db, status=status_filter, severity=severity, region_id=region_id, limit=limit
    )
    counts = alert_service.stats(db)
    return {
        "count": len(alerts),
        "alerts": alert_service.many_to_dict(alerts),
        "stats": counts,
        "thresholds": {
            "high": settings.alert_high_threshold,
            "critical": settings.alert_critical_threshold,
        },
    }


@router.post(
    "/alerts",
    status_code=http.HTTP_201_CREATED,
    summary="Raise an alert manually (officer)",
)
def create_alert(
    payload: ManualAlertIn,
    db: DbSession,
    principal: Annotated[Principal, Depends(require_officer)],
) -> dict[str, Any]:
    """An officer raising a warning from something seen in the field.

    Recorded as LIVE data because it is a human observation, and tagged with
    who raised it - the audit trail matters more here than anywhere else in
    the platform.
    """
    region = resolve_region(db, payload.region_id)
    alert = alert_service.create_manual(
        db,
        region,
        severity=payload.severity,
        risk_score=payload.risk_score,
        cause=payload.cause,
        recommended_action=payload.recommended_action,
        scenario=payload.scenario,
        actor=principal.username,
    )
    db.commit()
    db.refresh(alert)
    LOG.info("alert %s raised manually by %s", alert.alert_code, principal.username)
    return alert_service.to_dict(alert)


@router.put("/alerts/{alert_id}", summary="Acknowledge, assign or resolve (officer)")
def update_alert(
    alert_id: int,
    payload: AlertUpdate,
    db: DbSession,
    principal: Annotated[Principal, Depends(require_officer)],
) -> dict[str, Any]:
    """Move an alert through NEW -> ACKNOWLEDGED -> IN PROGRESS -> RESOLVED.

    Illegal transitions return 409 with the reason. Every change is stamped
    with the officer's name and appended to the alert's note, so the record
    shows who did what and when.
    """
    alert = db.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(
            status_code=http.HTTP_404_NOT_FOUND,
            detail=f"No alert with id {alert_id}.",
        )
    try:
        alert_service.transition(
            alert,
            payload.status,
            actor=principal.username,
            assigned_to=payload.assigned_to,
            note=payload.note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=http.HTTP_409_CONFLICT, detail=str(exc)) from exc

    db.commit()
    db.refresh(alert)
    LOG.info(
        "alert %s -> %s by %s", alert.alert_code, alert.status, principal.username
    )
    return alert_service.to_dict(alert)


@router.post("/alerts/sweep", summary="Re-score everything and update alerts")
def sweep(
    db: DbSession,
    scenario: ScenarioKey,
    principal: Annotated[Principal, Depends(current_principal)],
) -> dict[str, Any]:
    """Score every region, store what changed, raise and clear alerts.

    This is the engine behind the demo's extreme-rainfall button and what a
    scheduled job would call every few minutes in production. Left open to
    anonymous callers because it changes no human-entered data - it only makes
    the platform's own view of the world current.
    """
    scn = scenario_module.get(scenario)
    result = alert_service.sweep(db, scenario_key=scn.key)
    db.commit()
    raised = result.pop("alerts", [])
    result["alerts"] = alert_service.many_to_dict(raised)
    result["scenario_label"] = scn.label
    LOG.info(
        "sweep under %s: %d regions, %d stored, %d alerts raised",
        scn.key, result["regions_scored"], result["predictions_stored"],
        result["alerts_raised"],
    )
    return result
