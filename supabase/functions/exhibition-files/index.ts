import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3@3.1164.0";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.1164.0";
import { readB2Settings } from "../_shared/b2-config.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type, x-argon-action, x-argon-relative-path, x-argon-exhibition-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const EID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const EID_PATTERN = /^[A-Za-z0-9]{8}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type AdminClient = ReturnType<typeof createClient>;
type ExhibitionIdentity = { eid: string; instanceId: string };
type ExhibitionEntry = {
  id: string;
  title: string;
  color: string;
  eid?: string;
  instanceId?: string;
};

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

function getExhibitionPrefix(exhibitionId: unknown, userId: string, userDataRoot: string): string | null {
  if (exhibitionId === "legacy") return userDataRoot + "content/";
  if (typeof exhibitionId !== "string") return null;
  if (cleanRelativePath(exhibitionId) !== exhibitionId || exhibitionId.includes("/")) return null;
  const legacySuffix = "_" + userId;
  const eidSuffix = "_" + userId + "_";
  const eidIndex = exhibitionId.lastIndexOf(eidSuffix);
  const hasLegacyId = exhibitionId.endsWith(legacySuffix);
  const hasEidId = eidIndex > 0 && EID_PATTERN.test(exhibitionId.slice(eidIndex + eidSuffix.length));
  if (!hasLegacyId && !hasEidId) return null;
  return userDataRoot + "exhibitions/" + exhibitionId + "/";
}

async function readExhibitionMetadata(s3: S3Client, bucket: string, key: string): Promise<Record<string, unknown> | null> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!object.Body) return null;
    const text = await object.Body.transformToString();
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw error;
  }
}

function randomEid(): string {
  const bytes = new Uint8Array(16);
  while (true) {
    let eid = "";
    while (eid.length < 8) {
      crypto.getRandomValues(bytes);
      for (const byte of bytes) {
        // 248 is the largest multiple of 62 below 256, so each character is unbiased.
        if (byte >= 248) continue;
        eid += EID_ALPHABET[byte % EID_ALPHABET.length];
        if (eid.length === 8) break;
      }
    }
    if (/[A-Za-z]/.test(eid) && /[0-9]/.test(eid)) return eid;
  }
}

async function lookupEidReservation(
  admin: AdminClient,
  column: "eid" | "instance_id",
  value: string,
): Promise<{ eid: string; instance_id: string; owner_id: string } | null> {
  const { data, error } = await admin
    .from("exhibition_eid_registry")
    .select("eid, instance_id, owner_id")
    .eq(column, value)
    .maybeSingle();
  if (error) throw new Error("Could not check the exhibition ID registry: " + error.message);
  return data;
}

async function reserveNewIdentity(
  admin: AdminClient,
  ownerId: string,
  preferredInstanceId?: string,
): Promise<ExhibitionIdentity> {
  let instanceId = preferredInstanceId && UUID_PATTERN.test(preferredInstanceId)
    ? preferredInstanceId
    : "";
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = {
      eid: randomEid(),
      instance_id: instanceId || crypto.randomUUID(),
      owner_id: ownerId,
    };
    const { error } = await admin.from("exhibition_eid_registry").insert(candidate);
    if (!error) return { eid: candidate.eid, instanceId: candidate.instance_id };
    if (error.code !== "23505") {
      throw new Error("Could not reserve a unique exhibition ID: " + error.message);
    }

    const existingInstance = await lookupEidReservation(admin, "instance_id", candidate.instance_id);
    if (existingInstance?.owner_id === ownerId) {
      return { eid: existingInstance.eid, instanceId: existingInstance.instance_id };
    }
    instanceId = "";
  }
  throw new Error("Could not reserve a unique exhibition ID after several attempts.");
}

