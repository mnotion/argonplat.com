# argonplat.com

## Accounts (Supabase only)

Argon's account page connects directly to Supabase using the browser-safe publishable key. No Render service or custom Python API is required for signup, login, or profile display.

- Supabase Auth handles account signup, email confirmation, login, and sessions.
- The `handle_new_user` database trigger creates the `public.profiles` row from signup username metadata.
- The profile page queries only the signed-in user's row. PostgreSQL Row Level Security must remain enabled and the own-row policies must be in place.
- Never put a Supabase secret/service-role key or Backblaze B2 application key in frontend code or GitHub.

## Backblaze B2 signup provisioning

When a new user signs up, the frontend generates a cryptographically random, one-time provisioning token and stores it in that user's Supabase Auth metadata. It then invokes the `provision-user-storage` Edge Function. The function looks up the user and profile through Supabase Admin, verifies the one-time token, and creates these JSON objects in the private `argon-cloud-storage` bucket:

```text
argon/
├── config/
│   └── users/
│       └── {uid}_{username}.json
└── userdata/
    └── {uid}_{username}/
        ├── user.json
        └── exhibitions/
            ├── index.json  (reserved metadata)
            └── {exhibition-name}_{uid}_{eid}/
                └── .argon.json
```

B2 object keys are prefixes rather than physical folders. The JSON objects cause the corresponding prefixes to appear in the B2 file browser. `exhibitions/index.json` remains an empty reserved index; each exhibition is represented by a folder named `{slug}_{uid}_{eid}` and a `.argon.json` record with its display name, colour, and stable identity. The EID is eight random letters or digits. A private Supabase registry enforces global uniqueness and retains IDs after deletion so they are never reused. Signup does not create an exhibition or a `content/` folder.

The UID and username appear together in the user's storage path: `{uid}_{username}`. The JSON files also store the UID and username as separate fields. UID remains the immutable ownership key; username is a readable label. Provisioning schema version 4 uses exhibition folders instead of creating `content/`. Existing accounts are upgraded at their next sign-in. Existing `content/` data is kept accessible as a legacy exhibition during migration.

The function uses the Supabase-injected `SUPABASE_SECRET_KEYS` only on the server and uses a bucket-restricted Backblaze application key to upload the JSON objects. It does not accept a UID, username, or object path as trusted ownership information from the browser. The requested UID must exist in Supabase Auth and its one-time token must match that user's Auth metadata. After all objects are uploaded, the function marks provisioning complete and removes the one-time token from user metadata.

### Configure B2 secrets

In Supabase Dashboard → Edge Functions → Secrets, add:

| Secret name | Value |
|---|---|
| `ARGON_ENVIRONMENT` | `production` for the hosted production functions |
| `B2_BUCKET` | `argon-cloud-storage` |
| `B2_REGION` | `eu-central-003` |
| `B2_ENDPOINT` | `https://s3.eu-central-003.backblazeb2.com` |
| `B2_APPLICATION_KEY_ID` | Your bucket-restricted B2 Application Key ID |
| `B2_APPLICATION_KEY` | Its Application Key secret |

Test settings also require `ARGON_TEST_B2_BUCKET` to exactly match `B2_BUCKET`. The functions reject the production bucket and any hosted Supabase URL while `ARGON_ENVIRONMENT=test` is set. They do not silently substitute production values when configuration is missing.

Create a dedicated B2 application key restricted to this bucket with `listFiles`, `readFiles`, `writeFiles`, and `deleteFiles` permissions. Backblaze also documents `listAllBucketNames` as required for compatibility with bucket-restricted SDK keys, so include that capability if the key setup offers it. Do not use the B2 master key or grant bucket creation or public access permissions.

### Deploy the Edge Function

The function source is `supabase/functions/provision-user-storage/index.ts`. Its JWT check is disabled in `supabase/config.toml` because signup email confirmation can mean there is not yet a user access token. The function instead requires a random one-time provisioning token that it verifies against the user's Auth metadata.

From the repository root, link the Supabase project and deploy the function:

```bash
supabase login
supabase link --project-ref nacwfrsdpglzrhasmit
supabase functions deploy provision-user-storage --no-verify-jwt
```

Add the B2 secrets in the Supabase Dashboard before testing signup. New secrets are available to Edge Functions without another deployment.

If B2 provisioning fails during signup, the Supabase account remains created. The one-time token stays in Auth metadata, and the next login retries storage provisioning. After successful provisioning, the token is removed.

## My Exhibition file explorer

