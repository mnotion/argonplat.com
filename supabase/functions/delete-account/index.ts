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

function readJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const segment = token.split(".")[1];
    if (!segment) return null;
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
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

  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

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
  if (!tokenMatch) {
    return json(401, { error: "You must be signed in to delete your account." });
  }
  const accessToken = tokenMatch[1];

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) {
    console.error("Account deletion is missing its Supabase server configuration.");
    return json(500, { error: "Account deletion is not configured yet." });
  }

  const admin = createClient(supabaseUrl, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  // getUser() validates the supplied access token with Supabase Auth.
  const { data: { user }, error: userError } = await admin.auth.getUser(accessToken);
  if (userError || !user) {
    return json(401, { error: "Your session is invalid. Sign in again and retry." });
  }

  // Require a fresh sign-in (the frontend asks for the current password again).
  // The token claims are inspected only after Auth has validated this token.
  const claims = readJwtClaims(accessToken);
  const authTime = Number(claims?.auth_time);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(authTime) ||
    authTime <= 0 ||
    authTime > now + 30 ||
    now - authTime > 300
  ) {
    return json(401, {
      error: "For security, sign in with your password again immediately before deleting your account.",
      code: "reauthentication_required",
    });
  }

  if (claims?.sub !== user.id) {
    return json(401, { error: "Your session could not be verified." });
  }

  // public.profiles references auth.users with ON DELETE CASCADE.
  // Delete the Auth user last so the profile is removed by the database.
  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id, false);
  if (deleteError) {
    console.error("Supabase Auth account deletion failed:", deleteError.message);
    return json(500, {
      error: "Supabase could not complete account deletion. Your account has not been confirmed as deleted.",
    });
  }

  return json(200, { success: true });
});
