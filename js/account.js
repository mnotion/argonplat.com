(() => {
    "use strict";

    const { createClient } = window.supabase;
    const supabase = createClient(
        window.ARGON_SUPABASE_URL,
        window.ARGON_SUPABASE_PUBLISHABLE_KEY
    );

    const loginTab = document.getElementById("login-tab");
    const signupTab = document.getElementById("signup-tab");
    const tabs = document.getElementById("account-tabs");
    const loginPanel = document.getElementById("login-panel");
    const signupPanel = document.getElementById("signup-panel");
    const accountPanel = document.getElementById("account-panel");
    const message = document.getElementById("account-message");
    const loginForm = document.getElementById("login-form");
    const signupForm = document.getElementById("signup-form");
    const logoutButton = document.getElementById("logout-button");
    const showDeleteButton = document.getElementById("show-delete-button");
    const deleteForm = document.getElementById("delete-form");
    const cancelDeleteButton = document.getElementById("cancel-delete-button");
    const confirmDeleteButton = document.getElementById("confirm-delete-button");

    function setMessage(text) { message.textContent = text || ""; }

    function showForm(which) {
        const isLogin = which === "login";
        loginPanel.hidden = !isLogin;
        signupPanel.hidden = isLogin;
        accountPanel.hidden = true;
        tabs.hidden = false;
        loginTab.setAttribute("aria-pressed", String(isLogin));
        signupTab.setAttribute("aria-pressed", String(!isLogin));
    }

    function busy(form, state) {
        form.querySelector('button[type="submit"]').disabled = state;
        form.setAttribute("aria-busy", String(state));
    }

    const storageProvisioning = new Map();

    function createProvisioningToken() {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    }

    async function getFunctionErrorMessage(error) {
        let detail = error?.message || "Storage provisioning failed.";
        try {
            const response = error?.context;
            if (response && typeof response.json === "function") {
                const payload = await response.json();
                if (payload?.error) detail = payload.error;
            }
        } catch { /* Keep the original function error. */ }
        return detail;
    }

    async function ensureStorageProvisioned(user) {
        if (storageProvisioning.has(user.id)) {
            return storageProvisioning.get(user.id);
        }

        // Run after registering the promise so auth-state events cannot start
        // a second provisioning request while metadata is being updated.
        const task = Promise.resolve().then(async () => {
            let currentUser = user;
            let metadata = currentUser.user_metadata || {};
            if (metadata.argon_storage_provisioned === true && Number(metadata.argon_storage_schema_version) >= 2) return true;

            let provisioningToken = metadata.argon_storage_provisioning_token;
            if (!provisioningToken) {
                // Existing accounts created before B2 provisioning receive a token
                // on their next login and are initialized through the same flow.
                provisioningToken = createProvisioningToken();
                const { data, error } = await supabase.auth.updateUser({
                    data: {
                        ...metadata,
                        argon_storage_provisioning_token: provisioningToken
                    }
                });
                if (error || !data.user) {
                    throw new Error(error?.message || "Could not prepare secure storage setup.");
                }
                currentUser = data.user;
                metadata = currentUser.user_metadata || {};
                provisioningToken = metadata.argon_storage_provisioning_token;
            }

            const { data, error } = await supabase.functions.invoke("provision-user-storage", {
                body: {
                    userId: currentUser.id,
                    provisioningToken
                }
            });

            if (error) throw new Error(await getFunctionErrorMessage(error));
            if (!data?.success) throw new Error(data?.error || "Storage provisioning did not complete.");

            // The server marks this user as provisioned and removes the one-time token.
            metadata.argon_storage_provisioned = true;
            metadata.argon_storage_schema_version = 2;
            delete metadata.argon_storage_provisioning_token;
            return true;
        });

        storageProvisioning.set(user.id, task);
        try {
            return await task;
        } finally {
            storageProvisioning.delete(user.id);
        }
    }

    async function loadProfile(user) {
        const { data, error } = await supabase
            .from("profiles")
            .select("id,username,plan,created_at")
            .eq("id", user.id)
            .single();
        if (error) throw new Error("Signed in, but your Argon profile could not be loaded: " + error.message);

        document.getElementById("profile-username").textContent = data.username;
        document.getElementById("profile-email").textContent = user.email || "—";
        document.getElementById("profile-plan").textContent = data.plan || "free";
        document.getElementById("profile-id").textContent = data.id;

        const time = document.getElementById("profile-created");
        time.dateTime = data.created_at;
        time.textContent = data.created_at ? new Date(data.created_at).toLocaleString() : "—";

        loginPanel.hidden = true;
        signupPanel.hidden = true;
        tabs.hidden = true;
        accountPanel.hidden = false;
        deleteForm.hidden = true;
        showDeleteButton.hidden = false;
        deleteForm.reset();

        setMessage("");
        try {
            await ensureStorageProvisioned(user);
        } catch (error) {
            setMessage("Your account exists, but its B2 storage setup is pending: " + error.message);
        }
    }

    async function showCurrentSession() {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) await loadProfile(session.user);
        else showForm("login");
    }

    loginTab.addEventListener("click", () => { showForm("login"); setMessage(""); });
    signupTab.addEventListener("click", () => { showForm("signup"); setMessage(""); });

    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        busy(loginForm, true);
        setMessage("Logging in…");
        const form = new FormData(loginForm);
        const { data, error } = await supabase.auth.signInWithPassword({
            email: form.get("email"),
            password: form.get("password")
        });
        busy(loginForm, false);
        if (error) { setMessage(error.message); return; }
        loginForm.reset();
        try { await loadProfile(data.user); }
        catch (err) { setMessage(err.message); }
    });

    signupForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        busy(signupForm, true);
        setMessage("Creating your Argon account…");
        const form = new FormData(signupForm);
        const username = String(form.get("username")).trim().toLowerCase();
        const provisioningToken = createProvisioningToken();

        const { data, error } = await supabase.auth.signUp({
            email: form.get("email"),
            password: form.get("password"),
            options: {
                data: {
                    username,
                    argon_storage_provisioning_token: provisioningToken
                }
            }
        });
        busy(signupForm, false);
        if (error) { setMessage(error.message); return; }
        signupForm.reset();

        if (!data.user) {
            showForm("login");
            setMessage("Signup was submitted. Check your email for confirmation.");
            return;
        }

        if (data.session) {
            try {
                await loadProfile(data.user);
                if (data.user.user_metadata?.argon_storage_provisioned) {
                    setMessage("Your Argon account and B2 storage have been created.");
                }
            } catch (err) {
                setMessage(err.message);
            }
        } else {
            showForm("login");
            try {
                await ensureStorageProvisioned(data.user);
                setMessage("Account created and B2 storage initialized. Check your email to confirm your account, then log in.");
            } catch (provisionError) {
                setMessage("Account created, but B2 storage setup is pending: " + provisionError.message + " Confirm your email and log in to retry.");
            }
        }
    });

    logoutButton.addEventListener("click", async () => {
        logoutButton.disabled = true;
        const { error } = await supabase.auth.signOut();
        logoutButton.disabled = false;
        showForm("login");
        setMessage(error ? error.message : "You have been logged out.");
    });

    showDeleteButton.addEventListener("click", () => {
        deleteForm.hidden = false;
        showDeleteButton.hidden = true;
        document.getElementById("delete-password").focus();
        setMessage("Account deletion is permanent. Confirm your password and type DELETE.");
    });

    cancelDeleteButton.addEventListener("click", () => {
        deleteForm.reset();
        deleteForm.hidden = true;
        showDeleteButton.hidden = false;
        setMessage("");
    });

    deleteForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(deleteForm);
        const password = String(form.get("password") || "");
        const confirmation = String(form.get("confirmation") || "");

        if (confirmation !== "DELETE") {
            setMessage('Type exactly "DELETE" to confirm.');
            return;
        }

        confirmDeleteButton.disabled = true;
        cancelDeleteButton.disabled = true;
        setMessage("Verifying password…");

        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user?.email) throw new Error("Could not identify your signed-in email. Log in again.");

            const { data: reauthData, error: reauthError } = await supabase.auth.signInWithPassword({
                email: user.email,
                password
            });
            if (reauthError) throw new Error("Password verification failed: " + reauthError.message);
            if (reauthData.user?.id !== user.id) {
                throw new Error("Password verification returned a different account. Log in again.");
            }

            setMessage("Deleting your Argon account…");
            const { error: deleteError } = await supabase.rpc("delete_my_account", {
                confirmation: "DELETE"
            });
            if (deleteError) throw new Error(deleteError.message || "Account deletion failed.");

            await supabase.auth.signOut({ scope: "local" });
            accountPanel.hidden = true;
            tabs.hidden = false;
            loginPanel.hidden = false;
            signupPanel.hidden = true;
            deleteForm.reset();
            loginForm.reset();
            setMessage("Your Argon account has been permanently deleted. You can sign up again.");
        } catch (error) {
            setMessage(error?.message || "Account deletion failed. Check whether the account still exists before retrying.");
        } finally {
            confirmDeleteButton.disabled = false;
            cancelDeleteButton.disabled = false;
        }
    });

    supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.user && accountPanel.hidden) {
            loadProfile(session.user).catch(err => setMessage(err.message));
        }
    });

    showCurrentSession().catch(err => setMessage(err.message));
})();
