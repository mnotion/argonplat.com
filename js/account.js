(() => {
    "use strict";

    const API_BASE = (window.ARGON_API_BASE || "").replace(/\/$/, "");
    const SESSION_KEY = "argon.auth.session";

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

    function setMessage(text) {
        message.textContent = text || "";
    }

    function showForm(which) {
        const isLogin = which === "login";
        loginPanel.hidden = !isLogin;
        signupPanel.hidden = isLogin;
        accountPanel.hidden = true;
        tabs.hidden = false;
        loginTab.setAttribute("aria-pressed", String(isLogin));
        signupTab.setAttribute("aria-pressed", String(!isLogin));
    }

    function readSession() {
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            sessionStorage.removeItem(SESSION_KEY);
            return null;
        }
    }

    function saveSession(data) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: data.expires_at || null
        }));
    }

    function clearSession() {
        sessionStorage.removeItem(SESSION_KEY);
    }

    async function request(path, options = {}) {
        if (!API_BASE) {
            throw new Error("The Argon API address has not been configured.");
        }

        let response;
        try {
            response = await fetch(API_BASE + path, {
                ...options,
                headers: {
                    "Content-Type": "application/json",
                    ...(options.headers || {})
                }
            });
        } catch {
            throw new Error("Could not reach Argon's account service.");
        }

        let data = {};
        try {
            data = await response.json();
        } catch {
            // A non-JSON error response is handled below.
        }

        if (!response.ok) {
            const error = new Error(data.detail || "The request could not be completed.");
            error.status = response.status;
            throw error;
        }

        return data;
    }

    function setFormBusy(form, busy) {
        const button = form.querySelector('button[type="submit"]');
        button.disabled = busy;
        form.setAttribute("aria-busy", String(busy));
    }

    function showAccount(profile) {
        loginPanel.hidden = true;
        signupPanel.hidden = true;
        tabs.hidden = true;
        accountPanel.hidden = false;

        document.getElementById("profile-username").textContent = profile.username;
        document.getElementById("profile-email").textContent = profile.email || "—";
        document.getElementById("profile-plan").textContent = profile.plan || "free";
        document.getElementById("profile-id").textContent = profile.user_id;

        const created = document.getElementById("profile-created");
        if (profile.created_at) {
            const date = new Date(profile.created_at);
            created.textContent = Number.isNaN(date.getTime())
                ? profile.created_at
                : date.toLocaleString();
            created.dateTime = profile.created_at;
        } else {
            created.textContent = "—";
            created.removeAttribute("datetime");
        }

        setMessage("");
    }

    async function refreshAccessToken(session) {
        const refreshed = await request("/auth/refresh", {
            method: "POST",
            body: JSON.stringify({ refresh_token: session.refresh_token })
        });
        saveSession(refreshed);
        return refreshed;
    }

    async function fetchProfile(session) {
        return request("/auth/me", {
            method: "GET",
            headers: { Authorization: "Bearer " + session.access_token }
        });
    }

    async function restoreAccount() {
        const session = readSession();
        if (!session || !session.access_token || !session.refresh_token) {
            showForm("login");
            return;
        }

        try {
            const profile = await fetchProfile(session);
            showAccount(profile);
        } catch (error) {
            if (error.status === 401) {
                try {
                    const refreshed = await refreshAccessToken(session);
                    const profile = await fetchProfile(refreshed);
                    showAccount(profile);
                    return;
                } catch (refreshError) {
                    clearSession();
                    showForm("login");
                    setMessage(refreshError.message || "Your session expired. Please log in again.");
                    return;
                }
            }

            showForm("login");
            setMessage(error.message);
        }
    }

    loginTab.addEventListener("click", () => {
        showForm("login");
        setMessage("");
    });

    signupTab.addEventListener("click", () => {
        showForm("signup");
        setMessage("");
    });

    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        setFormBusy(loginForm, true);
        setMessage("Logging in…");

        const form = new FormData(loginForm);
        try {
            const result = await request("/auth/login", {
                method: "POST",
                body: JSON.stringify({
                    email: form.get("email"),
                    password: form.get("password")
                })
            });
            saveSession(result);
            const profile = await fetchProfile(result);
            loginForm.reset();
            showAccount(profile);
        } catch (error) {
            clearSession();
            setMessage(error.message);
        } finally {
            setFormBusy(loginForm, false);
        }
    });

    signupForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        setFormBusy(signupForm, true);
        setMessage("Creating your Argon account…");

        const form = new FormData(signupForm);
        try {
            const result = await request("/auth/signup", {
                method: "POST",
                body: JSON.stringify({
                    username: form.get("username"),
                    email: form.get("email"),
                    password: form.get("password")
                })
            });

            signupForm.reset();

            if (result.access_token && result.refresh_token) {
                saveSession(result);
                const profile = await fetchProfile(result);
                showAccount(profile);
            } else {
                showForm("login");
                setMessage("Account created. Check your email to confirm it, then log in.");
            }
        } catch (error) {
            setMessage(error.message);
        } finally {
            setFormBusy(signupForm, false);
        }
    });

    logoutButton.addEventListener("click", async () => {
        const session = readSession();
        logoutButton.disabled = true;

        try {
            if (session) {
                await request("/auth/logout", {
                    method: "POST",
                    body: JSON.stringify({
                        access_token: session.access_token,
                        refresh_token: session.refresh_token
                    })
                });
            }
        } catch {
            // Always clear this browser's local session, even if the API is offline.
        } finally {
            clearSession();
            logoutButton.disabled = false;
            showForm("login");
            setMessage("You have been logged out.");
        }
    });

    restoreAccount();
})();
