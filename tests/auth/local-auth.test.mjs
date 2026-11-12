import assert from "node:assert/strict";
import test from "node:test";

const settings = {
  url: process.env.ARGON_AUTH_TEST_URL,
  publishableKey: process.env.ARGON_AUTH_TEST_PUBLISHABLE_KEY,
  email: process.env.ARGON_AUTH_TEST_EMAIL,
  password: process.env.ARGON_AUTH_TEST_PASSWORD,
};

const missingSettings = Object.entries(settings)
  .filter(([, value]) => !value)
  .map(([name]) => name);

test("local test user can sign in and read its own Argon profile", {
  skip: missingSettings.length
    ? `Set the local auth test values in this terminal: ${missingSettings.join(", ")}`
    : false,
}, async () => {
  const baseUrl = new URL(settings.url);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

  assert.equal(baseUrl.protocol, "http:", "Auth tests must use local HTTP");
  assert.ok(loopbackHosts.has(baseUrl.hostname), "Auth tests must use this computer only");

  const signInResponse = await fetch(new URL("/auth/v1/token?grant_type=password", baseUrl), {
    method: "POST",
    headers: {
      apikey: settings.publishableKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: settings.email, password: settings.password }),
  });

  assert.equal(signInResponse.ok, true, `Local sign-in failed with HTTP ${signInResponse.status}`);
  const session = await signInResponse.json();
  assert.ok(session.access_token, "Supabase should return a signed-in session");
  assert.ok(session.user?.id, "Supabase should return the signed-in user");

  try {
    const profileUrl = new URL("/rest/v1/profiles", baseUrl);
    profileUrl.searchParams.set("select", "id,username,plan,created_at");
    profileUrl.searchParams.set("id", `eq.${session.user.id}`);

    const profileResponse = await fetch(profileUrl, {
      headers: {
        apikey: settings.publishableKey,
        authorization: `Bearer ${session.access_token}`,
      },
    });

    assert.equal(profileResponse.ok, true, `Local profile read failed with HTTP ${profileResponse.status}`);
    const profiles = await profileResponse.json();
    assert.equal(profiles.length, 1, "The signed-in user should see exactly their own profile");
    assert.equal(profiles[0].id, session.user.id, "The returned profile should belong to the signed-in user");
    assert.equal(typeof profiles[0].username, "string");
  } finally {
    await fetch(new URL("/auth/v1/logout", baseUrl), {
      method: "POST",
      headers: {
        apikey: settings.publishableKey,
        authorization: `Bearer ${session.access_token}`,
      },
    });
  }
});
