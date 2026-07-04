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
const OTP_RESEND_SECONDS = 45;
const OTP_DELAY_NOTICE_MS = 25000;
const AUTH_NULL_GRACE_MS = 10000;

let confirmationResult = null;
let recaptchaVerifier = null;
let recaptchaRenderPromise = null;
let recaptchaInitPromise = null;
let otpCooldownUntil = 0;
let otpInFlight = false;
let otpVerifyInFlight = false;
let pushRegistrationInFlight = false;
let pendingAuthResolve = null;
let authNullTimer = null;
let resendTimer = null;
let otpDelayNoticeTimer = null;
let webOtpController = null;
let lastAutoVerifyCode = "";
const VAPID_KEY_RE = /^[A-Za-z0-9_-]{80,}$/;
const DEV_LOGS = ["localhost", "127.0.0.1"].includes(location.hostname) || location.search.includes("debugAuth=1");
const REFERRAL_STORAGE_KEY = "magneetozPendingReferral";

auth.languageCode = "en";

function captureReferralCode(){
  const code = new URLSearchParams(location.search).get("ref");
  if(code) localStorage.setItem(REFERRAL_STORAGE_KEY, code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24));
}

async function attachPendingReferral(user){
  const code = localStorage.getItem(REFERRAL_STORAGE_KEY);
  if(!code || !user) return;
  try{
    const token = await user.getIdToken();
    const projectId = auth.app.options.projectId;
    const response = await fetch(`https://asia-south1-${projectId}.cloudfunctions.net/attachReferralToUser`, {
      method:"POST",
      headers:{ "Content-Type":"application/json", Authorization:`Bearer ${token}` },
      body:JSON.stringify({ code })
    });
    const data = await response.json().catch(() => ({}));
    if(response.ok || /already attached/i.test(data.error || "")) localStorage.removeItem(REFERRAL_STORAGE_KEY);
  }catch(error){
    devLog("Referral attachment deferred:", error);
  }
}

captureReferralCode();

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

function setOtpHelp(message = ""){
  const el = $("otpHelp");
  if(el) el.textContent = message;
}

function stopOtpDelayNotice(){
  if(otpDelayNoticeTimer){
    clearTimeout(otpDelayNoticeTimer);
    otpDelayNoticeTimer = null;
  }
}

