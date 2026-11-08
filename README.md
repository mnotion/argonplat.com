# argonplat.com

## Accounts (Supabase only)

Argon's account page connects directly to Supabase using the browser-safe publishable key. No Render service or custom Python API is required for signup, login, or profile display.

- Supabase Auth handles account signup, email confirmation, login, and sessions.
- The `handle_new_user` database trigger creates the `public.profiles` row from signup username metadata.
- The profile page queries only the signed-in user's row. PostgreSQL Row Level Security must remain enabled and the own-row policies must be in place.
- Never put a Supabase secret/service-role key in frontend code. The publishable key is intended for browser use; RLS protects database records.

## Account deletion

- The account page asks for the current password again and the exact confirmation text `DELETE`.
- The password is rechecked using Supabase Auth before deletion.
- The frontend calls `public.delete_my_account(text)` through the authenticated Supabase client.
- The database function checks `auth.uid()`, checks the exact confirmation string, and deletes only the caller's own row from `auth.users`.
- Execute permission is revoked from `PUBLIC` and `anon`, and granted only to `authenticated`.
- The function runs with an empty `search_path` and uses fully qualified table names. The `public.profiles` row is removed by its existing `ON DELETE CASCADE` foreign key.
- The account page no longer invokes the `delete-account` Edge Function. That previously deployed function is obsolete and can be removed from Supabase separately.
- No Supabase Storage buckets or objects exist in this project at present. Argon has not connected Backblaze B2 yet, so this flow cannot remove B2 files or data held outside this Supabase project.
- Account deletion does not erase email messages, provider backups, logs subject to retention, or browser/device files.