async function ensureExhibitionIdentity(
  admin: AdminClient,
  ownerId: string,
  id: string,
  metadata: Record<string, unknown> | null,
): Promise<ExhibitionIdentity> {
  const metadataEid = typeof metadata?.eid === "string" && EID_PATTERN.test(metadata.eid)
    ? metadata.eid
    : "";
  const metadataInstanceId = typeof metadata?.instanceId === "string" && UUID_PATTERN.test(metadata.instanceId)
    ? metadata.instanceId
    : "";
  const suffix = "_" + ownerId + "_";
  const suffixIndex = id.lastIndexOf(suffix);
  const pathEid = suffixIndex > 0 && EID_PATTERN.test(id.slice(suffixIndex + suffix.length))
    ? id.slice(suffixIndex + suffix.length)
    : "";

  if (metadataInstanceId) {
    const existing = await lookupEidReservation(admin, "instance_id", metadataInstanceId);
    if (existing?.owner_id === ownerId) {
      return { eid: existing.eid, instanceId: existing.instance_id };
    }
  }

  const candidateEid = metadataEid || pathEid;
  if (candidateEid) {
    const existing = await lookupEidReservation(admin, "eid", candidateEid);
    if (existing?.owner_id === ownerId && (!metadataInstanceId || existing.instance_id === metadataInstanceId)) {
      return { eid: existing.eid, instanceId: existing.instance_id };
    }
    if (!existing) {
      const instanceId = metadataInstanceId || crypto.randomUUID();
      const { error } = await admin.from("exhibition_eid_registry").insert({
        eid: candidateEid,
        instance_id: instanceId,
        owner_id: ownerId,
      });
      if (!error) return { eid: candidateEid, instanceId };
      if (error.code !== "23505") {
        throw new Error("Could not register the exhibition ID: " + error.message);
      }
      const byInstance = await lookupEidReservation(admin, "instance_id", instanceId);
      if (byInstance?.owner_id === ownerId) {
        return { eid: byInstance.eid, instanceId: byInstance.instance_id };
      }
      const byEid = await lookupEidReservation(admin, "eid", candidateEid);
      if (byEid?.owner_id === ownerId && (!metadataInstanceId || byEid.instance_id === metadataInstanceId)) {
        return { eid: byEid.eid, instanceId: byEid.instance_id };
      }
    }
  }

  return reserveNewIdentity(admin, ownerId, metadataInstanceId || undefined);
}

async function listCurrentObjects(s3: S3Client, bucket: string, prefix: string) {
  const objects: Array<{ key: string; size: number; etag: string }> = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    for (const item of page.Contents ?? []) {
      if (!item.Key) continue;
      objects.push({ key: item.Key, size: item.Size ?? 0, etag: item.ETag ?? "" });
    }
    if (page.IsTruncated && !page.NextContinuationToken) {
      throw new Error("B2 did not provide a continuation token while listing exhibition files.");
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

async function deleteAllObjectVersions(
  s3: S3Client,
  bucket: string,
  prefix: string,
  options: { excludeKey?: string; exactKey?: string } = {},
) {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: prefix,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
      MaxKeys: 1000,
    }));
    const versions = [
      ...(page.Versions ?? []).map((item) => ({ Key: item.Key, VersionId: item.VersionId })),
      ...(page.DeleteMarkers ?? []).map((item) => ({ Key: item.Key, VersionId: item.VersionId })),
    ].filter((item): item is { Key: string; VersionId: string } => {
      if (!item.Key || !item.VersionId) return false;
      if (options.excludeKey && item.Key === options.excludeKey) return false;
      if (options.exactKey && item.Key !== options.exactKey) return false;
      return true;
    });
    for (let index = 0; index < versions.length; index += 1000) {
      const result = await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: versions.slice(index, index + 1000), Quiet: true },
      }));
      if (result.Errors?.length) {
        throw new Error("B2 could not permanently remove every old exhibition file version. The bucket key needs permission to delete file versions.");
      }
    }
    if (page.IsTruncated && !page.NextKeyMarker) {
      throw new Error("B2 did not provide a continuation marker while removing exhibition file versions.");
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);
}

