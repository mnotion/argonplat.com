# argonplat.com

## Accounts (Supabase only)

Argon's account page connects directly to Supabase using the browser-safe publishable key. No Render service or custom Python API is required for signup, login, or profile display.

- Supabase Auth handles account signup, email confirmation, login, and sessions.
- The `handle_new_user` database trigger creates the `public.profiles` row from signup username metadata.
- The profile page queries only the signed-in user's row. PostgreSQL Row Level Security must remain enabled and the own-row policies must be in place.
- Never put a Supabase secret/service-role key in frontend code. The publishable key is intended for browser use; RLS protects database records.

## Account deletion

- The account page requires the current password again and the exact confirmation text `DELETE`.
- The `delete-account` Supabase Edge Function validates the access token, requires a recent authentication time, and deletes the Auth user with the server-side Admin API.
- The `public.profiles` row is deleted by its `ON DELETE CASCADE` foreign key.
- No Supabase Storage buckets or objects exist in this project at present. Argon has not connected Backblaze B2 yet, so this flow cannot remove B2 files or data held outside this Supabase project.
- Account deletion does not erase email messages, provider backups, logs subject to retention, or browser/device files.
- The Edge Function must keep its server-side Supabase secret in Supabase-managed environment variables. Never copy it into frontend files or GitHub.
