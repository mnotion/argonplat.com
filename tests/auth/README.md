# Local auth test starter

This folder contains small checks for Argon's Supabase sign-in setup. They use Node's built-in test runner, so no extra test framework needs to be installed.

## Before running the sign-in check

1. Start the local Supabase services from the repository folder with `npx supabase start`.
2. Make sure you ran `supabase/local-test/setup.sql` in the local Studio SQL editor.
3. Create or use a disposable account in the local app. Use the local address printed by `npx supabase status` and its local publishable key. Do not use a hosted account.
4. Open a new VS Code terminal in the repository folder. In PowerShell, enter these four commands, replacing the example values with your **local** settings:

   ```powershell
   $env:ARGON_AUTH_TEST_URL = 'http://127.0.0.1:54321'
   $env:ARGON_AUTH_TEST_PUBLISHABLE_KEY = 'paste-the-local-publishable-key-here'
   $env:ARGON_AUTH_TEST_EMAIL = 'your-disposable-local-account@example.test'
   $env:ARGON_AUTH_TEST_PASSWORD = 'the-password-for-that-local-account'
   ```

   These values stay in that terminal session. Do not put your password or a secret/service-role key in a file or in chat. The publishable key is intended for browser use; the test additionally refuses non-local Supabase addresses.

## Run the auth checks

Run:

```powershell
npm run test:auth
```

The configuration checks run every time. The sign-in/profile check runs only when all four values above are present. It signs in, checks that the account can read its own profile, and signs out. It does not create or delete accounts, and it does not contact Backblaze. Without the four values, that integration check is shown as skipped.

When finished, close that terminal or clear the values with:

```powershell
Remove-Item Env:ARGON_AUTH_TEST_URL, Env:ARGON_AUTH_TEST_PUBLISHABLE_KEY, Env:ARGON_AUTH_TEST_EMAIL, Env:ARGON_AUTH_TEST_PASSWORD -ErrorAction SilentlyContinue
```

The test is intended for the local Supabase stack only. It does not prove that hosted email delivery, hosted credentials, or production services work.
