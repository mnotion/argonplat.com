import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { PutObjectCommand, S3Client } from "npm:@aws-sdk/client-s3@3.1164.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function getSupabaseSecretKey(): string | null {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw);
      const key = keys.default ?? Object.values(keys)[0];
      if (typeof key === "string" && key.length > 0) return key;
    } catch {
      // Use the legacy environment variable below if the JSON is unavailable.
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? null;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  let body: { userId?: unknown; provisioningToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON request." });
  }

  const userId = typeof body.userId === "string" ? body.userId : "";
  const provisioningToken = typeof body.provisioningToken === "string"
    ? body.provisioningToken
    : "";

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    return json(400, { error: "A valid account ID is required." });
  }
  if (!/^[0-9a-f]{64}$/i.test(provisioningToken)) {
    return json(401, { error: "The signup provisioning token is invalid." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseSecretKey = getSupabaseSecretKey();
  const b2KeyId = Deno.env.get("B2_APPLICATION_KEY_ID");
  const b2ApplicationKey = Deno.env.get("B2_APPLICATION_KEY");

  if (!supabaseUrl || !supabaseSecretKey) {
    console.error("Provisioning is missing its Supabase server configuration.");
    return json(500, { error: "Storage setup is not configured on the server." });
  }
  if (!b2KeyId || !b2ApplicationKey) {
    console.error("Provisioning is missing its Backblaze B2 application key secrets.");
    return json(503, { error: "Backblaze storage credentials have not been configured yet." });
  }

  const admin = createClient(supabaseUrl, supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  // Look up the account server-side. Never trust a username or storage path supplied by the browser.
  const { data: userResult, error: userError } = await admin.auth.admin.getUserById(userId);
  const user = userResult?.user;
  if (userError || !user) {
    return json(404, { error: "The new Argon account could not be found." });
  }

  const metadata = user.user_metadata ?? {};
  if (metadata.argon_storage_provisioned === true) {
    return json(200, { success: true, alreadyProvisioned: true });
  }
  if (metadata.argon_storage_provisioning_token !== provisioningToken) {
    return json(401, { error: "The signup provisioning token does not match this account." });
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, username, created_at")
    .eq("id", userId)
    .single();

  if (profileError || !profile || profile.id !== userId) {
    console.error("Profile lookup failed during storage provisioning:", profileError?.message);
    return json(409, { error: "The Argon profile is not ready yet. Sign in again to retry storage setup." });
  }

  const username = String(profile.username ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return json(409, { error: "The Argon username is not valid for storage provisioning." });
  }

  const bucket = "argon-cloud-storage";
  const region = "eu-central-003";
  const endpoint = "https://s3.eu-central-003.backblazeb2.com";
  const userPrefix = `argon/userdata/${userId}/`;
  const createdAt = profile.created_at ?? user.created_at;

  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: b2KeyId,
      secretAccessKey: b2ApplicationKey,
    },
  });

  const objects = [
    {
      Key: `argon/config/users/${userId}.json`,
      Body: jsonBody({
        uid: userId,
        username,
        userdataPrefix: userPrefix,
        createdAt,
        schemaVersion: 1,
      }),
    },
    {
      Key: `${userPrefix}user.json`,
      Body: jsonBody({
        uid: userId,
        username,
        createdAt,
        schemaVersion: 1,
      }),
    },
    {
      Key: `${userPrefix}exhibitions/index.json`,
      Body: jsonBody({
        uid: userId,
        exhibitions: [],
        schemaVersion: 1,
      }),
    },
  ];

  try {
    for (const object of objects) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: object.Key,
        Body: object.Body,
        ContentType: "application/json; charset=utf-8",
      }));
    }
  } catch (error) {
    console.error("B2 object provisioning failed:", error instanceof Error ? error.message : "Unknown B2 error");
    return json(502, {
      error: "Supabase created the account, but Backblaze could not create its storage files. Sign in again to retry.",
      code: "b2_provisioning_failed",
    });
  }

  // Mark complete only after all three objects have been uploaded.
  // Keep other user metadata intact and remove the one-time provisioning token.
  const updatedMetadata = { ...metadata, argon_storage_provisioned: true };
  delete updatedMetadata.argon_storage_provisioning_token;

  const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
    user_metadata: updatedMetadata,
  });

  if (updateError) {
    console.error("Could not mark B2 provisioning complete:", updateError.message);
    return json(502, {
      error: "Storage files were created, but Argon could not mark setup as complete. Sign in again to retry safely.",
      code: "provisioning_completion_failed",
    });
  }

  return json(200, {
    success: true,
    objectsCreated: objects.map((object) => object.Key),
  });
});
