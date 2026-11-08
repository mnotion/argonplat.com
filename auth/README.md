# Argon Auth API

FastAPI service for Argon account signup, login, session refresh, logout and profile retrieval.

## Local development

1. Copy `.env.example` to `.env`.
2. Set `SUPABASE_PUBLISHABLE_KEY` to the publishable key from the Argon Supabase project.
3. Set `ARGON_ALLOWED_ORIGINS=http://localhost:5500`.
4. Install dependencies and start the API:

   ```bash
   python -m venv .venv
   # Activate the virtual environment, then:
   pip install -r requirements.txt
   uvicorn main:app --reload --port 8000
   ```

5. For local frontend testing, temporarily set `window.ARGON_API_BASE` in `../js/auth-config.js` to `http://localhost:8000`.

## Endpoints

- `GET /health`
- `POST /auth/signup`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me` (requires `Authorization: Bearer <access_token>`)

The API uses only the Supabase publishable key. User profile queries include the user's own access token and are constrained by the database's Row Level Security policy. Never put a Supabase secret/service-role key in frontend code or commit one to this repository.