async function moveExhibitionPrefix(
  s3: S3Client,
  bucket: string,
  sourcePrefix: string,
  targetPrefix: string,
  sourceId: string,
  sourceMetadataKey: string,
  targetId: string,
  nextMetadata: Record<string, unknown>,
  identity: ExhibitionIdentity,
  ownerId: string,
) {
  const targetMetadataKey = targetPrefix + ".argon.json";
  const committedTarget = await readExhibitionMetadata(s3, bucket, targetMetadataKey);
  const alreadyCommitted = committedTarget?.ownerId === ownerId &&
    committedTarget.eid === identity.eid &&
    committedTarget.instanceId === identity.instanceId &&
    committedTarget.id === targetId;

  if (!alreadyCommitted) {
    if (committedTarget) {
      throw new Error("The destination folder already belongs to another exhibition.");
    }

    const sourceObjects = await listCurrentObjects(s3, bucket, sourcePrefix);
    const existingTargetObjects = await listCurrentObjects(s3, bucket, targetPrefix);
    const expectedByKey = new Map(sourceObjects
      .filter((item) => item.key !== sourceMetadataKey)
      .map((item) => [targetPrefix + item.key.slice(sourcePrefix.length), item]));
    const existingTargetIsCompatible = existingTargetObjects.every((item) => {
      const expected = expectedByKey.get(item.key);
      return Boolean(expected) && expected!.size === item.size &&
        (!expected!.etag || !item.etag || expected!.etag === item.etag);
    });

    if (!existingTargetIsCompatible) {
      await deleteAllObjectVersions(s3, bucket, targetPrefix);
    }

    const targetKeys = new Set(existingTargetIsCompatible ? existingTargetObjects.map((item) => item.key) : []);
    for (const item of sourceObjects) {
      if (item.key === sourceMetadataKey) continue;
      const destinationKey = targetPrefix + item.key.slice(sourcePrefix.length);
      if (targetKeys.has(destinationKey)) continue;
      const copySource = `/${bucket}/${item.key.split("/").map(encodeURIComponent).join("/")}`;
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: destinationKey,
        CopySource: copySource,
        MetadataDirective: "COPY",
      }));
      const copied = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: destinationKey }));
      if ((copied.ContentLength ?? 0) !== item.size) {
        throw new Error("B2 could not verify every copied exhibition file; the original folder was kept.");
      }
    }

    const copiedObjects = await listCurrentObjects(s3, bucket, targetPrefix);
    const copiedByKey = new Map(copiedObjects.map((item) => [item.key, item]));
    for (const [destinationKey, source] of expectedByKey) {
      const copied = copiedByKey.get(destinationKey);
      if (!copied || copied.size !== source.size) {
        throw new Error("B2 could not verify every copied exhibition file; the original folder was kept.");
      }
    }
    if (copiedObjects.length !== expectedByKey.size) {
      throw new Error("The destination folder contains unexpected files; the original folder was kept.");
    }

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: targetMetadataKey,
      Body: JSON.stringify(nextMetadata),
      ContentType: "application/json; charset=utf-8",
      Metadata: { "argon-owner": ownerId },
    }));
    const confirmed = await readExhibitionMetadata(s3, bucket, targetMetadataKey);
    if (
      confirmed?.ownerId !== ownerId || confirmed.eid !== identity.eid ||
      confirmed.instanceId !== identity.instanceId || confirmed.id !== targetId
    ) {
      throw new Error("B2 did not confirm the renamed exhibition record; the original folder was kept.");
    }
  }

  // The destination is complete. Mark the source so a later request can finish cleanup safely.
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: sourceMetadataKey,
    Body: JSON.stringify({ ...nextMetadata, id: sourceId, movedTo: targetId }),
    ContentType: "application/json; charset=utf-8",
    Metadata: { "argon-owner": ownerId },
  }));

  // Permanently remove the old versions after the verified copy so B2 does not retain a second billable copy.
  await deleteAllObjectVersions(s3, bucket, sourcePrefix, { excludeKey: sourceMetadataKey });
  await deleteAllObjectVersions(s3, bucket, sourceMetadataKey, { exactKey: sourceMetadataKey });
}

