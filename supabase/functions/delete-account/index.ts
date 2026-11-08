import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function getSecretKey(): string | null {
  const keysJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keysJson) {
    try {
      const keys = JSON.parse(keysJson);
      const value = keys.default ?? Object.values(keys)[0];
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // Fall through to the legacy environment variable.
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SECRET_KEY");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });

  let body: { confirmation?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid request body." });
  }
  if (body.confirmation !== "DELETE") {
    return json(400, { error: 'Type "DELETE" to confirm account removal.' });
  }

  const authorization = req.headers.get("Authorization") ?? "";
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) return json(401, { error: "You must be signed in." });
  const accessToken = tokenMatch[1];

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) {
    console.error("Account deletion is missing server configuration.");
    return json(500, { error: "Account deletion is not configured." });
  }

  const admin = createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  // Validate the caller's bearer token with Supabase Auth.
  const { data: { user }, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !user) {
    return json(401, { error: "Your session is invalid. Log in again." });
  }

  // The frontend has just verified the current password using signInWithPassword.
  // Require a valid signed-in user, but don't rely on auth_time being refreshed.
  // The confirmation text and password check are enforced in the account UI.
  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id, false);
  if (deleteError) {
    console.error("Supabase Auth account deletion failed:", deleteError.message);
    return json(500, { error: "Supabase could not complete account deletion." });
  }

  return json(200, { success: true });
});
