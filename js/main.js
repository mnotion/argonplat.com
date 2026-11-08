// Argon interaction entry point

document.addEventListener("DOMContentLoaded", () => {
  // Bottom dock: browser navigation history + app edit history.
  const dock = document.querySelector(".argon-dock");
  if (dock) {
    const undoStack = [];
    const redoStack = [];
    let replaying = false;

    // Future content actions can register reversible operations here:
    // window.argonHistory.record({ undo: () => ..., redo: () => ... })
    window.argonHistory = {
      record(action) {
        if (!action || typeof action.undo !== "function" || typeof action.redo !== "function") return;
        if (replaying) return;
        undoStack.push(action);
        redoStack.length = 0;
        updateButtons();
      },
      undo() {
        const action = undoStack.pop();
        if (!action) return;
        replaying = true;
        try { action.undo(); redoStack.push(action); } finally { replaying = false; }
        updateButtons();
      },
      redo() {
        const action = redoStack.pop();
        if (!action) return;
        replaying = true;
        try { action.redo(); undoStack.push(action); } finally { replaying = false; }
        updateButtons();
      }
    };

    const updateButtons = () => {
      // Native browser history does not expose a reliable forward-stack length.
      // Keep navigation controls enabled; history.back()/forward() safely no-op at limits.
      dock.querySelector('[data-history="nav-undo"]').disabled = false;
      dock.querySelector('[data-history="nav-redo"]').disabled = false;
      dock.querySelector('[data-history="edit-undo"]').disabled = undoStack.length === 0;
      dock.querySelector('[data-history="edit-redo"]').disabled = redoStack.length === 0;
    };

    window.addEventListener("pageshow", updateButtons);
    window.addEventListener("popstate", updateButtons);

    dock.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-history]");
      if (!button) return;
      switch (button.dataset.history) {
        case "nav-undo": history.back(); break;
        case "nav-redo": history.forward(); break;
        case "edit-undo": window.argonHistory.undo(); break;
        case "edit-redo": window.argonHistory.redo(); break;
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
