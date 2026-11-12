import assert from "node:assert/strict";
import test from "node:test";
import { validateB2Settings } from "../../supabase/functions/_shared/b2-config.mjs";

const safeTestSettings = {
  environment: "test",
  bucket: "argonplat-test-bucket",
  expectedTestBucket: "argonplat-test-bucket",
  region: "eu-central-003",
  endpoint: "https://s3.eu-central-003.backblazeb2.com",
  supabaseUrl: "http://127.0.0.1:54321",
};

test("allows explicit local Supabase and dedicated B2 test bucket", () => {
  assert.equal(validateB2Settings(safeTestSettings), null);
});

test("blocks the production B2 bucket in test mode", () => {
  assert.equal(validateB2Settings({
    ...safeTestSettings,
    bucket: "argon-cloud-storage",
    expectedTestBucket: "argon-cloud-storage",
  }), "The production B2 bucket is blocked in test mode.");
});

test("blocks hosted Supabase projects in test mode", () => {
  assert.equal(validateB2Settings({
    ...safeTestSettings,
    supabaseUrl: "https://example.supabase.co",
  }), "Test mode cannot connect to a hosted Supabase project.");
});

test("requires exact agreement with the test bucket setting", () => {
  assert.equal(validateB2Settings({
    ...safeTestSettings,
    bucket: "some-other-bucket",
  }), "The configured B2 bucket does not match the explicitly approved test bucket.");
});

test("requires the Backblaze endpoint to match its region", () => {
  assert.equal(validateB2Settings({
    ...safeTestSettings,
    endpoint: "https://s3.us-west-004.backblazeb2.com",
  }), "The B2 endpoint host must match the configured Backblaze region.");
});

test("rejects a missing environment marker", () => {
  assert.equal(validateB2Settings({
    ...safeTestSettings,
    environment: "",
  }), "ARGON_ENVIRONMENT must be explicitly set to test or production.");
});
