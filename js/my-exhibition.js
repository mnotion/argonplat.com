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
  const exhibitionCatalog = document.getElementById("exhibitions-catalog");
  const exhibitionCount = document.getElementById("exhibition-count");
  const exhibitionEmpty = document.getElementById("exhibitions-empty");
  const exhibitionCards = document.getElementById("exhibition-cards");
  const exhibitionForm = document.getElementById("create-exhibition-form");
  const exhibitionNameInput = document.getElementById("create-exhibition-name");
  const exhibitionColorInput = document.getElementById("create-exhibition-color");
  const createExhibitionButton = document.getElementById("create-exhibition-button");
  const exhibitionCatalogMessage = document.getElementById("exhibitions-message");
  const breadcrumbs = document.getElementById("file-explorer-breadcrumbs");
  const dropZone = document.getElementById("file-drop-zone");
  const picker = document.getElementById("file-picker");
  const folderPicker = document.getElementById("folder-picker");
  const uploadFolderButton = document.getElementById("upload-folder-button");
  const refreshButton = document.getElementById("refresh-files-button");
  const newFolderButton = document.getElementById("new-folder-button");
  const newFolderForm = document.getElementById("new-folder-form");
  const newFolderName = document.getElementById("new-folder-name");
  const cancelNewFolder = document.getElementById("cancel-new-folder");
  const backToExhibitionsButton = document.getElementById("back-to-exhibitions-button");
  const fileExplorer = document.querySelector(".file-explorer");
  const fileExplorerActions = document.querySelector(".file-explorer-actions");

  let accessToken = null;
  let currentPath = "";
  let currentExhibitionId = null;
  let currentExhibitionTitle = "";
  let busy = false;
  let controlsLocked = true;

  function setControlsLocked(locked) {
    controlsLocked = locked;
    fileExplorer.classList.toggle("is-locked", locked);
    fileExplorer.setAttribute("aria-disabled", String(locked));
    exhibitionCatalog.classList.toggle("is-locked", locked);
    exhibitionCatalog.setAttribute("aria-disabled", String(locked));

    [createExhibitionButton, exhibitionNameInput, exhibitionColorInput, backToExhibitionsButton,
      uploadFolderButton, refreshButton, newFolderButton, picker, folderPicker, newFolderName, cancelNewFolder]
      .forEach((control) => { control.disabled = locked; });
    newFolderForm.querySelectorAll('button[type="submit"]').forEach((control) => { control.disabled = locked; });
    breadcrumbs.querySelectorAll("button").forEach((control) => { control.disabled = locked; });
    dropZone.setAttribute("aria-disabled", String(locked));

    const hint = locked ? "Sign in to open and store your resources." : "";
    [fileExplorerActions, breadcrumbs, dropZone, exhibitionCatalog].forEach((element) => {
      element.title = hint;
    });
  }

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
    setControlsLocked(true);
    exhibitionCatalog.hidden = false;
    fileExplorer.hidden = true;
    exhibitionCount.textContent = "Sign in to open your exhibitions.";
    exhibitionEmpty.hidden = true;
    exhibitionCards.replaceChildren();
    exhibitionCatalogMessage.replaceChildren();
    const loginLink = document.createElement("a");
    loginLink.href = "account.html";
    loginLink.textContent = "open your Argon account";
    exhibitionCatalogMessage.append(loginLink);
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
    const root = makeButton(currentExhibitionTitle || "exhibition", "", () => loadFolder(""));
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
    if (controlsLocked) breadcrumbs.querySelectorAll("button").forEach((button) => { button.disabled = true; });
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
    if (!currentExhibitionId) return false;
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
      const result = await callService("list", {
        exhibitionId: currentExhibitionId,
        path: currentPath
      });
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
      return true;
    } catch (error) {
      list.replaceChildren();
      const failed = document.createElement("p");
      failed.className = "file-explorer-empty";
      failed.textContent = "Could not load this folder: " + error.message;
      list.append(failed);
      setStatus("sync failed");
      return false;
    }
  }

  async function downloadFile(path) {
    try {
      setStatus("preparing download…");
      const result = await callService("download-url", {
        exhibitionId: currentExhibitionId,
        file: path
      });
      window.location.assign(result.url);
      setStatus("all changes synced");
    } catch (error) {
      setStatus("sync failed");
      setMessage(error.message);
    }
  }

  function joinPath(left, right) {
    return [left, right].filter(Boolean).join("/");
  }

  async function collectDirectoryEntry(entry, parentPath, files, directories) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => {
        entry.file(resolve, reject);
      });
      files.push({
        file,
        relativePath: joinPath(parentPath, file.name)
      });
      return;
    }

    if (entry.isDirectory) {
      const directoryPath = joinPath(parentPath, entry.name);
      directories.add(directoryPath);

      const reader = entry.createReader();
      while (true) {
        const batch = await new Promise((resolve, reject) => {
          reader.readEntries(resolve, reject);
        });
        if (!batch.length) break;
        for (const child of batch) {
          await collectDirectoryEntry(child, directoryPath, files, directories);
        }
      }
    }
  }

  function addParentDirectories(relativePath, directories) {
    const parts = relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }

  async function createDirectoryMarkers(relativeDirectories, targetFolder) {
    const ordered = Array.from(relativeDirectories).sort((a, b) => {
      const depth = a.split("/").length - b.split("/").length;
      return depth || a.localeCompare(b);
    });

    for (const directory of ordered) {
      const parts = directory.split("/");
      const name = parts.pop();
      const parent = joinPath(targetFolder, parts.join("/"));
      await callService("create-folder", {
        exhibitionId: currentExhibitionId,
        path: parent,
        name
      });
    }
  }

  async function uploadItems(items, explicitDirectories = []) {
    const uploads = items.filter((item) => item?.file instanceof File && item.relativePath);
    if ((!uploads.length && !explicitDirectories.length) || busy) return;

    busy = true;
    uploadFolderButton.disabled = true;
    newFolderButton.disabled = true;
    refreshButton.disabled = true;

    const targetFolder = currentPath;
    const directories = new Set(explicitDirectories);
    for (const item of uploads) addParentDirectories(item.relativePath, directories);

    let uploaded = 0;
    const failures = [];

    try {
      await createDirectoryMarkers(directories, targetFolder);

      for (let index = 0; index < uploads.length; index += 1) {
        const { file, relativePath } = uploads[index];
        if (file.size > 25 * 1024 * 1024) {
          failures.push(relativePath + " is larger than 25 MB.");
          continue;
        }

        const targetPath = joinPath(targetFolder, relativePath);
        setStatus("syncing " + (index + 1) + " of " + uploads.length + "…");
        setMessage("Uploading " + targetPath + "…");

        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + accessToken,
            "apikey": window.ARGON_SUPABASE_PUBLISHABLE_KEY,
            "Content-Type": file.type || "application/octet-stream",
            "x-argon-action": "upload",
            "x-argon-relative-path": encodeURIComponent(targetPath),
            "x-argon-exhibition-id": encodeURIComponent(currentExhibitionId)
          },
          body: file
        });
        await responseJson(response);
        uploaded += 1;
      }

      const refreshed = await loadFolder(targetFolder);
      if (!refreshed) {
        setStatus("refresh failed");
        setMessage("The upload finished, but this folder could not be refreshed. Use refresh to check its contents.");
        return;
      }
      if (failures.length) {
        setStatus("sync failed");
        setMessage((uploaded ? uploaded + " file(s) synced. " : "") + failures.join(" "));
      } else {
        const folderCount = directories.size;
        const summary = [];
        if (uploaded) summary.push(uploaded + " file(s) synced");
        if (folderCount) summary.push(folderCount + " folder(s) created");
        setMessage(summary.length ? summary.join(" · ") + " to Backblaze." : "");
      }
    } catch (error) {
      const failureMessage = "Sync stopped: " + error.message;
      await loadFolder(targetFolder);
      setStatus("sync failed");
      setMessage(failureMessage);
    } finally {
      busy = false;
      uploadFolderButton.disabled = false;
      newFolderButton.disabled = false;
      refreshButton.disabled = false;
      picker.value = "";
      folderPicker.value = "";
    }
  }

  function filesFromPicker(fileList) {
    return Array.from(fileList || []).map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name
    }));
  }

  function showExhibitionCatalog() {
    currentExhibitionId = null;
    currentExhibitionTitle = "";
    currentPath = "";
    fileExplorer.hidden = true;
    exhibitionCatalog.hidden = false;
    loadExhibitions();
  }

  async function openExhibition(exhibition) {
    currentExhibitionId = exhibition.id;
    currentExhibitionTitle = exhibition.title;
    currentPath = "";
    exhibitionCatalog.hidden = true;
    fileExplorer.hidden = false;
    await loadFolder("");
  }

  async function loadExhibitions() {
    exhibitionCatalogMessage.textContent = "";
    exhibitionCards.replaceChildren();
    setStatus("syncing…");
    try {
      const result = await callService("list-exhibitions");
      const exhibitions = Array.isArray(result.exhibitions) ? result.exhibitions : [];
      exhibitionCount.textContent = exhibitions.length === 0
        ? "0 exhibitions made. Create a new exhibition to begin!"
        : exhibitions.length + " of 2 exhibitions made.";
      exhibitionEmpty.hidden = exhibitions.length > 0;

      exhibitions.forEach((exhibition) => {
        const card = document.createElement("div");
        card.className = "exhibition-card-item";
        card.setAttribute("role", "listitem");
        const openButton = makeButton("", "exhibition-card", () => openExhibition(exhibition));
        openButton.style.backgroundColor = exhibition.color || "#d8d8d8";
        const title = document.createElement("span");
        title.className = "exhibition-card-title";
        title.textContent = exhibition.title;
        openButton.append(title);
        card.append(openButton);

        if (exhibition.id !== "legacy") {
          const controls = document.createElement("div");
          controls.className = "exhibition-card-controls";
          const color = document.createElement("input");
          color.type = "color";
          color.value = exhibition.color || "#d8d8d8";
          color.setAttribute("aria-label", "Change colour for " + exhibition.title);
          color.disabled = controlsLocked;
          color.addEventListener("change", () => updateExhibition(exhibition, { color: color.value }));
          const rename = makeButton("rename", "", async () => {
            const nextTitle = window.prompt("Rename exhibition", exhibition.title);
            if (nextTitle === null || !nextTitle.trim()) return;
            await updateExhibition(exhibition, { title: nextTitle.trim() });
          });
          const remove = makeButton("delete", "", async () => {
            if (!window.confirm("Delete “" + exhibition.title + "” and all its files? This cannot be undone.")) return;
            try {
              await callService("delete-exhibition", { exhibitionId: exhibition.id });
              await loadExhibitions();
              exhibitionCatalogMessage.textContent = "Exhibition and its files deleted.";
            } catch (error) {
              exhibitionCatalogMessage.textContent = error.message;
              setStatus("sync failed");
            }
          });
          controls.append(color, rename, remove);
          card.append(controls);
        }
        exhibitionCards.append(card);
      });

      const addButton = makeButton("", "add-exhibition-card", () => exhibitionNameInput.focus());
      addButton.disabled = controlsLocked || exhibitions.length >= 2;
      addButton.title = addButton.disabled
        ? "The free plan allows up to 2 exhibitions."
        : "Add another exhibition.";
      const symbol = document.createElement("span");
      symbol.className = "add-exhibition-symbol";
      symbol.textContent = "+";
      const label = document.createElement("span");
      label.textContent = "add another exhibition";
      addButton.append(symbol, label);
      const addItem = document.createElement("div");
      addItem.setAttribute("role", "listitem");
      addItem.append(addButton);
      exhibitionCards.append(addItem);
      setStatus("all changes synced");
      return true;
    } catch (error) {
      exhibitionCount.textContent = "Could not load your exhibitions.";
      exhibitionEmpty.hidden = true;
      exhibitionCatalogMessage.textContent = error.message;
      setStatus("sync failed");
      return false;
    }
  }

  async function updateExhibition(exhibition, changes) {
    if (controlsLocked) return;
    try {
      const result = await callService("update-exhibition", {
        exhibitionId: exhibition.id,
        ...changes
      });
      await loadExhibitions();
      exhibitionCatalogMessage.textContent = "Exhibition updated.";
      return result;
    } catch (error) {
      exhibitionCatalogMessage.textContent = error.message;
      setStatus("sync failed");
      return null;
    }
  }

  async function filesFromDrop(dataTransfer) {
    const files = [];
    const directories = new Set();
    const items = Array.from(dataTransfer?.items || []);

    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      if (entry) {
        await collectDirectoryEntry(entry, "", files, directories);
      } else {
        const file = item.getAsFile();
        if (file) {
          files.push({
            file,
            relativePath: file.webkitRelativePath || file.name
          });
        }
      }
    }

    if (!items.length) {
      for (const file of Array.from(dataTransfer?.files || [])) {
        files.push({
          file,
          relativePath: file.webkitRelativePath || file.name
        });
      }
    }
    return { files, directories: Array.from(directories) };
  }

  picker.addEventListener("change", () => uploadItems(filesFromPicker(picker.files)));
  backToExhibitionsButton.addEventListener("click", showExhibitionCatalog);
  uploadFolderButton.addEventListener("click", () => folderPicker.click());
  folderPicker.addEventListener("change", () => uploadItems(filesFromPicker(folderPicker.files)));
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
    refreshButton.disabled = true;
    setStatus("syncing…");
    setMessage("Creating folder…");
    try {
      await callService("create-folder", {
        exhibitionId: currentExhibitionId,
        path: currentPath,
        name
      });
      newFolderForm.reset();
      newFolderForm.hidden = true;
      const refreshed = await loadFolder(currentPath);
      if (!refreshed) {
        setStatus("refresh failed");
        setMessage("The folder was created, but this folder could not be refreshed. Use refresh to check it.");
        return;
      }
      setMessage("Folder created and synced.");
    } catch (error) {
      setStatus("sync failed");
      setMessage(error.message);
    } finally {
      busy = false;
      newFolderButton.disabled = false;
      refreshButton.disabled = false;
    }
  });

  exhibitionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || controlsLocked) return;
    const title = exhibitionNameInput.value.trim();
    if (!title) return;

    busy = true;
    createExhibitionButton.disabled = true;
    setStatus("syncing…");
    exhibitionCatalogMessage.textContent = "Creating exhibition…";
    try {
      await callService("create-exhibition", {
        title,
        color: exhibitionColorInput.value
      });
      exhibitionForm.reset();
      const refreshed = await loadExhibitions();
      exhibitionCatalogMessage.textContent = refreshed
        ? "Exhibition created."
        : "Exhibition created, but the exhibition list could not be refreshed.";
    } catch (error) {
      setStatus("sync failed");
      exhibitionCatalogMessage.textContent = error.message;
    } finally {
      busy = false;
      createExhibitionButton.disabled = controlsLocked;
    }
  });

  dropZone.addEventListener("dragover", (event) => {
    if (controlsLocked || !accessToken) return;
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
  dropZone.addEventListener("dragleave", (event) => {
    if (!dropZone.contains(event.relatedTarget)) {
      dropZone.classList.remove("is-dragging");
    }
  });
  dropZone.addEventListener("drop", async (event) => {
    if (controlsLocked || !accessToken) return;
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    try {
      const result = await filesFromDrop(event.dataTransfer);
      await uploadItems(result.files, result.directories);
    } catch (error) {
      setStatus("sync failed");
      setMessage("Could not read the dropped folder: " + error.message);
    }
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
      Number(metadata.argon_storage_schema_version) >= 4
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
      Number(refreshed.user.user_metadata?.argon_storage_schema_version) < 4
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
    setControlsLocked(true);
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
      setControlsLocked(false);
      await loadExhibitions();
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
