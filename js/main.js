// entry point


// sidebar resize login, roughly
document.addEventListener("DOMContentLoaded", () => {
  const sidebar = document.querySelector(".exhibition-sidebar");
  const handle = document.querySelector(".sidebar-resize-handle");
  if (!sidebar || !handle) return;
  const min = 0;
  const max = 360;
  let dragging = false;


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
