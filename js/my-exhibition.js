(() => {
  "use strict";

  const { createClient } = window.supabase;
  const supabase = createClient(
    window.ARGON_SUPABASE_URL,
    window.ARGON_SUPABASE_PUBLISHABLE_KEY
  );

  const endpoint = window.ARGON_SUPABASE_URL.replace(/\/+$/, "") + "/functions/v1/exhibition-files";
  const status = document.getElementById("exhibition-sync-status");
  const message = document.getElementById("file-explorer-message");
  const list = document.getElementById("file-explorer-list");
  const breadcrumbs = document.getElementById("file-explorer-breadcrumbs");
  const dropZone = document.getElementById("file-drop-zone");
  const picker = document.getElementById("file-picker");
  const uploadButton = document.getElementById("upload-files-button");
  const refreshButton = document.getElementById("refresh-files-button");
  const newFolderButton = document.getElementById("new-folder-button");
  const newFolderForm = document.getElementById("new-folder-form");
  const newFolderName = document.getElementById("new-folder-name");
  const cancelNewFolder = document.getElementById("cancel-new-folder");

  let accessToken = null;
  let currentPath = "";
  let busy = false;

  function setStatus(value) {
    status.textContent = value;
    const normalized = value.toLowerCase();
    status.dataset.state = normalized.includes("fail") ? "error" :
      normalized.includes("syncing") || normalized.includes("connecting") ? "syncing" : "ready";
  }

  function setMessage(value) {
    message.textContent = value || "";
  }

  function showSignedOut() {
    list.replaceChildren();
    const text = document.createElement("p");
    text.className = "file-explorer-empty";
    text.textContent = "Sign in to open your exhibition.";
    const link = document.createElement("a");
    link.href = "account.html";
    link.textContent = "open your Argon account";
    text.append(" ", link);
    list.append(text);
    setStatus("not connected");
  }

  async function responseJson(response) {
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { data = { error: raw || "The file service returned an invalid response." }; }
    if (!response.ok) {
      const detail = data.detail ? " (" + data.detail + ")" : "";
      throw new Error((data.error || "File operation failed.") + detail);
    }
    return data;
  }

  async function callService(action, body = {}) {
    if (!accessToken) throw new Error("Your session has expired. Sign in again.");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + accessToken,
        "apikey": window.ARGON_SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
        "x-argon-action": action
      },
      body: JSON.stringify(body)
    });
    return responseJson(response);
  }

  function makeButton(text, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function renderBreadcrumbs() {
    breadcrumbs.replaceChildren();
    const root = makeButton("exhibitions", "", () => loadFolder(""));
    breadcrumbs.append(root);

    if (!currentPath) return;
    const parts = currentPath.split("/");
    let cumulative = "";
    parts.forEach((part, index) => {
      const divider = document.createElement("span");
      divider.className = "file-explorer-crumb-divider";
      divider.textContent = "/";
      breadcrumbs.append(divider);

      cumulative = cumulative ? cumulative + "/" + part : part;
      const path = cumulative;
      const button = makeButton(part, "", () => loadFolder(path));
      if (index === parts.length - 1) {
        button.setAttribute("aria-current", "page");
      }
      breadcrumbs.append(button);
    });
  }

  function formatSize(bytes) {
    if (!bytes) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function renderEntry(item) {
    const row = document.createElement("div");
    row.className = "file-explorer-entry";
    row.setAttribute("role", "listitem");

    const nameGroup = document.createElement("div");
    nameGroup.className = "file-entry-name-group";
    const icon = document.createElement("span");
    icon.className = "file-entry-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = item.type === "folder" ? "▰" : "▤";

    const name = document.createElement("span");
    name.className = "file-entry-name";
    name.textContent = item.name;
    nameGroup.append(icon, name);
    row.append(nameGroup);

    if (item.type === "folder") {
      row.classList.add("is-folder");
      row.append(makeButton("open", "file-entry-action", () => {
        const next = currentPath ? currentPath + "/" + item.name : item.name;
        loadFolder(next);
      }));
    } else {
      const details = document.createElement("span");
      details.className = "file-entry-details";
      details.textContent = formatSize(item.size);
      row.append(details);
      row.append(makeButton("download", "file-entry-action", () => downloadFile(item.path)));
    }
    return row;
  }

  async function loadFolder(path) {
    currentPath = path;
    renderBreadcrumbs();
    list.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "file-explorer-loading";
    loading.textContent = "Loading…";
    list.append(loading);
    setStatus("syncing…");
    setMessage("");

    try {
      const result = await callService("list", { path: currentPath });
      list.replaceChildren();
      const entries = [...result.folders, ...result.files];
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      if (!entries.length) {
        const empty = document.createElement("p");
        empty.className = "file-explorer-empty";
        empty.textContent = "This folder is empty. Drop files here to add them.";
        list.append(empty);
      } else {
        entries.forEach((item) => list.append(renderEntry(item)));
      }

      if (result.truncated) {
        const note = document.createElement("p");
        note.className = "file-explorer-empty";
        note.textContent = "Showing the first 1,000 items in this folder.";
        list.append(note);
      }
      setStatus("all changes synced");
    } catch (error) {
      list.replaceChildren();
      const failed = document.createElement("p");
      failed.className = "file-explorer-empty";
      failed.textContent = "Could not load this folder: " + error.message;
      list.append(failed);
      setStatus("sync failed");
    }
  }

  async function downloadFile(path) {
    try {
      setStatus("preparing download…");
      const result = await callService("download-url", { file: path });
      window.location.assign(result.url);
      setStatus("all changes synced");
    } catch (error) {
      setStatus("sync failed");
      setMessage(error.message);
    }
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || busy) return;
    busy = true;
    uploadButton.disabled = true;
    newFolderButton.disabled = true;
    refreshButton.disabled = true;
    const targetFolder = currentPath;
    let uploaded = 0;
    const failures = [];

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (file.size > 25 * 1024 * 1024) {
          failures.push(file.name + " is larger than 25 MB.");
          continue;
        }

        setStatus("syncing " + (index + 1) + " of " + files.length + "…");
        setMessage("Uploading " + file.name + "…");

        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + accessToken,
            "apikey": window.ARGON_SUPABASE_PUBLISHABLE_KEY,
            "Content-Type": file.type || "application/octet-stream",
            "x-argon-action": "upload",
            "x-argon-folder": encodeURIComponent(targetFolder),
            "x-argon-file-name": encodeURIComponent(file.name)
          },
          body: file
        });
        await responseJson(response);
        uploaded += 1;
      }

      await loadFolder(targetFolder);
      if (failures.length) {
        setMessage((uploaded ? uploaded + " file(s) synced. " : "") + failures.join(" "));
      } else {
        setMessage(uploaded ? uploaded + " file(s) automatically synced to Backblaze." : "");
      }
    } catch (error) {
      setStatus("sync failed");
      setMessage("Sync stopped: " + error.message);
      await loadFolder(targetFolder);
    } finally {
      busy = false;
      uploadButton.disabled = false;
      newFolderButton.disabled = false;
      refreshButton.disabled = false;
      picker.value = "";
    }
  }

  uploadButton.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => uploadFiles(picker.files));
  refreshButton.addEventListener("click", () => loadFolder(currentPath));

  newFolderButton.addEventListener("click", () => {
    newFolderForm.hidden = false;
    newFolderName.focus();
  });

  cancelNewFolder.addEventListener("click", () => {
    newFolderForm.reset();
    newFolderForm.hidden = true;
  });

  newFolderForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const name = newFolderName.value.trim();
    if (!name) return;
    busy = true;
    newFolderButton.disabled = true;
    uploadButton.disabled = true;
    refreshButton.disabled = true;
    setStatus("syncing…");
    setMessage("Creating folder…");
    try {
      await callService("create-folder", { path: currentPath, name });
      newFolderForm.reset();
      newFolderForm.hidden = true;
      await loadFolder(currentPath);
      setMessage("Folder created and synced.");
    } catch (error) {
      setStatus("sync failed");
      setMessage(error.message);
    } finally {
      busy = false;
      newFolderButton.disabled = false;
      uploadButton.disabled = false;
      refreshButton.disabled = false;
    }
  });

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
  dropZone.addEventListener("dragleave", (event) => {
    if (!dropZone.contains(event.relatedTarget)) {
      dropZone.classList.remove("is-dragging");
    }
  });
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    uploadFiles(event.dataTransfer?.files);
  });
  dropZone.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target === dropZone) {
      event.preventDefault();
      picker.click();
    }
  });

  function createProvisioningToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function ensureStorageProvisioned(user) {
    let metadata = user.user_metadata || {};
    if (
      metadata.argon_storage_provisioned === true &&
      Number(metadata.argon_storage_schema_version) >= 2
    ) return;

    let token = metadata.argon_storage_provisioning_token;
    if (!token) {
      token = createProvisioningToken();
      const { data, error } = await supabase.auth.updateUser({
        data: { ...metadata, argon_storage_provisioning_token: token }
      });
      if (error || !data.user) {
        throw new Error(error?.message || "Could not prepare your B2 storage.");
      }
      user = data.user;
      metadata = user.user_metadata || {};
      token = metadata.argon_storage_provisioning_token;
    }

    const { data, error } = await supabase.functions.invoke("provision-user-storage", {
      body: { userId: user.id, provisioningToken: token }
    });
    if (error) throw new Error(await responseJsonFromFunction(error));
    if (!data?.success) throw new Error(data?.error || "B2 storage setup did not complete.");

    const { data: refreshed, error: refreshError } = await supabase.auth.getUser();
    if (refreshError || !refreshed.user) {
      throw new Error("Storage was created, but the account session could not be refreshed.");
    }
    if (
      refreshed.user.user_metadata?.argon_storage_provisioned !== true ||
      Number(refreshed.user.user_metadata?.argon_storage_schema_version) < 3
    ) throw new Error("B2 storage setup is not marked complete yet.");
  }

  async function responseJsonFromFunction(error) {
    let detail = error?.message || "B2 storage setup failed.";
    try {
      const response = error?.context;
      if (response && typeof response.json === "function") {
        const data = await response.json();
        if (data?.error) detail = data.error;
      }
    } catch { /* Use the function error message. */ }
    return detail;
  }

  async function initialize() {
    setStatus("connecting…");
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error || !session?.user) {
      showSignedOut();
      return;
    }
    accessToken = session.access_token;

    const { data: current, error: userError } = await supabase.auth.getUser();
    if (userError || !current.user) {
      showSignedOut();
      return;
    }

    try {
      await ensureStorageProvisioned(current.user);
      const { data: latestSession } = await supabase.auth.getSession();
      accessToken = latestSession.session?.access_token || accessToken;
      await loadFolder("");
    } catch (error) {
      list.replaceChildren();
      const pending = document.createElement("p");
      pending.className = "file-explorer-empty";
      pending.textContent = "Your account is signed in, but storage setup has not completed: " + error.message;
      list.append(pending);
      setStatus("storage setup pending");
    }
  }

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" || !session?.user) {
      accessToken = null;
      showSignedOut();
      return;
    }
    accessToken = session.access_token;
    if (event === "TOKEN_REFRESHED") {
      // Keep the authenticated token current without interrupting folder browsing.
    }
  });

  initialize().catch((error) => {
    setStatus("sync failed");
    setMessage(error.message || "Could not initialize the exhibition.");
  });
})();
