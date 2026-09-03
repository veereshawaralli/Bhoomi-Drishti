"""Authentication, password hashing and role-based access control.

Dependency-free on purpose
--------------------------
Password hashing uses PBKDF2-HMAC-SHA256 from ``hashlib`` and the tokens are
HS256 JWTs signed with ``hmac``. Both are in the standard library, so the
backend installs from a short requirements file and cannot fail at start-up
because a native crypto wheel is missing for someone's Python version. The
formats are the standard ones, so swapping in ``bcrypt``/``argon2`` or
``PyJWT`` later is a drop-in change.

Demo credentials are exactly that - demo. ``.env.example`` says to change
``JWT_SECRET`` before any real deployment, and the API warns at start-up when
it is still the default.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .clock import utcnow
from .config import settings
from .database import get_db
from .models import User

LOG = logging.getLogger("app.security")

PBKDF2_ROUNDS = 120_000
ALGORITHM = "HS256"

# Who can do what. Roles are ordered: an ADMIN can do everything an OFFICER
# can, and an OFFICER everything a CITIZEN can.
ROLE_RANK = {"CITIZEN": 1, "OFFICER": 2, "ADMIN": 3}


# ----------------------------------------------------------------- passwords

def hash_password(password: str, *, salt: bytes | None = None) -> str:
    """``pbkdf2_sha256$<rounds>$<salt>$<hash>`` - self-describing, portable."""
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return "$".join(
        [
            "pbkdf2_sha256",
            str(PBKDF2_ROUNDS),
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(digest).decode("ascii"),
        ]
    )


def verify_password(password: str, encoded: str) -> bool:
    """Constant-time check that `password` produced `encoded`."""
    try:
        scheme, rounds, salt_b64, hash_b64 = encoded.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            base64.b64decode(salt_b64),
            int(rounds),
        )
        return hmac.compare_digest(digest, base64.b64decode(hash_b64))
    except Exception:
        return False


# --------------------------------------------------------------------- JWT

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def create_token(user: User, *, minutes: int | None = None) -> str:
    """Signed HS256 JWT carrying the subject, role and expiry."""
    expires = utcnow() + timedelta(minutes=minutes or settings.jwt_expiry_minutes)
    header = {"alg": ALGORITHM, "typ": "JWT"}
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role,
        "name": user.full_name,
        "iat": int(utcnow().timestamp()),
        "exp": int(expires.timestamp()),
        "iss": settings.app_name,
    }
    signing_input = ".".join(
        _b64url(json.dumps(part, separators=(",", ":")).encode("utf-8"))
        for part in (header, payload)
    )
    signature = hmac.new(
        settings.jwt_secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256
    ).digest()
    return f"{signing_input}.{_b64url(signature)}"


def decode_token(token: str) -> dict[str, Any] | None:
    """Verify signature and expiry; return the claims or None."""
    try:
        header_b64, payload_b64, signature_b64 = token.split(".")
        expected = hmac.new(
            settings.jwt_secret.encode("utf-8"),
            f"{header_b64}.{payload_b64}".encode("ascii"),
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(expected, _b64url_decode(signature_b64)):
            return None
        claims = json.loads(_b64url_decode(payload_b64))
        if int(claims.get("exp", 0)) < int(utcnow().timestamp()):
            return None
        return claims
    except Exception:
        return None


# ------------------------------------------------------------ current user

@dataclass(frozen=True)
class Principal:
    """Who is making this request."""

    id: int | None
    username: str
    role: str
    full_name: str | None = None

    @property
    def rank(self) -> int:
        return ROLE_RANK.get(self.role, 0)

    @property
    def is_authenticated(self) -> bool:
        return self.id is not None

    def can(self, minimum: str) -> bool:
        return self.rank >= ROLE_RANK.get(minimum, 99)


ANONYMOUS = Principal(id=None, username="anonymous", role="CITIZEN")


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


def current_principal(
    request: Request, db: Session = Depends(get_db)
) -> Principal:
    """Resolve the caller, or ANONYMOUS.

    Public endpoints (the risk map, the citizen report form) accept anonymous
    callers by design - an early-warning platform that hides the warning
    behind a login is not doing its job. Endpoints that change state depend on
    `require_officer` or `require_admin` instead.
    """
    token = _bearer(request)
    if not token:
        return ANONYMOUS
    claims = decode_token(token)
    if not claims:
        return ANONYMOUS
    try:
        user_id = int(claims.get("sub", "0"))
    except (TypeError, ValueError):
        return ANONYMOUS
    user = db.get(User, user_id)
    if user is None:
        return ANONYMOUS
    return Principal(
        id=user.id, username=user.username, role=user.role, full_name=user.full_name
    )


def _require(minimum: str):
    def dependency(principal: Principal = Depends(current_principal)) -> Principal:
        if not principal.is_authenticated:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Sign in to perform this action.",
                headers={"WWW-Authenticate": "Bearer"},
            )
        if not principal.can(minimum):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"This action requires the {minimum} role.",
            )
        return principal

    return dependency


require_citizen = _require("CITIZEN")
require_officer = _require("OFFICER")
require_admin = _require("ADMIN")


def role_capabilities(role: str) -> dict[str, bool]:
    rank = ROLE_RANK.get(role, 0)
    return {
        "can_manage_alerts": rank >= ROLE_RANK["OFFICER"],
        "can_review_reports": rank >= ROLE_RANK["OFFICER"],
        "is_admin": rank >= ROLE_RANK["ADMIN"],
    }


def authenticate(db: Session, username: str, password: str) -> User | None:
    user = db.execute(
        select(User).where(User.username == username.strip().lower())
    ).scalar_one_or_none()
    if user is None or not verify_password(password, user.password_hash):
        return None
    return user


def warn_on_default_secret() -> None:
    if "change-me" in settings.jwt_secret or "demo-secret" in settings.jwt_secret:
        LOG.warning(
            "JWT_SECRET is still the demo default - set a real value in .env "
            "before deploying anywhere reachable."
        )
