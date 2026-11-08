import os
import re

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field
from supabase import Client, create_client

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")

if not SUPABASE_URL or not SUPABASE_PUBLISHABLE_KEY:
    raise RuntimeError(
        "Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY environment variables."
    )


def new_supabase_client() -> Client:
    # Never share an authenticated Supabase client between web requests.
    return create_client(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)


app = FastAPI(title="Argon Auth API", version="0.2.0")

origins = [
    origin.strip()
    for origin in os.getenv(
        "ARGON_ALLOWED_ORIGINS", "http://localhost:5500"
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


class SignupRequest(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class LogoutRequest(BaseModel):
    access_token: str = Field(min_length=1)
    refresh_token: str = Field(min_length=1)


def valid_username(value: str) -> bool:
    return re.fullmatch(r"[a-zA-Z0-9_]+", value) is not None


def session_data(session, user):
    return {
        "access_token": session.access_token,
        "refresh_token": session.refresh_token,
        "expires_at": session.expires_at,
        "user": {"id": user.id, "email": user.email},
    }


@app.get("/health")
def health():
    return {"status": "ok", "service": "argon-auth-api"}


@app.post("/auth/signup", status_code=201)
def signup(body: SignupRequest):
    username = body.username.strip().lower()
    if not valid_username(username):
        raise HTTPException(
            400,
            "Username may contain only letters, numbers, and underscores.",
        )

    client = new_supabase_client()
    try:
        result = client.auth.sign_up(
            {
                "email": str(body.email),
                "password": body.password,
                "options": {"data": {"username": username}},
            }
        )
    except Exception as exc:
        message = str(exc).lower()
        if "already" in message and "registered" in message:
            raise HTTPException(409, "That email is already registered.")
        if (
            "duplicate key" in message
            or "profiles_username_key" in message
            or "unique constraint" in message
        ):
            raise HTTPException(409, "That username is already taken.")
        raise HTTPException(
            400,
            "Signup could not be completed. Check your details and try again.",
        )

    if not result.user:
        raise HTTPException(400, "Supabase did not return a user.")

    response = {
        "user_id": result.user.id,
        "email": result.user.email,
        "confirmation_required": result.session is None,
        "message": (
            "Account created. Check your email to confirm it."
            if result.session is None
            else "Account created."
        ),
    }

    # Supabase returns no session when email confirmation is enabled.
    if result.session:
        response.update(session_data(result.session, result.user))

    return response


@app.post("/auth/login")
def login(body: LoginRequest):
    client = new_supabase_client()
    try:
        result = client.auth.sign_in_with_password(
            {
                "email": str(body.email),
                "password": body.password,
            }
        )
    except Exception:
        raise HTTPException(401, "Invalid email or password.")

    if not result.user or not result.session:
        raise HTTPException(
            401,
            "Email confirmation may be required before signing in.",
        )

    return session_data(result.session, result.user)


@app.post("/auth/refresh")
def refresh(body: RefreshRequest):
    client = new_supabase_client()
    try:
        result = client.auth.refresh_session(body.refresh_token)
    except Exception:
        raise HTTPException(401, "Session expired. Please log in again.")

    if not result.user or not result.session:
        raise HTTPException(401, "Session expired. Please log in again.")

    return session_data(result.session, result.user)


@app.post("/auth/logout")
def logout(body: LogoutRequest):
    client = new_supabase_client()
    try:
        client.auth.set_session(body.access_token, body.refresh_token)
        # Revoke only this browser session, not the user's other devices.
        client.auth.sign_out({"scope": "local"})
    except Exception:
        # The browser should still clear its local session if revocation fails.
        pass

    return {"status": "signed_out"}


@app.get("/auth/me")
def me(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sign in required.")

    token = authorization.split(" ", 1)[1].strip()
    client = new_supabase_client()

    try:
        user = client.auth.get_user(token).user
        if not user:
            raise HTTPException(401, "Session is invalid or expired.")

        # Attach this user's JWT to PostgREST. The profiles table's RLS
        # policy then limits the result to auth.uid() = profiles.id.
        profile_result = (
            client.postgrest.auth(token)
            .from_("profiles")
            .select("id,username,plan,created_at")
            .eq("id", str(user.id))
            .maybe_single()
            .execute()
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "Session is invalid or expired.")

    profile = profile_result.data
    if not profile:
        raise HTTPException(
            404,
            "Your account profile was not found. Contact Argon support.",
        )

    return {
        "user_id": str(profile["id"]),
        "username": profile["username"],
        "email": user.email,
        "plan": profile["plan"],
        "created_at": profile["created_at"],
    }
