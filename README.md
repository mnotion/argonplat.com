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
        ├── exhibitions/
        │   └── index.json  (reserved metadata)
        └── content/
            └── index.json
```

B2 object keys are prefixes rather than physical folders. The JSON objects cause the corresponding prefixes to appear in the B2 file browser. `exhibitions/index.json` remains an empty reserved index for exhibition records. `content/index.json` marks the root directory used by My Exhibition. Signup does not create an exhibition.

The UID and username appear together in both storage paths: `{uid}_{username}`. The JSON files also store the UID and username as separate fields. UID remains the immutable ownership key; username is a readable label. Provisioning schema version 3 adds the `content/` directory. Existing accounts with earlier storage schemas are upgraded at their next sign-in.\n\nThe function uses the Supabase-injected `SUPABASE_SECRET_KEYS` only on the server and uses a bucket-restricted Backblaze application key to upload the JSON objects. It does not accept a UID, username, or object path as trusted ownership information from the browser. The requested UID must exist in Supabase Auth and its one-time token must match that user's Auth metadata. After all objects are uploaded, the function marks provisioning complete and removes the one-time token from user metadata.

### Configure B2 secrets

In Supabase Dashboard → Edge Functions → Secrets, add:

| Secret name | Value |
|---|---|
| `B2_APPLICATION_KEY_ID` | Your bucket-restricted B2 Application Key ID |
| `B2_APPLICATION_KEY` | Its Application Key secret |

The bucket name, endpoint and region are currently configured in the function source:
- Bucket: `argon-cloud-storage`
- Endpoint: `https://s3.eu-central-003.backblazeb2.com`
- Region: `eu-central-003`

Create a dedicated B2 application key restricted to this bucket with `writeFiles` permission. Backblaze also documents `listAllBucketNames` as required for compatibility with bucket-restricted SDK keys, so include that capability if the key setup offers it. Do not use the B2 master key. The integration only uploads objects at signup; it does not need `readFiles`, `deleteFiles`, bucket creation, or public access permissions.

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

The My Exhibition page provides a simple file explorer rooted at the signed-in user's `userdata/{uid}_{username}/content/` prefix. It lists folders and files, navigates nested folders with breadcrumbs, creates folders, accepts individual files and entire folder trees through folder selection or drag-and-drop, and offers download links.

The `exhibition-files` Supabase Edge Function derives the user ID and username from the validated Supabase session and `public.profiles`. The browser cannot supply a storage owner or an arbitrary bucket prefix. All uploads are sent through the Edge Function and written to the user's own `content/` prefix. Folder-relative paths are preserved, so folder uploads do not require ZIP archives. Empty folders are represented by B2 folder-marker objects when the browser exposes them. Each successful upload or folder creation refreshes the displayed folder automatically; there is no manual save step.

For this file explorer, the bucket-restricted B2 application key needs:
- `listFiles` to browse object keys and folders.
- `readFiles` to create temporary download links.
- `writeFiles` to upload files and create folder markers.
- `listAllBucketNames` for compatibility with bucket-restricted S3 SDK integrations.

Do not grant `deleteFiles` for this UI; it does not include a delete operation. Keep the key restricted to `argon-cloud-storage`. Never put the B2 key into browser code.

Files up to 25 MB each are supported in this first version. Folder uploads send each file separately and preserve nested paths. Uploads are proxied through the authenticated Edge Function, so the bucket does not need browser CORS rules for uploads. Download links expire after five minutes.

Deploy from the repository root:

```bash
supabase functions deploy exhibition-files
```

The function uses the existing `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY` Supabase Edge Function secrets.

## Account deletion

- The account page asks for the current password again and the exact confirmation text `DELETE`.
- The password is rechecked using Supabase Auth before deletion.
- The frontend calls `public.delete_my_account(text)` through the authenticated Supabase client.
- The database function checks `auth.uid()`, checks the exact confirmation string, and deletes only the caller's own row from `auth.users`.
- Execute permission is revoked from `PUBLIC` and `anon`, and granted only to `authenticated`.
- The `public.profiles` row is removed by its existing `ON DELETE CASCADE` foreign key.
- No Supabase Storage buckets or objects exist in this project at present. Argon's B2 account data is provisioned separately using the UID-prefixed object keys above.
- Account deletion does not yet remove B2 objects. That will need to be added to the deletion workflow before B2-backed user content is stored.
- Account deletion does not erase email messages, provider backups, logs subject to retention, or browser/device files.
