/**
 * @typedef {Object} B2SettingsInput
 * @property {string} environment
 * @property {string} bucket
 * @property {string} expectedTestBucket
 * @property {string} region
 * @property {string} endpoint
 * @property {string} supabaseUrl
 */

/**
 * @typedef {Object} B2Settings
 * @property {string} bucket
 * @property {string} region
 * @property {string} endpoint
 */

/** @param {B2SettingsInput} input @returns {string | null} */
export function validateB2Settings(input) {
  if (input.environment !== "test" && input.environment !== "production") {
    return "ARGON_ENVIRONMENT must be explicitly set to test or production.";
  }
  if (!input.bucket || !input.region || !input.endpoint || !input.supabaseUrl) {
    return "B2 bucket, region, endpoint, and Supabase URL must all be configured.";
  }

  let endpoint;
  let supabaseUrl;
  try {
    endpoint = new URL(input.endpoint);
    supabaseUrl = new URL(input.supabaseUrl);
  } catch {
    return "The B2 endpoint or Supabase URL is invalid.";
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    return "The B2 endpoint must be a clean HTTPS URL.";
  }
  if (endpoint.hostname !== `s3.${input.region}.backblazeb2.com`) {
    return "The B2 endpoint host must match the configured Backblaze region.";
  }

  if (input.environment === "test") {
    if (!input.expectedTestBucket || input.bucket !== input.expectedTestBucket) {
      return "The configured B2 bucket does not match the explicitly approved test bucket.";
    }
    if (input.bucket === "argon-cloud-storage") {
      return "The production B2 bucket is blocked in test mode.";
    }
    if (supabaseUrl.hostname.endsWith(".supabase.co")) {
      return "Test mode cannot connect to a hosted Supabase project.";
    }
  }

  return null;
}

/**
 * @param {string} supabaseUrl
 * @param {(name: string) => string | undefined} getEnv
 * @returns {B2Settings}
 */
export function readB2Settings(supabaseUrl, getEnv) {
  const input = {
    environment: getEnv("ARGON_ENVIRONMENT")?.trim() ?? "",
    bucket: getEnv("B2_BUCKET")?.trim() ?? "",
    expectedTestBucket: getEnv("ARGON_TEST_B2_BUCKET")?.trim() ?? "",
    region: getEnv("B2_REGION")?.trim() ?? "",
    endpoint: getEnv("B2_ENDPOINT")?.trim() ?? "",
    supabaseUrl: supabaseUrl.trim(),
  };
  const error = validateB2Settings(input);
  if (error) throw new Error(error);
  return { bucket: input.bucket, region: input.region, endpoint: input.endpoint };
}