The My Exhibition page shows up to two exhibitions for a free account. Each exhibition has a name and colour and stores its files in `userdata/{uid}_{username}/exhibitions/{slug}_{uid}_{eid}/`. Renaming preserves the EID and exhibition instance. Because B2 has no atomic folder-rename operation, the function copies the current objects, verifies the destination, and then permanently removes all old object versions. It reports a failure instead of claiming success if cleanup is denied or incomplete.

The `exhibition-files` Supabase Edge Function derives the user ID and username from the validated Supabase session and `public.profiles`. The browser cannot supply a storage owner or an arbitrary bucket prefix. All uploads are sent through the Edge Function and written to the selected exhibition. Folder-relative paths are preserved, so folder uploads do not require ZIP archives. Empty folders are represented by B2 folder-marker objects when the browser exposes them. Each successful upload or folder creation refreshes the displayed folder automatically; there is no manual save step.

For this file explorer, the bucket-restricted B2 application key needs:
- `listFiles` to browse object keys and folders.
- `readFiles` to create temporary download links.
- `writeFiles` to upload files and create folder markers.
- `listAllBucketNames` for compatibility with bucket-restricted S3 SDK integrations.

Exhibition deletion and rename cleanup remove old B2 object versions, so the key needs `deleteFiles` permission in addition to read, list, and write access. Keep the key restricted to the appropriate bucket. Never put the B2 key into browser code.

Files up to 25 MB each are supported in this first version. Folder uploads send each file separately and preserve nested paths. Uploads are proxied through the authenticated Edge Function, so the bucket does not need browser CORS rules for uploads. Download links expire after five minutes.

Deploy from the repository root:

```bash
supabase functions deploy exhibition-files
```

The function uses the existing `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY` Supabase Edge Function secrets.

Before deploying this function to a hosted project, apply `supabase/migrations/20261109190000_exhibition_eid_registry.sql`. Do not deploy the function before its private EID registry table exists.

## Isolated local integration testing

Localhost is deliberately configured to use only a local Supabase URL. It never falls back to the hosted project. Use `local-test-setup.html` from the loopback-only local server to save the publishable key printed by the local Supabase CLI in this browser's local storage.

The local setup requires the Supabase CLI and a Docker-compatible runtime. Supabase's local stack provides local Auth, Postgres, and an Edge Function runtime. From the repository root:

```bash
supabase start
```

Open the local Supabase Studio URL printed by the CLI, then run `supabase/local-test/setup.sql` in its SQL editor. This creates only the local test `profiles` table, its own-row policies, the signup trigger, and the private exhibition EID registry. It contains no production user records. Use the API URL and publishable key printed by `supabase status` to configure `local-test-setup.html`.

For B2 integration tests, create a separate test bucket and a separate application key restricted to that bucket. Do not reuse the production key. Copy `supabase/.env.test.example` to `supabase/.env.test` and replace the placeholders locally. If the local Supabase stack was started on a custom Docker network, serve the functions on that same network. This project's local test stack uses `argonplat-local-network`:

```bash
supabase --network-id argonplat-local-network functions serve --env-file supabase/.env.test
```

The test configuration refuses the production bucket, refuses hosted Supabase URLs, and requires the chosen B2 bucket to match `ARGON_TEST_B2_BUCKET`. Keep the test credential file out of Git. Begin with small disposable files, check each upload, browse, rename, colour, and delete result in the test bucket, then remove only those test fixtures. Do not use the normal production account or bucket for these tests.

## Developer checks

Small automated checks live in `tests/`. Run `npm test` from the repository folder to run the local configuration checks. To run only the auth checks, use `npm run test:auth`. The sign-in/profile integration check is skipped unless you explicitly provide local test credentials in the current terminal; see `tests/auth/README.md`. It accepts loopback addresses only and never creates or deletes an account.

## Account deletion

- The account page asks for the current password again and the exact confirmation text `DELETE`.
- The password is rechecked using Supabase Auth before deletion.
- The frontend calls `public.delete_my_account(text)` through the authenticated Supabase client.
- The database function checks `auth.uid()`, checks the exact confirmation string, and deletes only the caller's own row from `auth.users`.
- Execute permission is revoked from `PUBLIC` and `anon`, and granted only to `authenticated`.
- The `public.profiles` row is removed by its existing `ON DELETE CASCADE` foreign key.
- Argon uses Backblaze B2 for account files and exhibition content; it does not use Supabase Storage buckets for these files.
- Account deletion does not yet remove B2 objects. That will need to be added to the deletion workflow before B2-backed user content is stored.
- Account deletion does not erase email messages, provider backups, logs subject to retention, or browser/device files.
