"""Time helpers.

Every timestamp the platform stores or returns is UTC. This module exists
because of one sharp edge: SQLite has no timezone-aware datetime type, so a
value written as aware comes back naive, and comparing the two raises
``TypeError`` at run time. ``as_utc`` normalises anything read from the
database before it is compared or serialised, which keeps the same code
working on SQLite and PostgreSQL.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

UTC = timezone.utc


def utcnow() -> datetime:
    """Current time, timezone-aware, UTC."""
    return datetime.now(UTC)


def as_utc(value: datetime | None) -> datetime | None:
    """Attach UTC to a naive datetime (SQLite), convert an aware one."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def iso(value: datetime | date | None) -> str | None:
    """ISO-8601 string, or None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return (as_utc(value) or value).isoformat()
    return value.isoformat()


def floor_hour(value: datetime) -> datetime:
    """Truncate to the top of the hour.

    DEMO weather is deterministic per region and per hour, so flooring here is
    what makes two dashboard loads a few seconds apart agree with each other.
    """
    return (as_utc(value) or value).replace(minute=0, second=0, microsecond=0)


def hours_since_epoch(value: datetime) -> int:
    """Whole hours since the Unix epoch - a stable seed component."""
    return int((as_utc(value) or value).timestamp() // 3600)


def day_of_year(value: datetime | date) -> int:
    return value.timetuple().tm_yday


def plus_hours(value: datetime, hours: float) -> datetime:
    return (as_utc(value) or value) + timedelta(hours=hours)


def age_minutes(value: datetime | None, *, now: datetime | None = None) -> float:
    """Minutes elapsed since `value`; +inf when it is missing."""
    stamp = as_utc(value)
    if stamp is None:
        return float("inf")
    return ((now or utcnow()) - stamp).total_seconds() / 60.0
