import os
import re
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field
from supabase import create_client, Client
from gotrue.errors import AuthApiError

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")

if not SUPABASE_URL or not SUPABASE_PUBLISHABLE_KEY:
    raise RuntimeError("Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
app = FastAPI(title="Argon Auth API", version="0.1.0")

# Set ARGON_ALLOWED_ORIGINS to comma-separated deployed origins in production.
origins = [x.strip() for x in os.getenv("ARGON_ALLOWED_ORIGINS", "http://localhost:5500").split(",") if x.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)

class SignupRequest(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)

class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)

def valid_username(value: str) -> bool:
    return re.fullmatch(r"[a-zA-Z0-9_]+", value) is not None

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/auth/signup", status_code=201)
def signup(body: SignupRequest):
    username = body.username.strip().lower()
    if not valid_username(username):
        raise HTTPException(400, "Username may contain only letters, numbers, and underscores.")
    try:
        result = supabase.auth.sign_up({
            "email": str(body.email),
            "password": body.password,
            "options": {"data": {"username": username}},
        })
    except Exception as exc:
        # Supabase Auth owns email/password and its errors; never log passwords.
        message = str(exc)
        if "already" in message.lower() and "registered" in message.lower():
            raise HTTPException(409, "That email is already registered.")
        raise HTTPException(400, "Signup could not be completed. Check your details and try again.")
    user = result.user
    if not user:
        raise HTTPException(400, "Supabase did not return a user.")
    return {
        "user_id": user.id,
        "email": user.email,
        "confirmation_required": result.session is None,
        "message": "Account created. Check your email if confirmation is required.",
    }

@app.post("/auth/login")
def login(body: LoginRequest):
    try:
        result = supabase.auth.sign_in_with_password({
            "email": str(body.email),
            "password": body.password,
        })
    except Exception:
        raise HTTPException(401, "Invalid email or password.")
    if not result.user or not result.session:
        raise HTTPException(401, "Email confirmation may be required before signing in.")
    return {
        "access_token": result.session.access_token,
        "refresh_token": result.session.refresh_token,
        "expires_at": result.session.expires_at,
        "user": {"id": result.user.id, "email": result.user.email},
    }

@app.get("/auth/me")
def me(authorization: str | None = None):
    # The frontend sends its Supabase access token in Authorization: Bearer <token>.
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sign in required.")
    token = authorization.split(" ", 1)[1].strip()
    try:
        user = supabase.auth.get_user(token).user
    except Exception:
        raise HTTPException(401, "Session is invalid or expired.")
    if not user:
        raise HTTPException(401, "Session is invalid or expired.")
    return {"user_id": user.id, "email": user.email}
