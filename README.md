# argonplat.com

## Account authentication

The account page uses the FastAPI service in `auth/` and Supabase Auth.

### Deploy the API

1. In Render, create a new Blueprint and connect this repository.
2. Select the `development` branch. Render reads the root `render.yaml` file.
3. When prompted, set `SUPABASE_PUBLISHABLE_KEY` to the project's Supabase publishable key.
4. Set `ARGON_ALLOWED_ORIGINS` to the exact origin serving the Argon website (for example, `https://argonplat.com`). Include localhost only for local development.
5. Deploy the `argonplat-auth-api` web service. Its health endpoint is `/health`.

The frontend config in `js/auth-config.js` expects the service URL:
`https://argonplat-auth-api.onrender.com`.

### Local API development

1. Copy `auth/.env.example` to `auth/.env`.
2. Fill in the Supabase publishable key and set `ARGON_ALLOWED_ORIGINS=http://localhost:5500`.
3. From the `auth` directory, install `requirements.txt` and run:
   `uvicorn main:app --reload --port 8000`.
4. Temporarily set `window.ARGON_API_BASE` in `js/auth-config.js` to `http://localhost:8000`.

Do not commit `auth/.env` or any secret key.

### Account behavior

- Signup creates the Supabase Auth user. The existing database trigger creates the matching `public.profiles` row from the username metadata.
- If email confirmation is enabled in Supabase, users must confirm their email and then log in.
- After login, the account page loads the profile using the user's JWT. The database's own-row RLS policy remains active.
- Sessions are kept in tab-scoped browser session storage and refreshed through the API when needed.
