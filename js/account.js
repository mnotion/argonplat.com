// account page switches between login and signup
document.addEventListener("DOMContentLoaded", () => {
    const loginButton = document.querySelector("#show-login");
    const signupButton = document.querySelector("#show-signup");
    const loginSection = document.querySelector("#login-section");
    const signupSection = document.querySelector("#signup-section");
    const note = document.querySelector("#account-note");

    // show whichever form was clicked
    loginButton.addEventListener("click", () => {
        loginSection.hidden = false;
        signupSection.hidden = true;
        note.textContent = "This is a front-end mockup. Accounts are not created or saved yet.";
    });

    signupButton.addEventListener("click", () => {
        loginSection.hidden = true;
        signupSection.hidden = false;
        note.textContent = "This is a front-end mockup. Accounts are not created or saved yet.";
    });

    // stop forms from pretending to submit to a server
    document.querySelectorAll("form").forEach((form) => {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            note.textContent = "No backend is connected. This form does not create or log in to an account.";
        });
    });
});
