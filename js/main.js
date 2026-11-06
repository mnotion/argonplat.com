// argon site js entry point - just start things here


// sidebar resize logic, roughly
// - find the sidebar and the little grip first
// - if either is missing, dont do anything i guess
// - start at zero because it can hide all the way
// - keep the max so it dont eat the cards
// - while dragging, work out where pointer is
// - clamp width, because negative sidebar is nonsense
// - update flex and width both (browser can be weird)
// - stop dragging on pointer up or cancel
// - arrows also nudges it for keyboard users
document.addEventListener("DOMContentLoaded", () => {
  const sidebar = document.querySelector(".exhibition-sidebar");
  const handle = document.querySelector(".sidebar-resize-handle");
  if (!sidebar || !handle) return;
  const min = 0; // fully tucked away
  const max = 360; // enough sidebar, not the whole page
  let dragging = false;
  // pseudocode: pointer x minus sidebar start = new width
  // - dont let it go past the ends
  // - then tell layout to use that size
  const resize = (clientX) => {
    const width = Math.max(min, Math.min(max, clientX - sidebar.getBoundingClientRect().left));
    sidebar.style.flexBasis = width + "px";
    sidebar.style.width = width + "px";
  };
  // mouse/touch grabs the handle, then browser tracks it
  handle.addEventListener("pointerdown", (event) => {
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  handle.addEventListener("pointermove", (event) => {
    if (dragging) resize(event.clientX);
  });
  // release state, restore normal cursor and selecting
  const stop = () => {
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  // keyboard route is simpler: small step left/right
  handle.addEventListener("keydown", (event) => {
    const current = sidebar.getBoundingClientRect().width;
    if (event.key === "ArrowLeft") { resize(sidebar.getBoundingClientRect().left + current - 10); event.preventDefault(); }
    if (event.key === "ArrowRight") { resize(sidebar.getBoundingClientRect().left + current + 10); event.preventDefault(); }
  });
});
