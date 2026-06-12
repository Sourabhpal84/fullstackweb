// auth.js - production customer OTP login for MAGNEETOZ
window.AUTH_MODULE_LOADED = true;

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
let otpVerifyInFlight = false;
let pushRegistrationInFlight = false;
let pendingAuthResolve = null;
let authNullTimer = null;
let resendTimer = null;
let webOtpController = null;
const VAPID_KEY_RE = /^[A-Za-z0-9_-]{80,}$/;
const DEV_LOGS = ["localhost", "127.0.0.1"].includes(location.hostname) || location.search.includes("debugAuth=1");

const $ = (id) => document.getElementById(id);

function devLog(...args){
  if(DEV_LOGS) console.info(...args);
}

function setAuthStatus(message, type = "info"){
  const el = $("authStatus");
  if(!el) return;
  el.textContent = message;
  el.dataset.type = type;
}

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
    cleanupOtpSession({ keepRecaptcha:true });
    setAuthStatus("Login successful", "success");
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
  setAuthStatus("Enter mobile number", "info");
  ensureRecaptcha().catch((error) => {
    devLog("Invisible reCAPTCHA preload failed:", error);
    setAuthStatus("Security check will start when you send OTP.", "info");
  });
  $("phoneNumber")?.focus();
  window.dispatchEvent(new CustomEvent("magneetoz:auth-required", { detail:{ reason } }));
}

