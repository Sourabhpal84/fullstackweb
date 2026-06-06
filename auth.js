// auth.js - production customer OTP login for MAGNEETOZ
window.AUTH_MODULE_LOADED = true;

console.log("✅ auth.js loaded");
import { auth, db, messagingReady } from "./firebase-config.js";
import {
  RecaptchaVerifier,
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithPhoneNumber,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  arrayUnion,
  doc,
  getDoc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getToken
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const PHONE_RE = /^[6-9]\d{9}$/;
const OTP_RE = /^\d{6}$/;

let confirmationResult = null;
let recaptchaVerifier = null;
let otpCooldownUntil = 0;
let otpInFlight = false;
let pushRegistrationInFlight = false;
let pendingAuthResolve = null;
let authNullTimer = null;
const VAPID_KEY_RE = /^[A-Za-z0-9_-]{80,}$/;

const $ = (id) => document.getElementById(id);

function isValidVapidKey(value = ""){
  const key = String(value || "").trim();
  if(!VAPID_KEY_RE.test(key) || key.length % 4 === 1) return false;
  try{
    const padded = key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=");
    atob(padded);
    return true;
  }catch(_){
    return false;
  }
}

function toast(message, type = "info"){
  let el = $("__toast");
  if(!el){
    el = document.createElement("div");
    el.id = "__toast";
    el.className = "premium-auth-toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.dataset.type = type;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 2800);
}

function setButton(button, busy, busyText){
  if(!button) return;
  if(!button.dataset.idleText) button.dataset.idleText = button.textContent.trim();
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.idleText;
}

function setAuthView(user){
  const popup = $("authPopup");
  const app = $("mainWebsite");
  document.body.classList.remove("auth-loading");

  if(user){
    document.body.classList.remove("auth-required");
    document.body.classList.add("auth-success");
    if(popup) popup.style.display = "none";
    if(app) app.style.display = "block";
    window.dispatchEvent(new CustomEvent("magneetoz:auth-ready", { detail:{ user } }));
    if(pendingAuthResolve){
      pendingAuthResolve(user);
      pendingAuthResolve = null;
    }
    registerCustomerPushToken(user, false);
    return;
  }

  document.body.classList.remove("auth-required");
  document.body.classList.remove("auth-success");
  if(app) app.style.display = "block";
  if(popup) popup.style.display = "none";
  window.dispatchEvent(new CustomEvent("magneetoz:guest-ready"));
}

function openAuthPopup(reason = "checkout"){
  const popup = $("authPopup");
  const app = $("mainWebsite");
  if(app) app.style.display = "block";
  document.body.classList.add("auth-required");
  document.body.classList.remove("auth-success");
  if(popup){
    popup.style.display = "flex";
    popup.dataset.reason = reason;
  }
  $("phoneNumber")?.focus();
  window.dispatchEvent(new CustomEvent("magneetoz:auth-required", { detail:{ reason } }));
}

function closeAuthPopup(){
  if(auth.currentUser) return;
  const popup = $("authPopup");
  document.body.classList.remove("auth-required");
  if(popup) popup.style.display = "none";
  if(pendingAuthResolve){
    pendingAuthResolve(null);
    pendingAuthResolve = null;
  }
}

function requireMagneetozAuth(reason = "checkout"){
  if(auth.currentUser) return Promise.resolve(auth.currentUser);
  openAuthPopup(reason);
  return new Promise(resolve => {
    pendingAuthResolve = resolve;
  });
}

async function loadVapidKey(){
  const snap = await getDoc(doc(db, "settings", "notifications"));
  return snap.exists() ? String(snap.data().publicVapidKey || "").trim() : "";
}

async function registerCustomerPushToken(user = auth.currentUser, askPermission = true){
  if(!user || pushRegistrationInFlight || !("Notification" in window) || !("serviceWorker" in navigator)) return false;
  pushRegistrationInFlight = true;
  try{
    let permission = Notification.permission;
    if(permission === "default" && askPermission){
      permission = await Notification.requestPermission();
    }
    if(permission !== "granted") return false;
    const publicVapidKey = await loadVapidKey();
    if(!isValidVapidKey(publicVapidKey)){
      console.warn("Customer push registration skipped: invalid public VAPID key.");
      return false;
    }
    const messaging = await messagingReady;
    if(!messaging) return false;
    const registration = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
    const token = await getToken(messaging, {
      vapidKey:publicVapidKey,
      serviceWorkerRegistration:registration
    });
    await setDoc(doc(db, "users", user.uid), {
      uid:user.uid,
      phone:user.phoneNumber || "",
      fcmToken:token,
      fcmTokens:arrayUnion(token),
      notificationsEnabled:true,
      tokenUpdatedAt:serverTimestamp(),
      lastSeenAt:serverTimestamp()
    }, { merge:true });
    await setDoc(doc(db, "notificationTokens", token), {
      token,
      userId:user.uid,
      phone:user.phoneNumber || "",
      type:"web",
      enabled:true,
      updatedAt:serverTimestamp()
    }, { merge:true });
    return true;
  }catch(error){
    console.warn("Customer push registration failed:", error);
    return false;
  }finally{
    pushRegistrationInFlight = false;
  }
}

function cleanPhone(){
  const input = $("phoneNumber");
  const raw = (input?.value || "").replace(/\D/g, "").slice(-10);
  if(input) input.value = raw;
  return raw;
}

async function ensureRecaptcha(){
  if(recaptchaVerifier) return recaptchaVerifier;
  const container = $("recaptcha-container");
  if(!container) throw new Error("Login security container missing");
  recaptchaVerifier = new RecaptchaVerifier(auth, "recaptcha-container", {
    size: "normal",
    "expired-callback": () => {
      toast("Security check expired. Please try again.", "error");
      resetRecaptcha();
    }
  });
  await recaptchaVerifier.render();
  return recaptchaVerifier;
}

function resetRecaptcha(){
  try{ recaptchaVerifier?.clear(); }catch(_){}
  recaptchaVerifier = null;
}

async function sendOTP(){
  if(otpInFlight) return;
  const button = $("sendOtpBtn");
  const phone = cleanPhone();

  if(!PHONE_RE.test(phone)){
    toast("Enter a valid 10 digit mobile number", "error");
    $("phoneNumber")?.focus();
    return;
  }

  if(Date.now() < otpCooldownUntil){
    const wait = Math.ceil((otpCooldownUntil - Date.now()) / 1000);
    toast(`Please wait ${wait}s before resending OTP`, "error");
    return;
  }

  otpInFlight = true;
  setButton(button, true, "Sending OTP...");

  try{
    confirmationResult = await signInWithPhoneNumber(auth, `+91${phone}`, await ensureRecaptcha());
    otpCooldownUntil = Date.now() + 30000;
    $("authPopup")?.classList.add("otp-sent");
    $("otp")?.focus();
    toast("OTP sent successfully", "success");
    startOtpListener();
  }catch(error){
    console.error("sendOTP error:", error);
    toast(error?.message || "Unable to send OTP", "error");
    resetRecaptcha();
  }finally{
    otpInFlight = false;
    setButton(button, false);
  }
}

async function verifyOTP(){
  const button = $("verifyOtpBtn");
  const code = ($("otp")?.value || "").trim();

  if(!confirmationResult){
    toast("Send OTP first", "error");
    return;
  }

  if(!OTP_RE.test(code)){
    toast("Enter the 6 digit OTP", "error");
    $("otp")?.focus();
    return;
  }

  setButton(button, true, "Verifying...");

  try{
    await confirmationResult.confirm(code);
    toast("Login successful", "success");
  }catch(error){
    console.error("verifyOTP error:", error);
    toast("Wrong OTP. Please try again.", "error");
    setButton(button, false);
  }
}

async function logout(){

  try{

    await signOut(auth);

    const app =
      document.getElementById("mainWebsite");

    const popup =
      document.getElementById("authPopup");

    if(app){
      app.style.display = "block";
    }

    if(popup){
      popup.style.display = "none";
    }

    confirmationResult = null;

    resetRecaptcha();

    const otpInput =
      document.getElementById("otp");

    if(otpInput){
      otpInput.value = "";
    }

    toast("Logged out", "success");

  }catch(error){

    console.error("logout error:", error);

    toast("Logout failed", "error");

  }

}

async function startOtpListener(){
  if(!("OTPCredential" in window)) return;
  try{
    const input = $("otp");
    if(!input) return;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60000);
    const otp = await navigator.credentials.get({
      otp:{ transport:["sms"] },
      signal:controller.signal
    });
    if(otp?.code){
      input.value = otp.code;
      input.dispatchEvent(new Event("input", { bubbles:true }));
      setTimeout(verifyOTP, 250);
    }
  }catch(error){
    console.log("Auto OTP unavailable:", error);
  }
}

function bindAuthUI(){
  $("phoneNumber")?.addEventListener("input", cleanPhone);
  $("sendOtpBtn")?.addEventListener("click", sendOTP);
  $("verifyOtpBtn")?.addEventListener("click", verifyOTP);
  $("closeAuthPopup")?.addEventListener("click", closeAuthPopup);
  $("otp")?.addEventListener("keydown", (event) => {
    if(event.key === "Enter") verifyOTP();
  });
}

document.body.classList.add("auth-loading");
bindAuthUI();

await setPersistence(auth, browserLocalPersistence)
  .catch((error) => {
    console.warn("Persistence error:", error);
  });

onAuthStateChanged(auth, (user) => {

  console.info("[AUTH]", { state:user ? "signed_in" : "signed_out", uid:user?.uid || null });

  if(user){
    if(authNullTimer){
      clearTimeout(authNullTimer);
      authNullTimer = null;
    }
    setAuthView(user);
    return;
  }

  if(authNullTimer) clearTimeout(authNullTimer);
  authNullTimer = setTimeout(() => {
    if(auth.currentUser) return;
    setAuthView(null);
    authNullTimer = null;
  }, 2500);

}, (error) => {

  console.error("AUTH ERROR:", error);

  setAuthView(null);

});
window.sendOTP = sendOTP;
window.verifyOTP = verifyOTP;
window.logout = logout;
window.openMagneetozAuth = openAuthPopup;
window.closeMagneetozAuth = closeAuthPopup;
window.requireMagneetozAuth = requireMagneetozAuth;
window.enableMagneetozOffers = () => registerCustomerPushToken(auth.currentUser, true);
