// Argon interaction entry point

document.addEventListener("DOMContentLoaded", () => {
  const exhibitionLink = document.querySelector(".dashboard-exhibition-link");
  if (exhibitionLink && window.supabase && window.ARGON_SUPABASE_URL && window.ARGON_SUPABASE_PUBLISHABLE_KEY) {
    const authClient = window.supabase.createClient(
      window.ARGON_SUPABASE_URL,
      window.ARGON_SUPABASE_PUBLISHABLE_KEY
    );
    const setExhibitionAccess = (enabled) => {
      exhibitionLink.classList.toggle("is-locked", !enabled);
      exhibitionLink.href = enabled ? "my-exhibition.html" : "account.html";
      exhibitionLink.setAttribute("aria-label", enabled ? "My exhibition" : "Sign in to open My exhibition");
      exhibitionLink.title = enabled ? "" : "Sign in to open and store your resources.";
    };

    authClient.auth.getSession().then(({ data, error }) => {
      setExhibitionAccess(!error && Boolean(data.session?.user));
    }).catch(() => setExhibitionAccess(false));
    authClient.auth.onAuthStateChange((_event, session) => {
      setExhibitionAccess(Boolean(session?.user));
    });
  }

  // Bottom dock: browser navigation history.
  const dock = document.querySelector(".argon-dock");
  if (dock) {
    const updateButtons = () => {
      // Native browser history does not expose a reliable forward-stack length.
      // Keep navigation controls enabled; history.back()/forward() safely no-op at limits.
      const backButton = dock.querySelector('[data-history="nav-undo"]');
      const forwardButton = dock.querySelector('[data-history="nav-redo"]');
      if (backButton) backButton.disabled = false;
      if (forwardButton) forwardButton.disabled = false;
    };

    window.addEventListener("pageshow", updateButtons);
    window.addEventListener("popstate", updateButtons);

    dock.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-history]");
      if (!button) return;
      switch (button.dataset.history) {
        case "nav-undo": history.back(); break;
        case "nav-redo": history.forward(); break;
      }
    });
    updateButtons();
  }

  // Legacy sidebar resize support (only on pages that still include one).
  const sidebar = document.querySelector(".exhibition-sidebar");
  const handle = document.querySelector(".sidebar-resize-handle");
  if (!sidebar || !handle) return;
  let dragging = false;
  const resize = (clientX) => {
    const width = Math.max(0, Math.min(360, clientX - sidebar.getBoundingClientRect().left));
    sidebar.style.flexBasis = width + "px";
    sidebar.style.width = width + "px";
  };
  handle.addEventListener("pointerdown", (event) => {
    dragging = true; handle.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
  });
  handle.addEventListener("pointermove", (event) => { if (dragging) resize(event.clientX); });
  const stop = () => { dragging = false; document.body.style.cursor = ""; document.body.style.userSelect = ""; };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("keydown", (event) => {
    const current = sidebar.getBoundingClientRect().width;
    if (event.key === "ArrowLeft") { resize(sidebar.getBoundingClientRect().left + current - 10); event.preventDefault(); }
    if (event.key === "ArrowRight") { resize(sidebar.getBoundingClientRect().left + current + 10); event.preventDefault(); }
  });
});