function startOtpDelayNotice(phone){
  stopOtpDelayNotice();
  otpDelayNoticeTimer = setTimeout(() => {
    setOtpHelp(`OTP late aa sakta hai. ${maskPhone(phone)} par SMS inbox check karein. Resend button active hote hi fresh OTP bhej sakte hain.`);
    setAuthStatus("OTP late aa raha hai? SMS inbox check karein, phir Resend OTP use karein.", "info");
  }, OTP_DELAY_NOTICE_MS);
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

function isOtpSessionActive(){
  return !!(confirmationResult || document.getElementById("authPopup")?.classList.contains("otp-sent"));
}

function syncAuthControls(user){
  const needsVerification = document.body.classList.contains("auth-needs-verification") || !!(user && !user.phoneNumber);
  const loggedIn = !!user && !needsVerification;
  document.body.classList.toggle("is-guest", !loggedIn);
  document.body.classList.toggle("is-logged-in", loggedIn);
  document.querySelectorAll(".auth-login-action").forEach(button => {
    button.hidden = loggedIn;
    button.setAttribute("aria-hidden", loggedIn ? "true" : "false");
  });
  document.querySelectorAll(".auth-only").forEach(element => {
    element.hidden = !loggedIn;
    element.setAttribute("aria-hidden", loggedIn ? "false" : "true");
  });
  const headerAuthBtn = $("headerAuthBtn");
  if(headerAuthBtn){
    headerAuthBtn.textContent = loggedIn ? "🚪 Logout" : "🔐 Login";
    headerAuthBtn.title = needsVerification ? "Login to verify mobile" : (loggedIn ? "Logout from MAGNEETOZ" : "Login to MAGNEETOZ");
    headerAuthBtn.hidden = false;
    headerAuthBtn.setAttribute("aria-hidden", "false");
  }
}

function setAuthView(user){
  const popup = $("authPopup");
  const app = $("mainWebsite");
  document.body.classList.remove("auth-loading");
  syncAuthControls(user);

  if(user){
    document.body.classList.remove("auth-needs-verification");
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
    attachPendingReferral(user);
    return;
  }

  document.body.classList.remove("auth-required");
  document.body.classList.remove("auth-success");
  document.body.classList.remove("auth-needs-verification");
  if(app) app.style.display = "block";
  if(popup && !isOtpSessionActive()) popup.style.display = "none";
  window.dispatchEvent(new CustomEvent("magneetoz:guest-ready"));
  if(new URLSearchParams(location.search).get("login") === "1"){
    history.replaceState(null, "", location.pathname + location.hash);
    setTimeout(() => openAuthPopup("mobile_verification"), 0);
  }
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
  $("phoneNumber")?.focus();
  window.dispatchEvent(new CustomEvent("magneetoz:auth-required", { detail:{ reason } }));
}

function authPopupVisible(){
  const popup = $("authPopup");
  return !!(popup && popup.style.display !== "none");
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

function handlePhoneInput(){
  const before = confirmationResult;
  const raw = cleanPhone();
  if(before){
    cleanupOtpSession({ keepRecaptcha:true });
    setAuthStatus("Mobile number changed. Send OTP again.", "info");
  }
  setOtpHelp(raw.length === 10
    ? "Send OTP tap karein. OTP kabhi-kabhi 30-60 seconds le sakta hai."
    : "Enter 10 digit mobile number.");
}

async function ensureRecaptcha(){
  if(recaptchaInitPromise) return recaptchaInitPromise;
  recaptchaInitPromise = (async () => {
    if(recaptchaVerifier && recaptchaRenderPromise){
      await recaptchaRenderPromise;
      return recaptchaVerifier;
    }
    if(recaptchaVerifier) return recaptchaVerifier;
    const container = $("recaptcha-container");
    if(!container) throw new Error("Login security container missing");
    recaptchaVerifier = new RecaptchaVerifier(auth, "recaptcha-container", {
      size:"invisible",
      badge:"bottomright",
      isolated:true,
      callback:() => setAuthStatus("Security verified. Sending OTP...", "info"),
      "expired-callback":() => {
        setAuthStatus("Security check expired. Tap Send OTP again.", "error");
        resetRecaptcha({ recreateContainer:true });
      }
    });
    recaptchaRenderPromise = recaptchaVerifier.render();
    await recaptchaRenderPromise;
    return recaptchaVerifier;
  })();
  try{
    return await recaptchaInitPromise;
  }catch(error){
    resetRecaptcha({ recreateContainer:true });
    throw error;
  }finally{
    recaptchaInitPromise = null;
  }
}

function resetRecaptcha({ recreateContainer = false } = {}){
  try{ recaptchaVerifier?.clear(); }catch(_){}
  recaptchaVerifier = null;
  recaptchaRenderPromise = null;
  recaptchaInitPromise = null;
  const container = $("recaptcha-container");
  if(!container) return;
  if(recreateContainer){
    const replacement = container.cloneNode(false);
    replacement.id = "recaptcha-container";
    container.replaceWith(replacement);
  }else{
    container.replaceChildren();
  }
}

function maskPhone(phone){
  return `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`;
}

function friendlyAuthError(error){
  const code = error?.code || "";
  if(code.includes("invalid-verification-code")) return "Invalid OTP, please try again.";
  if(code.includes("code-expired")) return "OTP expired. Please resend OTP.";
  if(code.includes("too-many-requests") || code.includes("quota-exceeded")) return "Too many OTP attempts ho gaye. Please 15-30 minutes baad retry karein.";
  if(code.includes("captcha") || code.includes("app-not-authorized") || code.includes("missing-app-credential")) return "Security check complete nahi hua. Please page refresh karke Send OTP again karein.";
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
  lastAutoVerifyCode = "";
  stopResendTimer();
  stopOtpListener();
  stopOtpDelayNotice();
  setOtpHelp("OTP kabhi-kabhi 30-60 seconds le sakta hai. Ek baar Send OTP tap karke thoda wait karein.");
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

function prepareOtpInput(){
  const input = $("otp");
  if(!input) return null;
  input.setAttribute("autocomplete", "one-time-code");
  input.setAttribute("inputmode", "numeric");
  input.setAttribute("pattern", "[0-9]*");
  input.setAttribute("maxlength", "6");
  input.setAttribute("type", "tel");
  input.setAttribute("aria-label", "One time password");
  return input;
}

function setOtpValue(value = "", { autoVerify = false, source = "manual" } = {}){
  const input = prepareOtpInput();
  if(!input) return "";
  const code = String(value || "").replace(/\D/g, "").slice(0, 6);
  input.value = code;
  input.setAttribute("value", code);
  input.dataset.autofilled = source === "webotp" && code.length === 6 ? "true" : "false";
  if(source === "webotp"){
    input.dispatchEvent(new Event("change", { bubbles:true }));
  }
  if(code.length < 6){
    lastAutoVerifyCode = "";
    return code;
  }
  if(source === "webotp"){
    input.focus({ preventScroll:true });
    setAuthStatus("OTP auto-filled. Verifying now...", "success");
    setOtpHelp("OTP field me code auto-fill ho gaya hai. Login verify ho raha hai.");
  }
  if(autoVerify && OTP_RE.test(code) && !otpVerifyInFlight && lastAutoVerifyCode !== code){
    lastAutoVerifyCode = code;
    setTimeout(() => verifyOTP(), source === "webotp" ? 900 : 150);
  }
  return code;
}

async function sendOTP(options = {}){
  const retryAfterRecaptchaReset = options?.retryAfterRecaptchaReset === true;
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
  setOtpHelp("Security check ke baad OTP send hoga. Please ek baar tap karke wait karein.");
  setButton(button, true, "Sending OTP...");
  resetRecaptcha({ recreateContainer:true });

  try{
    confirmationResult = await signInWithPhoneNumber(auth, `+91${phone}`, await ensureRecaptcha());
    $("authPopup")?.classList.add("otp-sent");
    const otpInput = $("otp");
    if(otpInput){
      prepareOtpInput();
      setOtpValue("");
      requestAnimationFrame(() => {
        otpInput.focus({ preventScroll:true });
        otpInput.click?.();
      });
    }
    setAuthStatus(`OTP sent to ${maskPhone(phone)}. Auto-detecting OTP...`, "success");
    setOtpHelp("OTP 30-60 seconds tak le sakta hai. Resend active hone se pehle wait karein; latest OTP hi valid hota hai.");
    toast("OTP sent", "success");
    startResendTimer(OTP_RESEND_SECONDS);
    startOtpDelayNotice(phone);
    startOtpListener();
  }catch(error){
    devLog("sendOTP error:", error);
    const rawMessage = String(error?.message || error?.code || "");
    if(!retryAfterRecaptchaReset && /already.*rendered|reCAPTCHA has already been rendered/i.test(rawMessage)){
      resetRecaptcha({ recreateContainer:true });
      otpInFlight = false;
      setButton(button, false);
      setAuthStatus("Refreshing security check. Sending OTP again...", "info");
      return sendOTP({ retryAfterRecaptchaReset:true });
    }
    const message = friendlyAuthError(error);
    setAuthStatus(message, "error");
    setOtpHelp("OTP nahi aa raha ho to internet check karein, number verify karein, phir page refresh karke retry karein.");
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
    stopOtpDelayNotice();
    setAuthStatus("Login successful", "success");
    setOtpHelp("Login successful.");
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
      setOtpValue(otp.code, { autoVerify:true, source:"webotp" });
    }
  }catch(error){
    devLog("Auto OTP unavailable:", error);
  }finally{
    webOtpController = null;
  }
}

function bindAuthUI(){
  prepareOtpInput();
  $("phoneNumber")?.addEventListener("input", handlePhoneInput);
  $("sendOtpBtn")?.addEventListener("click", sendOTP);
  $("resendOtpBtn")?.addEventListener("click", sendOTP);
  $("verifyOtpBtn")?.addEventListener("click", verifyOTP);
  $("closeAuthPopup")?.addEventListener("click", closeAuthPopup);
  document.querySelectorAll(".auth-login-action").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openAuthPopup(button.id === "headerAuthBtn" ? "header_login" : "login");
    });
  });
  $("headerAuthBtn")?.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if(auth.currentUser && !document.body.classList.contains("auth-needs-verification")){
      logout();
      return;
    }
    openAuthPopup("header_login");
  });
  $("otp")?.addEventListener("input", () => {
    const code = setOtpValue($("otp")?.value || "", { autoVerify:true });
    if(code.length < 6) setAuthStatus("Auto-detecting OTP...", "info");
  });
  $("otp")?.addEventListener("keydown", (event) => {
    if(event.key === "Enter") verifyOTP();
  });
}

