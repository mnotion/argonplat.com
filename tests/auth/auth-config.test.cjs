const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../../js/auth-config.js"), "utf8");

function loadConfig(hostname, savedValue = null) {
  const localStorage = {
    getItem: () => savedValue,
  };
  const window = {
    location: { hostname },
    localStorage,
  };
  const document = {
    addEventListener: () => {},
  };
  vm.runInNewContext(source, { window, document, URL, Set });
  return window;
}

test("localhost without saved settings uses a local URL and never the hosted project", () => {
  const config = loadConfig("127.0.0.1");
  assert.equal(config.ARGON_SUPABASE_URL, "http://127.0.0.1:54321");
  assert.equal(config.ARGON_LOCAL_TEST_SETUP_REQUIRED, true);
  assert.equal(config.ARGON_SUPABASE_URL.includes(".supabase.co"), false);
});

test("localhost accepts only a loopback Supabase URL", () => {
  const valid = loadConfig("localhost", JSON.stringify({
    url: "http://localhost:54321",
    publishableKey: "local-test-key",
  }));
  assert.equal(valid.ARGON_SUPABASE_URL, "http://localhost:54321");
  assert.equal(valid.ARGON_LOCAL_TEST_SETUP_REQUIRED, false);

  const invalid = loadConfig("localhost", JSON.stringify({
    url: "https://example.supabase.co",
    publishableKey: "local-test-key",
  }));
  assert.equal(invalid.ARGON_SUPABASE_URL, "http://127.0.0.1:54321");
  assert.equal(invalid.ARGON_LOCAL_TEST_SETUP_REQUIRED, true);
});

test("non-local pages retain the existing hosted configuration", () => {
  const config = loadConfig("argonplat.com");
  assert.equal(config.ARGON_SUPABASE_URL, "https://nacwftrsdpglzrhasmit.supabase.co");
  assert.equal(config.ARGON_LOCAL_TEST_SETUP_REQUIRED, false);
});
