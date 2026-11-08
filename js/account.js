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
        setMessage("");
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
        const { data, error } = await supabase.auth.signUp({
            email: form.get("email"),
            password: form.get("password"),
            options: { data: { username } }
        });
        busy(signupForm, false);
        if (error) { setMessage(error.message); return; }
        signupForm.reset();

        if (data.session && data.user) {
            try { await loadProfile(data.user); }
            catch (err) { setMessage(err.message); }
        } else {
            showForm("login");
            setMessage("Account created. Check your email to confirm it, then log in.");
        }
    });

    logoutButton.addEventListener("click", async () => {
        logoutButton.disabled = true;
        const { error } = await supabase.auth.signOut();
        logoutButton.disabled = false;
        showForm("login");
        setMessage(error ? error.message : "You have been logged out.");
    });

    supabase.auth.onAuthStateChange((_event, session) => {
        if (session?.user && accountPanel.hidden) loadProfile(session.user).catch(err => setMessage(err.message));
    });

    showCurrentSession().catch(err => setMessage(err.message));
})();
