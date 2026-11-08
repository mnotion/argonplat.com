import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@3.1164.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.1164.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type, x-argon-action, x-argon-folder, x-argon-file-name",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const BUCKET = "argon-cloud-storage";
const REGION = "eu-central-003";
const ENDPOINT = "https://s3.eu-central-003.backblazeb2.com";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function decodeHeader(value: string | null): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function cleanRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === "") return "";
  if (value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
    return null;
  }
  const segments = value.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) return null;
  if (segments.some((part) => part.length > 180)) return null;
  return segments.join("/");
}

function getSecret(rawName: string): string {
  return Deno.env.get(rawName)?.trim() ?? "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });

  const authorization = req.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return json(401, { error: "You must be signed in." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseSecret = (() => {
    const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
    if (raw) {
      try {
        const values = JSON.parse(raw);
        const key = values.default ?? Object.values(values)[0];
        if (typeof key === "string") return key;
      } catch {
        // Use legacy secret below.
      }
    }
    return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  })();

  const b2KeyId = getSecret("B2_APPLICATION_KEY_ID");
  const b2ApplicationKey = getSecret("B2_APPLICATION_KEY");

  if (!supabaseUrl || !supabaseSecret) return json(500, { error: "Storage service is not configured." });
  if (!b2KeyId || !b2ApplicationKey) return json(503, { error: "Backblaze credentials are missing." });
  if (/[\r\n]/.test(b2KeyId) || /[\r\n]/.test(b2ApplicationKey)) {
    return json(503, { error: "Backblaze credentials contain embedded line breaks. Re-save the Supabase secrets." });
  }

  const admin = createClient(supabaseUrl, supabaseSecret, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const { data: { user }, error: authError } = await admin.auth.getUser(match[1]);
  if (authError || !user) return json(401, { error: "Your session is invalid. Log in again." });

  if (
    user.user_metadata?.argon_storage_provisioned !== true ||
    Number(user.user_metadata?.argon_storage_schema_version) < 2
  ) {
    return json(409, { error: "Your B2 storage is not initialized yet. Open your account page and sign in there to finish setup." });
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, username")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) return json(404, { error: "Your Argon profile could not be found." });

  const username = String(profile.username ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return json(409, { error: "Your Argon username is invalid." });

  const userRoot = `argon/userdata/${user.id}_${username}/exhibitions/`;

  const s3 = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: b2KeyId, secretAccessKey: b2ApplicationKey },
  });

  const action = req.headers.get("x-argon-action") ?? "";

  try {
    if (action === "upload") {
      const folder = cleanRelativePath(decodeHeader(req.headers.get("x-argon-folder")));
      const fileName = decodeHeader(req.headers.get("x-argon-file-name"));
      if (folder === null) return json(400, { error: "The target folder path is invalid." });
      if (
        !fileName ||
        fileName === "." ||
        fileName === ".." ||
        fileName.includes("/") ||
        fileName.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(fileName) ||
        fileName.length > 180
      ) return json(400, { error: "The file name is invalid." });

      const length = Number(req.headers.get("content-length") ?? 0);
      if (length > MAX_UPLOAD_BYTES) {
        return json(413, { error: "Files must be 25 MB or smaller for now." });
      }

      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return json(413, { error: "Files must be 25 MB or smaller for now." });
      }
      const key = userRoot + (folder ? folder + "/" : "") + fileName;

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: req.headers.get("content-type") || "application/octet-stream",
        Metadata: { "argon-owner": user.id },
      }));

      return json(200, {
        success: true,
        item: {
          name: fileName,
          path: (folder ? folder + "/" : "") + fileName,
          size: bytes.byteLength,
        },
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Invalid JSON request." });
    }

    if (action === "download-url") {
      const relativeFile = cleanRelativePath(body.file);
      if (relativeFile === null || !relativeFile) return json(400, { error: "The file path is invalid." });

      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: BUCKET,
        Key: userRoot + relativeFile,
        ResponseContentDisposition: "attachment",
      }), { expiresIn: 300 });

      return json(200, { success: true, url });
    }

    const path = cleanRelativePath(body.path);
    if (path === null) return json(400, { error: "The folder path is invalid." });
    const prefix = userRoot + (path ? path + "/" : "");

    if (action === "list") {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        Delimiter: "/",
        MaxKeys: 1000,
      }));

      const folders = (result.CommonPrefixes ?? [])
        .map((entry) => {
          const key = entry.Prefix ?? "";
          const name = key.slice(prefix.length).replaceAll("/", "");
          return name ? { name, type: "folder" } : null;
        })
        .filter(Boolean);

      const files = (result.Contents ?? [])
        .filter((entry) => {
          const key = entry.Key ?? "";
          return key !== prefix && !key.endsWith("/") && key !== userRoot + "index.json";
        })
        .map((entry) => {
          const key = entry.Key ?? "";
          return {
            name: key.slice(prefix.length),
            path: key.slice(userRoot.length),
            type: "file",
            size: entry.Size ?? 0,
            lastModified: entry.LastModified?.toISOString() ?? null,
          };
        })
        .filter((entry) => entry.name && !entry.name.includes("/"));

      return json(200, {
        success: true,
        path,
        folders,
        files,
        truncated: Boolean(result.IsTruncated),
      });
    }

    if (action === "create-folder") {
      const folderName = typeof body.name === "string" ? body.name.trim() : "";
      if (
        !folderName ||
        folderName === "." ||
        folderName === ".." ||
        folderName.includes("/") ||
        folderName.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(folderName) ||
        folderName.length > 100
      ) return json(400, { error: "The folder name is invalid." });

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: prefix + folderName + "/",
        Body: new Uint8Array(),
        ContentType: "application/x-directory",
        Metadata: { "argon-owner": user.id },
      }));
      return json(200, { success: true, folder: folderName });
    }

    return json(400, { error: "Unknown file operation." });
  } catch (error) {
    console.error("Exhibition file operation failed:", error instanceof Error ? error.message : "Unknown error");
    return json(502, {
      error: "Backblaze could not complete this file operation. Check the B2 application key permissions.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
