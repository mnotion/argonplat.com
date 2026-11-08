# argonplat.com

## Accounts (Supabase only)

Argon's account page connects directly to Supabase using the browser-safe publishable key. No Render service or custom Python API is required for signup, login, or profile display.

- Supabase Auth handles account signup, email confirmation, login, and sessions.
- The `handle_new_user` database trigger creates the `public.profiles` row from signup username metadata.
- The profile page queries only the signed-in user's row. PostgreSQL Row Level Security must remain enabled and the own-row policies must be in place.
- Never put a Supabase secret/service-role key in frontend code. The publishable key is intended for browser use; RLS protects database records.

For private Backblaze B2 operations or other privileged server-side tasks, a backend/Edge Function may still be needed later. It is not needed for basic accounts.
