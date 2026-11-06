// send the exhibition account button to the account page
document.addEventListener("DOMContentLoaded", () => {
    const accountButton = document.querySelector("#account-open");

    if (!accountButton) return;

    accountButton.addEventListener("click", () => {
        window.location.href = "account.html";
    });
});
