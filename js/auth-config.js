(() => {
  "use strict";

  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const isLocalHost = localHosts.has(window.location.hostname);

  if (isLocalHost) {
    let localConfig = null;
    try {
      localConfig = JSON.parse(window.localStorage.getItem("argon-local-supabase-config") || "null");
    } catch {
      localConfig = null;
    }

    const url = typeof localConfig?.url === "string" ? localConfig.url : "http://127.0.0.1:54321";
    const publishableKey = typeof localConfig?.publishableKey === "string" ? localConfig.publishableKey : "";
    let safeLocalUrl = false;
    try {
      const parsed = new URL(url);
      safeLocalUrl = parsed.protocol === "http:" && localHosts.has(parsed.hostname);
    } catch {
      safeLocalUrl = false;
    }

    window.ARGON_SUPABASE_URL = safeLocalUrl ? url : "http://127.0.0.1:54321";
    window.ARGON_SUPABASE_PUBLISHABLE_KEY = publishableKey || "local-test-setup-required";
    window.ARGON_LOCAL_TEST_SETUP_REQUIRED = !safeLocalUrl || !publishableKey;

    if (window.ARGON_LOCAL_TEST_SETUP_REQUIRED) {
      document.addEventListener("DOMContentLoaded", () => {
        const notice = document.createElement("aside");
        notice.setAttribute("role", "status");
        notice.style.cssText = "position:fixed;z-index:9999;right:12px;bottom:12px;max-width:360px;padding:12px 16px;background:#fff;border:1px solid #999;color:#111;font:14px/1.4 sans-serif;box-shadow:0 2px 10px #0002";
        notice.append("Local Supabase test settings are missing. ");
        const link = document.createElement("a");
        link.href = "local-test-setup.html";
        link.textContent = "Configure the local test connection";
        notice.append(link);
        document.body.append(notice);
      });
    }
    return;
  }

  // Hosted pages use the existing browser-safe public configuration.
  window.ARGON_SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
  window.ARGON_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
  window.ARGON_LOCAL_TEST_SETUP_REQUIRED = false;
})();