document.addEventListener("click", event => {
  if(auth.currentUser) return;
  if(authPopupVisible()) return;
  const target = event.target;
  if(target?.closest?.("#authPopup,#recaptcha-container,.auth-login-action,.auth-state-action,.add-cart-btn,.cart-wrapper,.cart-panel,#cartPanel,.magneetoz-chatbot,.taste-quiz-modal,.taste-quiz-open,[aria-label='Place order'],#codBtn,#upiBtn,[onclick*='toggleCart'],[onclick*='placeOrder'],[onclick*='codOrder'],[onclick*='upiOrder'],[data-auth-free],a[href^='tel:'],a[href^='mailto:']")) return;
  openAuthPopup("site_click");
  event.preventDefault();
  event.stopPropagation();
}, true);

document.body.classList.add("auth-loading");
bindAuthUI();

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
    if(isOtpSessionActive()){
      openAuthPopup($("authPopup")?.dataset.reason || "login");
      $("authPopup")?.classList.add("otp-sent");
      setAuthStatus("OTP sent. Code enter karke verify karein.", "success");
      requestAnimationFrame(() => $("otp")?.focus({ preventScroll:true }));
      authNullTimer = null;
      return;
    }
    setAuthView(null);
    authNullTimer = null;
  }, AUTH_NULL_GRACE_MS);

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