async function listExhibitions(
  admin: AdminClient,
  s3: S3Client,
  bucket: string,
  userDataRoot: string,
  userId: string,
): Promise<ExhibitionEntry[]> {
  const exhibitionsRoot = userDataRoot + "exhibitions/";
  const [objects, legacyObjects] = await Promise.all([
    s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: exhibitionsRoot,
      Delimiter: "/",
      MaxKeys: 1000,
    })),
    s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: userDataRoot + "content/",
      Delimiter: "/",
      MaxKeys: 1000,
    })),
  ]);

  const exhibitions: ExhibitionEntry[] = [];
  const seenEids = new Set<string>();
  for (const entry of objects.CommonPrefixes ?? []) {
    const prefix = entry.Prefix ?? "";
    const id = prefix.slice(exhibitionsRoot.length).replaceAll("/", "");
    if (!id) continue;
    const metadataKey = prefix + ".argon.json";
    let metadata = await readExhibitionMetadata(s3, bucket, metadataKey);
    let restoredPendingMove = false;
    if (metadata?.ownerId && metadata.ownerId !== userId) continue;

    if (typeof metadata?.movedTo === "string") {
      const movedTo = metadata.movedTo;
      const movedToPrefix = exhibitionsRoot + movedTo + "/";
      const movedToMetadata = await readExhibitionMetadata(s3, bucket, movedToPrefix + ".argon.json");
      if (
        movedToMetadata?.ownerId === userId &&
        movedToMetadata.instanceId === metadata.instanceId &&
        movedToMetadata.eid === metadata.eid
      ) {
        await deleteAllObjectVersions(s3, bucket, prefix);
        continue;
      }
      const { movedTo: _movedTo, ...restoredMetadata } = metadata;
      metadata = restoredMetadata;
      restoredPendingMove = true;
    }

    let identity = await ensureExhibitionIdentity(admin, userId, id, metadata);
    if (seenEids.has(identity.eid)) {
      identity = await reserveNewIdentity(admin, userId);
    }
    seenEids.add(identity.eid);

    let baseName = id;
    const eidSuffix = "_" + userId + "_";
    const eidIndex = id.lastIndexOf(eidSuffix);
    if (eidIndex > 0 && EID_PATTERN.test(id.slice(eidIndex + eidSuffix.length))) {
      baseName = id.slice(0, eidIndex);
    } else if (id.endsWith("_" + userId)) {
      baseName = id.slice(0, -(userId.length + 1));
    }
    const fallbackTitle = baseName.replace(/[-_]+/g, " ");
    const title = typeof metadata?.title === "string" ? metadata.title : fallbackTitle;
    const color = typeof metadata?.color === "string" && /^#[0-9a-f]{6}$/i.test(metadata.color)
      ? metadata.color
      : "#d8d8d8";
    const nextMetadata = {
      ...(metadata ?? {}),
      id,
      title,
      color,
      ownerId: userId,
      eid: identity.eid,
      instanceId: identity.instanceId,
    };
    if (
      !metadata || metadata.id !== id || metadata.title !== title || metadata.color !== color ||
      metadata.ownerId !== userId || metadata.eid !== identity.eid || metadata.instanceId !== identity.instanceId ||
      restoredPendingMove
    ) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: metadataKey,
        Body: JSON.stringify(nextMetadata),
        ContentType: "application/json; charset=utf-8",
        Metadata: { "argon-owner": userId },
      }));
    }
    exhibitions.push({ id, title, color, eid: identity.eid, instanceId: identity.instanceId });
  }

  const legacyPrefix = userDataRoot + "content/";
  const hasLegacyContent = (legacyObjects.CommonPrefixes?.length ?? 0) > 0 ||
    (legacyObjects.Contents ?? []).some((entry) => {
      const key = entry.Key ?? "";
      return key !== legacyPrefix + "index.json" && key !== legacyPrefix && !key.endsWith("/");
    });
  if (hasLegacyContent) {
    exhibitions.push({ id: "legacy", title: "My exhibition", color: "#d8d8d8" });
  }

  return exhibitions;
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
  let b2Settings: ReturnType<typeof readB2Settings>;
  try {
    b2Settings = readB2Settings(supabaseUrl, (name) => Deno.env.get(name));
  } catch (error) {
    return json(503, { error: error instanceof Error ? error.message : "B2 storage configuration is invalid." });
  }
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
    Number(user.user_metadata?.argon_storage_schema_version) < 4
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

  const userDataRoot = `argon/userdata/${user.id}_${username}/`;

  const s3 = new S3Client({
    region: b2Settings.region,
    endpoint: b2Settings.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: b2KeyId, secretAccessKey: b2ApplicationKey },
  });

  const action = req.headers.get("x-argon-action") ?? "";

  try {
    if (action === "upload") {
      const exhibitionId = decodeHeader(req.headers.get("x-argon-exhibition-id"));
      const exhibitionPrefix = getExhibitionPrefix(exhibitionId, user.id, userDataRoot);
      if (!exhibitionPrefix) return json(400, { error: "The exhibition is invalid." });

      const relativePath = cleanRelativePath(decodeHeader(req.headers.get("x-argon-relative-path")));
      if (relativePath === null || !relativePath) {
        return json(400, { error: "The upload path is invalid." });
      }

      const segments = relativePath.split("/");
      if (relativePath === ".argon.json") {
        return json(400, { error: "That file name is reserved for exhibition settings." });
      }
      if (segments.some((part) => part.length > 180)) {
        return json(400, { error: "A path or file name is too long." });
      }

      const length = Number(req.headers.get("content-length") ?? 0);
      if (length > MAX_UPLOAD_BYTES) {
        return json(413, { error: "Files must be 25 MB or smaller for now." });
      }

      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return json(413, { error: "Files must be 25 MB or smaller for now." });
      }

      const key = exhibitionPrefix + relativePath;
      await s3.send(new PutObjectCommand({
        Bucket: b2Settings.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: req.headers.get("content-type") || "application/octet-stream",
        Metadata: { "argon-owner": user.id },
      }));

      return json(200, {
        success: true,
        item: {
          name: segments[segments.length - 1],
          path: relativePath,
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

    if (action === "list-exhibitions") {
      const exhibitions = await listExhibitions(admin, s3, b2Settings.bucket, userDataRoot, user.id);
      return json(200, { success: true, exhibitions });
    }

    if (action === "create-exhibition") {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const color = typeof body.color === "string" ? body.color.trim() : "#d8d8d8";
      if (
        !title || title.length > 100 || title.includes("/") || title.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(title)
      ) return json(400, { error: "The exhibition name is invalid." });
      if (!/^#[0-9a-f]{6}$/i.test(color)) return json(400, { error: "The exhibition colour is invalid." });

      const current = await listExhibitions(admin, s3, b2Settings.bucket, userDataRoot, user.id);
      if (current.length >= 2) return json(409, { error: "Free accounts can create up to 2 exhibitions." });
      if (current.some((item) => item.title.toLocaleLowerCase() === title.toLocaleLowerCase())) {
        return json(409, { error: "An exhibition with that name already exists." });
      }

      const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "exhibition";
      const identity = await reserveNewIdentity(admin, user.id);
      const id = `${slug}_${user.id}_${identity.eid}`;
      const exhibitionPrefix = userDataRoot + "exhibitions/" + id + "/";
      await s3.send(new PutObjectCommand({
        Bucket: b2Settings.bucket,
        Key: exhibitionPrefix + ".argon.json",
        Body: JSON.stringify({
          id,
          title,
          color,
          eid: identity.eid,
          instanceId: identity.instanceId,
          createdAt: new Date().toISOString(),
          ownerId: user.id,
        }),
        ContentType: "application/json; charset=utf-8",
        Metadata: { "argon-owner": user.id },
      }));

      return json(200, { success: true, exhibition: { id, title, color, eid: identity.eid } });
    }

    if (action === "update-exhibition") {
      const id = typeof body.exhibitionId === "string" ? body.exhibitionId : "";
      const exhibitionPrefix = getExhibitionPrefix(id, user.id, userDataRoot);
      if (!exhibitionPrefix || id === "legacy") return json(400, { error: "This exhibition cannot be changed." });
      const metadataKey = exhibitionPrefix + ".argon.json";
      let metadata = await readExhibitionMetadata(s3, b2Settings.bucket, metadataKey);
      if (!metadata) return json(404, { error: "The exhibition could not be found." });
      if (metadata.ownerId !== user.id) return json(403, { error: "You cannot change this exhibition." });

      const nextTitle = typeof body.title === "string" ? body.title.trim() : String(metadata.title ?? "");
      const nextColor = typeof body.color === "string" ? body.color.trim() : String(metadata.color ?? "#d8d8d8");
      if (!nextTitle || nextTitle.length > 100 || nextTitle.includes("/") || nextTitle.includes("\\") || /[\u0000-\u001f\u007f]/.test(nextTitle)) {
        return json(400, { error: "The exhibition name is invalid." });
      }
      if (!/^#[0-9a-f]{6}$/i.test(nextColor)) return json(400, { error: "The exhibition colour is invalid." });
      const current = await listExhibitions(admin, s3, b2Settings.bucket, userDataRoot, user.id);
      const exhibition = current.find((item) => item.id === id);
      if (!exhibition || !exhibition.eid || !exhibition.instanceId) {
        return json(404, { error: "The exhibition identity could not be loaded." });
      }
      metadata = await readExhibitionMetadata(s3, b2Settings.bucket, metadataKey);
      if (!metadata) return json(404, { error: "The exhibition could not be found." });
      if (metadata.ownerId !== user.id) return json(403, { error: "You cannot change this exhibition." });
      if (current.some((item) => item.id !== id && item.title.toLocaleLowerCase() === nextTitle.toLocaleLowerCase())) {
        return json(409, { error: "An exhibition with that name already exists." });
      }

      const slug = nextTitle.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "exhibition";
      const nextId = `${slug}_${user.id}_${exhibition.eid}`;
      const nextPrefix = userDataRoot + "exhibitions/" + nextId + "/";
      const existingTarget = current.find((item) => item.id === nextId);
      if (nextId !== id && existingTarget && existingTarget.instanceId !== exhibition.instanceId) {
        return json(409, { error: "That name conflicts with an existing exhibition folder." });
      }

      const nextMetadata = {
        ...metadata,
        id: nextId,
        title: nextTitle,
        color: nextColor,
        eid: exhibition.eid,
        instanceId: exhibition.instanceId,
        ownerId: user.id,
        updatedAt: new Date().toISOString(),
      };
      if (nextId !== id) {
        await moveExhibitionPrefix(
          s3,
          b2Settings.bucket,
          exhibitionPrefix,
          nextPrefix,
          id,
          metadataKey,
          nextId,
          nextMetadata,
          { eid: exhibition.eid, instanceId: exhibition.instanceId },
          user.id,
        );
      } else {
        await s3.send(new PutObjectCommand({
          Bucket: b2Settings.bucket,
          Key: metadataKey,
          Body: JSON.stringify(nextMetadata),
          ContentType: "application/json; charset=utf-8",
          Metadata: { "argon-owner": user.id },
        }));
      }
      return json(200, { success: true, exhibition: { id: nextId, title: nextTitle, color: nextColor, eid: exhibition.eid } });
    }

    if (action === "delete-exhibition") {
      const id = typeof body.exhibitionId === "string" ? body.exhibitionId : "";
      const exhibitionPrefix = getExhibitionPrefix(id, user.id, userDataRoot);
      if (!exhibitionPrefix || id === "legacy") return json(400, { error: "This exhibition cannot be deleted." });
      const metadata = await readExhibitionMetadata(s3, b2Settings.bucket, exhibitionPrefix + ".argon.json");
      if (!metadata) return json(404, { error: "The exhibition could not be found." });
      if (metadata.ownerId !== user.id) return json(403, { error: "You cannot delete this exhibition." });

      let continuationToken: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({
          Bucket: b2Settings.bucket,
          Prefix: exhibitionPrefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }));
        const keys = (page.Contents ?? []).map((item) => item.Key).filter((key): key is string => Boolean(key));
        if (keys.length) {
          await s3.send(new DeleteObjectsCommand({
            Bucket: b2Settings.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }));
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
      return json(200, { success: true });
    }

    if (action === "download-url") {
      const exhibitionPrefix = getExhibitionPrefix(body.exhibitionId, user.id, userDataRoot);
      const relativeFile = cleanRelativePath(body.file);
      if (!exhibitionPrefix) return json(400, { error: "The exhibition is invalid." });
      if (relativeFile === null || !relativeFile) return json(400, { error: "The file path is invalid." });

      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: b2Settings.bucket,
        Key: exhibitionPrefix + relativeFile,
        ResponseContentDisposition: "attachment",
      }), { expiresIn: 300 });

      return json(200, { success: true, url });
    }

    const exhibitionPrefix = getExhibitionPrefix(body.exhibitionId, user.id, userDataRoot);
    const path = cleanRelativePath(body.path);
    if (!exhibitionPrefix) return json(400, { error: "The exhibition is invalid." });
    if (path === null) return json(400, { error: "The folder path is invalid." });
    const prefix = exhibitionPrefix + (path ? path + "/" : "");

    if (action === "list") {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: b2Settings.bucket,
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
          return key !== prefix && !key.endsWith("/") && key !== exhibitionPrefix + ".argon.json";
        })
        .map((entry) => {
          const key = entry.Key ?? "";
          return {
            name: key.slice(prefix.length),
            path: key.slice(exhibitionPrefix.length),
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
        folderName.length > 180
      ) return json(400, { error: "The folder name is invalid." });

      await s3.send(new PutObjectCommand({
        Bucket: b2Settings.bucket,
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