function closeAuthPopup(){
  if(auth.currentUser) return;
  cleanupOtpSession({ keepRecaptcha:true });
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
  container.innerHTML = "";
  recaptchaVerifier = new RecaptchaVerifier(auth, "recaptcha-container", {
    size: "invisible",
    callback: () => {
      setAuthStatus("Security verified. Sending OTP...", "info");
    },
    "expired-callback": () => {
      setAuthStatus("Security check expired. Please try again.", "error");
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

function maskPhone(phone){
  return `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`;
}

function friendlyAuthError(error){
  const code = error?.code || "";
  if(code.includes("invalid-verification-code")) return "Invalid OTP, please try again.";
  if(code.includes("code-expired")) return "OTP expired. Please resend OTP.";
  if(code.includes("too-many-requests") || code.includes("quota-exceeded")) return "Too many attempts. Please try again after some time.";
  if(code.includes("captcha") || code.includes("app-not-authorized") || code.includes("missing-app-credential")) return "Security check failed. Please retry OTP.";
  if(code.includes("invalid-phone-number")) return "Enter a valid 10 digit mobile number.";
  if(code.includes("network")) return "Network issue. Please check internet and retry.";
  return error?.message || "Something went wrong. Please try again.";
}

function stopResendTimer(){
  if(resendTimer){
    clearInterval(resendTimer);
    resendTimer = null;
  }
}

function startResendTimer(seconds = 30){
  stopResendTimer();
  const sendButton = $("sendOtpBtn");
  const resendButton = $("resendOtpBtn");
  if(sendButton) sendButton.style.display = "none";
  if(resendButton){
    resendButton.style.display = "block";
    resendButton.disabled = true;
  }

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((otpCooldownUntil - Date.now()) / 1000));
    if(remaining > 0){
      if(resendButton) resendButton.textContent = `Resend OTP in ${remaining}s`;
      return;
    }
    stopResendTimer();
    if(resendButton){
      resendButton.textContent = "Resend OTP";
      resendButton.disabled = false;
    }
  };

  otpCooldownUntil = Date.now() + seconds * 1000;
  tick();
  resendTimer = setInterval(tick, 250);
}

function stopOtpListener(){
  try{ webOtpController?.abort(); }catch(_){}
  webOtpController = null;
}

function cleanupOtpSession({ keepRecaptcha = false } = {}){
  confirmationResult = null;
  otpCooldownUntil = 0;
  otpInFlight = false;
  otpVerifyInFlight = false;
  stopResendTimer();
  stopOtpListener();
  $("authPopup")?.classList.remove("otp-sent");
  const otpInput = $("otp");
  if(otpInput) otpInput.value = "";
  const sendButton = $("sendOtpBtn");
  const resendButton = $("resendOtpBtn");
  if(sendButton){
    setButton(sendButton, false);
    sendButton.style.display = "block";
  }
  if(resendButton){
    resendButton.disabled = true;
    resendButton.textContent = "Resend OTP";
    resendButton.style.display = "none";
  }
  if(!keepRecaptcha) resetRecaptcha();
}

async function sendOTP(){
  if(otpInFlight) return;
  const button = $("sendOtpBtn");
  const phone = cleanPhone();

  if(!PHONE_RE.test(phone)){
    setAuthStatus("Enter a valid 10 digit mobile number.", "error");
    toast("Enter a valid 10 digit mobile number", "error");
    $("phoneNumber")?.focus();
    return;
  }

  if(Date.now() < otpCooldownUntil){
    const wait = Math.ceil((otpCooldownUntil - Date.now()) / 1000);
    setAuthStatus(`Resend OTP in ${wait}s`, "info");
    toast(`Please wait ${wait}s before resending OTP`, "error");
    return;
  }

  otpInFlight = true;
  setAuthStatus("Sending OTP...", "info");
  setButton(button, true, "Sending OTP...");

  try{
    confirmationResult = await signInWithPhoneNumber(auth, `+91${phone}`, await ensureRecaptcha());
    $("authPopup")?.classList.add("otp-sent");
    const otpInput = $("otp");
    if(otpInput){
      otpInput.value = "";
      otpInput.focus();
    }
    setAuthStatus(`OTP sent to ${maskPhone(phone)}`, "success");
    toast("OTP sent", "success");
    startResendTimer(30);
    startOtpListener();
  }catch(error){
    devLog("sendOTP error:", error);
    const message = friendlyAuthError(error);
    setAuthStatus(message, "error");
    toast(message, "error");
    resetRecaptcha();
    ensureRecaptcha().catch((recaptchaError) => devLog("Invisible reCAPTCHA retry preload failed:", recaptchaError));
  }finally{
    otpInFlight = false;
    setButton(button, false);
  }
}

async function verifyOTP(){
  if(otpVerifyInFlight) return;
  const button = $("verifyOtpBtn");
  const code = ($("otp")?.value || "").trim();

  if(!confirmationResult){
    setAuthStatus("Send OTP first.", "error");
    toast("Send OTP first", "error");
    return;
  }

  if(!OTP_RE.test(code)){
    setAuthStatus("Enter the 6 digit OTP.", "error");
    toast("Enter the 6 digit OTP", "error");
    $("otp")?.focus();
    return;
  }

  otpVerifyInFlight = true;
  setAuthStatus("Verifying OTP...", "info");
  setButton(button, true, "Verifying OTP...");

  try{
    await confirmationResult.confirm(code);
    stopOtpListener();
    stopResendTimer();
    setAuthStatus("Login successful", "success");
    toast("Login successful", "success");
  }catch(error){
    devLog("verifyOTP error:", error);
    const message = friendlyAuthError(error);
    setAuthStatus(message, "error");
    toast(message, "error");
    setButton(button, false);
  }finally{
    otpVerifyInFlight = false;
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

    cleanupOtpSession();

    toast("Logged out", "success");

  }catch(error){

    devLog("logout error:", error);

    toast("Logout failed", "error");

  }

}

async function startOtpListener(){
  if(!("OTPCredential" in window)) return;
  stopOtpListener();
  try{
    const input = $("otp");
    if(!input) return;
    setAuthStatus("Auto-detecting OTP...", "info");
    webOtpController = new AbortController();
    setTimeout(() => webOtpController?.abort(), 60000);
    const otp = await navigator.credentials.get({
      otp:{ transport:["sms"] },
      signal:webOtpController.signal
    });
    if(otp?.code){
      input.value = String(otp.code).replace(/\D/g, "").slice(0, 6);
      input.dispatchEvent(new Event("input", { bubbles:true }));
      if(OTP_RE.test(input.value)) setTimeout(verifyOTP, 250);
    }
  }catch(error){
    devLog("Auto OTP unavailable:", error);
  }finally{
    webOtpController = null;
  }
}

function bindAuthUI(){
  $("phoneNumber")?.addEventListener("input", cleanPhone);
  $("sendOtpBtn")?.addEventListener("click", sendOTP);
  $("resendOtpBtn")?.addEventListener("click", sendOTP);
  $("verifyOtpBtn")?.addEventListener("click", verifyOTP);
  $("closeAuthPopup")?.addEventListener("click", closeAuthPopup);
  $("otp")?.addEventListener("input", () => {
    const input = $("otp");
    if(!input) return;
    input.value = input.value.replace(/\D/g, "").slice(0, 6);
    if(input.value.length === 6) verifyOTP();
  });
  $("otp")?.addEventListener("keydown", (event) => {
    if(event.key === "Enter") verifyOTP();
  });
}

document.body.classList.add("auth-loading");
bindAuthUI();
ensureRecaptcha().catch((error) => devLog("Invisible reCAPTCHA preload skipped:", error));

await setPersistence(auth, browserLocalPersistence)
  .catch((error) => {
    console.warn("Persistence error:", error);
  });

onAuthStateChanged(auth, (user) => {

  devLog("[AUTH]", { state:user ? "signed_in" : "signed_out", uid:user?.uid || null });

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

  devLog("AUTH ERROR:", error);

  setAuthView(null);

});
window.sendOTP = sendOTP;
window.verifyOTP = verifyOTP;
window.logout = logout;
window.openMagneetozAuth = openAuthPopup;
window.closeMagneetozAuth = closeAuthPopup;
window.requireMagneetozAuth = requireMagneetozAuth;
window.enableMagneetozOffers = () => registerCustomerPushToken(auth.currentUser, true);
