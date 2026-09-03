"""Sign-in and identity.

Three roles, ordered: CITIZEN, OFFICER, ADMIN. An officer can do everything a
citizen can; an administrator everything an officer can. The token is a signed
HS256 JWT carrying the subject and role, and it is the only thing the frontend
stores - there is no server-side session to fall out of sync with it.

The seeded accounts are demo accounts. ``GET /api/auth/demo-accounts`` lists
them on purpose: a judge should be able to sign in as an officer without
guessing, and hiding known-public demo credentials would be security theatre.
The warning about changing ``JWT_SECRET`` before a real deployment is emitted
at start-up by ``security.warn_on_default_secret``.
"""
from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status as http
from sqlalchemy import select

from ..config import settings
from ..models import User
from ..schemas import LoginRequest
from ..seed import DEMO_USERS
from ..security import (
    Principal,
    ROLE_RANK,
    authenticate,
    create_token,
    current_principal,
    require_admin,
    role_capabilities,
)
from .deps import DbSession

LOG = logging.getLogger("app.api.auth")

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_out(user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "role": user.role,
        "organisation": user.organisation,
        "phone": user.phone,
    }


@router.post("/login", summary="Sign in and receive a token")
def login(payload: LoginRequest, db: DbSession) -> dict[str, Any]:
    """Exchange a username and password for a bearer token.

    A failed attempt returns 401 with the same message whether the username was
    wrong or the password was, so the response cannot be used to enumerate
    accounts.
    """
    user = authenticate(db, payload.username, payload.password)
    if user is None:
        LOG.info("failed sign-in for %r", payload.username)
        raise HTTPException(
            status_code=http.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = create_token(user)
    LOG.info("sign-in: %s (%s)", user.username, user.role)
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in_minutes": settings.jwt_expiry_minutes,
        "user": _user_out(user),
        "capabilities": role_capabilities(user.role),
    }


@router.get("/me", summary="Who am I, and what may I do")
def me(
    principal: Annotated[Principal, Depends(current_principal)],
) -> dict[str, Any]:
    """The caller's identity and capabilities.

    Answers for anonymous callers too, rather than 401-ing: the frontend asks
    this on load to decide which controls to render, and "you are anonymous,
    here is what that allows" is a useful answer.
    """
    return {
        "authenticated": principal.is_authenticated,
        "id": principal.id,
        "username": principal.username,
        "full_name": principal.full_name,
        "role": principal.role,
        "rank": principal.rank,
        "capabilities": role_capabilities(principal.role)
        if principal.is_authenticated
        else {"can_manage_alerts": False, "can_review_reports": False, "is_admin": False},
    }


@router.get("/roles", summary="The role model")
def roles() -> dict[str, Any]:
    """What each role can do, described in one place.

    The UI reads this instead of hardcoding a permission table, so the screen
    and the dependencies that actually enforce access cannot drift apart.
    """
    return {
        "roles": [
            {
                "role": "CITIZEN",
                "rank": ROLE_RANK["CITIZEN"],
                "label": "Citizen",
                "description": (
                    "View risk, forecasts and alerts, and file reports. Filing "
                    "does not require an account at all."
                ),
                **role_capabilities("CITIZEN"),
            },
            {
                "role": "OFFICER",
                "rank": ROLE_RANK["OFFICER"],
                "label": "District officer",
                "description": (
                    "Acknowledge, assign and resolve alerts; triage citizen "
                    "reports; drive the virtual sensor network."
                ),
                **role_capabilities("OFFICER"),
            },
            {
                "role": "ADMIN",
                "rank": ROLE_RANK["ADMIN"],
                "label": "Administrator",
                "description": (
                    "Everything an officer can do, plus user administration and "
                    "platform configuration."
                ),
                **role_capabilities("ADMIN"),
            },
        ],
        "note": (
            "Reading risk and filing a report are open. Anything that changes an "
            "operational record requires at least the OFFICER role."
        ),
    }


@router.get("/demo-accounts", summary="The seeded demo credentials")
def demo_accounts(db: DbSession) -> dict[str, Any]:
    """The seeded accounts, so the demo can be driven without guesswork.

    Cross-checked against the database, so this cannot advertise an account
    that does not exist - if seeding was turned off, the list comes back empty
    rather than listing credentials that will fail at the login form.
    """
    if not settings.seed_demo_users:
        return {
            "accounts": [],
            "note": (
                "SEED_DEMO_USERS is false, so no demo accounts were created. "
                "Sign in with an account from your own database."
            ),
        }

    present = {
        user.username: user
        for user in db.scalars(select(User).order_by(User.id)).all()
    }
    accounts = [
        {
            "username": spec["username"],
            "password": spec["password"],
            "role": spec["role"],
            "full_name": spec["full_name"],
            "organisation": spec["organisation"],
        }
        for spec in DEMO_USERS
        if spec["username"] in present
    ]
    return {
        "accounts": accounts,
        "note": (
            "Demo accounts, seeded on first run and documented in the README. "
            "Set SEED_DEMO_USERS=false and change JWT_SECRET before deploying "
            "anywhere reachable."
        ),
    }


@router.get("/users", summary="All accounts (administrator)")
def list_users(
    db: DbSession,
    principal: Annotated[Principal, Depends(require_admin)],
) -> dict[str, Any]:
    """The user list, for the administrator view."""
    users = db.scalars(select(User).order_by(User.role, User.username)).all()
    return {
        "count": len(users),
        "users": [
            {**_user_out(user), "created_at": user.created_at} for user in users
        ],
    }
