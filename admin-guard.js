import { auth } from "./firebase-config.js";
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

export const ADMIN_EMAIL = "magneeto73@gmail.com";
export const ADMIN_EMAILS = [ADMIN_EMAIL, "sourabhpal982@gmail.com"];

const adminPersistenceReady = setPersistence(auth, browserLocalPersistence).catch(() => {});

export async function protectAdminPage(){
  await adminPersistenceReady;
  document.documentElement.classList.add("admin-auth-checking");
  onAuthStateChanged(auth, user => {
    const allowed = ADMIN_EMAILS.includes(user?.email?.toLowerCase());
    if(!allowed){
      const next = encodeURIComponent(location.pathname.split("/").pop() || "8423order9839status.html");
      location.replace(`admin-login.html?next=${next}`);
      return;
    }
    document.documentElement.classList.remove("admin-auth-checking");
    window.currentAdminEmail = user.email;
  });
}

export function mountAdminLogout(container = document.body){
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Logout";
  button.className = "admin-logout-btn";
  button.addEventListener("click", async () => {
    await signOut(auth);
    location.replace("admin-login.html");
  });
  container.appendChild(button);
}
