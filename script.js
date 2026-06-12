import {
  collection,
  addDoc,
  getDocs,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  orderBy,
  doc,
  getDoc,
  updateDoc,
  Timestamp,
  runTransaction,
  increment,
  setDoc,
  deleteField
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Import BOTH auth and db from your centralized firebase.js file
import { auth, db, messagingReady } from "./firebase-config.js"; 
import { getIdToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";


/* DELIVERY SETTINGS */

let MAX_DELIVERY_DISTANCE = 6;

let ALL_INDIA_DELIVERY = false;
let VIP_DELIVERY_ENABLED = false;

/* ================= CONFIG ================= */

const EMERGENCY_RESTAURANT_LOCATION = Object.freeze({
  lat:28.465283,
  lng:77.502608
});
const restaurantLocation = {
  lat:null,
  lng:null,
  loaded:false,
  source:"pending"
};
window.restaurantLocation = restaurantLocation;

function getRestaurantLocation(){
  const source = window.restaurantLocation || restaurantLocation || {};
  const lat = Number(source.lat);
  const lng = Number(source.lng);
  if(Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  return null;
}

function setRestaurantLocation(lat, lng){
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if(!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return null;
  const next = { lat:parsedLat, lng:parsedLng };
  restaurantLocation.lat = next.lat;
  restaurantLocation.lng = next.lng;
  restaurantLocation.loaded = true;
  restaurantLocation.source = "firestore:settings/restaurant/location";
  window.restaurantLocation = restaurantLocation;
  return next;
}

let themeParticleCanvas = null;
let themeParticleCtx = null;
let themeParticles = [];
let themeParticleFrame = 0;

function sizeThemeParticleCanvas(){
  if(!themeParticleCanvas || !themeParticleCtx) return;
  const ratio = window.devicePixelRatio || 1;
  themeParticleCanvas.width = window.innerWidth * ratio;
  themeParticleCanvas.height = window.innerHeight * ratio;
  themeParticleCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function createThemeParticles(){
  const count = Math.min(120, Math.floor(window.innerWidth / 12));
  themeParticles = Array.from({ length:count }, () => ({
    x:Math.random() * window.innerWidth,
    y:Math.random() * window.innerHeight,
    vx:(Math.random() - .5) * .35,
    vy:(Math.random() - .5) * .35,
    r:Math.random() * 1.8 + .35,
    a:Math.random() * .7 + .15
  }));
}

function drawThemeParticles(){
  if(!themeParticleCanvas || !themeParticleCtx) return;
  themeParticleCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  themeParticles.forEach((p, i) => {
    p.x += p.vx;
    p.y += p.vy;
    if(p.x < 0 || p.x > window.innerWidth) p.vx *= -1;
    if(p.y < 0 || p.y > window.innerHeight) p.vy *= -1;
    themeParticleCtx.beginPath();
    themeParticleCtx.fillStyle = `rgba(216,170,79,${p.a})`;
    themeParticleCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    themeParticleCtx.fill();
    for(let j = i + 1; j < themeParticles.length; j++){
      const q = themeParticles[j];
      const distance = Math.hypot(p.x - q.x, p.y - q.y);
      if(distance < 120){
        themeParticleCtx.strokeStyle = `rgba(216,170,79,${(1 - distance / 120) * .13})`;
        themeParticleCtx.lineWidth = 1;
        themeParticleCtx.beginPath();
        themeParticleCtx.moveTo(p.x, p.y);
        themeParticleCtx.lineTo(q.x, q.y);
        themeParticleCtx.stroke();
      }
    }
  });
  themeParticleFrame = requestAnimationFrame(drawThemeParticles);
}

function setThemeParticles(enabled){
  document.body.classList.toggle("theme-particles-on", enabled);
  if(!enabled){
    if(themeParticleFrame) cancelAnimationFrame(themeParticleFrame);
    themeParticleFrame = 0;
    themeParticleCanvas?.remove();
    themeParticleCanvas = null;
    themeParticleCtx = null;
    themeParticles = [];
    return;
  }
  if(themeParticleCanvas) return;
  themeParticleCanvas = document.createElement("canvas");
  themeParticleCanvas.className = "theme-particle-canvas";
  themeParticleCanvas.setAttribute("aria-hidden", "true");
  document.body.prepend(themeParticleCanvas);
  themeParticleCtx = themeParticleCanvas.getContext("2d");
  sizeThemeParticleCanvas();
  createThemeParticles();
  drawThemeParticles();
}

window.addEventListener("resize", () => {
  if(!themeParticleCanvas) return;
  sizeThemeParticleCanvas();
  createThemeParticles();
});

/* ================= STATE ================= */

let cart = [];
let userLocation = null;
let deliveryDistance = 0;
let deliveryCharge = 0;
let actualRoadDistance = 0;
let estimatedTravelTime = "";
let deliveryRoute = null;
let distanceSource = "route_pending";
let googleMapsApiKey = "";
let userLocationUpdatedAt = 0;
let deliveryDistanceUpdatedAt = 0;
let deliveryDistanceSignature = "";
let orderPerfDepth = 0;
let appPricing = {
  gstPercent:0,
  handlingCharge:0
};
let isOrderProcessing = false;
let lastOrderSignature = null;
let razorpayInFlight = false;
let activeCoupon = null;
let availableCoupons = [];
let countdownInterval = null;
let cachedAuthUser = auth.currentUser || null;
let authReadyResolved = false;
let resolveAuthReady;
const authReadyPromise = new Promise(resolve => {
  resolveAuthReady = resolve;
});
let restaurantState = {
  restaurantOpen:true,
  unavailableMessage:"Restaurant currently closed",
  autoCloseEnabled:false,
  closeTime:"02:00",
  openTime:"08:00",
  maintenanceMode:false
};

const GUEST_CART_KEY = "magneetozGuestCart";
const CHECKOUT_STATE_KEY = "magneetozCheckoutState";
const PG_REFERRAL_COUPON_KEY = "magneetozPgReferralCoupon";
const RAZORPAY_RECOVERY_KEY = "magneetozRazorpayRecovery";
const FUNCTIONS_REGION = "asia-south1";
const FUNCTIONS_BASE_URL = "https://asia-south1-magneetoz.cloudfunctions.net";
const LOCATION_CACHE_KEY = "magneetozLocation";
const CUSTOMER_LOCATION_MAX_AGE_MS = 2 * 60 * 1000;
const CHECKOUT_LOCATION_MAX_AGE_MS = 60 * 1000;
const CHECKOUT_LOCATION_REUSE_MAX_AGE_MS = 15 * 60 * 1000;
const DISTANCE_CACHE_MAX_AGE_MS = 60 * 1000;
const DEFAULT_FREE_DELIVERY_MIN = 199;
let resumeCheckoutAfterAuth = false;
let checkoutInFlightId = "";
let orderTrackingUnsub = null;
let orderTrackingUserId = "";
let phoneTrackingUnsub = null;
let authSignOutClearTimer = null;
let authCacheNullTimer = null;
let orderTrackingPausedForAuthRefresh = false;
let menuDishesUnsub = null;
let allMenuDishes = [];
let smartAssistantIntent = "popular";

function resetRazorpayCheckoutState({ clearCheckoutId = true } = {}){
  isOrderProcessing = false;
  razorpayInFlight = false;
  lastOrderSignature = null;
  if(clearCheckoutId) checkoutInFlightId = "";
}

function hasVisibleRazorpayCheckout(){
  return [...document.querySelectorAll(".razorpay-container, iframe[src*='razorpay'], iframe[name*='razorpay']")]
    .some(node => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
}

function renderHeroPizzaSlider(images = [], imageSets = []){
  const slider = document.getElementById("heroPizzaSlider");
  const bgSlider = document.getElementById("heroBgSlider");
  const cleanImages = images
    .map((image, index) => ({
      url:normalizeImageUrl(image),
      imageSet:imageSets[index] || null
    }))
    .filter(item => item.url)
    .slice(0, 8);
  const slides = cleanImages.length ? cleanImages : [{ url:"logo_tran.jpeg", imageSet:null }];
  const markup = slides.map((slide, index) => {
    const srcset = buildImageSrcset(slide.imageSet);
    const srcsetAttr = srcset ? `srcset="${escapeHTML(srcset)}" sizes="(max-width: 720px) 62vw, 420px"` : "";
    return `
    <img
      src="${escapeHTML(bestImageUrl(slide.url, slide.imageSet))}"
      ${srcsetAttr}
      alt="MAGNEETOZ pizza slide ${index + 1}"
      width="420"
      height="420"
      loading="${index === 0 ? "eager" : "lazy"}"
      fetchpriority="${index === 0 ? "high" : "auto"}"
      decoding="async"
      style="--slide-index:${index};--slide-count:${slides.length};"
      onerror="this.onerror=null;this.src='logo_tran.jpeg';"
    >
  `;
  }).join("");
  if(slider){
    slider.innerHTML = markup;
    slider.style.setProperty("--slide-count", String(slides.length));
  }
  if(bgSlider){
    bgSlider.innerHTML = slides.map((slide, index) => {
      const srcset = buildImageSrcset(slide.imageSet);
      const srcsetAttr = srcset ? `srcset="${escapeHTML(srcset)}" sizes="100vw"` : "";
      return `
      <img
        src="${escapeHTML(bestImageUrl(slide.url, slide.imageSet))}"
        ${srcsetAttr}
        alt=""
        width="1200"
        height="800"
        loading="${index === 0 ? "eager" : "lazy"}"
        fetchpriority="${index === 0 ? "high" : "auto"}"
        decoding="async"
        style="--slide-index:${index};--slide-count:${slides.length};"
        onerror="this.remove();"
      >
    `;
    }).join("");
    bgSlider.style.setProperty("--slide-count", String(slides.length));
  }
}

function warmVisibleMenuImages(){
  const run = () => {
    document.querySelectorAll(".new-card img, .offer-card img, .combo-card img").forEach((img, index) => {
      if(index < 10){
        img.loading = "eager";
        img.fetchPriority = index < 4 ? "high" : "auto";
      }
      img.decoding = "async";
      img.decode?.().catch(() => {});
    });
  };
  if("requestIdleCallback" in window){
    requestIdleCallback(run, { timeout:1200 });
  }else{
    setTimeout(run, 120);
  }
}

function syncHeroEmptyState(hero = {}){
  const heroSection = document.querySelector(".hero");
  if(!heroSection) return;
  const managedKeys = ["kicker", "title", "subtitle", "primaryButton", "secondaryButton"];
  const isManaged = managedKeys.some(key => key in hero);
  const fieldMap = {
    kicker:document.getElementById("heroKickerText"),
    title:document.getElementById("heroTitleText"),
    subtitle:document.getElementById("heroSubtitleText")?.closest("p"),
    primaryButton:document.getElementById("heroPrimaryBtnText"),
    secondaryButton:document.getElementById("heroSecondaryBtnText")?.closest("button")
  };
  if(!isManaged){
    Object.values(fieldMap).forEach(el => el?.classList.remove("hero-field-hidden"));
    document.querySelector(".hero-local-line")?.classList.remove("hero-field-hidden");
    heroSection.classList.remove("hero-empty-text");
    return;
  }
  const textValues = Object.entries(fieldMap).map(([key, el]) => {
    const value = String(hero[key] || "").trim();
    el?.classList.toggle("hero-field-hidden", !value);
    return value;
  });
  const isEmpty = textValues.every(value => !value);
  heroSection.classList.toggle("hero-empty-text", isEmpty);
  document.querySelector(".hero-local-line")?.classList.toggle("hero-field-hidden", isEmpty);
}

function applyHeroColors(hero = {}){
  const colors = hero.colors || {};
  const root = document.documentElement;
  const colorMap = {
    "--hero-kicker-color":colors.kicker,
    "--hero-title-color":colors.title,
    "--hero-subtitle-color":colors.subtitle,
    "--hero-primary-text-color":colors.primaryButton,
    "--hero-secondary-text-color":colors.secondaryButton
  };
  Object.entries(colorMap).forEach(([key, value]) => {
    if(typeof value === "string" && value.trim()) root.style.setProperty(key, value.trim());
    else root.style.removeProperty(key);
  });
}

function applyHeroBackgroundBlur(hero = {}){
  const rawValue = Number(hero.backgroundBlur);
  const blur = Number.isFinite(rawValue) ? Math.max(0, Math.min(24, Math.round(rawValue))) : 0;
  const rawBlackIntensity = Number(hero.backgroundBlackIntensity);
  const blackIntensity = Number.isFinite(rawBlackIntensity) ? Math.max(0, Math.min(85, Math.round(rawBlackIntensity))) : 24;
  document.documentElement.style.setProperty("--hero-bg-blur", `${blur}px`);
  document.documentElement.style.setProperty("--hero-bg-black-opacity", (blackIntensity / 100).toFixed(2));
}

function armRazorpayOpenWatchdog(){
  let checks = 0;
  const timer = setInterval(() => {
    checks += 1;
    if(!razorpayInFlight){
      clearInterval(timer);
      return;
    }
    if(!hasVisibleRazorpayCheckout() && checks >= 3){
      resetRazorpayCheckoutState();
      setCheckoutLoading(false);
      clearInterval(timer);
    }
    if(checks >= 12 && razorpayInFlight){
      resetRazorpayCheckoutState();
      setCheckoutLoading(false);
      clearInterval(timer);
    }
  }, 1000);
}

function rememberRazorpayPayment(paymentId, amount){
  if(!paymentId) return;
  try{
    localStorage.setItem(RAZORPAY_RECOVERY_KEY, JSON.stringify({
      paymentId,
      amount,
      orderId:"",
      orderNumber:"",
      savedAt:Date.now()
    }));
  }catch(error){
    console.warn("Razorpay recovery save skipped", error);
  }
}

function rememberCapturedOrderPayment({ paymentId, amount, orderId, orderNumber } = {}){
  if(!paymentId || !orderId) return;
  try{
    localStorage.setItem(RAZORPAY_RECOVERY_KEY, JSON.stringify({
      paymentId,
      amount,
      orderId,
      orderNumber:orderNumber || "",
      savedAt:Date.now()
    }));
    logStructured("PAYMENT RECOVERY", { event:"stored_captured_payment", orderId, paymentId });
  }catch(error){
    console.warn("Razorpay recovery save skipped", error);
  }
}

async function markOrderPaidFromRazorpay(orderId, paymentId){
  if(!orderId || !paymentId) throw new Error("Missing payment recovery details.");
  await updateDoc(doc(db, "orders", orderId), {
    status:"Pending",
    orderStatus:"Pending",
    paymentStatus:"paid",
    paymentMethod:"online",
    amountToCollect:0,
    paymentCaptured:true,
    paymentId,
    razorpayPaymentId:paymentId,
    transactionId:paymentId,
    paymentCollectedAt:serverTimestamp(),
    checkoutSource:"razorpay",
    paymentStage:"Payment Completed",
    lastStatusUpdatedAt:serverTimestamp()
  });
  logStructured("PAYMENT VERIFIED", { orderId, paymentId, paymentStatus:"paid", amountToCollect:0 });
}

async function retryCapturedPaymentRecovery(){
  try{
    const raw = localStorage.getItem(RAZORPAY_RECOVERY_KEY);
    if(!raw) return;
    const recovery = JSON.parse(raw);
    if(recovery?.mode === "payment_session" && recovery.paymentSessionId && recovery.paymentId && recovery.razorpayOrderId && recovery.razorpaySignature){
      const verifiedOrder = await callPaymentFunction("verifyPaymentAndCreateOrder", {
        paymentSessionId:recovery.paymentSessionId,
        razorpay_order_id:recovery.razorpayOrderId,
        razorpay_payment_id:recovery.paymentId,
        razorpay_signature:recovery.razorpaySignature
      }, 35000);
      clearRazorpayPaymentRecovery();
      logStructured("PAYMENT RECOVERY", { event:"session_recovered", orderId:verifiedOrder.orderId, paymentId:recovery.paymentId });
      return;
    }
    if(!recovery?.orderId || !recovery?.paymentId) return;
    await markOrderPaidFromRazorpay(recovery.orderId, recovery.paymentId);
    clearRazorpayPaymentRecovery();
    logStructured("PAYMENT RECOVERY", { event:"recovered", orderId:recovery.orderId, paymentId:recovery.paymentId });
  }catch(error){
    console.warn("Payment recovery retry failed", error);
  }
}

async function handlePaymentLinkReturn(){
  const params = new URLSearchParams(window.location.search || "");
  const paymentSessionId = params.get("paymentSessionId") || "";
  const razorpayPaymentId = params.get("razorpay_payment_id") || "";
  const paymentLinkId = params.get("razorpay_payment_link_id") || "";
  const paymentLinkReferenceId = params.get("razorpay_payment_link_reference_id") || "";
  const paymentLinkStatus = params.get("razorpay_payment_link_status") || "";
  const razorpaySignature = params.get("razorpay_signature") || "";
  if(!paymentSessionId || !razorpayPaymentId || !paymentLinkId || !paymentLinkReferenceId || !paymentLinkStatus || !razorpaySignature) return false;
  try{
    setCheckoutLoading(true, "Verifying payment and placing your order...");
    const verifiedOrder = await callPaymentFunction("verifyPaymentLinkAndCreateOrder", {
      paymentSessionId,
      razorpay_payment_id:razorpayPaymentId,
      razorpay_payment_link_id:paymentLinkId,
      razorpay_payment_link_reference_id:paymentLinkReferenceId,
      razorpay_payment_link_status:paymentLinkStatus,
      razorpay_signature:razorpaySignature
    }, 35000);
    clearRazorpayPaymentRecovery();
    window.history.replaceState({}, document.title, window.location.pathname);
    finishSuccessfulCheckout(verifiedOrder.orderNumber);
    return true;
  }catch(error){
    console.warn("Payment link verification failed:", error);
    setCheckoutRetry(error?.message || "Payment received. We are safely creating your order.", () => handlePaymentLinkReturn());
    return true;
  }
}

function clearRazorpayPaymentRecovery(){
  try{
    localStorage.removeItem(RAZORPAY_RECOVERY_KEY);
  }catch(error){
    console.warn("Razorpay recovery clear skipped", error);
  }
}

function rememberPaymentSessionRecovery(data = {}){
  if(!data.paymentSessionId) return;
  try{
    localStorage.setItem(RAZORPAY_RECOVERY_KEY, JSON.stringify({
      ...data,
      mode:"payment_session",
      savedAt:Date.now()
    }));
  }catch(error){
    console.warn("Payment session recovery save skipped", error);
  }
}

function withTimeout(promise, timeoutMs, message){
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || "Request timed out")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callPaymentFunction(name, payload, timeoutMs = 25000){
  const user = await waitForAuthReady();
  if(!user) throw new Error("Please login again to continue payment.");
  const token = await getIdToken(user, true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try{
    response = await fetch(`${FUNCTIONS_BASE_URL}/${name}`, {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Bearer ${token}`
      },
      body:JSON.stringify(payload || {}),
      signal:controller.signal
    });
  }catch(error){
    if(error?.name === "AbortError"){
      throw new Error(name === "createPaymentSession"
        ? "Payment server is taking too long. Please check internet and try again."
        : "Payment verification is taking too long. Your paid order recovery is safe, please retry.");
    }
    throw new Error(error?.message || "Payment server is not reachable.");
  }finally{
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if(name === "createPaymentSession"){
    console.log("CREATE_SESSION_RESPONSE", {
      status:response.status,
      ok:response.ok,
      paymentSessionId:data.paymentSessionId || "",
      razorpayOrderId:data.razorpayOrderId || "",
      amount:data.amount,
      amountPaise:data.amountPaise,
      currency:data.currency,
      orderStatus:data.orderStatus,
      paymentLinkUrl:data.paymentLinkUrl || "",
      keyId:data.keyId || ""
    });
  }
  if(!response.ok || data.ok === false) throw new Error(data.error || "Payment service failed.");
  return data;
}
let guestStatePersistTimer = null;
let categoryScrollRaf = false;
let categoriesUnsub = null;
let categoriesReady = false;
let menuListenerStarted = false;
let categoryGridIds = new Set();
let cachedCategorySections = [];
let cachedCategoryLinks = [];
let menuImageRenderIndex = 0;
let activeCategoryId = "";
let menuCategoryGroups = [];
let activeMenuGroup = "";
let activeMenuCategory = "";
let menuBrowserOpen = false;
let menuBrowserHideOnNextScroll = false;
const globalSnapshotUnsubs = [];
let restaurantLocationReadyResolved = false;
let resolveRestaurantLocationReady;
const restaurantLocationReadyPromise = new Promise(resolve => {
  resolveRestaurantLocationReady = resolve;
});

const CANCEL_WINDOW_SECONDS = 40;
const ACTIVE_RIDER_STATUSES = new Set([
  "Rider Accepted",
  "Rider Assigned",
  "Picked Up",
  "Out For Delivery",
  "Reached Nearby",
  "Collect Payment",
  "Payment Completed",
  "Assigned To Delivery Boy"
]);

function registerGlobalSnapshot(unsub){
  if(typeof unsub === "function") globalSnapshotUnsubs.push(unsub);
  return unsub;
}

function cleanupCheckoutListeners(){
  try{ orderTrackingUnsub?.(); }catch(error){}
  try{ phoneTrackingUnsub?.(); }catch(error){}
  try{ categoriesUnsub?.(); }catch(error){}
  try{ menuDishesUnsub?.(); }catch(error){}
  orderTrackingUnsub = null;
  phoneTrackingUnsub = null;
  categoriesUnsub = null;
  menuDishesUnsub = null;
  while(globalSnapshotUnsubs.length){
    const unsub = globalSnapshotUnsubs.pop();
    try{ unsub?.(); }catch(error){}
  }
}

window.addEventListener("pagehide", cleanupCheckoutListeners, { capture:true });

const VAPID_KEY_RE = /^[A-Za-z0-9_-]{80,}$/;
const ORDER_STATUS_FLOW = [
  "Pending",
  "Accepted",
  "Preparing",
  "Searching For Rider",
  "Rider Assigned",
  "Picked Up",
  "Out For Delivery",
  "Nearby",
  "Cash Collected",
  "Payment Settled",
  "Delivery Code Pending",
  "Payment Completed",
  "Delivered"
];

function normalizeVapidKey(value = ""){
  return String(value || "").trim();
}

function isValidVapidKey(value){
  const key = normalizeVapidKey(value);
  if(!VAPID_KEY_RE.test(key) || key.length % 4 === 1) return false;
  try{
    const padded = key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=");
    atob(padded);
    return true;
  }catch(_){
    return false;
  }
}

function escapeHTML(value = ""){
  return String(value)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function normalizeImageUrl(value){
  const image = String(value || "").trim();
  if(!image) return "logo_tran.jpeg";
  if(image.startsWith("http://") || image.startsWith("https://") || image.startsWith("data:") || image.startsWith("blob:")){
    return image;
  }
  return image.replace(/^\.?\//, "") || "logo_tran.jpeg";
}

function imageVariantUrl(imageSet, key){
  return imageSet?.variants?.[key]?.url || imageSet?.[key]?.url || imageSet?.[key] || "";
}

function bestImageUrl(src, imageSet){
  return normalizeImageUrl(
    imageVariantUrl(imageSet, "mobile") ||
    imageVariantUrl(imageSet, "desktop") ||
    imageSet?.url ||
    src
  );
}

function buildImageSrcset(imageSet){
  if(!imageSet) return "";
  return [
    ["thumbnail", 320],
    ["mobile", 400],
    ["tablet", 800],
    ["desktop", 1200]
  ]
    .map(([key, width]) => {
      const url = imageVariantUrl(imageSet, key);
      return url ? `${normalizeImageUrl(url)} ${width}w` : "";
    })
    .filter(Boolean)
    .join(", ");
}

function imageFallbackAttrs(){
  return `onload="this.closest('.image-shell')?.classList.add('is-loaded')" onerror="this.onerror=null;this.src='logo_tran.jpeg';this.closest('.image-shell')?.classList.add('is-loaded')"`;
}

function formatCurrency(amount){
  return new Intl.NumberFormat("en-IN", {
    style:"currency",
    currency:"INR",
    maximumFractionDigits:0
  }).format(Number(amount) || 0);
}

function logStructured(scope, detail = {}){
  console.info(`[${scope}]`, detail);
}

function statusRank(status){
  const normalized = normalizeTimelineStatus(status);
  const index = ORDER_STATUS_FLOW.indexOf(normalized);
  return index < 0 ? 0 : index;
}

function buildInvoiceNumber(orderId = ""){
  const stamp = new Date().toISOString().slice(0,10).replaceAll("-","");
  return `MZ-${stamp}-${String(orderId).slice(-6).toUpperCase() || Math.random().toString(36).slice(2,8).toUpperCase()}`;
}

function calculateInvoicePricing(subtotal, basePricing = calculateCouponPricing(subtotal)){
  const gstPercent = Math.max(0, Number(appPricing.gstPercent) || 0);
  const handlingCharge = Math.max(0, Math.round(Number(appPricing.handlingCharge) || 0));
  const discount = Math.max(0, Number(basePricing.couponDiscount || 0) + Number(basePricing.freeDeliveryDiscount || 0));
  const delivery = Math.max(0, Number(basePricing.deliveryCharge) || 0);
  const taxableAmount = Math.max(0, Number(subtotal) - Number(basePricing.couponDiscount || 0));
  const gstAmount = Math.round(taxableAmount * gstPercent / 100);
  const grandTotal = Math.max(0, Math.round(taxableAmount + gstAmount + handlingCharge + delivery));
  return {
    ...basePricing,
    gstPercent,
    gstAmount,
    handlingCharge,
    discount,
    grandTotal,
    finalTotal:grandTotal
  };
}

function ensureCustomerDistanceBanner(){
  return document.getElementById("customerDistanceBanner");
}

function updateCustomerDistanceGlobals(){
  window.customerDistanceKm = Number(deliveryDistance || 0);
  window.customerLatitude = userLocation?.lat || null;
  window.customerLongitude = userLocation?.lng || null;
}

function updateCustomerDistanceBanner(message){
  const banner = ensureCustomerDistanceBanner();
  if(!banner) return;
  if(message){
    banner.textContent = message;
    banner.title = "Tap to refresh your current location";
    return;
  }
  updateCustomerDistanceGlobals();
  const kitchen = getRestaurantLocation();
  if(!kitchen){
    banner.title = "Kitchen location is loading";
    banner.textContent = "📍 Kitchen location is loading. Please try again in a moment.";
    return;
  }
  banner.title = userLocation
    ? `Tap to refresh location. Restaurant: ${kitchen.lat}, ${kitchen.lng}. You: ${userLocation.lat}, ${userLocation.lng}.`
    : "Tap to allow current location";
  banner.textContent = deliveryDistance
    ? `📍 You are ${Number(deliveryDistance).toFixed(1)} km away from our kitchen · Tap to refresh`
    : "📍 Enable location to see your distance from our kitchen";
}

function setLocationUiState(state, detail = ""){
  const status = document.getElementById("locationStatus");
  const banner = ensureCustomerDistanceBanner();
  const messages = {
    detecting:"Detecting location...",
    current:"Current location updated",
    permission:"Location permission required",
    lastSaved:"Last saved location",
    idle:"Tap to fetch your current location"
  };
  const text = detail || messages[state] || messages.idle;
  if(status) status.textContent = text;
  if(banner) {
    banner.textContent = state === "lastSaved" ? `📍 Last saved location · ${detail || "Tap Refresh Location for current GPS"}` : `📍 ${text}`;
    banner.title = state === "lastSaved" ? "This is not live GPS. Tap to refresh current location." : "Tap to refresh current location";
  }
}

async function getLocationPermissionState(){
  try{
    if(!navigator.permissions?.query) return "unknown";
    const result = await navigator.permissions.query({ name:"geolocation" });
    return result.state || "unknown";
  }catch{
    return "unknown";
  }
}

function requestFreshGpsPosition(){
  return new Promise((resolve, reject) => {
    if(!navigator.geolocation){
      reject(new Error("Geolocation not supported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy:true,
      maximumAge:0,
      timeout:10000
    });
  });
}

async function reverseGeocodeFreshLocation(location){
  try{
    const result = await callPaymentFunction("reverseGeocodeAddress", { lat:location.lat, lng:location.lng }, 15000);
    console.info("[LOCATION]", { event:"reverse_geocode_response", result });
    return result;
  }catch(error){
    console.warn("[LOCATION]", { event:"reverse_geocode_failed", error:error?.message || String(error) });
    return null;
  }
}

function showLastSavedLocation(reason = "fresh_location_failed"){
  const saved = normalizeCustomerLocation(readJSON(LOCATION_CACHE_KEY, null), "last_saved");
  console.warn("[LOCATION]", { event:"show_last_saved_location", reason, saved });
  if(!saved){
    setLocationUiState("permission", "Please enable location permission and GPS, then retry.");
    return null;
  }
  userLocation = saved;
  userLocationUpdatedAt = saved.updatedAt || 0;
  updateCustomerDistanceGlobals();
  setLocationUiState("lastSaved", `${saved.lat.toFixed(5)}, ${saved.lng.toFixed(5)}`);
  return saved;
}

async function fetchFreshCurrentLocation({ updateAddress = true, source = "fresh_gps" } = {}){
  setLocationUiState("detecting");
  const permission = await getLocationPermissionState();
  console.info("[LOCATION]", { event:"permission_status", permission, source });
  try{
    const pos = await requestFreshGpsPosition();
    const fresh = {
      lat:pos.coords.latitude,
      lng:pos.coords.longitude,
      accuracy:pos.coords.accuracy,
      updatedAt:Date.now(),
      source,
      mapLink:`https://www.google.com/maps?q=${pos.coords.latitude},${pos.coords.longitude}`
    };
    console.info("[LOCATION]", { event:"fresh_gps_lat_lng", lat:fresh.lat, lng:fresh.lng, accuracy:fresh.accuracy, source });
    const geocode = updateAddress ? await reverseGeocodeFreshLocation(fresh) : null;
    setCustomerLocation({
      ...fresh,
      address:geocode?.formattedAddress || ""
    }, source);
    console.info("[LOCATION]", { event:"storage_update_status", ok:true, key:LOCATION_CACHE_KEY, updatedAt:userLocationUpdatedAt });
    if(updateAddress && geocode?.formattedAddress){
      const addressEl = document.getElementById("customerAddress");
      const latEl = document.getElementById("customerLat");
      const lngEl = document.getElementById("customerLng");
      if(addressEl) addressEl.value = geocode.formattedAddress;
      if(latEl) latEl.value = geocode.lat || fresh.lat;
      if(lngEl) lngEl.value = geocode.lng || fresh.lng;
      setCheckoutFieldsCollapsed(false);
      persistGuestState();
    }
    setLocationUiState("current", geocode?.formattedAddress || "Current location updated");
    updateCustomerDistanceGlobals();
    await refreshDeliveryDistance({ force:true, maxAgeMs:0, routeTimeoutMs:12000 }).catch(() => updateCustomerDistanceBanner());
    return userLocation;
  }catch(error){
    console.warn("[LOCATION]", { event:"fresh_location_failed", error:error?.message || String(error), code:error?.code, source });
    setLocationUiState("permission", "Please enable location permission and GPS, then retry.");
    showLastSavedLocation(error?.message || "fresh_location_failed");
    throw error;
  }
}

function resetCustomerLocation(){
  clearCustomerLocation("manual_reset");
  estimatedTravelTime = "";
  deliveryRoute = null;
  updateCustomerDistanceGlobals();
  updateCustomerDistanceBanner("📍 Tap to fetch your current location again");
}

window.resetCustomerLocation = resetCustomerLocation;

function timestampToMillis(value){
  if(!value) return 0;
  if(typeof value.toMillis === "function") return value.toMillis();
  if(value.seconds) return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildOrderTimestamps(){
  const now = new Date();
  return {
    createdAt: Timestamp.fromDate(now),
    cancelWindowEndsAt: Timestamp.fromDate(new Date(now.getTime() + CANCEL_WINDOW_SECONDS * 1000))
  };
}

function minutesOf(time = "00:00"){
  const [h,m] = String(time).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function restaurantUnavailable(){
  if(restaurantState.maintenanceMode) return true;
  if(restaurantState.restaurantOpen === false) return true;
  if(restaurantState.autoCloseEnabled){
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    const close = minutesOf(restaurantState.closeTime);
    const open = minutesOf(restaurantState.openTime);
    if(close === open) return false;
    if(close < open && current >= close && current < open) return true;
    if(close > open && (current >= close || current < open)) return true;
  }
  return false;
}

function ensureRestaurantBanner(){
  let banner = document.getElementById("restaurantAvailabilityBanner");
  if(banner) return banner;
  banner = document.createElement("div");
  banner.id = "restaurantAvailabilityBanner";
  banner.className = "restaurant-availability-banner";
  document.body.prepend(banner);
  return banner;
}

function applyRestaurantAvailability(){
  const unavailable = restaurantUnavailable();
  const banner = ensureRestaurantBanner();
  banner.innerHTML = `
    <strong>${unavailable ? "Restaurant currently closed" : "Restaurant open"}</strong>
    <span>${unavailable ? (restaurantState.unavailableMessage || "Service unavailable right now") : "We are accepting orders now."}</span>
  `;
  banner.classList.toggle("show", unavailable);
  document.body.classList.toggle("restaurant-closed", unavailable);
  document.querySelectorAll(".add-cart-btn, [aria-label='Place order'], #codBtn, #upiBtn").forEach(button => {
    button.disabled = unavailable;
  });
}

function parseCurrency(value){
  return Number(String(value || "").replace(/[^\d.-]/g, "")) || 0;
}

function normalizeUnicodeText(value = ""){
  return String(value || "").normalize("NFC").trim();
}

function cleanInvoiceItemName(value = ""){
  const text = normalizeUnicodeText(value)
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF�]/g, "")
    .replace(/^(?:ð|Ã|Â|â|Ø|Ÿ|‹|›|œ|¢|€|™|[^\w\s])+/iu, "")
    .trim();
  const firstReadable = text.search(/[A-Za-z0-9\u0900-\u097F]/u);
  return firstReadable > 0 ? text.slice(firstReadable).trim() : (text || "Item");
}

function imageMarkup(src, alt, imageSet = null){
  menuImageRenderIndex += 1;
  const eager = menuImageRenderIndex <= 12;
  const srcset = buildImageSrcset(imageSet);
  const srcsetAttr = srcset ? `srcset="${escapeHTML(srcset)}" sizes="(max-width: 720px) 46vw, (max-width: 1100px) 260px, 320px"` : "";
  return `<span class="image-shell dish-image-shell">
    <img src="${escapeHTML(bestImageUrl(src, imageSet))}" ${srcsetAttr} alt="${escapeHTML(alt || "Magneetoz dish")}" width="640" height="480" loading="${eager ? "eager" : "lazy"}" fetchpriority="${eager && menuImageRenderIndex <= 6 ? "high" : "auto"}" decoding="async" ${imageFallbackAttrs()}>
  </span>`;
}

function dishDataAttrs(d = {}){
  return `
    data-dish-name="${escapeHTML(normalizeUnicodeText(d.name || ""))}"
    data-dish-desc="${escapeHTML(normalizeUnicodeText(d.description || "Fresh MAGNEETOZ favourite"))}"
    data-dish-image="${escapeHTML(bestImageUrl(d.image, d.imageSet))}"
    data-dish-category="${escapeHTML(d.category || "Recommended")}"
  `;
}

function dishLowestVariant(d = {}){
  if(d.type === "simple"){
    return {
      size:"Regular",
      price:Number(d.price || 0),
      market:Number(d.marketPrice || Number(d.price || 0) + 20)
    };
  }
  const sizes = d.sizes || {};
  const variants = ["small", "medium", "large"]
    .map(key => {
      const value = sizes[key];
      if(!value) return null;
      const price = typeof value === "object" ? Number(value.price || 0) : Number(value || 0);
      const market = typeof value === "object" ? Number(value.market || price + 50) : price + 50;
      return { size:key.charAt(0).toUpperCase() + key.slice(1), price, market };
    })
    .filter(item => item && item.price > 0)
    .sort((a, b) => a.price - b.price);
  return variants[0] || { size:"Regular", price:Number(d.price || 0), market:Number(d.marketPrice || 0) };
}

function addDishObjectToCart(dish = {}, qty = 1){
  if(restaurantUnavailable()){
    alert(restaurantState.unavailableMessage || "Restaurant currently closed");
    applyRestaurantAvailability();
    return;
  }
  const variant = dishLowestVariant(dish);
  if(!variant.price){
    alert("This item is not available right now.");
    return;
  }
  cart.push({
    name:dish.name || "MAGNEETOZ Item",
    size:variant.size,
    qty,
    category:dish.category || "Recommended",
    image:normalizeImageUrl(dish.image),
    unitPrice:variant.price,
    price:variant.price * qty
  });
  persistGuestState();
  updateCart();
  notifyPremiumUI("magneetoz:item-added", { name:dish.name || "Item", qty, price:variant.price * qty });
  toastSuccess(`${dish.name || "Item"} added to cart`);
}

function textForDish(dish = {}){
  return `${dish.name || ""} ${dish.description || ""} ${dish.category || ""}`.toLowerCase();
}

function scoreSmartDish(dish = {}, intent = "popular"){
  const variant = dishLowestVariant(dish);
  const price = Number(variant.price || 0);
  const text = textForDish(dish);
  let score = 0;
  if(!dish.available || !price) return -999;
  if(intent === "budget") score += price <= 99 ? 80 : Math.max(0, 60 - price / 3);
  if(intent === "veg") score += /veg|vegetable|paneer|corn|mushroom|cheese/.test(text) ? 80 : -20;
  if(intent === "cheesy") score += /cheese|cheesy|paneer|mozzarella|loaded/.test(text) ? 85 : 5;
  if(intent === "spicy") score += /spicy|chilli|chili|masala|peri|hot|tandoori/.test(text) ? 85 : 5;
  if(intent === "popular") score += /pizza|magneetoz|special|loaded|best|popular|pick/.test(text) ? 65 : 25;
  if(intent === "freeDelivery") score += price >= 49 ? Math.min(90, price) : 35;
  if((cart || []).some(item => String(item.name || "").toLowerCase() === String(dish.name || "").toLowerCase())) score -= 18;
  score += Math.max(0, 120 - price) / 12;
  return score;
}

function smartAssistantTitle(intent){
  return ({
    budget:"Best picks under budget",
    veg:"Fresh veg picks for you",
    cheesy:"Cheesy cravings sorted",
    spicy:"Spicy favourites",
    popular:"Most loved MAGNEETOZ picks",
    freeDelivery:"Add these to unlock better value"
  })[intent] || "Recommended for you";
}

function renderSmartAssistant(intent = smartAssistantIntent){
  smartAssistantIntent = intent;
  const results = document.getElementById("smartAssistantResults");
  const summary = document.getElementById("smartAssistantSummary");
  const chips = document.getElementById("smartAssistantChips");
  if(!results) return;
  const subtotal = getCartSubtotal();
  const freeDeliveryTarget = deliveryDistance && deliveryDistance <= 3 ? 149 : DEFAULT_FREE_DELIVERY_MIN;
  const neededForFree = Math.max(0, freeDeliveryTarget - subtotal);
  const dishes = [...allMenuDishes]
    .sort((a, b) => scoreSmartDish(b, intent) - scoreSmartDish(a, intent))
    .slice(0, 4);
  if(summary){
    summary.textContent = intent === "freeDelivery" && neededForFree > 0
      ? `Add around ${formatCurrency(neededForFree)} more to reach free delivery.`
      : `${smartAssistantTitle(intent)} from the live menu.`;
  }
  chips?.querySelectorAll("button").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.aiIntent === intent);
  });
  if(!dishes.length){
    results.innerHTML = `<div class="smart-empty">Menu suggestions are loading...</div>`;
    return;
  }
  results.innerHTML = dishes.map((dish, index) => {
    const variant = dishLowestVariant(dish);
    return `
      <article class="smart-result-card">
        <img src="${escapeHTML(normalizeImageUrl(dish.image))}" alt="${escapeHTML(dish.name || "MAGNEETOZ item")}" loading="lazy" onerror="this.onerror=null;this.src='logo_tran.jpeg';">
        <div>
          <span>${index === 0 ? "Top pick" : escapeHTML(dish.category || "Recommended")}</span>
          <strong>${escapeHTML(dish.name || "MAGNEETOZ Item")}</strong>
          <small>${escapeHTML((dish.description || "Fresh MAGNEETOZ favourite").slice(0, 70))}</small>
          <b>${formatCurrency(variant.price)}</b>
        </div>
        <button type="button" onclick="addSmartAssistantItem('${escapeHTML(String(dish.id || ""))}')">Add +</button>
      </article>
    `;
  }).join("");
}

window.addSmartAssistantItem = function(dishId){
  const dish = allMenuDishes.find(item => String(item.id) === String(dishId));
  if(dish) addDishObjectToCart(dish, 1);
};

function notifyPremiumUI(name, detail = {}){
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function toastSuccess(message){ window.MagneetozNotify?.success(message); }
function toastInfo(message){ window.MagneetozNotify?.info(message); }
function toastWarning(message){ window.MagneetozNotify?.warning(message); }
function toastError(message){ window.MagneetozNotify?.error(message); }

onAuthStateChanged(auth, user => {
  if(user){
    if(authCacheNullTimer){
      clearTimeout(authCacheNullTimer);
      authCacheNullTimer = null;
    }
    cachedAuthUser = user;
  }else if(cachedAuthUser){
    if(authCacheNullTimer) clearTimeout(authCacheNullTimer);
    authCacheNullTimer = setTimeout(() => {
      if(!auth.currentUser) cachedAuthUser = null;
      authCacheNullTimer = null;
    }, 2500);
  }else{
    cachedAuthUser = null;
  }
  if(!authReadyResolved){
    authReadyResolved = true;
    resolveAuthReady(cachedAuthUser);
  }
  if(user) retryCapturedPaymentRecovery();
});

async function waitForAuthReady(timeoutMs = 6000){
  if(authReadyResolved) return cachedAuthUser || auth.currentUser || null;
  return Promise.race([
    authReadyPromise,
    new Promise(resolve => setTimeout(() => resolve(auth.currentUser || cachedAuthUser || null), timeoutMs))
  ]);
}

function setCheckoutLoading(active, message = "Processing your order..."){
  const loader = document.getElementById("globalLoader");
  document.body?.classList.toggle("checkout-busy", active);
  if(loader){
    loader.style.display = active ? "flex" : "none";
    loader.innerHTML = active
      ? `<div class="checkout-loader-card"><b>${escapeHTML(message)}</b><span>Please wait, do not close this page.</span><button type="button" id="checkoutRetryBtn" style="display:none">Retry</button></div>`
      : "Loading...";
  }
}

function setCheckoutRetry(message, retryFn){
  const loader = document.getElementById("globalLoader");
  if(!loader) return;
  loader.style.display = "flex";
  loader.innerHTML = `<div class="checkout-loader-card"><b>${escapeHTML(message)}</b><span>Your cart is safe. Try again when the connection is stable.</span><button type="button" id="checkoutRetryBtn">Retry</button></div>`;
  document.getElementById("checkoutRetryBtn")?.addEventListener("click", () => {
    setCheckoutLoading(false);
    retryFn?.();
  }, { once:true });
}

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryAsync(fn, attempts = 3, baseDelay = 450){
  let lastError;
  for(let i = 0; i < attempts; i++){
    try{
      return await fn(i);
    }catch(error){
      lastError = error;
      if(i < attempts - 1) await sleep(baseDelay * (i + 1));
    }
  }
  throw lastError;
}

function checkoutSignature(paymentMethod = "COD"){
  const subtotal = getCartSubtotal();
  const pricing = calculateInvoicePricing(subtotal);
  const fields = getCheckoutFields();
  return JSON.stringify({
    paymentMethod,
    items:cart.map(item => `${item.name}:${item.qty}:${item.price}`).join("|"),
    coupon:activeCoupon?.code || "",
    subtotal,
    deliveryCharge:pricing.deliveryCharge,
    couponDiscount:pricing.couponDiscount,
    freeDeliveryDiscount:pricing.freeDeliveryDiscount,
    gstAmount:pricing.gstAmount,
    handlingCharge:pricing.handlingCharge,
    total:pricing.grandTotal,
    distance:Number(deliveryDistance || 0),
    addressLat:fields.lat || userLocation?.lat || "",
    addressLng:fields.lng || userLocation?.lng || "",
    phone:fields.phone
  });
}

function readJSON(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch(_){
    return fallback;
  }
}

function writeJSON(key, value){
  try{
    localStorage.setItem(key, JSON.stringify(value));
  }catch(error){
    console.warn("Local cache write failed:", key, error);
  }
}

function normalizeCouponKey(value = ""){
  return String(value || "").trim().toUpperCase();
}

function capturePgReferralCoupon(){
  const params = new URLSearchParams(window.location.search || "");
  const couponCode = normalizeCouponKey(params.get("coupon") || params.get("couponCode") || params.get("code") || params.get("refCoupon"));
  const pgCode = normalizeCouponKey(params.get("pg") || params.get("pgCode") || params.get("pgid") || params.get("source"));
  const pgName = String(params.get("pgName") || params.get("hostel") || "").trim();
  if(!couponCode && !pgCode && !pgName) return readJSON(PG_REFERRAL_COUPON_KEY, null);

  const referral = {
    couponCode,
    pgCode,
    pgName,
    capturedAt:Date.now()
  };
  writeJSON(PG_REFERRAL_COUPON_KEY, referral);
  return referral;
}

function findReferralCoupon(referral = readJSON(PG_REFERRAL_COUPON_KEY, null)){
  if(!referral || !availableCoupons.length) return null;
  const couponCode = normalizeCouponKey(referral.couponCode);
  const pgCode = normalizeCouponKey(referral.pgCode);
  const pgName = normalizeCouponKey(referral.pgName);
  return availableCoupons.find(coupon => {
    if(coupon.deleted === true || coupon.active === false || couponExpired(coupon)) return false;
    if(couponCode && normalizeCouponKey(coupon.code) === couponCode) return true;
    if(pgCode && normalizeCouponKey(coupon.pgCode) === pgCode) return true;
    if(pgName && normalizeCouponKey(coupon.pgName || coupon.pg) === pgName) return true;
    return false;
  }) || null;
}

function fillReferralCouponField(coupon){
  if(!coupon?.code) return;
  const input = document.getElementById("couponInput");
  if(input) input.value = coupon.code;
}

function applyReferralCouponIfPossible({ silent = true } = {}){
  if(activeCoupon) return activeCoupon;
  const coupon = findReferralCoupon();
  if(!coupon) return null;
  activeCoupon = coupon;
  fillReferralCouponField(coupon);
  persistGuestState();
  if(!silent) toastSuccess?.(`${coupon.code} coupon ready`);
  return coupon;
}

function isUsableCoordinatePair(lat, lng){
  return Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lng)) &&
    Math.abs(Number(lat)) <= 90 &&
    Math.abs(Number(lng)) <= 180;
}

function normalizeCustomerLocation(location, source = "unknown"){
  if(!location || !isUsableCoordinatePair(location.lat, location.lng)) return null;
  const updatedAt = Number(location.updatedAt || location.timestamp || userLocationUpdatedAt || Date.now());
  return {
    lat:Number(location.lat),
    lng:Number(location.lng),
    mapLink:location.mapLink || `https://www.google.com/maps?q=${Number(location.lat)},${Number(location.lng)}`,
    accuracy:Number(location.accuracy || 0),
    updatedAt,
    source
  };
}

function setCustomerLocation(location, source = "gps"){
  const next = normalizeCustomerLocation(location, source);
  if(!next) return null;
  userLocation = next;
  userLocationUpdatedAt = next.updatedAt || Date.now();
  const shouldPersistLocation = /^(gps|fresh|address_geocode)/i.test(source);
  if(shouldPersistLocation){
    writeJSON(LOCATION_CACHE_KEY, {
      ...next,
      updatedAt:userLocationUpdatedAt
    });
    console.info("[LOCATION]", { event:"storage_update_status", ok:true, source, key:LOCATION_CACHE_KEY });
  }else{
    console.info("[LOCATION]", { event:"storage_update_skipped_non_fresh", source });
  }
  logDistanceDebug("customer_location_set", { customerLocationSource:source });
  return userLocation;
}

function isFreshCustomerLocation(maxAgeMs = CUSTOMER_LOCATION_MAX_AGE_MS){
  return !!(userLocation && isUsableCoordinatePair(userLocation.lat, userLocation.lng) && Date.now() - userLocationUpdatedAt <= maxAgeMs);
}

function clearCustomerLocation(reason = "cleared"){
  userLocation = null;
  userLocationUpdatedAt = 0;
  deliveryDistance = 0;
  actualRoadDistance = 0;
  deliveryDistanceUpdatedAt = 0;
  deliveryDistanceSignature = "";
  localStorage.removeItem(LOCATION_CACHE_KEY);
  logDistanceDebug("customer_location_cleared", { reason });
}

function distanceSignature(){
  const kitchen = getRestaurantLocation();
  if(!kitchen || !userLocation) return "";
  return [
    kitchen.lat.toFixed(6),
    kitchen.lng.toFixed(6),
    Number(userLocation.lat).toFixed(6),
    Number(userLocation.lng).toFixed(6)
  ].join("|");
}

function isFreshDeliveryDistance(maxAgeMs = DISTANCE_CACHE_MAX_AGE_MS){
  return !!(deliveryDistanceSignature &&
    deliveryDistanceSignature === distanceSignature() &&
    Date.now() - deliveryDistanceUpdatedAt <= maxAgeMs &&
    deliveryDistance > 0);
}

function perfStart(label){
  console.time(label);
}

function perfEnd(label){
  console.timeEnd(label);
}

async function timedStep(label, fn){
  perfStart(label);
  const started = performance.now();
  try{
    return await fn();
  }finally{
    const elapsed = performance.now() - started;
    perfEnd(label);
    if(elapsed > 100) console.warn("[CHECKOUT_PERF_SLOW_STEP]", { step:label, ms:Math.round(elapsed) });
    if(elapsed > 500) console.warn("[CHECKOUT_PERF_NETWORK_OR_BLOCKING]", { step:label, ms:Math.round(elapsed) });
  }
}



function getCheckoutFields(){
  return {
    name:normalizeUnicodeText(document.getElementById("customerName")?.value || ""),
    phone:normalizeUnicodeText(document.getElementById("customerPhone")?.value || ""),
    address:normalizeUnicodeText(document.getElementById("customerAddress")?.value || ""),
    landmark:normalizeUnicodeText(document.getElementById("customerLandmark")?.value || ""),
    lat:Number(document.getElementById("customerLat")?.value || userLocation?.lat || 0) || null,
    lng:Number(document.getElementById("customerLng")?.value || userLocation?.lng || 0) || null
  };
}

function focusMissingCheckoutField(){
  const fields = [
    ["customerName", "name"],
    ["customerPhone", "mobile number"],
    ["customerAddress", "address"]
  ];
  const missing = fields.find(([id]) => !normalizeUnicodeText(document.getElementById(id)?.value || ""));
  if(!missing) return false;
  setCheckoutFieldsCollapsed(false);
  const el = document.getElementById(missing[0]);
  el?.scrollIntoView({ behavior:"smooth", block:"center" });
  setTimeout(() => el?.focus(), 250);
  alert(`Please enter your ${missing[1]}.`);
  return true;
}

function restoreCheckoutFields(state = readJSON(CHECKOUT_STATE_KEY, {}), force = false){
  const map = {
    customerName:state.name,
    customerPhone:state.phone,
    customerAddress:state.address,
    customerLandmark:state.landmark,
    customerLat:state.lat,
    customerLng:state.lng
  };
  Object.entries(map).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if(el && value && (force || !el.value)) el.value = value;
  });
}

function setCheckoutFieldsCollapsed(collapsed){
  const panel = document.getElementById("cartPanel");
  panel?.classList.toggle("saved-address-selected", !!collapsed);
}

function addressSignature(fields){
  return [fields.name, fields.phone, fields.address, fields.landmark, fields.lat, fields.lng].map(v => String(v || "").trim().toLowerCase()).join("|");
}

function addressDistanceLabel(item = {}){
  if(Number(item.routeDistanceKm) > 0) return ` - You are ${Number(item.routeDistanceKm).toFixed(1)} km from us`;
  if(item.routeDistanceStatus === "loading") return " - checking distance...";
  if(item.routeDistanceStatus === "unavailable") return " - distance unavailable";
  return "";
}

async function hydrateSavedAddressDistances(addresses = []){
  const select = document.getElementById("savedAddressSelect");
  const kitchen = await waitForRestaurantLocation(4000);
  if(!select || !kitchen || !addresses.length) return;
  const next = addresses.map(item => ({ ...item }));
  let changed = false;
  await Promise.all(next.map(async (item, index) => {
    if(!isUsableLocation(item)) return;
    const signature = `${Number(item.lat).toFixed(6)},${Number(item.lng).toFixed(6)}|${Number(kitchen.lat).toFixed(6)},${Number(kitchen.lng).toFixed(6)}`;
    item.routeDistanceStatus = "loading";
    try{
      const result = await callPaymentFunction("calculateRouteDistance", {
        origin:kitchen,
        destination:{ lat:Number(item.lat), lng:Number(item.lng) }
      }, 12000);
      item.routeDistanceKm = Number(result.distanceKm || 0);
      item.routeDistanceText = result.durationText || "";
      item.routeDistanceSource = result.source || "google_routes_backend";
      item.routeDistanceSignature = signature;
      item.routeDistanceUpdatedAt = Date.now();
      item.routeDistanceStatus = item.routeDistanceKm ? "ok" : "unavailable";
      changed = true;
      const option = select.querySelector(`option[value="${index}"]`);
      if(option){
        const label = item.label || item.address || `Address ${index + 1}`;
        option.textContent = `${label.slice(0, 52)}${addressDistanceLabel(item)} 📍`;
      }
    }catch(error){
      item.routeDistanceStatus = "unavailable";
      const option = select.querySelector(`option[value="${index}"]`);
      if(option){
        const label = item.label || item.address || `Address ${index + 1}`;
        option.textContent = `${label.slice(0, 52)} - distance unavailable 📍`;
      }
    }
  }));
  select.dataset.addresses = JSON.stringify(next);
  if(changed && auth.currentUser?.uid){
    setDoc(doc(db, "users", auth.currentUser.uid), {
      savedAddresses:next.slice(0, 8),
      defaultAddress:next[0] || null,
      updatedAt:serverTimestamp()
    }, { merge:true }).catch(error => console.warn("Address distance save skipped", error));
  }
}

function renderSavedAddresses(addresses = []){
  const select = document.getElementById("savedAddressSelect");
  if(!select) return;
  const valid = addresses.filter(item => item && (item.address || item.phone || item.name));
  select.innerHTML = `<option value="">Add new address</option>` + valid.map((item, index) => {
    const label = item.label || item.address || `Address ${index + 1}`;
    const coord = item.lat && item.lng ? " 📍" : "";
    return `<option value="${index}">${escapeHTML(label).slice(0, 52)}${escapeHTML(addressDistanceLabel(item))}${coord}</option>`;
  }).join("");
  select.dataset.addresses = JSON.stringify(valid);
  if(valid.length && !select.value){
    select.value = "0";
    restoreCheckoutFields(valid[0], true);
    if(isUsableLocation(valid[0])){
      userLocation = normalizeCustomerLocation({
        lat:Number(valid[0].lat),
        lng:Number(valid[0].lng),
        accuracy:valid[0].accuracy || null,
        updatedAt:Number(valid[0].updatedAt || Date.now()),
        mapLink:`https://www.google.com/maps?q=${valid[0].lat},${valid[0].lng}`
      }, "last_saved_address_default");
      userLocationUpdatedAt = userLocation?.updatedAt || 0;
      setLocationUiState("lastSaved", `${Number(valid[0].lat).toFixed(5)}, ${Number(valid[0].lng).toFixed(5)}`);
    }
    setCheckoutFieldsCollapsed(true);
  }else{
    setCheckoutFieldsCollapsed(false);
  }
  hydrateSavedAddressDistances(valid).catch(error => console.warn("Saved address distance check failed", error));
}

function applySavedAddress(index){
  const select = document.getElementById("savedAddressSelect");
  if(!select) return;
  if(index === ""){
    setCheckoutFieldsCollapsed(false);
    ["customerName","customerPhone","customerAddress","customerLandmark"].forEach(id => {
      const el = document.getElementById(id);
      if(el) el.value = "";
    });
    persistGuestState();
    return;
  }
  let addresses = [];
  try{ addresses = JSON.parse(select.dataset.addresses || "[]"); }catch(_){}
  const item = addresses[Number(index)];
  if(!item) return;
  restoreCheckoutFields(item, true);
  if(isUsableLocation(item)){
    setCustomerLocation({
      lat:Number(item.lat),
      lng:Number(item.lng),
      accuracy:item.accuracy || null,
      updatedAt:Number(item.updatedAt || Date.now()),
      mapLink:`https://www.google.com/maps?q=${item.lat},${item.lng}`
    }, "last_saved_address_selected");
    setLocationUiState("lastSaved", `${Number(item.lat).toFixed(5)}, ${Number(item.lng).toFixed(5)}`);
    refreshDeliveryDistance({ force:true, maxAgeMs:0, routeTimeoutMs:12000 }).catch(() => updateCustomerDistanceBanner());
  }
  setCheckoutFieldsCollapsed(true);
  persistGuestState();
}

function isUsableLocation(item = {}){
  const lat = Number(item.lat);
  const lng = Number(item.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function currentSavedAddressIndex(){
  const value = document.getElementById("savedAddressSelect")?.value;
  return value === "" ? -1 : Number(value);
}

async function saveAddressBook(addresses){
  const user = auth.currentUser || cachedAuthUser || await waitForAuthReady();
  if(!user?.uid) throw new Error("Please login to save address.");
  const valid = (addresses || []).filter(item => item && item.address);
  await setDoc(doc(db, "users", user.uid), {
    uid:user.uid,
    defaultAddress:valid[0] || null,
    savedAddresses:valid.slice(0, 8),
    updatedAt:serverTimestamp()
  }, { merge:true });
  renderSavedAddresses(valid.slice(0, 8));
}

function readAddressBook(){
  const select = document.getElementById("savedAddressSelect");
  try{ return JSON.parse(select?.dataset.addresses || "[]"); }catch(_){ return []; }
}

async function saveCurrentAddressToBook(){
  const fields = getCheckoutFields();
  if(!fields.name || !fields.phone || !fields.address) throw new Error("Fill name, phone & address first.");
  const existing = readAddressBook();
  const nextAddress = {
    ...fields,
    label:fields.landmark ? `${fields.landmark} - ${fields.address}` : fields.address,
    updatedAt:Date.now()
  };
  const signature = addressSignature(nextAddress);
  const deduped = [nextAddress, ...existing.filter(item => addressSignature(item) !== signature)].slice(0, 8);
  await saveAddressBook(deduped);
  setCheckoutFieldsCollapsed(true);
}

async function useCurrentLocationForAddress(){
  const btn = document.getElementById("useCurrentLocationBtn");
  try{
    if(!auth.currentUser){
      alert("Please login first so we can save your delivery address.");
      await window.requireMagneetozAuth?.("address");
      if(!auth.currentUser) return;
    }
    if(btn) btn.textContent = "Detecting...";
    await fetchFreshCurrentLocation({ updateAddress:true, source:"fresh_gps:address_button" });
  }catch(error){
    alert("Please enable location permission and GPS, then retry.");
  }finally{
    if(btn) btn.textContent = "📍 Use Current Location";
  }
}

async function searchAddressForCheckout(){
  const input = document.getElementById("addressSearchInput");
  const query = input?.value.trim();
  if(!query){
    alert("Enter address or area to search.");
    return;
  }
  try{
    const result = await callPaymentFunction("geocodeAddress", { address:query }, 15000);
    document.getElementById("customerAddress").value = result.formattedAddress || query;
    document.getElementById("customerLat").value = result.lat || "";
    document.getElementById("customerLng").value = result.lng || "";
    setCustomerLocation({
      lat:Number(result.lat),
      lng:Number(result.lng),
      updatedAt:Date.now(),
      mapLink:`https://www.google.com/maps?q=${result.lat},${result.lng}`
    }, "address_geocode_search");
    setCheckoutFieldsCollapsed(false);
    refreshDeliveryDistance().catch(() => updateCustomerDistanceBanner());
    persistGuestState();
  }catch(error){
    alert(error.message || "Address not found.");
  }
}

async function deleteSelectedAddress(){
  const index = currentSavedAddressIndex();
  if(index < 0){
    alert("Select saved address first.");
    return;
  }
  const addresses = readAddressBook();
  const item = addresses[index];
  const ok = window.MagneetozNotify?.confirm
    ? await window.MagneetozNotify.confirm("Delete this saved address permanently?", { title:"Delete address", okText:"Delete" })
    : confirm("Delete this saved address permanently?");
  if(!ok) return;
  addresses.splice(index, 1);
  await saveAddressBook(addresses);
  setCheckoutFieldsCollapsed(false);
  alert("Address deleted.");
}

function editSelectedAddress(){
  const index = currentSavedAddressIndex();
  if(index < 0){
    setCheckoutFieldsCollapsed(false);
    return;
  }
  applySavedAddress(String(index));
  setCheckoutFieldsCollapsed(false);
}

async function loadSavedCustomerProfile(user){
  if(!user?.uid) return;
  try{
    const snap = await getDoc(doc(db, "users", user.uid));
    if(!snap.exists()) return;
    const data = snap.data() || {};
    renderSavedAddresses(data.savedAddresses || []);
    const preferred = data.defaultAddress || data.savedAddresses?.[0] || data.lastCheckoutState;
    if(preferred){
      const select = document.getElementById("savedAddressSelect");
      const saved = data.savedAddresses || [];
      const preferredIndex = saved.findIndex(item => addressSignature(item) === addressSignature(preferred));
      if(select && preferredIndex >= 0) select.value = String(preferredIndex);
      restoreCheckoutFields(preferred, true);
      if(isUsableLocation(preferred)){
        userLocation = normalizeCustomerLocation({
          lat:Number(preferred.lat),
          lng:Number(preferred.lng),
          accuracy:preferred.accuracy || null,
          updatedAt:Number(preferred.updatedAt || Date.now()),
          mapLink:`https://www.google.com/maps?q=${preferred.lat},${preferred.lng}`
        }, "last_saved_address_preferred");
        userLocationUpdatedAt = userLocation?.updatedAt || 0;
        setLocationUiState("lastSaved", `${Number(preferred.lat).toFixed(5)}, ${Number(preferred.lng).toFixed(5)}`);
        refreshDeliveryDistance({ force:true, maxAgeMs:0, routeTimeoutMs:12000 }).catch(() => updateCustomerDistanceBanner());
      }
      setCheckoutFieldsCollapsed(!!data.savedAddresses?.length);
    }
  }catch(error){
    console.warn("Saved address load failed", error);
  }
}

async function saveCustomerProfile(user){
  if(!user?.uid) return;
  const fields = getCheckoutFields();
  if(!fields.name || !fields.phone || !fields.address) return;
  try{
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    const existing = snap.exists() ? (snap.data().savedAddresses || []) : [];
    const nextAddress = {
      ...fields,
      lat:fields.lat || userLocation?.lat || null,
      lng:fields.lng || userLocation?.lng || null,
      label:fields.landmark ? `${fields.landmark} - ${fields.address}` : fields.address,
      updatedAt:Date.now()
    };
    const signature = addressSignature(nextAddress);
    const deduped = [nextAddress, ...existing.filter(item => addressSignature(item) !== signature)].slice(0, 5);
    await setDoc(ref, {
      uid:user.uid,
      customerName:fields.name,
      customerPhone:fields.phone,
      defaultAddress:nextAddress,
      savedAddresses:deduped,
      updatedAt:serverTimestamp()
    }, { merge:true });
    renderSavedAddresses(deduped);
  }catch(error){
    console.warn("Saved address update failed", error);
  }
}

function persistGuestState(){
  clearTimeout(guestStatePersistTimer);
  guestStatePersistTimer = setTimeout(() => {
    localStorage.setItem(GUEST_CART_KEY, JSON.stringify({
      cart,
      activeCouponCode:activeCoupon?.code || "",
      updatedAt:Date.now()
    }));
    localStorage.setItem(CHECKOUT_STATE_KEY, JSON.stringify({
      ...getCheckoutFields(),
      activeCouponCode:activeCoupon?.code || "",
      userLocation:userLocation ? {
        ...userLocation,
        updatedAt:userLocationUpdatedAt
      } : null,
      deliveryDistance,
      paymentPopupOpen:document.getElementById("paymentMethodPopup")?.style.display === "flex",
      cartOpen:document.getElementById("cartPanel")?.classList.contains("active"),
      updatedAt:Date.now()
    }));
  }, 250);
}

async function mergeGuestCartWithUser(user){
  const referral = capturePgReferralCoupon();
  const saved = readJSON(GUEST_CART_KEY, null);
  if(saved?.cart?.length && cart.length === 0){
    cart = saved.cart;
  }
  const checkout = readJSON(CHECKOUT_STATE_KEY, {});
  const checkoutLocation = normalizeCustomerLocation(checkout.userLocation, "checkout_cache");
  if(checkoutLocation){
    console.warn("[DISTANCE_DEBUG]", {
      event:"checkout_location_kept_as_last_saved_only",
      timestamp:new Date().toISOString(),
      cacheValues:{ checkoutUserLocation:checkout.userLocation }
    });
  }
  restoreCheckoutFields(checkout);
  await loadSavedCustomerProfile(user);
  const referralCoupon = findReferralCoupon(referral);
  if(referralCoupon){
    activeCoupon = referralCoupon;
  }else if(saved?.activeCouponCode && !activeCoupon){
    const found = availableCoupons.find(item => String(item.code || "").toUpperCase() === String(saved.activeCouponCode).toUpperCase());
    if(found) activeCoupon = found;
  }
  if(!activeCoupon) applyReferralCouponIfPossible();
  updateCart();
  if(user?.uid){
    await setDoc(doc(db, "users", user.uid), {
      uid:user.uid,
      guestCartMergedAt:serverTimestamp(),
      lastCheckoutState:{
        cart,
        couponCode:activeCoupon?.code || "",
        ...getCheckoutFields()
      }
    }, { merge:true }).catch(error => console.warn("Guest cart merge note failed", error));
  }
}

messagingReady.then(messaging => {
  if(!messaging) return;
  onMessage(messaging, payload => {
    const data = payload.data || {};
    if(!["offer_broadcast", "order_status"].includes(data.type)) return;
    try{ new Audio("ring2.mp3").play().catch(() => {}); }catch(_){}
    if(Notification.permission === "granted"){
      new Notification(payload.notification?.title || data.title || (data.type === "order_status" ? "Order Update" : "MAGNEETOZ Offer"), {
        body:payload.notification?.body || data.body || "A fresh MAGNEETOZ update is live.",
        icon:"logo_tran.jpeg",
        badge:"logo_tran.jpeg",
        tag:data.orderId || data.offerId || data.type,
        vibrate:data.type === "order_status" ? [160,80,160] : [140,70,180]
      });
    }
    notifyPremiumUI(data.type === "order_status" ? "magneetoz:order-status" : "magneetoz:offer-live", data);
  });
});

window.enableMagneetozOffers = async function(){
  try{
    if(!("Notification" in window)){
      toastWarning("Notifications are not supported in this browser.");
      return false;
    }
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if(permission !== "granted"){
      toastWarning("Notification permission was not enabled.");
      return false;
    }
    if("serviceWorker" in navigator){
      await navigator.serviceWorker.register("./firebase-messaging-sw.js");
      await navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
    const messaging = await messagingReady;
    if(messaging && auth.currentUser?.uid){
      const settingsSnap = await getDoc(doc(db, "settings", "notifications")).catch(() => null);
      const publicVapidKey = normalizeVapidKey(settingsSnap?.exists() ? settingsSnap.data().publicVapidKey : "");
      if(!isValidVapidKey(publicVapidKey)){
        toastWarning("Notification key is not configured correctly.");
        return false;
      }
      const registration = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
      const token = await getToken(messaging, {
        vapidKey:publicVapidKey,
        serviceWorkerRegistration:registration
      }).catch(error => {
        console.warn("Offer push token failed:", error);
        return "";
      });
      if(token){
        await setDoc(doc(db, "notificationTokens", token), {
          token,
          userId:auth.currentUser.uid,
          type:"web",
          enabled:true,
          updatedAt:serverTimestamp()
        }, { merge:true });
        await setDoc(doc(db, "users", auth.currentUser.uid), {
          notificationToken:token,
          notificationsEnabled:true,
          offerNotificationsEnabled:true,
          notificationsUpdatedAt:serverTimestamp()
        }, { merge:true });
      }
    }
    toastSuccess("Offer alerts enabled.");
    return true;
  }catch(error){
    console.warn("Notification setup failed:", error);
    toastError("Unable to enable notifications right now.");
    return false;
  }
};

function buildLatLng(value){
  const point = value || getRestaurantLocation() || EMERGENCY_RESTAURANT_LOCATION;
  return `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;
}

function logDistanceDebug(event, extra = {}){
  const kitchen = getRestaurantLocation();
  console.info("[DISTANCE_DEBUG]", {
    event,
    timestamp:new Date().toISOString(),
    orderId:extra.orderId || null,
    restaurantLatitude:kitchen?.lat ?? null,
    restaurantLongitude:kitchen?.lng ?? null,
    customerLatitude:userLocation?.lat ?? null,
    customerLongitude:userLocation?.lng ?? null,
    customerAccuracy:userLocation?.accuracy ?? null,
    customerLocationUpdatedAt:userLocationUpdatedAt ? new Date(userLocationUpdatedAt).toISOString() : null,
    calculatedDistanceKm:deliveryDistance || 0,
    actualRoadDistanceKm:actualRoadDistance || 0,
    source:distanceSource,
    restaurantLocationSource:restaurantLocation.source || "pending",
    firestoreValues:{
      settingsRestaurantLocation:kitchen ? { lat:kitchen.lat, lng:kitchen.lng } : null
    },
    cacheValues:{
      localStorageLocation:readJSON(LOCATION_CACHE_KEY, null),
      checkoutStateLocation:readJSON(CHECKOUT_STATE_KEY, {})?.userLocation || null,
      sessionStorageLastOfferSeen:sessionStorage.getItem("lastOfferSeen")
    },
    ...extra
  });
}

async function waitForRestaurantLocation(timeoutMs = 5000){
  if(getRestaurantLocation()) return getRestaurantLocation();
  await Promise.race([
    restaurantLocationReadyPromise,
    new Promise(resolve => setTimeout(resolve, timeoutMs))
  ]);
  return getRestaurantLocation();
}

function isLocalPreviewHost(){
  return ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
}

async function loadRoadDistance(){
  if(!userLocation) return false;
  const kitchen = getRestaurantLocation();
  if(!kitchen){
    distanceSource = "restaurant_location_pending";
    return false;
  }
  try{
    const result = await callPaymentFunction("calculateRouteDistance", {
      origin:kitchen,
      destination:{ lat:userLocation.lat, lng:userLocation.lng }
    }, 12000);
    if(!result?.distanceKm) return false;
    actualRoadDistance = Number(result.distanceKm);
    deliveryDistance = actualRoadDistance;
    estimatedTravelTime = result.durationText || "";
    distanceSource = result.source || "google_routes_backend";
    deliveryRoute = {
      origin:buildLatLng(kitchen),
      destination:buildLatLng(userLocation)
    };
    return true;
  }catch(error){
    console.warn("Road distance failed:", error);
    distanceSource = "route_unavailable";
    return false;
  }
}

async function refreshDeliveryDistance(options = {}){
  const { force = false, maxAgeMs = DISTANCE_CACHE_MAX_AGE_MS, routeTimeoutMs = 2500 } = options;
  if(!userLocation) return false;
  const kitchen = await waitForRestaurantLocation();
  if(!kitchen){
    deliveryDistance = 0;
    actualRoadDistance = 0;
    estimatedTravelTime = "";
    deliveryRoute = null;
    distanceSource = "restaurant_location_pending";
    logDistanceDebug("blocked_restaurant_location_pending");
    updateCustomerDistanceBanner("📍 Kitchen location is loading. Please try again in a moment.");
    return false;
  }
  if(!force && isFreshDeliveryDistance(maxAgeMs)){
    logDistanceDebug("distance_cache_used");
    return true;
  }
  deliveryDistance = 0;
  actualRoadDistance = 0;
  estimatedTravelTime = "";
  deliveryRoute = null;
  const loaded = await timedStep("refreshDeliveryDistance:loadRoadDistance", () =>
    withTimeout(loadRoadDistance(), routeTimeoutMs, "Google route distance")
  ).catch(error => {
    distanceSource = "route_unavailable";
    logDistanceDebug("road_distance_timeout_or_failed", { error:error?.message || String(error) });
    return false;
  });
  if(!loaded){
    updateCustomerDistanceGlobals();
    updateCustomerDistanceBanner("📍 Road route could not be calculated. Please refresh location.");
    logDistanceDebug("route_distance_required_failed");
    return false;
  }
  updateCustomerDistanceGlobals();
  updateCustomerDistanceBanner();
  updateCart();
  deliveryDistanceUpdatedAt = Date.now();
  deliveryDistanceSignature = distanceSignature();
  logDistanceDebug("refreshed");
  return true;
}

function deliveryMetrics(){
  return {
    actualRoadDistance:actualRoadDistance || deliveryDistance || 0,
    estimatedTravelTime,
    deliveryRoute,
    distanceSource
  };
}

async function buildNearbyRiderRequest(orderId){
  try{
    if(!orderId) return;
    await callPaymentFunction("createNearbyRiderRequest", { orderId }, 12000);
  }catch(error){
    console.error("RIDER REQUEST ERROR:", error);
  }
}

/* ================= LOCATION ================= */
function normalizeCategoryId(name = ""){
  return String(name || "").replace(/\s/g,'').toLowerCase();
}

function cacheCategoryScrollTargets(){
  cachedCategorySections = [...document.querySelectorAll(".category-block")];
  cachedCategoryLinks = [...document.querySelectorAll(".category-nav a")];
}

function categoryImageMarkup(category = {}, label = "MAGNEETOZ category"){
  const source = category.groupImage || category.image || category.imageUrl || category.icon || category.photo || category.thumbnail || "logo_tran.jpeg";
  const imageSet = category.groupImageSet || category.imageSet || null;
  const srcset = buildImageSrcset(imageSet);
  const srcsetAttr = srcset ? `srcset="${escapeHTML(srcset)}" sizes="72px"` : "";
  return `<span class="category-tab-media image-shell"><img src="${escapeHTML(bestImageUrl(source, imageSet))}" ${srcsetAttr} alt="${escapeHTML(label)}" width="72" height="72" loading="eager" fetchpriority="auto" decoding="async" ${imageFallbackAttrs()}></span>`;
}

function inferMenuGroup(category = {}){
  const raw = String(category.parent || category.group || category.type || category.mainCategory || category.name || "Recommended").trim();
  const text = raw.toLowerCase();
  const groups = [
    { key:"pizza", label:"Pizza", terms:["pizza","pizaa","piza"] },
    { key:"burger", label:"Burger", terms:["burger","burgar"] },
    { key:"sandwich", label:"Sandwich", terms:["sandwich","sendwitch","sandwitch"] },
    { key:"combo", label:"Combos", terms:["combo","meal","deal"] },
    { key:"drink", label:"Drinks", terms:["drink","cold","beverage","shake","mojito"] },
    { key:"fries", label:"Fries & Sides", terms:["fries","side","garlic","bread","snack"] }
  ];
  const found = groups.find(group => group.terms.some(term => text.includes(term)));
  if(found) return found;
  const firstWord = raw.split(/[\s/-]+/).filter(Boolean)[0] || "Recommended";
  return { key:normalizeCategoryId(firstWord), label:firstWord.charAt(0).toUpperCase() + firstWord.slice(1) };
}

function buildMenuCategoryGroups(categories = []){
  const map = new Map();
  categories.forEach(category => {
    const group = inferMenuGroup(category);
    if(!map.has(group.key)){
      map.set(group.key, { ...group, groupImage:category.groupImage || category.mainTypeImage || category.parentImage || category.image || "", categories:[] });
    }
    if(!map.get(group.key).groupImage && (category.groupImage || category.mainTypeImage || category.parentImage)){
      map.get(group.key).groupImage = category.groupImage || category.mainTypeImage || category.parentImage;
    }
    map.get(group.key).categories.push(category);
  });
  return [...map.values()];
}

function renderMenuGroupNav(groups = []){
  const nav = document.getElementById("categoryNav");
  if(!nav) return;
  nav.innerHTML = groups.map((group, index) => `
    <button type="button" class="category-tab menu-group-tab" data-menu-group="${escapeHTML(group.key)}">
      ${categoryImageMarkup({ ...(group.categories[0] || {}), groupImage:group.groupImage }, group.label)}
      <span class="category-tab-label">${escapeHTML(group.label)}</span>
    </button>
  `).join("");
  nav.querySelectorAll("[data-menu-group]").forEach(button => {
    button.addEventListener("click", () => {
      if(menuBrowserOpen && activeMenuGroup === button.dataset.menuGroup){
        closeMenuBrowser();
        return;
      }
      selectMenuGroup(button.dataset.menuGroup, true);
    });
  });
}

function closeMenuBrowser(){
  menuBrowserOpen = false;
  menuBrowserHideOnNextScroll = false;
  activeMenuGroup = "";
  activeMenuCategory = "";
  document.querySelectorAll("[data-menu-group]").forEach(button => button.classList.remove("active"));
  const browser = document.getElementById("menuCategoryBrowser");
  if(browser) browser.innerHTML = "";
  document.querySelectorAll(".category-block").forEach(block => {
    block.hidden = true;
    block.classList.remove("menu-category-active");
  });
}

function hideMenuCategoryPicker(){
  if(!menuBrowserOpen) return;
  menuBrowserOpen = false;
  menuBrowserHideOnNextScroll = false;
  const browser = document.getElementById("menuCategoryBrowser");
  if(browser) browser.innerHTML = "";
}

function renderMenuSubcategoryNav(group){
  if(!group) return "";
  if(group.categories.length <= 1) return `<div class="menu-direct-note">Showing all ${escapeHTML(group.label)} items</div>`;
  return `
    <div class="menu-subcategory-nav" id="menuSubcategoryNav" aria-label="${escapeHTML(group.label)} categories">
      ${group.categories.map((category, index) => `
        <button type="button" class="menu-subcategory-chip ${category.id === activeMenuCategory ? "active" : ""}" data-menu-category="${escapeHTML(category.id)}">
          ${categoryImageMarkup(category, category.name)}
          <span class="category-tab-label">${escapeHTML(category.name)}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function selectMenuGroup(groupKey, shouldScroll = true){
  const group = menuCategoryGroups.find(item => item.key === groupKey) || menuCategoryGroups[0];
  if(!group) return;
  menuBrowserOpen = true;
  menuBrowserHideOnNextScroll = false;
  activeMenuGroup = group.key;
  activeMenuCategory = "";
  document.querySelectorAll("[data-menu-group]").forEach(button => {
    button.classList.toggle("active", button.dataset.menuGroup === activeMenuGroup);
  });
  renderVisibleMenuCategories({ scroll:shouldScroll });
}

function selectMenuCategory(categoryId){
  activeMenuCategory = categoryId || activeMenuCategory;
  menuBrowserHideOnNextScroll = true;
  renderVisibleMenuCategories({ scroll:true });
}

function orderedGroupCategoryIds(group){
  if(!group) return [];
  const ids = group.categories.map(category => category.id);
  if(activeMenuCategory && ids.includes(activeMenuCategory)){
    return [activeMenuCategory, ...ids.filter(id => id !== activeMenuCategory)];
  }
  return ids;
}

function renderVisibleMenuCategories({ scroll = false } = {}){
  const group = menuCategoryGroups.find(item => item.key === activeMenuGroup) || menuCategoryGroups[0];
  const browser = document.getElementById("menuCategoryBrowser");
  if(!group || !browser) return;
  if(!menuBrowserOpen){
    closeMenuBrowser();
    return;
  }
  browser.innerHTML = `
    <div class="menu-browser-head">
      <span>${escapeHTML(group.label)}</span>
      <strong>${group.categories.length} categories</strong>
    </div>
    ${renderMenuSubcategoryNav(group)}
  `;
  browser.querySelectorAll("[data-menu-category]").forEach(button => {
    button.classList.toggle("active", button.dataset.menuCategory === activeMenuCategory);
    button.addEventListener("click", () => selectMenuCategory(button.dataset.menuCategory));
  });
  const visibleIds = orderedGroupCategoryIds(group);
  document.querySelectorAll(".category-block").forEach(block => {
    const isVisible = visibleIds.includes(block.id);
    block.classList.toggle("menu-category-active", block.id === activeMenuCategory);
    block.hidden = !isVisible;
    if(isVisible){
      block.style.order = String(visibleIds.indexOf(block.id) + 1);
    }else{
      block.style.removeProperty("order");
    }
  });
  if(scroll && activeMenuCategory){
    requestAnimationFrame(() => {
      const target = document.getElementById(activeMenuCategory);
      if(!target) return;
      const sticky = document.querySelector(".sticky-area");
      const offset = (sticky?.getBoundingClientRect().height || 0) + 10;
      const top = target.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top:Math.max(0, top), behavior:"smooth" });
    });
  }
}

function categoryJumpFooter(categories = [], index = 0){
  const current = categories[index];
  const previous = categories[index - 1];
  const next = categories[index + 1];
  if(!current || (!previous && !next)) return "";
  return `
    <div class="category-jump-footer" aria-label="More menu categories">
      <span>More dishes</span>
      <div>
        ${previous ? `<a href="#${escapeHTML(previous.id)}">← ${escapeHTML(previous.name)}</a>` : ""}
        <a href="#categoryNav">All categories</a>
        ${next ? `<a href="#${escapeHTML(next.id)}">${escapeHTML(next.name)} →</a>` : ""}
      </div>
    </div>
  `;
}

function loadCategories(){
  const container = document.getElementById("categoryContainer");
  const nav = document.getElementById("categoryNav");
  if(nav) nav.innerHTML = "";

  categoriesUnsub?.();
  categoriesUnsub = onSnapshot(
    query(collection(db,"categories"), orderBy("order","asc")),
    (snapshot)=>{
      const navHTML = [];
      const categoryHTML = [];
      const select = document.getElementById("category");
      const selectHTML = [];
      const nextGridIds = new Set();
      const activeCategories = [];

      snapshot.forEach(docSnap => {
        const c = docSnap.data();
        const id = normalizeCategoryId(c.name);
        if(!c.active) return;
        activeCategories.push({ id, name:c.name || "Menu", ...c });
        nextGridIds.add("grid-cat-" + id);
        selectHTML.push(`<option value="${escapeHTML(c.name)}">${escapeHTML(c.name)}</option>`);
      });

      menuCategoryGroups = buildMenuCategoryGroups(activeCategories);
      if(!activeMenuGroup || !menuCategoryGroups.some(group => group.key === activeMenuGroup)){
        activeMenuGroup = menuCategoryGroups[0]?.key || "";
      }

      activeCategories.forEach((category, index) => {
        categoryHTML.push(`
  <div class="category-block" id="${escapeHTML(category.id)}">
          <div class="section-header">
          <span class="line"></span>
          <h2>${escapeHTML(category.name)}</h2>
          <span class="line"></span>
         </div>
          <div class="grid" id="grid-cat-${escapeHTML(category.id)}"></div>
          ${categoryJumpFooter(activeCategories, index)}
        </div>
      `);
      });

      if(nav) renderMenuGroupNav(menuCategoryGroups);
      if(container) container.innerHTML = categoryHTML.join("");
      if(select) select.innerHTML = selectHTML.join("");
      categoryGridIds = nextGridIds;
      categoriesReady = true;
      cacheCategoryScrollTargets();
      closeMenuBrowser();
      if(menuListenerStarted){
        menuListenerStarted = false;
        loadMenu();
      }else{
        loadMenu();
      }
    },
    error => console.warn("Category listener failed:", error)
  );
}
loadCategories();

/* LOAD DELIVERY SETTINGS */

registerGlobalSnapshot(onSnapshot(
  doc(db,"settings","delivery"),
  (snap)=>{

    if(!snap.exists()) return;

    const data = snap.data();

    MAX_DELIVERY_DISTANCE =
      data.maxDeliveryDistanceKm || data.maxDistance || 6;

    ALL_INDIA_DELIVERY =
      data.allIndia || false;
    VIP_DELIVERY_ENABLED =
      data.vipDeliveryEnabled === true;

    googleMapsApiKey =
      data.googleMapsApiKey || data.mapsApiKey || "";

    console.log(
      "Delivery Settings Updated:",
      MAX_DELIVERY_DISTANCE,
      ALL_INDIA_DELIVERY
    );

  }
));

registerGlobalSnapshot(onSnapshot(doc(db, "settings", "pricing"), snap => {
  const data = snap.exists() ? snap.data() : {};
  appPricing = {
    ...appPricing,
    gstPercent:Number(data.gstPercent) || 0,
    handlingCharge:Number(data.handlingCharge) || 0
  };
  updateCart();
}, error => console.warn("[FIRESTORE LISTENER] Pricing settings failed", error)));

registerGlobalSnapshot(onSnapshot(doc(db,"settings","restaurant"), snap => {
  const data = snap.exists() ? snap.data() : {};
  const lat = Number(data.location?.lat);
  const lng = Number(data.location?.lng);
  if(Number.isFinite(lat) && Number.isFinite(lng)){
    setRestaurantLocation(lat, lng);
    if(!restaurantLocationReadyResolved){
      restaurantLocationReadyResolved = true;
      resolveRestaurantLocationReady(getRestaurantLocation());
    }
    logDistanceDebug("restaurant_location_loaded");
    refreshDeliveryDistance().catch(() => updateCustomerDistanceBanner());
  }
  restaurantState = {
    ...restaurantState,
    ...data
  };
  applyRestaurantAvailability();
}));

registerGlobalSnapshot(onSnapshot(doc(db, "settings", "theme"), snap => {
  const theme = snap.exists() ? snap.data() : {};
  const vars = theme.variables || {};
  const mode = theme.mode === "light" ? "light" : "dark";
  const modePrefix = mode === "light" ? "--light-" : "--dark-";
  const customThemeKeys = [
    "--site-background",
    "--menu-card-bg",
    "--menu-card-border",
    "--menu-card-shadow",
    "--menu-title-bg",
    "--menu-title-text",
    "--menu-desc-text",
    "--menu-badge-bg",
    "--menu-badge-text",
    "--menu-price-bg",
    "--menu-price-text",
    "--menu-old-price-text",
    "--menu-qty-bg",
    "--menu-qty-text",
    "--menu-qty-btn-bg",
    "--menu-qty-btn-text",
    "--menu-add-bg",
    "--menu-add-text"
  ];
  const cardKeys = [
    "menu-card-bg",
    "menu-card-border",
    "menu-card-shadow",
    "menu-title-bg",
    "menu-title-text",
    "menu-desc-text",
    "menu-badge-bg",
    "menu-badge-text",
    "menu-price-bg",
    "menu-price-text",
    "menu-old-price-text",
    "menu-qty-bg",
    "menu-qty-text",
    "menu-qty-btn-bg",
    "menu-qty-btn-text",
    "menu-add-bg",
    "menu-add-text"
  ];
  customThemeKeys.forEach(key => {
    if(!(key in vars)){
      document.documentElement.style.removeProperty(key);
      document.body.style.removeProperty(key);
    }
  });
  Object.entries(vars).forEach(([key, value]) => {
    if(/^--[a-z0-9-]+$/i.test(key)){
      document.documentElement.style.setProperty(key, value);
      document.body.style.setProperty(key, value);
    }
  });
  cardKeys.forEach(name => {
    const activeValue = vars[`${modePrefix}${name}`];
    if(activeValue){
      const key = `--${name}`;
      document.documentElement.style.setProperty(key, activeValue);
      document.body.style.setProperty(key, activeValue);
    }else{
      const key = `--${name}`;
      document.documentElement.style.removeProperty(key);
      document.body.style.removeProperty(key);
    }
  });
  document.body.classList.toggle("dark-theme", mode === "dark");
  document.body.classList.toggle("light-theme", mode === "light");
  document.body.classList.toggle("dark-mode", mode === "dark");
  const hero = theme.hero || {};
  const heroTextMap = {
    heroKickerText:hero.kicker,
    heroTitleText:hero.title,
    heroSubtitleText:hero.subtitle,
    heroPrimaryBtnText:hero.primaryButton,
    heroSecondaryBtnText:hero.secondaryButton
  };
  Object.entries(heroTextMap).forEach(([id, text]) => {
    const el = document.getElementById(id);
    if(el && typeof text === "string") el.textContent = text.trim();
  });
  applyHeroColors(hero);
  applyHeroBackgroundBlur(hero);
  syncHeroEmptyState(hero);
  renderHeroPizzaSlider(Array.isArray(hero.images) ? hero.images : [], Array.isArray(hero.imageSets) ? hero.imageSets : []);
  setThemeParticles(String(vars["--particle-bg"] || "").trim() === "founder-gold");
}));



function loadMenu(){
  if(menuListenerStarted) return;
  menuListenerStarted = true;

  // 🔥 utility (define once, not inside loop)
  const normalize = (str) => normalizeCategoryId(str);

  menuDishesUnsub?.();
  menuDishesUnsub = onSnapshot(collection(db,"dishes"), (snapshot)=>{

    // clear all grids
    categoryGridIds.forEach(gridId => {
      const grid = document.getElementById(gridId);
      if(grid) grid.innerHTML = "";
    });
    const htmlByGrid = new Map();
    const appendDish = (gridId, html) => {
      htmlByGrid.set(gridId, (htmlByGrid.get(gridId) || "") + html);
    };
    allMenuDishes = snapshot.docs
      .map(docSnap => ({ id:docSnap.id, ...docSnap.data() }))
      .filter(d => d.available && d.category);
    menuImageRenderIndex = 0;

    snapshot.forEach(docSnap => {

      const d = { id:docSnap.id, ...docSnap.data() };
      const safeCallName = String(d.name || "").replace(/\\/g,"\\\\").replace(/'/g,"\\'");
      const dishAttrs = dishDataAttrs(d);

      if(!d.available || !d.category) return;

      const gridId = "grid-cat-" + normalize(d.category);

      if(categoriesReady && !categoryGridIds.has(gridId)){
        console.debug("Dish skipped because category section is unavailable:", d.category);
        return;
      }

      // 🟢 SIMPLE CARD
      if(d.type === "simple"){

        appendDish(gridId, `
<div class="card new-card" ${dishAttrs}>
  <button type="button" class="quick-preview-btn" data-preview>Preview</button>
  <div class="card-img">
    ${imageMarkup(d.image, d.name, d.imageSet)}
  </div>

  <div class="card-body">
    <h3>${escapeHTML(d.name || '')}</h3>
    <p>${escapeHTML(d.description || '')}</p>

    <div class="quantity-box">
      <button onclick="changeQty(this,-1)">-</button>
      <span class="qty">1</span>
      <button onclick="changeQty(this,1)">+</button>
    </div>

    <div class="card-footer">
      <div class="price-box">
        <span class="offer" data-base="${d.price || 0}">${formatCurrency(d.price)}</span>
        <span class="market" data-base="${d.marketPrice || (d.price + 20)}">
          ${formatCurrency(d.marketPrice || (d.price + 20))}
        </span>
      </div>

      <button class="add-cart-btn" onclick="addToCartSimple(this,'${safeCallName}')">
        Add +
      </button>
    </div>
  </div>
</div>`);
      }

      // 🔵 SIZE BASED CARD
      else {

        if (!d.sizes) {
          console.error("❌ sizes missing in:", d.name);
          return;
        }

        // safe size extraction
        const getSize = (size) => {
          if(!size) return { price: 0, market: 50 };
          return typeof size === "object"
            ? size
            : { price: size, market: size + 50 };
        };

        const small  = getSize(d.sizes.small);
        const medium = getSize(d.sizes.medium);
        const large  = getSize(d.sizes.large);

        appendDish(gridId, `
<div class="card new-card" ${dishAttrs}>
  <button type="button" class="quick-preview-btn" data-preview>Preview</button>
  <div class="card-img">
    ${imageMarkup(d.image, d.name, d.imageSet)}
  </div>

  <div class="card-body">
    <h3>${escapeHTML(d.name || '')}</h3>

    <select class="size-select" onchange="updatePrice(this)">
      <option value="${small.price}" data-market="${small.market}">
        Small - ${formatCurrency(small.price)}
      </option>
      <option value="${medium.price}" data-market="${medium.market}">
        Medium - ${formatCurrency(medium.price)}
      </option>
      <option value="${large.price}" data-market="${large.market}">
        Large - ${formatCurrency(large.price)}
      </option>
    </select>

    <div class="quantity-box">
      <button onclick="changeQty(this,-1)">-</button>
      <span class="qty">1</span>
      <button onclick="changeQty(this,1)">+</button>
    </div>

    <div class="card-footer">
      <div class="price-box">
        <span class="offer" data-base="${small.price}">${formatCurrency(small.price)}</span>
        <span class="market" data-base="${small.market}">${formatCurrency(small.market)}</span>
      </div>

      <button class="add-cart-btn" onclick="addToCartFull(this,'${safeCallName}')">
        Add +
      </button>
    </div>
  </div>
</div>`);
      }

    });
    requestAnimationFrame(() => {
      htmlByGrid.forEach((html, gridId) => {
        const grid = document.getElementById(gridId);
        if(grid) grid.innerHTML = html;
      });

      notifyPremiumUI("magneetoz:menu-rendered", {
        count: document.querySelectorAll(".new-card").length
      });
      warmVisibleMenuImages();
      renderSmartAssistant();
      applyRestaurantAvailability();
    });

  }, error => {
    console.warn("Menu listener failed:", error);
  });

}

async function getUserLocation() {
  return fetchFreshCurrentLocation({ updateAddress:false, source:"gps:getUserLocation" });
}

async function checkServiceArea(){

  if(!userLocation){
    return;
  }

  await refreshDeliveryDistance();
  updateCustomerDistanceBanner();

}

function closeServicePopup(){
  document.getElementById("serviceUnavailablePopup").style.display = "none";
}

function contactOutsideDeliveryArea(){
  const address = getCheckoutFields().address || userLocation?.mapLink || "Location not entered";
  const message = [
    "Hello MAGNEETOZ,",
    "I am outside your delivery area but would like to place a large order.",
    "",
    `My location: ${address}`,
    `Distance: ${deliveryDistance ? `${deliveryDistance} km` : "Not available"}`
  ].join("\n");
  window.open(`https://wa.me/918303614331?text=${encodeURIComponent(message)}`, "_blank");
}

window.contactOutsideDeliveryArea = contactOutsideDeliveryArea;

function showServiceAreaPopup(message, options = {}){
  const popup = document.getElementById("serviceUnavailablePopup");
  if(!popup) return;
  const title = popup.querySelector("h2");
  const icon = popup.querySelector(".service-icon");
  const contactBtn = popup.querySelector(".service-popup-btn");
  const radiusBadge = popup.querySelector(".distance-badge");
  if(title) title.textContent = options.title || "Service Not Available";
  if(icon) icon.textContent = options.icon || "🚫";
  if(contactBtn) contactBtn.style.display = options.showContact === false ? "none" : "";
  if(radiusBadge) radiusBadge.style.display = options.showRadius === false ? "none" : "";
  const p = popup.querySelector("p");
  if(p && message) p.innerHTML = message;
  const text = document.getElementById("deliveryLimitText");
  if(text) text.textContent = `${MAX_DELIVERY_DISTANCE} KM`;
  popup.style.display = "flex";
}

async function ensureDeliveryEligible(){
  perfStart("ensureDeliveryEligible");
  try{
  const kitchen = await waitForRestaurantLocation();
  if(!kitchen){
    updateCustomerDistanceBanner("📍 Kitchen location is loading. Please try again in a moment.");
    showServiceAreaPopup("Kitchen location is still loading. Please try again in a moment.", {
      title:"Please wait",
      icon:"🍕",
      showContact:false,
      showRadius:false
    });
    logDistanceDebug("delivery_blocked_restaurant_location_missing");
    return false;
  }
  if(!isFreshCustomerLocation(CHECKOUT_LOCATION_REUSE_MAX_AGE_MS)){
    await timedStep("ensureDeliveryEligible:getCurrentPosition", () => getUserLocation()).catch(() => null);
  }
  if(!isFreshCustomerLocation(CHECKOUT_LOCATION_REUSE_MAX_AGE_MS)){
    updateCustomerDistanceBanner("📍 Enable location to see your distance from our kitchen");
    showServiceAreaPopup("Please turn on location so we can check the exact road distance from our kitchen to your address.", {
      title:"Location Permission Needed",
      icon:"📍",
      showContact:false,
      showRadius:false
    });
    logDistanceDebug("delivery_blocked_customer_location_missing_or_stale");
    return false;
  }
  const hasRouteDistance = await timedStep("ensureDeliveryEligible:refreshDeliveryDistance", () => refreshDeliveryDistance({ force:true, maxAgeMs:0, routeTimeoutMs:12000 }));
  if(!hasRouteDistance || distanceSource !== "google_routes_backend"){
    showServiceAreaPopup("We could not calculate the road route to your location. Please refresh your location and try again.", {
      title:"Route Check Failed",
      icon:"🛣️",
      showContact:false,
      showRadius:false
    });
    logDistanceDebug("delivery_blocked_route_distance_required");
    return false;
  }
  if(!ALL_INDIA_DELIVERY && !VIP_DELIVERY_ENABLED && deliveryDistance > MAX_DELIVERY_DISTANCE){
    showServiceAreaPopup(`Sorry, we currently deliver only within ${MAX_DELIVERY_DISTANCE} KM of our pizza kitchen.<br><br>For large orders please contact us directly on WhatsApp.<br>📞 8303614331`);
    return false;
  }
  return true;
  }finally{
    perfEnd("ensureDeliveryEligible");
  }
}

/* ================= LOCATION SYSTEM ================= */

async function acceptLocation() {

  const btn = document.querySelector("#locationPopup button");
  const popup = document.getElementById("locationPopup");

  if(btn){
    btn.innerText = "Detecting...";
    btn.disabled = true;
  }
  try{
    await fetchFreshCurrentLocation({ updateAddress:true, source:"gps:acceptLocation" });
    logStructured("AUTH", { event:"location_granted", lat:userLocation?.lat, lng:userLocation?.lng });
    await checkServiceArea();
    if(popup) popup.style.display = "none";
    toastSuccess?.("Current location updated");
  }catch(error){
    console.log(error);
    updateCustomerDistanceBanner("📍 Please enable location permission and GPS, then retry.");
    alert("Please enable location permission and GPS, then retry.");
  }finally{
    if(btn){
      btn.innerText = "Allow Location";
      btn.disabled = false;
    }
  }

}

window.acceptLocation = acceptLocation;

window.acceptLocation = acceptLocation;
document.getElementById("customerDistanceBanner")?.addEventListener("click", () => {
  resetCustomerLocation();
  acceptLocation();
});
window.addEventListener("load", ()=>{
  handlePaymentLinkReturn().catch(error => console.warn("Payment link return skipped:", error));
  capturePgReferralCoupon();

  const saved = normalizeCustomerLocation(readJSON(LOCATION_CACHE_KEY, null), "localStorage");

  if(saved){
    userLocation = saved;
    userLocationUpdatedAt = saved.updatedAt || 0;
    updateCustomerDistanceGlobals();
    setLocationUiState("lastSaved", `${saved.lat.toFixed(5)}, ${saved.lng.toFixed(5)}`);
  }else{
    setLocationUiState("idle");
  }
  const savedCart = readJSON(GUEST_CART_KEY, null);
  if(savedCart?.cart?.length){
    cart = savedCart.cart;
  }
  const savedCheckout = readJSON(CHECKOUT_STATE_KEY, {});
  restoreCheckoutFields(savedCheckout);
  updateCart();

});

function calculateDistance(){

  if(!userLocation) return;
  const kitchen = getRestaurantLocation();
  if(!kitchen){
    deliveryDistance = 0;
    actualRoadDistance = 0;
    estimatedTravelTime = "";
    deliveryRoute = null;
    distanceSource = "restaurant_location_pending";
    logDistanceDebug("calculate_blocked_restaurant_location_pending");
    return;
  }

  deliveryDistance = 0;
  actualRoadDistance = 0;
  estimatedTravelTime = "";
  deliveryRoute = {
    origin:buildLatLng(kitchen),
    destination:buildLatLng(userLocation)
  };
  distanceSource = "route_required";
  logDistanceDebug("route_distance_required");
}

/* ================= DELIVERY LOGIC ================= */
function calculateDeliveryCharge(subtotal){

if(subtotal < 2){

const remaining = 2 - subtotal;

showMinOrderPopup(remaining);

return false;

}

deliveryCharge = 0;

return true;

}

// function calculateDeliveryCharge(subtotal){

// // minimum order
// if(subtotal < 2){

// const remaining = 2 - subtotal;

// showMinOrderPopup(remaining);

// return false;

// }

// // beyond service area
// if(!ALL_INDIA_DELIVERY && !VIP_DELIVERY_ENABLED &&
// deliveryDistance > MAX_DELIVERY_DISTANCE){

// showServiceAreaPopup(`Sorry, we currently deliver only within ${MAX_DELIVERY_DISTANCE} KM of our pizza kitchen.<br><br>For large orders please contact us directly on WhatsApp.<br>📞 8303614331`);

// return false;
// }

// // ₹99 – ₹149
// if(subtotal < 149){

// if(deliveryDistance <= 3){
// deliveryCharge = 20;
// }

// else{
// deliveryCharge = 30;
// }

// }

// // ₹149 – ₹199
// else if(subtotal < 199){

// if(deliveryDistance <= 3){
// deliveryCharge = 0;
// }

// else{

// const extraKm = Math.ceil(deliveryDistance - 3);
// deliveryCharge = extraKm * 7;

// }

// }

// // ₹199+
// else{

// deliveryCharge = 0;

// }

// return true;

// }

/* ================= COUPONS ================= */

registerGlobalSnapshot(onSnapshot(collection(db, "coupons"), (snapshot) => {
  availableCoupons = snapshot.docs.map(item => ({ id:item.id, ...item.data() }));
  const referral = capturePgReferralCoupon();
  const referralCoupon = findReferralCoupon(referral);
  if(referralCoupon) activeCoupon = referralCoupon;
  if(!activeCoupon){
    const saved = readJSON(GUEST_CART_KEY, null);
    const code = saved?.activeCouponCode || readJSON(CHECKOUT_STATE_KEY, {})?.activeCouponCode || "";
    const found = availableCoupons.find(item => String(item.code || "").toUpperCase() === String(code).toUpperCase());
    if(found) activeCoupon = found;
    if(!found) applyReferralCouponIfPossible();
  }
  if(activeCoupon) fillReferralCouponField(activeCoupon);
  renderAvailableCoupons();
  if(activeCoupon) validateActiveCoupon();
  updateCart();
}));

registerGlobalSnapshot(onSnapshot(query(collection(db, "offers"), orderBy("createdAt", "desc")), (snapshot) => {
  const host = document.getElementById("offerRail");
  if(!host) return;
  const offers = snapshot.docs
    .map(item => ({ id:item.id, ...item.data() }))
    .filter(offer => offer.active !== false && offer.deleted !== true)
    .slice(0, 8);
  host.innerHTML = offers.map(offer => `
    <article class="offer-card">
      <img src="${escapeHTML(normalizeImageUrl(offer.image))}" alt="${escapeHTML(offer.title || "Offer")}" onerror="this.onerror=null;this.src='logo_tran.jpeg';">
      <div>
        <span>${offer.couponCode ? "Use code" : "Magneetoz offer"}</span>
        <h3>${escapeHTML(offer.title || "Special Offer")}</h3>
        <p>${escapeHTML(offer.description || offer.notificationBody || "")}</p>
        ${offer.couponCode ? `<button type="button" onclick="applyCoupon('${escapeHTML(offer.couponCode)}')">${escapeHTML(offer.couponCode)}</button>` : ""}
      </div>
    </article>
  `).join("") || `<p class="coupon-empty">Fresh offers will appear here.</p>`;
  const newest = offers[0];
  if(newest && sessionStorage.getItem("lastOfferSeen") !== newest.id){
    sessionStorage.setItem("lastOfferSeen", newest.id);
    notifyPremiumUI("magneetoz:offer-live", newest);
  }
}));

registerGlobalSnapshot(onSnapshot(query(collection(db, "combos"), orderBy("createdAt", "desc")), (snapshot) => {
  const host = document.getElementById("comboRail");
  if(!host) return;
  const combos = snapshot.docs
    .map(item => ({ id:item.id, ...item.data() }))
    .filter(combo => combo.active !== false)
    .slice(0, 10);
  host.innerHTML = combos.map(combo => `
    <article class="combo-card">
      <img src="${escapeHTML(normalizeImageUrl(combo.image))}" alt="${escapeHTML(combo.name || "Combo")}" onerror="this.onerror=null;this.src='logo_tran.jpeg';">
      <div>
        <span>Combo deal</span>
        <h3>${escapeHTML(combo.name || "MAGNEETOZ Combo")}</h3>
        <p>${escapeHTML(combo.description || combo.itemsIncluded || "")}</p>
        <div class="combo-price-row">
          <s>${formatCurrency(combo.originalPrice || combo.comboPrice || 0)}</s>
          <b>${formatCurrency(combo.comboPrice || 0)}</b>
        </div>
        <button type="button" onclick="addComboToCart('${escapeHTML(combo.id)}')">Add Combo</button>
      </div>
    </article>
  `).join("") || `<p class="coupon-empty">Active combos will appear here.</p>`;
  window.__magneetozActiveCombos = combos;
}));

function getCartSubtotal(){
  return cart.reduce((sum, item) => sum + item.price, 0);
}

function couponExpired(coupon){
  const expiry = timestampToMillis(coupon.expiryDate);
  return expiry > 0 && Date.now() > expiry;
}

function normalizeCouponCategory(value = ""){
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function couponCategoryAliases(value = ""){
  const normalized = normalizeCouponCategory(value);
  const aliases = new Set([normalized]);
  if(normalized.includes("pizza") || normalized.includes("pizaa") || normalized.includes("piza")) aliases.add("pizza");
  if(normalized.includes("burger") || normalized.includes("burgar")) aliases.add("burger");
  if(normalized.includes("sandwich") || normalized.includes("sendwitch") || normalized.includes("sandwitch")) aliases.add("sandwich");
  if(normalized.includes("combo") || normalized.includes("meal") || normalized.includes("deal")) aliases.add("combo");
  if(normalized.includes("drink") || normalized.includes("cold") || normalized.includes("beverage") || normalized.includes("shake")) aliases.add("drink");
  if(normalized.includes("fries") || normalized.includes("side") || normalized.includes("snack")) aliases.add("fries");
  return aliases;
}

function cartCategories(){
  const categories = new Set();
  cart.forEach(item => {
    [item.category, item.dishCategory, item.name].filter(Boolean).forEach(value => {
      couponCategoryAliases(value).forEach(alias => {
        if(alias) categories.add(alias);
      });
    });
  });
  return categories;
}

function couponCategoryMatches(couponCategory, cartCategorySet){
  const aliases = couponCategoryAliases(couponCategory);
  for(const alias of aliases){
    if(cartCategorySet.has(alias)) return true;
    for(const cartCategory of cartCategorySet){
      if(alias && cartCategory && (alias.includes(cartCategory) || cartCategory.includes(alias))) return true;
    }
  }
  return false;
}

function validateCoupon(coupon, subtotal = getCartSubtotal()){
  if(!coupon) return { ok:false, message:"Coupon not found" };
  if(coupon.active !== true) return { ok:false, message:"Coupon is not active" };
  if(couponExpired(coupon)) return { ok:false, message:"Coupon expired" };
  if(coupon.usageLimit && (coupon.usedCount || 0) >= coupon.usageLimit) return { ok:false, message:"Coupon usage limit reached" };
  if(subtotal < (coupon.minOrderAmount || 0)) return { ok:false, message:`Add ${formatCurrency((coupon.minOrderAmount || 0) - subtotal)} more to use this coupon` };
  if(Array.isArray(coupon.allowedUsers) && coupon.allowedUsers.length && !coupon.allowedUsers.includes(auth.currentUser?.uid || "")){
    return { ok:false, message:"Coupon is not available for this account" };
  }
  if((coupon.visibility === "vip-only" || coupon.vipOnly) && !(Array.isArray(coupon.allowedUsers) && coupon.allowedUsers.includes(auth.currentUser?.uid || ""))){
    return { ok:false, message:"This VIP coupon is not available for this account" };
  }
  if(Array.isArray(coupon.applicableCategories) && coupon.applicableCategories.length){
    const categories = cartCategories();
    const matched = coupon.applicableCategories.some(category => couponCategoryMatches(category, categories));
    if(!matched) return { ok:false, message:"Coupon is not valid for these items" };
  }
  if(coupon.firstOrderOnly && !auth.currentUser?.uid){
    return { ok:true, message:"Coupon ready. Sign in before checkout to confirm first order." };
  }
  return { ok:true, message:"Coupon applied" };
}

function calculateCouponPricing(subtotal = getCartSubtotal()){
  let couponDiscount = 0;
  let freeDeliveryDiscount = 0;
  let finalDeliveryCharge = deliveryCharge;
  if(activeCoupon){
    const validation = validateCoupon(activeCoupon, subtotal);
    if(validation.ok){
      if(activeCoupon.type === "percentage"){
        couponDiscount = subtotal * ((activeCoupon.discountValue || 0) / 100);
        if(activeCoupon.maxDiscount) couponDiscount = Math.min(couponDiscount, activeCoupon.maxDiscount);
      }else if(activeCoupon.type === "flat"){
        couponDiscount = activeCoupon.discountValue || 0;
      }
      couponDiscount = Math.min(Math.max(0, couponDiscount), subtotal);
      if(activeCoupon.freeDelivery){
        freeDeliveryDiscount = deliveryCharge;
        finalDeliveryCharge = 0;
      }
    }
  }
  const finalTotal = Math.max(0, subtotal - couponDiscount + finalDeliveryCharge);
  return { subtotal, couponDiscount:Math.round(couponDiscount), deliveryCharge:finalDeliveryCharge, freeDeliveryDiscount, finalTotal };
}

function renderCouponPanel(result = calculateInvoicePricing(getCartSubtotal())){
  const applied = document.getElementById("appliedCoupon");
  if(applied){
    const activeValidation = activeCoupon ? validateCoupon(activeCoupon) : { ok:false };
    applied.innerHTML = activeCoupon && activeValidation.ok
      ? `<strong>${escapeHTML(activeCoupon.code)}</strong><span>Saved ${formatCurrency(result.couponDiscount + result.freeDeliveryDiscount)}</span><button type="button" onclick="removeCoupon()">Remove</button>`
      : "";
  }
  const breakdown = document.getElementById("cartPriceBreakdown");
  if(breakdown){
    breakdown.innerHTML = `
      <div><span>Subtotal</span><b>${formatCurrency(result.subtotal)}</b></div>
      <div><span>Coupon Savings</span><b>-${formatCurrency(result.couponDiscount)}</b></div>
      <div><span>GST (${result.gstPercent || 0}%)</span><b>${formatCurrency(result.gstAmount || 0)}</b></div>
      <div><span>Handling Charges</span><b>${formatCurrency(result.handlingCharge || 0)}</b></div>
      <div><span>Delivery Fee</span><b>${formatCurrency(result.deliveryCharge)}</b></div>
      ${result.freeDeliveryDiscount ? `<div><span>Free Delivery</span><b>-${formatCurrency(result.freeDeliveryDiscount)}</b></div>` : ""}
      <div class="grand"><span>Grand Total</span><b>${formatCurrency(result.finalTotal)}</b></div>
    `;
  }
}

function renderAvailableCoupons(){
  const host = document.getElementById("availableCoupons");
  if(!host) return;
  const subtotal = getCartSubtotal();
  const isCustomerVisibleCoupon = (coupon) => {
    const visibility = String(coupon.visibility || "public").toLowerCase();
    if(coupon.deleted === true) return false;
    if(coupon.active === false) return false;
    if(couponExpired(coupon)) return false;
    if(visibility === "hidden" || visibility === "vip-only" || coupon.vipOnly === true) return false;
    return true;
  };
  const cards = availableCoupons
    .filter(isCustomerVisibleCoupon)
    .filter(coupon => validateCoupon(coupon, subtotal).ok || String(coupon.code || "").toUpperCase() === String(activeCoupon?.code || "").toUpperCase())
    .slice(0, 6)
    .map(coupon => {
      const valid = validateCoupon(coupon, subtotal);
      const label = coupon.freeDelivery ? "Free delivery" :
        coupon.freeItem ? `Free ${coupon.freeItem.name || coupon.freeItem}` :
        coupon.type === "percentage" ? `${coupon.discountValue}% OFF` :
        `${formatCurrency(coupon.discountValue)} OFF`;
      return `<button type="button" class="coupon-card ${valid.ok ? "" : "disabled"}" onclick="applyCoupon('${escapeHTML(coupon.code)}')">
        <strong>${escapeHTML(coupon.code)}</strong>
        <span>${escapeHTML(valid.ok ? label : valid.message)}</span>
      </button>`;
    }).join("");
  host.innerHTML = cards || `<p class="coupon-empty">Coupons will appear here when available.</p>`;
}

function validateActiveCoupon(){
  if(!activeCoupon) return;
  const validation = validateCoupon(activeCoupon);
  if(!validation.ok){
    activeCoupon = null;
    const input = document.getElementById("couponInput");
    if(input) input.value = "";
    persistGuestState();
  }
}

async function validateCouponUsage(coupon){
  const userId = auth.currentUser?.uid || "";
  if(!userId) return { ok:true };
  const previousOrders = await getDocs(query(collection(db, "orders"), where("userId", "==", userId)));
  let usedCoupon = false;
  let completedOrders = 0;
  previousOrders.forEach(item => {
    const order = item.data();
    if(order.status !== "Cancelled" && order.status !== "Rejected") completedOrders++;
    if(String(order.couponCode || "").toUpperCase() === String(coupon.code || "").toUpperCase()) usedCoupon = true;
  });
  if(usedCoupon) return { ok:false, message:"Coupon already used on this account" };
  if(coupon.firstOrderOnly && completedOrders > 0) return { ok:false, message:"This coupon is only for your first order" };
  return { ok:true };
}



async function validateCartInventory(){

  const normalItems = cart.filter(item => !item.comboId);

  if (!normalItems.length) {
    return { ok:true };
  }

  const names = [...new Set(
    normalItems
      .map(item => normalizeUnicodeText(item.name))
      .filter(Boolean)
  )];

  try{
    const available = new Map();

    for(let i = 0; i < names.length; i += 10){

      const chunk = names.slice(i, i + 10);

      const snap = await getDocs(
        query(collection(db, "dishes"), where("name", "in", chunk))
      );

      snap.forEach(item => {
        const dish = item.data();
        available.set(
          normalizeUnicodeText(dish.name),
          dish.available !== false
        );
      });
    }

    const missing = names.find(
      name => available.get(name) !== true
    );

    if(missing){
      return {
        ok:false,
        message:`${missing} is currently unavailable.`
      };
    }

  }catch(error){
    console.warn("Inventory validation fallback:", error);
  }

  return { ok:true };
}

async function recordCouponUsage(coupon, discount){
  if(!coupon?.id) return;
  const uid = auth.currentUser?.uid || "guest";
  try{
    await updateDoc(doc(db, "coupons", coupon.id), {
      usedCount: increment(1),
      totalDiscountGiven: increment(Number(discount) || 0),
      [`usageByUser.${uid}`]: increment(1),
      lastUsedAt: serverTimestamp()
    });
  }catch(error){
    console.warn("Coupon usage logging skipped:", error);
  }
}

async function createOrderSafely({ paymentMethod, paymentStatus, paymentId = "", source = "checkout" }){
  perfStart("createOrderSafely");
  try{
  if(restaurantUnavailable()) throw new Error(restaurantState.unavailableMessage || "Restaurant currently closed");
  const user = await timedStep("createOrderSafely:waitForAuthReady", () => waitForAuthReady());
  if(!user?.uid) throw new Error("Please login again to place this order.");
  if(!cart.length) throw new Error("Cart empty");

  const fields = getCheckoutFields();
  if(!fields.name || !fields.phone || !fields.address) throw new Error("Fill name, phone & address");
  const normalizedPaymentMethod = String(paymentMethod || "").toLowerCase();
  const normalizedPaymentStatus = String(paymentStatus || "pending").toLowerCase();
  if(!["cod", "online", "upi"].includes(normalizedPaymentMethod)) throw new Error("Invalid payment method");

  const subtotal = getCartSubtotal();
  if(subtotal < 2) throw new Error(`Add ${formatCurrency(2 - subtotal)} more to place order`);

  if(!(await timedStep("createOrderSafely:ensureDeliveryEligible", () => ensureDeliveryEligible()))) throw new Error("Delivery is not available for this location.");
  if(!calculateDeliveryCharge(subtotal)) throw new Error("Delivery is not available for this location.");

  validateActiveCoupon();
  const [usageValidation, inventory] = await timedStep("createOrderSafely:couponAndInventory", () => Promise.all([
    activeCoupon ? validateCouponUsage(activeCoupon) : Promise.resolve({ ok:true }),
    validateCartInventory()
  ]));
  if(!usageValidation.ok) throw new Error(usageValidation.message);
  if(!inventory.ok) throw new Error(inventory.message);

  const pricing = calculateInvoicePricing(subtotal);
  const restaurantAssignment = {
  restaurantId: "primary",
  restaurantName: "MAGNEETOZ",
  restaurantLocation:getRestaurantLocation(),
  restaurantDistance: deliveryDistance || 0,
  maxDeliveryDistance:MAX_DELIVERY_DISTANCE,
  restaurantRoutingMode: "single_restaurant"
};
  const signature = checkoutSignature(paymentMethod);
  const checkoutId = checkoutInFlightId || `co_${user.uid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  checkoutInFlightId = checkoutId;
  const isRazorpayPendingOrder = source === "razorpay_pending";
  const initialOrderStatus = isRazorpayPendingOrder ? "Payment Pending" : "Pending";
  const orderRef = doc(collection(db, "orders"));
  const counterRef = doc(db, "counters", "orders");
  const orderTimes = buildOrderTimestamps();
  const itemsSnapshot = cart.map(item => ({ ...item }));

  logDistanceDebug("order_payload_distance_ready");
  const result = await timedStep("createOrderSafely:orderTransaction", () => retryAsync(async () => {
    return runTransaction(db, async transaction => {
      const counterSnap = await transaction.get(counterRef);
      const nextOrderNumber = Number(counterSnap.exists() ? counterSnap.data().lastOrderNumber || 0 : 0) + 1;
      const orderData = {
        orderId:orderRef.id,
        checkoutId,
        checkoutSignature:signature,
        orderNumber:nextOrderNumber,
        customerName:fields.name,
        phone:fields.phone,
        address:fields.address,
        landmark:fields.landmark,
        addressLat:fields.lat || userLocation?.lat || null,
        addressLng:fields.lng || userLocation?.lng || null,
        items:itemsSnapshot,
        subtotalAmount:subtotal,
        totalAmount:pricing.grandTotal,
        deliveryDistance,
        ...deliveryMetrics(),
        deliveryCharge:pricing.deliveryCharge,
        originalDeliveryCharge:deliveryCharge,
        couponId:activeCoupon?.id || "",
        couponCode:activeCoupon?.code || "",
        couponPgName:activeCoupon?.pgName || activeCoupon?.pg || "",
        couponPgCode:activeCoupon?.pgCode || "",
        couponDiscount:pricing.couponDiscount,
        freeDelivery:!!activeCoupon?.freeDelivery,
        gstPercent:pricing.gstPercent,
        gstAmount:pricing.gstAmount,
        handlingCharge:pricing.handlingCharge,
        subtotal,
        grandTotal:pricing.grandTotal,
        invoiceNumber:buildInvoiceNumber(orderRef.id),
        invoiceGeneratedAt:serverTimestamp(),
        finalAmount:pricing.grandTotal,
        paymentMethod:normalizedPaymentMethod === "upi" ? "online" : normalizedPaymentMethod,
        paymentStatus:normalizedPaymentStatus,
        amountToCollect:normalizedPaymentStatus === "paid" ? 0 : pricing.grandTotal,
        paymentCaptured:normalizedPaymentStatus === "paid",
        orderSource:"online",
        checkoutSource:source,
        status:initialOrderStatus,
        orderStatus:initialOrderStatus,
        location:userLocation,
        ...restaurantAssignment,
        userId:user.uid,
        ...(paymentId ? {
          paymentId,
          razorpayPaymentId:paymentId,
          transactionId:paymentId,
          paymentCollectedAt:serverTimestamp()
        } : {}),
        ...orderTimes,
        placedAt:serverTimestamp()
      };
      transaction.set(counterRef, {
        lastOrderNumber:nextOrderNumber,
        updatedAt:serverTimestamp()
      }, { merge:true });
      transaction.set(orderRef, orderData);
      return { orderId:orderRef.id, orderNumber:nextOrderNumber, orderData };
    });
  }));

  await timedStep("createOrderSafely:recordCouponUsage", () =>
    recordCouponUsage(activeCoupon, pricing.couponDiscount + pricing.freeDeliveryDiscount)
  );
  await timedStep("createOrderSafely:saveCustomerProfile", () => saveCustomerProfile(user));
  if(!isRazorpayPendingOrder){
    timedStep("createOrderSafely:buildNearbyRiderRequest:background", () =>
      buildNearbyRiderRequest(result.orderId)
    ).catch(error => console.warn("Background rider request failed:", error));
  }
  logDistanceDebug("order_created", { orderId:result.orderId });
  checkoutInFlightId = "";
  return result;
  }finally{
    perfEnd("createOrderSafely");
  }
}

async function buildPaidOnlineOrderDraft(){
  if(restaurantUnavailable()) throw new Error(restaurantState.unavailableMessage || "Restaurant currently closed");
  const user = await waitForAuthReady();
  if(!user?.uid) throw new Error("Please login again to place this order.");
  if(!cart.length) throw new Error("Cart empty");

  const fields = getCheckoutFields();
  if(!fields.name || !fields.phone || !fields.address) throw new Error("Fill name, phone & address");

  const subtotal = getCartSubtotal();
  if(subtotal < 2) throw new Error(`Add ${formatCurrency(2 - subtotal)} more to place order`);
  if(!(await ensureDeliveryEligible())) throw new Error("Delivery is not available for this location.");
  if(!calculateDeliveryCharge(subtotal)) throw new Error("Delivery is not available for this location.");

  validateActiveCoupon();
  const [usageValidation, inventory] = await Promise.all([
    activeCoupon ? validateCouponUsage(activeCoupon) : Promise.resolve({ ok:true }),
    validateCartInventory()
  ]);
  if(!usageValidation.ok) throw new Error(usageValidation.message);
  if(!inventory.ok) throw new Error(inventory.message);

  const pricing = calculateInvoicePricing(subtotal);
  const checkoutId = checkoutInFlightId || `co_${user.uid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  checkoutInFlightId = checkoutId;
  const itemsSnapshot = cart.map(item => ({
    id:item.id || "",
    name:item.name || "",
    price:Number(item.price || 0),
    qty:Number(item.qty || item.quantity || 1),
    quantity:Number(item.quantity || item.qty || 1),
    image:item.image || "",
    category:item.category || ""
  }));

  return {
    idempotencyKey:`${checkoutSignature("Online")}|${checkoutId}`,
    amount:pricing.grandTotal,
    cart:itemsSnapshot,
    orderDraft:{
      checkoutId,
      checkoutSignature:checkoutSignature("Online"),
      customerName:fields.name,
      phone:fields.phone,
      address:fields.address,
      landmark:fields.landmark,
      addressLat:fields.lat || userLocation?.lat || null,
      addressLng:fields.lng || userLocation?.lng || null,
      items:itemsSnapshot,
      subtotalAmount:subtotal,
      totalAmount:pricing.grandTotal,
      deliveryDistance,
      ...deliveryMetrics(),
      deliveryCharge:pricing.deliveryCharge,
      originalDeliveryCharge:deliveryCharge,
      couponId:activeCoupon?.id || "",
      couponCode:activeCoupon?.code || "",
      couponPgName:activeCoupon?.pgName || activeCoupon?.pg || "",
      couponPgCode:activeCoupon?.pgCode || "",
      couponDiscount:pricing.couponDiscount,
      freeDelivery:!!activeCoupon?.freeDelivery,
      gstPercent:pricing.gstPercent,
      gstAmount:pricing.gstAmount,
      handlingCharge:pricing.handlingCharge,
      subtotal,
      grandTotal:pricing.grandTotal,
      finalAmount:pricing.grandTotal,
      orderSource:"online",
      location:userLocation,
      restaurantId:"primary",
      restaurantName:"MAGNEETOZ",
      restaurantLocation:getRestaurantLocation(),
      restaurantDistance:deliveryDistance || 0,
      maxDeliveryDistance:MAX_DELIVERY_DISTANCE,
      restaurantRoutingMode:"single_restaurant",
      userId:user.uid
    }
  };
}

window.applyCoupon = async function(codeFromCard){
  const input = document.getElementById("couponInput");
  const code = String(codeFromCard || input?.value || "").trim().toUpperCase();
  const coupon = availableCoupons.find(item => String(item.code || "").toUpperCase() === code);
  const validation = validateCoupon(coupon);
  if(!validation.ok){
    alert(validation.message);
    return;
  }
  const usageValidation = await validateCouponUsage(coupon);
  if(!usageValidation.ok){
    alert(usageValidation.message);
    return;
  }
  activeCoupon = coupon;
  if(input) input.value = coupon.code;
  updateCart();
  persistGuestState();
  notifyPremiumUI("magneetoz:coupon-applied", { code:coupon.code });
};

window.removeCoupon = function(){
  activeCoupon = null;
  localStorage.removeItem(PG_REFERRAL_COUPON_KEY);
  const input = document.getElementById("couponInput");
  if(input) input.value = "";
  updateCart();
  persistGuestState();
};

/* ================= CART ================= */

function updateCart() {

  let itemsHTML = "";
  let total = 0;
  const totalQty = cart.reduce((sum, item) => sum + (Number(item.qty) || 1), 0);

  cart.forEach((item, index) => {
    total += item.price;
    itemsHTML += `
  <div class="cart-item cart-item-pro">
    <img src="${escapeHTML(normalizeImageUrl(item.image))}" alt="${escapeHTML(item.name)}" onerror="this.onerror=null;this.src='logo_tran.jpeg';">
    <div>
      <strong>${escapeHTML(item.name)}</strong><br>
      <small>${escapeHTML(item.size || "Regular")} x ${item.qty}</small>
    </div>
    <div class="cart-line-actions">
      <b>${formatCurrency(item.price)}</b>
      <div class="cart-qty-controls" aria-label="Quantity controls">
        <button type="button" onclick="changeCartItemQty(${index}, -1)">-</button>
        <span>${item.qty}</span>
        <button type="button" onclick="changeCartItemQty(${index}, 1)">+</button>
      </div>
      <button type="button" aria-label="Remove ${escapeHTML(item.name)}" onclick="removeItem(${index})">x</button>
    </div>
     </div>
    `;
  });

  const cartItems = document.getElementById("cartItems");
  const totalEl = document.getElementById("total");
  const countEl = document.getElementById("cartCount");
  const headerTitle = document.querySelector("#cartPanel .cart-header h3");
  if(cartItems){
    cartItems.innerHTML = totalQty
      ? `<div class="cart-items-title">Items in cart <b>${totalQty}</b></div>${itemsHTML}`
      : "";
  }
  const couponResult = calculateInvoicePricing(total);
  if(totalEl) totalEl.innerText = formatCurrency(couponResult.finalTotal);
  if(countEl) countEl.innerText = totalQty;
  if(headerTitle) headerTitle.textContent = `Your Cart (${totalQty} ${totalQty === 1 ? "item" : "items"})`;
  renderCouponPanel(couponResult);
  showFreeDeliveryHint(total);
  persistGuestState();
  notifyPremiumUI("magneetoz:cart-updated", {
    count: totalQty,
    total: couponResult.finalTotal,
    items: [...cart]
  });
  renderSmartAssistant();
}

function changeCartItemQty(index, delta){
  const item = cart[index];
  if(!item) return;
  const unit = Number(item.unitPrice || (item.qty ? item.price / item.qty : item.price)) || 0;
  item.qty = Math.max(1, Number(item.qty || 1) + delta);
  item.unitPrice = unit;
  item.price = Math.round(unit * item.qty);
  updateCart();
}

function removeItem(index) {
  cart.splice(index, 1);
  if(activeCoupon) validateActiveCoupon();
  updateCart();
}

function toggleCart(forceOpen) {
  const panel = document.getElementById("cartPanel");
  const backdrop = document.getElementById("cartBackdrop");
  if(!panel) return false;
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !panel.classList.contains("active");
  panel.classList.toggle("active", shouldOpen);
  panel.setAttribute("aria-hidden", String(!shouldOpen));
  document.body.classList.toggle("cart-open", shouldOpen);
  document.documentElement.classList.toggle("cart-open-root", shouldOpen);
  if(backdrop){
    backdrop.classList.toggle("active", shouldOpen);
    backdrop.hidden = !shouldOpen;
  }
  if(shouldOpen){
    panel.style.visibility = "visible";
    panel.style.pointerEvents = "auto";
    if(window.matchMedia("(max-width: 760px)").matches){
      panel.style.bottom = "0";
      panel.style.top = "auto";
      panel.style.right = "0";
      panel.scrollTop = 0;
    }
  }
  if(!shouldOpen){
    panel.style.pointerEvents = "none";
  }
  return shouldOpen;
}

document.addEventListener("keydown", event => {
  if(event.key === "Escape") toggleCart(false);
});

function closePaymentPopup(){
  const popup = document.getElementById("paymentMethodPopup");
  if(popup){
    popup.style.display = "none";
    popup.classList.remove("mz-payment-ready");
  }
}

/* ================= CARD ================= */

function changeQty(btn, amount){

  const card = btn.closest(".card");
  const qtySpan = card.querySelector(".qty");

  let qty = parseInt(qtySpan.innerText);
  qty += amount;

  if(qty < 1) qty = 1;

  qtySpan.innerText = qty;

  const offerEl = card.querySelector(".offer");
  const marketEl = card.querySelector(".market");

  // 🔥 FIX: use base price
  const baseOffer = parseInt(offerEl.dataset.base);
  const baseMarket = parseInt(marketEl.dataset.base);

  offerEl.innerText = formatCurrency(baseOffer * qty);
  marketEl.innerText = formatCurrency(baseMarket * qty);
}

function updatePrice(selectElement){

  const card = selectElement.closest(".new-card");
  const selectedOption = selectElement.options[selectElement.selectedIndex];

  const offerPrice = parseInt(selectElement.value);
  const marketPrice = parseInt(selectedOption.dataset.market);

  const offerEl = card.querySelector(".offer");
  const marketEl = card.querySelector(".market");

  if(!offerEl || !marketEl) return;

  // ✅ price update
  offerEl.textContent = formatCurrency(offerPrice);
  marketEl.textContent = formatCurrency(marketPrice);

  // 🔥 IMPORTANT: base update
  offerEl.dataset.base = offerPrice;
  marketEl.dataset.base = marketPrice;

  // 🔥 IMPORTANT: qty reset
  const qtySpan = card.querySelector(".qty");
  if(qtySpan){
    qtySpan.innerText = 1;
  }

}

/* ================= ADD TO CART ================= */

function addToCartFull(btn, name){
  if(restaurantUnavailable()){
    alert(restaurantState.unavailableMessage || "Restaurant currently closed");
    applyRestaurantAvailability();
    return;
  }

  const card = btn.closest(".card");

  const select = card.querySelector("select");

  const size = select.options[select.selectedIndex].text.split(" - ")[0];

  const price = parseInt(select.value);

  const qtyEl = card.querySelector(".qty");
  const qty = qtyEl ? parseInt(qtyEl.innerText) : 1;

  cart.push({
    name,
    size,
    qty,
    category: card.dataset.dishCategory || "",
    image: card.dataset.dishImage || card.querySelector("img")?.getAttribute("src") || "logo_tran.jpeg",
    unitPrice: price,
    price: price * qty
  });

  persistGuestState();
  updateCart();
  notifyPremiumUI("magneetoz:item-added", { name, qty, price: price * qty });

  btn.innerText = "Added ✓";
  setTimeout(()=>{
    btn.innerText = "Add +";
  },800);
}

function addToCartSimple(btn, name){
  if(restaurantUnavailable()){
    alert(restaurantState.unavailableMessage || "Restaurant currently closed");
    applyRestaurantAvailability();
    return;
  }

  const card = btn.closest(".card");

  const qty = parseInt(card.querySelector(".qty").innerText);

  const priceEl = card.querySelector(".offer");
  const price = parseCurrency(priceEl.innerText);

  cart.push({
    name,
    size:"Regular",
    qty,
    category: card.dataset.dishCategory || "",
    image: card.dataset.dishImage || card.querySelector("img")?.getAttribute("src") || "logo_tran.jpeg",
    unitPrice: qty ? price / qty : price,
    price
  });

  persistGuestState();
  updateCart();
  notifyPremiumUI("magneetoz:item-added", { name, qty, price });

  btn.innerText = "Added ✓";
  setTimeout(()=>{
    btn.innerText = "Add +";
  },800);
}

window.addComboToCart = function(id){
  if(restaurantUnavailable()){
    alert(restaurantState.unavailableMessage || "Restaurant currently closed");
    applyRestaurantAvailability();
    return;
  }
  const combo = (window.__magneetozActiveCombos || []).find(item => item.id === id);
  if(!combo) return;
  const price = Number(combo.comboPrice || 0);
  cart.push({
    name:combo.name || "MAGNEETOZ Combo",
    size:"Combo",
    qty:1,
    category:"Combo",
    image:combo.image || "logo_tran.jpeg",
    unitPrice:price,
    price,
    comboId:id,
    itemsIncluded:combo.itemsIncluded || ""
  });
  persistGuestState();
  updateCart();
  notifyPremiumUI("magneetoz:item-added", { name:combo.name || "Combo", qty:1, price });
};





function showFreeDeliveryHint(subtotal){

const hintText = document.getElementById("freeDeliveryHint");
const summaryHint = document.getElementById("summaryFreeDelivery");

if(!ALL_INDIA_DELIVERY && !VIP_DELIVERY_ENABLED &&
  deliveryDistance > MAX_DELIVERY_DISTANCE){
if(hintText) hintText.innerHTML = "";
if(summaryHint) summaryHint.innerHTML = "";
return;
}

let target = deliveryDistance <= 3 ? 149 : 199;

if(subtotal >= target){

if(hintText){
hintText.innerHTML = "🎉 Free Delivery Applied!";
hintText.style.color = "green";
}

if(summaryHint){
summaryHint.innerHTML = "🎉 Free Delivery Applied!";
summaryHint.style.color = "green";
}

}
else{

const remaining = target - subtotal;
const msg = `Add ${formatCurrency(remaining)} more for FREE DELIVERY`;

if(hintText){
hintText.innerHTML = msg;
hintText.style.color = "#ff4d00";
}

if(summaryHint){
summaryHint.innerHTML = msg;
summaryHint.style.color = "#ff4d00";
}

}

 }

/* ================= ORDER ================= */

async function placeOrder(){
console.time("PLACE_ORDER_TOTAL");
perfStart("placeOrder");
const placeBtn = document.querySelector('[aria-label="Place order"]');
if(placeBtn){
  placeBtn.disabled = true;
  placeBtn.classList.add("ai-loading");
}
try{
if(restaurantUnavailable()){
alert(restaurantState.unavailableMessage || "Restaurant currently closed");
applyRestaurantAvailability();
return;
}

const name = normalizeUnicodeText(document.getElementById("customerName").value);
const phone = normalizeUnicodeText(document.getElementById("customerPhone").value);
const address = normalizeUnicodeText(document.getElementById("customerAddress").value);

  if (!name || !phone || !address) {
focusMissingCheckoutField();
return;
}

if (cart.length === 0) {
alert("Cart empty");
return;
}

persistGuestState();

if(!auth.currentUser){
  resumeCheckoutAfterAuth = true;
  await timedStep("placeOrder:auth", () => window.requireMagneetozAuth?.("checkout"));
  if(!auth.currentUser){
    resumeCheckoutAfterAuth = false;
    return;
  }
  await timedStep("placeOrder:mergeGuestCart", () => mergeGuestCartWithUser(auth.currentUser));
  resumeCheckoutAfterAuth = false;
}
await timedStep("placeOrder:saveCustomerProfile", () => saveCustomerProfile(auth.currentUser || cachedAuthUser));
await timedStep("placeOrder:saveAddressBook", () => saveCurrentAddressToBook().catch(error => console.warn("Address book save skipped", error)));

const subtotal = cart.reduce((sum,item)=>sum+item.price,0);

// ⭐ Minimum order check
if(subtotal < 2){

const remaining = 2 - subtotal;

showMinOrderPopup(remaining);

return false;

}

if(!(await timedStep("placeOrder:ensureDeliveryEligible", () => ensureDeliveryEligible()))) return;

// delivery condition check
if(!calculateDeliveryCharge(subtotal)){
return;
}

await timedStep("placeOrder:prepareOrderSummary", () => prepareOrderSummary({ skipDistanceRefresh:true }));

toggleCart(false);

const paymentPopup = document.getElementById("paymentMethodPopup");
if(paymentPopup){
  paymentPopup.style.display = "flex";
  paymentPopup.classList.add("mz-payment-ready");
  persistGuestState();
}
}finally{
  if(placeBtn){
    placeBtn.disabled = false;
    placeBtn.classList.remove("ai-loading");
  }
  perfEnd("placeOrder");
  console.timeEnd("PLACE_ORDER_TOTAL");
}
}


async function trackOrderByPhone(){

  const phone = document.getElementById("trackPhoneInput").value.trim();

  if(!phone){
    alert("Enter mobile number");
    return;
  }

  const user = await waitForAuthReady();
  if(!user?.uid){
    await window.requireMagneetozAuth?.("order_tracking");
  }
  const currentUser = auth.currentUser || cachedAuthUser;
  if(!currentUser?.uid){
    alert("Please login to track your orders.");
    return;
  }

  phoneTrackingUnsub?.();

  const q = query(
    collection(db,"orders"),
    where("userId","==",currentUser.uid),
    orderBy("createdAt","desc")
  );

  phoneTrackingUnsub = onSnapshot(q,(snapshot)=>{

    const box = document.getElementById("orderStatusBox");
    const matchingDocs = snapshot.docs.filter(item => String(item.data().phone || "").trim() === phone);

    if(matchingDocs.length === 0){
      box.innerHTML = "No order found";
      return;
    }

    box.innerHTML = "";

    matchingDocs.forEach(docSnap=>{
      const data = docSnap.data();

      box.innerHTML += `
      <div style="margin-top:10px">
        <strong>Order #${data.orderNumber}</strong><br>
        Status: <b>${data.status}</b><br>
        Total: ${formatCurrency(data.totalAmount)}<br>
        Distance: ${data.deliveryDistance} km
      </div>
      `;
    });

  }, error => {
    console.warn("Phone order tracking listener failed:", error);
    const box = document.getElementById("orderStatusBox");
    if(box) box.innerHTML = "Unable to track orders right now. Please try again.";
  });

}

window.debugLocation = () => {
  console.log("Restaurant:", getRestaurantLocation());
  console.log("User:", userLocation);
  console.log("Delivery Distance:", deliveryDistance);
  console.log("Actual Road Distance:", actualRoadDistance);
  console.log("Distance Source:", distanceSource);
  console.log("Travel Time:", estimatedTravelTime);
};

async function prepareOrderSummary(options = {}) {

  if(!options.skipDistanceRefresh){
    await timedStep("prepareOrderSummary:refreshDeliveryDistance", () => refreshDeliveryDistance());
  }

  logDistanceDebug("prepare_order_summary");

  const subtotal = cart.reduce((sum, item) => sum + item.price, 0);

  if (subtotal > 2000) {
    alert(`For large orders above ${formatCurrency(2000)} please contact via WhatsApp`);
  }

  if (!calculateDeliveryCharge(subtotal)) return;

  const pricing = calculateInvoicePricing(subtotal);

  // Fill summary box
  document.getElementById("summaryDetails").innerHTML = `
    Subtotal: ${formatCurrency(pricing.subtotal)} <br>
    Coupon Discount: -${formatCurrency(pricing.couponDiscount)} <br>
    GST (${pricing.gstPercent}%): ${formatCurrency(pricing.gstAmount)} <br>
    Handling: ${formatCurrency(pricing.handlingCharge)} <br>
    Distance: ${deliveryDistance} km ${estimatedTravelTime ? `(${estimatedTravelTime})` : ""}<br>
    Delivery: ${formatCurrency(pricing.deliveryCharge)} <br>
    <hr style="margin:6px 0;">
    <strong>Total Payable: ${formatCurrency(pricing.grandTotal)}</strong>
  `;
  showFreeDeliveryHint(subtotal);
}

/* ================= COD ================= */

async function codOrder(){
  console.time("COD_ORDER_TOTAL");
  perfStart("codOrder");
  try{
  if(restaurantUnavailable()){
    alert(restaurantState.unavailableMessage || "Restaurant currently closed");
    applyRestaurantAvailability();
    return;
  }

  if(!auth.currentUser){
    persistGuestState();
    await timedStep("codOrder:auth", () => window.requireMagneetozAuth?.("payment"));
    if(!auth.currentUser) return;
    await timedStep("codOrder:mergeGuestCart", () => mergeGuestCartWithUser(auth.currentUser));
  }

  if (isOrderProcessing) return;
  const signature = checkoutSignature("COD");
  isOrderProcessing = true;
  lastOrderSignature = signature;

  const btn = document.getElementById("codBtn") || document.querySelector("#paymentMethodPopup button");
  const originalText = btn?.innerText || "Cash on Delivery";
  let keepRetryOverlay = false;
  if(btn){
    btn.innerText = "Processing...";
    btn.disabled = true;
    btn.classList.add("ai-loading");
  }

  try{
    setCheckoutLoading(true, "Confirming COD order...");
    const result = await timedStep("codOrder:createOrderSafely", () => createOrderSafely({
      paymentMethod:"cod",
      paymentStatus:"pending",
      source:"cod"
    }));
    finishSuccessfulCheckout(result.orderNumber);

  }catch(e){

    console.error("COD ERROR:",e);
    lastOrderSignature = null;
    keepRetryOverlay = true;
    setCheckoutRetry(e?.message || "Order could not be placed.", () => codOrder());
    alert(e?.message || "Something went wrong");

  }finally{
    if(btn){
      btn.innerText = originalText;
      btn.disabled = false;
      btn.classList.remove("ai-loading");
    }
    isOrderProcessing = false;
    if(!keepRetryOverlay) setCheckoutLoading(false);
  }
  }finally{
    perfEnd("codOrder");
    console.timeEnd("COD_ORDER_TOTAL");
  }
}

/* ================= UPI ================= */

async function upiOrder(){
console.time("UPI_ORDER_TOTAL");
perfStart("upiOrder");
let razorpayOpened = false;
try{
if(restaurantUnavailable()){
alert(restaurantState.unavailableMessage || "Restaurant currently closed");
applyRestaurantAvailability();
return;
}

if(!auth.currentUser){
persistGuestState();
await timedStep("upiOrder:auth", () => window.requireMagneetozAuth?.("payment"));
if(!auth.currentUser) return;
await timedStep("upiOrder:mergeGuestCart", () => mergeGuestCartWithUser(auth.currentUser));
}

if (typeof Razorpay === "undefined") {
alert("Payment gateway is loading. Please try again in a moment.");
return;
}

if (isOrderProcessing || razorpayInFlight) {
if(hasVisibleRazorpayCheckout()){
alert("Payment is already opening. Please wait.");
return;
}
resetRazorpayCheckoutState();
}

const signature = checkoutSignature("Online");
isOrderProcessing = true;
razorpayInFlight = true;
lastOrderSignature = signature;

const subtotal = cart.reduce((s,i)=>s+i.price,0);

if(!(await timedStep("upiOrder:ensureDeliveryEligible", () => ensureDeliveryEligible()))){
resetRazorpayCheckoutState();
return;
}

if(!calculateDeliveryCharge(subtotal)){
resetRazorpayCheckoutState();
return;
}

validateActiveCoupon();
if(activeCoupon){
const usageValidation = await timedStep("upiOrder:validateCouponUsage", () => validateCouponUsage(activeCoupon));
if(!usageValidation.ok){
alert(usageValidation.message);
resetRazorpayCheckoutState();
return;
}
}
const pricing = calculateInvoicePricing(subtotal);
const finalTotal = pricing.grandTotal;
if(finalTotal < 10){
  resetRazorpayCheckoutState();
  alert("Online payment is available for orders of ₹10 or more. Please add more items or choose Cash on Delivery.");
  return;
}
setCheckoutLoading(true, "Creating secure payment session...");
const orderDraftPayload = await timedStep("upiOrder:buildPaidOnlineOrderDraft", () => buildPaidOnlineOrderDraft());
const paymentSession = await timedStep("upiOrder:createPaymentSession", () => callPaymentFunction("createPaymentSession", orderDraftPayload, 12000));
const sessionAmount = Number(paymentSession.amount);
const sessionAmountPaise = Number(paymentSession.amountPaise || Math.round(sessionAmount * 100));
if(!paymentSession.razorpayOrderId || !paymentSession.paymentSessionId || !paymentSession.keyId || !Number.isFinite(sessionAmount) || sessionAmount <= 0 || !Number.isFinite(sessionAmountPaise) || sessionAmountPaise <= 0){
  throw new Error("Payment session was not created correctly. Please try again.");
}
if(Math.round(Number(orderDraftPayload.amount || 0) * 100) !== sessionAmountPaise){
  throw new Error("Payment amount changed. Please close checkout and try again.");
}
rememberPaymentSessionRecovery({
  paymentSessionId:paymentSession.paymentSessionId,
  razorpayOrderId:paymentSession.razorpayOrderId,
  amount:sessionAmount
});
setCheckoutLoading(false);

if(paymentSession.paymentLinkUrl){
  console.log("RAZORPAY_PAYMENT_LINK_REDIRECT", {
    paymentSessionId:paymentSession.paymentSessionId,
    paymentLinkUrl:paymentSession.paymentLinkUrl
  });
  resetRazorpayCheckoutState();
  window.location.href = paymentSession.paymentLinkUrl;
  return;
}

const options = {

key: paymentSession.keyId,

amount: sessionAmountPaise,

currency: String(paymentSession.currency || "INR").toUpperCase(),

name: "Magneetoz",

description:"Magneetoz order payment",
order_id:String(paymentSession.razorpayOrderId),
theme:{
  color:"#ff7b00"
},

handler: async function (response){

let keepRetryOverlay = false;
try{
rememberPaymentSessionRecovery({
  paymentId:response.razorpay_payment_id,
  razorpayOrderId:response.razorpay_order_id,
  razorpaySignature:response.razorpay_signature,
  paymentSessionId:paymentSession.paymentSessionId,
  amount:sessionAmount,
});
setCheckoutLoading(true, "Verifying payment and placing your order...");
const verifiedOrder = await timedStep("upiOrder.handler:verifyPaymentAndCreateOrder", () => callPaymentFunction("verifyPaymentAndCreateOrder", {
  paymentSessionId:paymentSession.paymentSessionId,
  razorpay_order_id:response.razorpay_order_id,
  razorpay_payment_id:response.razorpay_payment_id,
  razorpay_signature:response.razorpay_signature
}, 35000));
clearRazorpayPaymentRecovery();
finishSuccessfulCheckout(verifiedOrder.orderNumber);

}catch(e){

console.error("UPI ERROR:",e);
keepRetryOverlay = true;
setCheckoutRetry("Payment received. We are safely creating your order.", async () => {
  try{
    setCheckoutLoading(true, "Retrying secure order creation...");
    const verifiedOrder = await callPaymentFunction("verifyPaymentAndCreateOrder", {
      paymentSessionId:paymentSession.paymentSessionId,
      razorpay_order_id:response.razorpay_order_id,
      razorpay_payment_id:response.razorpay_payment_id,
      razorpay_signature:response.razorpay_signature
    }, 35000);
    clearRazorpayPaymentRecovery();
    finishSuccessfulCheckout(verifiedOrder.orderNumber);
  }catch(retryError){
    setCheckoutRetry(retryError?.message || "Still retrying paid order recovery.", null);
  }
});
alert("Payment received. We are safely creating your order. Payment id: " + (response.razorpay_payment_id || ""));

}finally{
if(!keepRetryOverlay){
  setCheckoutLoading(false);
  resetRazorpayCheckoutState();
}else{
  isOrderProcessing = false;
  razorpayInFlight = false;
}
}

},

modal:{
ondismiss:function(){
console.log("Payment cancelled");
resetRazorpayCheckoutState();
}
}

};

console.log("RAZORPAY_OPTIONS", {
  key:options.key,
  amount:options.amount,
  currency:options.currency,
  order_id:options.order_id,
  name:options.name,
  hasHandler:typeof options.handler === "function",
  hasCallbackUrl:!!options.callback_url,
  paymentSessionId:paymentSession.paymentSessionId
});
const rzp = new Razorpay(options);

rzp.on('payment.failed', function (response){

resetRazorpayCheckoutState();
console.log("PAYMENT_ERROR", response?.error || response);
alert(response?.error?.description || "Payment failed. Please try again.");

});

try{
  razorpayOpened = true;
  rzp.open();
  armRazorpayOpenWatchdog();
}catch(error){
  razorpayOpened = false;
  resetRazorpayCheckoutState();
  console.log("PAYMENT_ERROR", error);
  alert(error?.message || "Payment gateway could not open. Please try again.");
}

}finally{
if(!razorpayOpened && razorpayInFlight) resetRazorpayCheckoutState();
perfEnd("upiOrder");
console.timeEnd("UPI_ORDER_TOTAL");
}
}

/* ================= WHATSAPP ================= */

function showOrderSuccess(orderNumber){

const popup = document.getElementById("orderPopup");
const displayOrderId = document.getElementById("displayOrderId");

if(displayOrderId) displayOrderId.innerText = orderNumber || "";

if(popup) popup.style.display = "flex";
try{
  notifyPremiumUI?.("magneetoz:order-success", { orderNumber });
}catch(error){
  console.warn("Order success notification skipped", error);
}

}

function closeOrderPopup(){
const popup = document.getElementById("orderPopup");
if(popup) popup.style.display="none";
}

function finishSuccessfulCheckout(orderNumber){
  try{ closePaymentPopup(); }catch(error){ console.warn("Payment popup close skipped", error); }
  try{ showOrderSuccess(orderNumber); }catch(error){ console.warn("Order success popup skipped", error); }
  try{ resetCart(); }catch(error){ console.warn("Cart reset skipped", error); }
  try{ clearRazorpayPaymentRecovery(); }catch(error){ console.warn("Payment recovery clear skipped", error); }
}

/* ================= RESET ================= */

function resetCart() {
  cart = [];
  activeCoupon = null;
  lastOrderSignature = null;
  checkoutInFlightId = "";
  localStorage.removeItem(GUEST_CART_KEY);
  localStorage.removeItem(CHECKOUT_STATE_KEY);
  localStorage.removeItem(PG_REFERRAL_COUPON_KEY);
  const couponInput = document.getElementById("couponInput");
  if(couponInput) couponInput.value = "";
  updateCart();
  const resetPaymentPopup = document.getElementById("paymentMethodPopup");
  if(resetPaymentPopup){
    resetPaymentPopup.style.display = "none";
    resetPaymentPopup.classList.remove("mz-payment-ready");
  }
}
function toggleLocation() {

  const toggle = document.getElementById("locationSwitch");

  if (toggle.checked) {
  acceptLocation();
  } else {
    clearCustomerLocation("location_toggle_off");

    document.getElementById("locationStatus").innerText = "🔴 Location Off";

    document.getElementById("locationPopup").style.display = "flex";
  }
}

async function getNextOrderNumber(){

  const snapshot = await getDocs(collection(db,"orders"));

  let max = 0;

  snapshot.forEach(doc=>{
    const data = doc.data();
    if(data.orderNumber && data.orderNumber > max){
      max = data.orderNumber;
    }
  });

  return max + 1;
}

function showMinOrderPopup(amount){

const popup = document.getElementById("minOrderPopup");
const text = document.getElementById("minOrderText");

if(!popup || !text){
alert("Add "+formatCurrency(amount)+" more to place order");
return;
}

text.innerText = "Add "+formatCurrency(amount)+" more to place order";

popup.style.display = "flex";

}

function closeMinOrderPopup(){

const popup = document.getElementById("minOrderPopup");
if(popup) popup.style.display="none";

}

document.addEventListener("DOMContentLoaded", () => {

  const allowBtn = document.getElementById("allowLocationBtn");

  if (allowBtn) {
    allowBtn.addEventListener("click", acceptLocation);
  }
  document.getElementById("savedAddressSelect")?.addEventListener("change", event => {
    applySavedAddress(event.target.value);
  });
  document.getElementById("useCurrentLocationBtn")?.addEventListener("click", useCurrentLocationForAddress);
  document.getElementById("refreshLocationBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("refreshLocationBtn");
    try{
      if(btn) btn.textContent = "Detecting...";
      await fetchFreshCurrentLocation({ updateAddress:true, source:"fresh_gps:refresh_button" });
    }catch{
      alert("Please enable location permission and GPS, then retry.");
    }finally{
      if(btn) btn.textContent = "↻ Refresh Location";
    }
  });
  document.getElementById("searchAddressBtn")?.addEventListener("click", searchAddressForCheckout);
  document.getElementById("editSavedAddressBtn")?.addEventListener("click", editSelectedAddress);
  document.getElementById("deleteSavedAddressBtn")?.addEventListener("click", () => {
    deleteSelectedAddress().catch(error => alert(error.message || "Unable to delete address."));
  });
  document.getElementById("smartAssistantChips")?.addEventListener("click", event => {
    const button = event.target.closest("[data-ai-intent]");
    if(!button) return;
    renderSmartAssistant(button.dataset.aiIntent || "popular");
  });
  document.querySelector(".hero")?.addEventListener("click", event => {
    if(event.target.closest("button,a,select,input,textarea")) return;
    document.getElementById("menuSection")?.scrollIntoView({ behavior:"smooth", block:"start" });
  });
  document.querySelector(".hero")?.addEventListener("keydown", event => {
    if(event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    document.getElementById("menuSection")?.scrollIntoView({ behavior:"smooth", block:"start" });
  });
  ["customerName","customerPhone","customerAddress","customerLandmark"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", () => {
      setCheckoutFieldsCollapsed(false);
      persistGuestState();
    });
  });

});

window.addEventListener("scroll", ()=>{
  if(menuBrowserHideOnNextScroll){
    hideMenuCategoryPicker();
    return;
  }
  if(menuCategoryGroups.length) return;
  if(categoryScrollRaf) return;
  categoryScrollRaf = true;
  requestAnimationFrame(() => {
    categoryScrollRaf = false;
    let activeId = window.scrollY < 260 ? "menuSection" : "";
    for(const section of cachedCategorySections){
      const rect = section.getBoundingClientRect();
      if(rect.top < 200 && rect.bottom > 200){
        activeId = section.id;
        break;
      }
    }
    if(!activeId || activeId === activeCategoryId) return;
    activeCategoryId = activeId;
    cachedCategoryLinks.forEach(a=>{
      a.classList.toggle("active", a.getAttribute("href") === "#"+activeId || (activeId === "menuSection" && a.dataset.categoryTab === "all"));
    });
  });
}, { passive:true });

["touchstart","wheel"].forEach(eventName => {
  window.addEventListener(eventName, event => {
    if(!menuBrowserHideOnNextScroll) return;
    if(event.target?.closest?.("#menuCategoryBrowser")) return;
    hideMenuCategoryPicker();
  }, { passive:true });
});

// LOCATION POPUP ONLY AFTER LOGIN

onAuthStateChanged(auth,(user)=>{

  if(user){
    mergeGuestCartWithUser(user).then(async () => {
      if(resumeCheckoutAfterAuth) persistGuestState();
      await fetchFreshCurrentLocation({ updateAddress:true, source:"fresh_gps:login" }).catch(() => {
        setLocationUiState("permission", "Please enable location permission and GPS, then retry.");
      });
    });

  }

});


/* =========================================
   TRACK ORDER OVERLAY
========================================= */

const trackingOverlay =
document.getElementById("trackingOverlay");

const trackOrderBtn =
document.getElementById("trackOrderBtn");

const closeTracking =
document.getElementById("closeTracking");

/* OPEN */

if(trackOrderBtn){

  trackOrderBtn.addEventListener("click", async ()=>{
    if(!auth.currentUser){
      await window.requireMagneetozAuth?.("order_tracking");
      if(!auth.currentUser) return;
    }

    trackingOverlay.classList.add("active");

    document.body.style.overflow = "hidden";

  });

}

/* CLOSE */

if(closeTracking){

  closeTracking.addEventListener("click", ()=>{

    trackingOverlay.classList.remove("active");

    document.body.style.overflow = "auto";

  });

}

/* OUTSIDE CLICK CLOSE */

trackingOverlay?.addEventListener("click",(e)=>{

  if(e.target === trackingOverlay){

    trackingOverlay.classList.remove("active");

    document.body.style.overflow = "auto";

  }

});

if(location.hash === "#tracking" || new URLSearchParams(location.search).has("orderId")){
  waitForAuthReady().then(async user => {
    if(!user){
      await window.requireMagneetozAuth?.("order_tracking");
    }
    if(auth.currentUser || cachedAuthUser){
      trackingOverlay?.classList.add("active");
      document.body.style.overflow = "hidden";
    }
  });
}


/* =========================================
   HEADER MENU
========================================= */

const menuToggleBtn =
document.getElementById("menuToggleBtn");

const headerDropdown =
document.getElementById("headerDropdown");

const dropdownTrackBtn =
document.getElementById("dropdownTrackBtn");

/* TOGGLE */

menuToggleBtn?.addEventListener("click",(e)=>{

  e.stopPropagation();

  headerDropdown.classList.toggle("active");
  menuToggleBtn.classList.toggle("active");

});

/* OUTSIDE CLICK */

document.addEventListener("click",(e)=>{

  if(
    !headerDropdown?.contains(e.target) &&
    !menuToggleBtn?.contains(e.target)
  ){

    headerDropdown?.classList.remove("active");
    menuToggleBtn?.classList.remove("active");

  }

});

/* TRACK BUTTON */

dropdownTrackBtn?.addEventListener("click", async ()=>{

  headerDropdown.classList.remove("active");
  if(!auth.currentUser){
    await window.requireMagneetozAuth?.("order_tracking");
    if(!auth.currentUser) return;
  }

  trackingOverlay.classList.add("active");

  document.body.style.overflow = "hidden";

});


/* =========================================
   LIVE ORDER TRACKING
========================================= */


/* ELEMENTS */

const ordersContainer =
document.getElementById("ordersContainer");

const trackingLoader =
document.getElementById("trackingLoader");

const emptyOrders =
document.getElementById("emptyOrders");

/* STORE */

let liveOrders = [];
const CUSTOMER_LIVE_ORDERS_CACHE_KEY = "magneetozLiveOrdersCache";

let currentFilter = "active";
const feedbackPromptedOrders = new Set(JSON.parse(localStorage.getItem("magneetozFeedbackPromptedOrders") || "[]"));

function cacheLiveOrdersForUser(userId, orders = []){
  if(!userId) return;
  writeJSON(`${CUSTOMER_LIVE_ORDERS_CACHE_KEY}:${userId}`, {
    savedAt:Date.now(),
    orders:orders.slice(0, 20)
  });
}

function readCachedLiveOrdersForUser(userId){
  if(!userId) return [];
  const cached = readJSON(`${CUSTOMER_LIVE_ORDERS_CACHE_KEY}:${userId}`, null);
  return Array.isArray(cached?.orders) ? cached.orders : [];
}

/* FILTER BUTTONS */

document.querySelectorAll(".filter-btn")
.forEach(btn=>{

  btn.addEventListener("click", ()=>{

    document
    .querySelectorAll(".filter-btn")
    .forEach(b=>b.classList.remove("active"));

    btn.classList.add("active");

    currentFilter = btn.dataset.filter;

    renderOrders();

  });

});

/* REALTIME LISTENER */

function stopOrderTrackingListener({ clearState = false } = {}){
  orderTrackingUnsub?.();
  orderTrackingUnsub = null;
  orderTrackingUserId = "";
  if(clearState){
    liveOrders = [];
    renderOrders();
  }
}

function startOrderTrackingListener(user){
  if(authSignOutClearTimer){
    clearTimeout(authSignOutClearTimer);
    authSignOutClearTimer = null;
  }
  orderTrackingPausedForAuthRefresh = false;
  if(!user?.uid || orderTrackingUserId === user.uid) return;

  stopOrderTrackingListener();
  orderTrackingUserId = user.uid;
  if(trackingLoader) trackingLoader.style.display = "block";
  const cachedOrders = readCachedLiveOrdersForUser(user.uid);
  if(cachedOrders.length){
    liveOrders = cachedOrders;
    renderOrders();
  }

  const attachOrdersListener = (ordersQuery, fallbackEnabled = true) => {
  orderTrackingUnsub = onSnapshot(ordersQuery,(snapshot)=>{

    if(trackingLoader) trackingLoader.style.display = "none";

    const previousById = new Map(liveOrders.map(order => [order.id, order]));
    const nextOrders = [];

    snapshot.forEach(docSnap=>{

      const incoming = { id:docSnap.id, ...docSnap.data() };
      const previous = previousById.get(docSnap.id);
      const orderData = previous && statusRank(incoming.status) < statusRank(previous.status)
        ? { ...incoming, status:previous.status, orderStatus:previous.status }
        : incoming;
      if(previous && statusRank(incoming.status) < statusRank(previous.status)){
        logStructured("ORDER STATUS", { event:"ignored_backward_status", orderId:docSnap.id, incoming:incoming.status, kept:previous.status });
      }
      nextOrders.push(orderData);
      if(orderData.status === "Delivered" && !feedbackPromptedOrders.has(docSnap.id) && !orderData.feedbackSubmitted){
        setTimeout(() => showDeliveryFeedbackPopup(orderData), 500);
      }

    });

    nextOrders.sort((a,b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    liveOrders = nextOrders;
    cacheLiveOrdersForUser(user.uid, nextOrders);
    renderOrders();
    hydrateDeliveryAuthorizationCodes(nextOrders).catch(error => console.warn("Delivery OTP hydrate failed:", error));
    logStructured("FIRESTORE LISTENER", { name:"customer-live-orders", count:nextOrders.length });

  }, error => {
    if(!auth.currentUser){
      console.info("[FIRESTORE LISTENER]", { name:"customer-live-orders", event:"paused_during_auth_refresh" });
    }else{
      console.warn("Live order tracking listener failed:", error);
    }
    orderTrackingUnsub = null;
    orderTrackingUserId = "";
    if(trackingLoader) trackingLoader.style.display = "none";
    if(fallbackEnabled && auth.currentUser?.uid){
      console.warn("Retrying live orders without createdAt ordering.");
      orderTrackingUserId = auth.currentUser.uid;
      attachOrdersListener(query(collection(db,"orders"), where("userId","==",auth.currentUser.uid)), false);
      return;
    }
    if(ordersContainer && liveOrders.length === 0){
      ordersContainer.innerHTML = `<div class="order-track-card"><p>Unable to load live order updates right now.</p></div>`;
    }
  });
  };

  attachOrdersListener(query(
    collection(db,"orders"),
    where("userId","==",user.uid),
    orderBy("createdAt","desc")
  ));

}

onAuthStateChanged(auth,(user)=>{
  if(!user){
    if(orderTrackingUnsub){
      console.info("[AUTH]", { event:"temporary_null_pause_tracking", previousUserId:orderTrackingUserId });
      stopOrderTrackingListener({ clearState:false });
      orderTrackingPausedForAuthRefresh = true;
    }
    if(authSignOutClearTimer) clearTimeout(authSignOutClearTimer);
    authSignOutClearTimer = setTimeout(() => {
      if(auth.currentUser) return;
      stopOrderTrackingListener({ clearState:true });
      phoneTrackingUnsub?.();
      phoneTrackingUnsub = null;
      authSignOutClearTimer = null;
      orderTrackingPausedForAuthRefresh = false;
    }, 1500);
    return;
  }
  if(orderTrackingPausedForAuthRefresh){
    console.info("[AUTH]", { event:"auth_restored_restart_tracking", uid:user.uid });
  }
  startOrderTrackingListener(user);
});

/* RENDER */

function renderOrders(){
  if(countdownInterval) clearInterval(countdownInterval);
  if(!ordersContainer || !emptyOrders) return;

  ordersContainer.innerHTML = "";

  let filtered = liveOrders.filter(order=>{

    if(currentFilter === "active"){

      return (
        order.status !== "Delivered" && order.status !== "Cancelled" && order.status !== "Rejected"
      );

    }

    if(currentFilter === "cancelled"){
      return order.status === "Cancelled" || order.status === "Rejected";
    }

    return (
      order.status === "Delivered"
    );

  });

  /* EMPTY */

  if(filtered.length === 0){

    emptyOrders.style.display = "block";

    return;
  }

  emptyOrders.style.display = "none";

  /* LOOP */

  filtered.forEach(order=>{

    /* TIMELINE */

const timelineSteps = [

  "Pending",
  "Accepted",
  "Preparing",
  "Searching For Rider",
  "Rider Assigned",
  "Picked Up",
  "Out For Delivery",
  "Nearby",
  "Cash Collected",
  "Payment Settled",
  "Delivery Code Pending",
  "Payment Completed",
  "Delivered"

];

const currentStepIndex =
Math.max(0, timelineSteps.findIndex(
  step => step === normalizeTimelineStatus(order.status)
));

const cancelHTML = buildCancelWindowHTML(order);
const paymentHTML = buildPaymentTrackingHTML(order);
const riderLiveMapHTML = buildRiderLiveMapHTML(order);

const timelineHTML = `

<div class="timeline">

  ${
    timelineSteps.map((step,index)=>`

      <div class="
      timeline-step
      ${index <= currentStepIndex ? "active" : ""}
      ">

        <div class="timeline-dot"></div>

        <div>

          <div class="timeline-title">
            ${step}
          </div>

          ${
            index === currentStepIndex
            ? `
              <div class="timeline-live">
                LIVE
              </div>
            `
            : ""
          }

        </div>

      </div>

    `).join("")
  }

</div>

`;

    ordersContainer.innerHTML += `

    <div class="order-track-card">

      <!-- HEADER -->

      <div class="order-header">

        <div>

          <div class="order-id">
            #${order.id}
          </div>

          <div class="order-date">

            ${
              order.createdAt
              ? new Date(
                  order.createdAt.seconds * 1000
                ).toLocaleString()
              : ""
            }

          </div>

        </div>

        <div class="
order-status

${
order.status === "Delivered"
? "status-delivered"

: order.status === "Rejected"
? "status-rejected"

: order.status === "Pending"
? "status-pending"

: "status-live"
}
">

  ${order.status || "Pending"}

</div>

      </div>

      <!-- ITEMS -->

      <div class="order-items">

        ${
          (order.items || [])
          .map(item=>`

            <div class="order-item">

              <span>
                ${item.name}
                × ${item.qty}
              </span>

              <strong>
                ${formatCurrency(item.price)}
              </strong>

            </div>

          `).join("")
        }

      </div>

      <!-- PRICE -->

      <div class="price-summary">

        <div class="summary-card">

          <p>Total</p>

          <h3>
            ${formatCurrency(order.totalAmount || 0)}
          </h3>

        </div>

        <div class="summary-card">

          <p>Payment</p>

          <h3>
            ${order.paymentMethod || "COD"}
          </h3>

        </div>
        <div class="summary-card">
          <p>Invoice</p>
          <h3>${escapeHTML(order.invoiceNumber || "Ready")}</h3>
        </div>

      </div>
      <button type="button" class="invoice-download-btn" onclick="downloadInvoicePDF('${order.id}')">⬇ Download Invoice PDF</button>

      ${timelineHTML}

      ${cancelHTML}

      ${paymentHTML}

      ${
        (order.riderName || order.assignedRider?.name || order.riderLocation)
        ? `

        <div class="rider-box">

          <h4>
            🚚 Delivery Partner
          </h4>

          <p>
            ${order.riderName || order.assignedRider?.name || "Delivery partner"}
          </p>

          <p>
            📞 ${order.riderPhone || order.assignedRider?.phone || ""}
          </p>

          <p>
            ${order.riderStatus || ""}
          </p>

          ${riderLiveMapHTML}

        </div>

        `
        : ""
      }

    </div>

    `;

  });
  hydrateDeliveryAuthorizationCodes(filtered);
  startCountdownTicker();

}

function buildRiderLiveMapHTML(order){
  const location = order.riderLocation || {};
  const riderLat = Number(location.lat);
  const riderLng = Number(location.lng);
  const customerLat = Number(order.location?.lat || order.customerLocation?.lat);
  const customerLng = Number(order.location?.lng || order.customerLocation?.lng);
  const liveStatus = ["Out For Delivery","Reached Nearby","Collect Payment","Cash Collected","Payment Settled","Delivery Code Pending","Payment Completed"].includes(normalizeTimelineStatus(order.status));
  if(!liveStatus) return "";
  if(!Number.isFinite(riderLat) || !Number.isFinite(riderLng)){
    return `
      <div class="rider-live-map rider-live-map-pending">
        <div class="rider-live-map-head">
          <strong>Live rider map</strong>
          <span>Waiting for rider GPS</span>
        </div>
        <p>Rider location will appear here once the rider allows location and the dashboard sends the first update.</p>
      </div>
    `;
  }
  const markerQuery = Number.isFinite(customerLat) && Number.isFinite(customerLng)
    ? `marker=${customerLat},${customerLng}&marker=${riderLat},${riderLng}`
    : `marker=${riderLat},${riderLng}`;
  const south = Number.isFinite(customerLat) ? Math.min(customerLat, riderLat) - .012 : riderLat - .018;
  const north = Number.isFinite(customerLat) ? Math.max(customerLat, riderLat) + .012 : riderLat + .018;
  const west = Number.isFinite(customerLng) ? Math.min(customerLng, riderLng) - .012 : riderLng - .018;
  const east = Number.isFinite(customerLng) ? Math.max(customerLng, riderLng) + .012 : riderLng + .018;
  const updatedAt = location.updatedAt ? new Date(location.updatedAt).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }) : "Live";
  return `
    <div class="rider-live-map">
      <div class="rider-live-map-head">
        <strong>Live rider map</strong>
        <span>Updated ${escapeHTML(updatedAt)}</span>
      </div>
      <iframe
        title="Live rider location map"
        loading="lazy"
        referrerpolicy="no-referrer-when-downgrade"
        src="https://www.openstreetmap.org/export/embed.html?bbox=${west},${south},${east},${north}&layer=mapnik&${markerQuery}">
      </iframe>
      <a href="https://www.openstreetmap.org/?mlat=${riderLat}&mlon=${riderLng}#map=16/${riderLat}/${riderLng}" target="_blank" rel="noopener">Open full map</a>
    </div>
  `;
}

function normalizeTimelineStatus(status){
  if(status === "Assigned To Delivery Boy") return "Rider Accepted";
  if(status === "Ready") return "Preparing";
  if(status === "Searching Rider") return "Searching For Rider";
  if(status === "Rider Accepted") return "Rider Assigned";
  if(status === "Collect Payment" || status === "Reached Nearby") return "Nearby";
  if(status === "Cash Collected") return "Cash Collected";
  if(status === "Payment Settled") return "Payment Settled";
  if(status === "Delivery Code Pending") return "Delivery Code Pending";
  if(status === "Paid" || status === "Payment Received") return "Payment Completed";
  return status || "Pending";
}

function buildCancelWindowHTML(order){
  if(order.status !== "Pending") return "";
  const endsAt = timestampToMillis(order.cancelWindowEndsAt);
  const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  const pct = Math.max(0, Math.min(100, (remaining / CANCEL_WINDOW_SECONDS) * 100));
  const disabled = remaining <= 0;
  return `
    <div class="cancel-timer-card" data-cancel-order="${order.id}" data-ends-at="${endsAt}">
      <div class="timer-ring" style="--progress:${pct}">
        <span>${String(Math.floor(remaining / 60)).padStart(2,"0")}:${String(remaining % 60).padStart(2,"0")}</span>
      </div>
      <div>
        <h4>${disabled ? "Order confirmation in progress" : "Confirming your order..."}</h4>
        <p>${disabled ? "The quick cancel window has closed." : `Restaurant will confirm your order in ${String(Math.floor(remaining / 60)).padStart(2,"0")}:${String(remaining % 60).padStart(2,"0")}`}</p>
        <button type="button" class="cancel-order-btn" ${disabled ? "disabled" : ""} onclick="cancelPendingOrder('${order.id}')">Cancel Order</button>
      </div>
    </div>
  `;
}

function buildPaymentTrackingHTML(order){
  if(!["Out For Delivery","Reached Nearby","Collect Payment","Cash Collected","Payment Settled","Payment Completed","Delivery Code Pending","Delivered"].includes(order.status)) return "";
  const paymentStatus = String(order.paymentStatus || "").toLowerCase();
  const paymentMethod = String(order.paymentMethod || order.paymentMode || "").toLowerCase();
  const paid = paymentStatus === "paid" || paymentStatus === "collected" || order.paymentCaptured === true || !!order.razorpayPaymentId;
  const methodLabel = paymentMethod === "online" || paymentMethod === "upi" ? "Online" : paymentMethod === "cod" || paymentMethod === "cash" ? "COD" : (order.paymentMethod || "CASH/UPI");
  const codeExpiresAt = timestampToMillis(order.deliveryAuthorizationCodeExpiresAt);
  const showDeliveryCode = (order.status === "Delivery Code Pending" || order.deliveryOtpStatus === "active") && (!codeExpiresAt || Date.now() < codeExpiresAt);
  const prepaidOtpPending = paid
    && (paymentMethod === "online" || paymentMethod === "upi")
    && ["Out For Delivery","Reached Nearby"].includes(order.status)
    && order.deliveryOtpStatus !== "verified"
    && !showDeliveryCode;
  const codeHelp = paymentMethod === "online" || paymentMethod === "upi"
    ? "Share this OTP only with the rider after you receive your order."
    : "Share this code only after receiving your order.";
  return `
    <div class="payment-tracking-card">
      <span class="${paid ? "paid" : "pending"}">${paid ? "Payment Received" : "Payment Pending"}</span>
      <strong>${methodLabel}</strong>
      <p>Status: ${paid ? "paid" : (order.paymentStatus || "pending")}</p>
      ${showDeliveryCode ? `<p><strong>Delivery OTP: <span data-delivery-code-order="${escapeHTML(order.id)}">Loading</span></strong></p><p>${codeHelp}</p>` : ""}
      ${prepaidOtpPending ? `<p><strong>Delivery OTP: generating...</strong></p><p>${codeHelp}</p>` : ""}
    </div>
  `;
}

async function hydrateDeliveryAuthorizationCodes(orders = []){
  const pending = orders.filter(order => order.status === "Delivery Code Pending" || order.deliveryOtpStatus === "active");
  await Promise.all(pending.map(async order => {
    const target = document.querySelector(`[data-delivery-code-order="${CSS.escape(order.id)}"]`);
    if(!target) return;
    try{
      const snap = await getDoc(doc(db, "customerDeliveryCodes", order.id));
      const data = snap.exists() ? snap.data() : {};
      const expiresAt = timestampToMillis(data.expiresAt);
      if(data.used){
        target.textContent = "Used";
      }else if(expiresAt && Date.now() > expiresAt){
        target.textContent = "Expired";
      }else{
        target.textContent = data.code || "Pending";
      }
    }catch(error){
      target.textContent = "Unavailable";
    }
  }));
}

function invoiceRows(order = {}){
  const subtotal = Number(order.subtotalAmount || order.subtotal || (order.items || []).reduce((sum, item) => sum + Number(item.price || 0), 0));
  const basePricing = {
    subtotal,
    couponDiscount:Number(order.couponDiscount || 0),
    freeDeliveryDiscount:Number(order.freeDeliveryDiscount || 0),
    deliveryCharge:Number(order.deliveryCharge || 0)
  };
  const calculated = calculateInvoicePricing(subtotal, basePricing);
  return {
    invoiceNumber:order.invoiceNumber || buildInvoiceNumber(order.orderId || order.id || ""),
    subtotal,
    gstPercent:Number(order.gstPercent ?? calculated.gstPercent) || 0,
    gstAmount:Number(order.gstAmount ?? calculated.gstAmount) || 0,
    handlingCharge:Number(order.handlingCharge ?? calculated.handlingCharge) || 0,
    deliveryCharge:Number(order.deliveryCharge ?? calculated.deliveryCharge) || 0,
    discount:Number(order.couponDiscount ?? calculated.couponDiscount) || 0,
    grandTotal:Number(order.grandTotal || order.finalAmount || order.totalAmount || calculated.grandTotal) || 0
  };
}

window.downloadInvoicePDF = async function(orderId){
  const localOrder = liveOrders.find(order => order.id === orderId);
  let order = localOrder;
  if(!order){
    const snap = await getDoc(doc(db, "orders", orderId));
    if(!snap.exists()) return;
    order = { id:snap.id, ...snap.data() };
  }
  const invoice = invoiceRows(order);
  const jsPDF = window.jspdf?.jsPDF;
  if(!jsPDF){
    alert("Invoice PDF tool is still loading. Please try again in a moment.");
    return;
  }
  if(!window.html2canvas){
    alert("Invoice PDF renderer is still loading. Please try again in a moment.");
    return;
  }
  const money = value => `Rs. ${Math.round(Number(value) || 0).toLocaleString("en-IN")}`;
  const rows = (order.items || []).map(item => {
    const qty = Number(item.qty || 1);
    const total = Number(item.price || 0);
    const unit = qty ? total / qty : total;
    const size = item.size ? `<div class="muted">Size: ${escapeHTML(item.size)}</div>` : "";
    const combo = item.comboName ? `<div class="muted">Combo: ${escapeHTML(item.comboName)}</div>` : "";
    const itemName = cleanInvoiceItemName(item.name || "Item");
    return `<tr>
      <td><strong>${escapeHTML(itemName)}</strong>${size}${combo}</td>
      <td>${qty}</td>
      <td>${money(unit)}</td>
      <td>${money(total)}</td>
    </tr>`;
  }).join("");
  const summary = [
    ["Subtotal", invoice.subtotal],
    [`GST (${invoice.gstPercent}%)`, invoice.gstAmount],
    ["Handling Charges", invoice.handlingCharge],
    ["Delivery Charges", invoice.deliveryCharge],
    ["Discount", -invoice.discount],
    ["Grand Total", invoice.grandTotal]
  ].map(([label, value], index, all) => `<div class="${index === all.length - 1 ? "grand" : ""}"><span>${escapeHTML(label)}</span><b>${money(value)}</b></div>`).join("");
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.innerHTML = `
    <section style="width:794px;min-height:1123px;padding:42px;background:#fff;color:#111;font-family:Arial,'Noto Color Emoji','Segoe UI Emoji','Nirmala UI',sans-serif;">
      <style>
        .invoice-head{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #111;padding-bottom:18px}
        .brand{font-size:30px;font-weight:900;letter-spacing:0}
        .muted{color:#555;font-size:12px;margin-top:3px}
        .block{margin-top:22px}
        table{width:100%;border-collapse:collapse;margin-top:14px;font-size:14px}
        th,td{padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}
        th:nth-child(n+2),td:nth-child(n+2){text-align:right;white-space:nowrap}
        .summary{width:330px;margin-left:auto;margin-top:18px}
        .summary div{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #eee}
        .summary .grand{font-size:18px;border-bottom:0;border-top:2px solid #111;margin-top:6px;padding-top:12px}
        .thanks{position:absolute;left:42px;right:42px;bottom:32px;text-align:center;color:#555}
      </style>
      <div class="invoice-head">
        <div><div class="brand">MAGNEETOZ</div><div class="muted">Taste of Attraction</div></div>
        <div>
          <strong>Invoice: ${escapeHTML(invoice.invoiceNumber)}</strong><br>
          <span class="muted">Order: ${escapeHTML(order.orderNumber || order.id || "")}</span><br>
          <span class="muted">Date: ${escapeHTML(new Date(timestampToMillis(order.createdAt) || Date.now()).toLocaleString())}</span>
        </div>
      </div>
      <div class="block">
        <strong>Customer Details</strong>
        <div>${escapeHTML(order.customerName || "Customer")} | ${escapeHTML(order.phone || "")}</div>
        <div class="muted">${escapeHTML(order.address || "")}</div>
      </div>
      <div class="block">
        <strong>Items</strong>
        <table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
      <div class="summary">${summary}</div>
      <div class="thanks">Thank you for ordering from MAGNEETOZ</div>
    </section>`;
  document.body.appendChild(host);
  const pdf = new jsPDF({ unit:"pt", format:"a4" });
  await pdf.html(host.firstElementChild, {
    x: 0,
    y: 0,
    html2canvas: { scale: 0.75, useCORS: true, backgroundColor: "#ffffff" },
    callback: doc => {
      doc.save(`${invoice.invoiceNumber}.pdf`);
      host.remove();
    }
  });
};

function startCountdownTicker(){
  if(!document.querySelector("[data-cancel-order]")) return;
  countdownInterval = setInterval(() => {
    document.querySelectorAll("[data-cancel-order]").forEach(card => {
      const endsAt = Number(card.dataset.endsAt || 0);
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      const pct = Math.max(0, Math.min(100, (remaining / CANCEL_WINDOW_SECONDS) * 100));
      const time = `${String(Math.floor(remaining / 60)).padStart(2,"0")}:${String(remaining % 60).padStart(2,"0")}`;
      card.querySelector(".timer-ring")?.style.setProperty("--progress", pct);
      const ringText = card.querySelector(".timer-ring span");
      if(ringText) ringText.textContent = time;
      const title = card.querySelector("h4");
      const copy = card.querySelector("p");
      const button = card.querySelector("button");
      if(remaining <= 0){
        if(title) title.textContent = "Order confirmation in progress";
        if(copy) copy.textContent = "The quick cancel window has closed.";
        if(button) button.disabled = true;
      }else if(copy){
        copy.textContent = `Restaurant will confirm your order in ${time}`;
      }
    });
  }, 1000);
}

function ensureFeedbackPopup(){
  let popup = document.getElementById("deliveryFeedbackPopup");
  if(popup) return popup;
  const starGroup = (key, label, required = false) => `
    <div class="feedback-rating-row">
      <span>${label}${required ? " *" : ""}</span>
      <div class="feedback-stars" data-feedback-stars="${key}" aria-label="${label} rating">
        ${[1,2,3,4,5].map(i => `<button type="button" data-rating="${i}" aria-label="${i} star">★</button>`).join("")}
      </div>
    </div>`;
  popup = document.createElement("div");
  popup.id = "deliveryFeedbackPopup";
  popup.className = "delivery-feedback-popup";
  popup.innerHTML = `
    <div class="delivery-feedback-card" role="dialog" aria-modal="true" aria-labelledby="deliveryFeedbackTitle">
      <button type="button" class="feedback-close" aria-label="Close">x</button>
      <h2 id="deliveryFeedbackTitle">How was your MAGNEETOZ order?</h2>
      <p class="feedback-step-label">Step 1 - Overall Rating</p>
      <div class="feedback-stars feedback-overall-stars" data-feedback-stars="overall" aria-label="Overall rating">
        ${[1,2,3,4,5].map(i => `<button type="button" data-rating="${i}" aria-label="${i} star">★</button>`).join("")}
      </div>
      <p class="feedback-step-label">Step 2 - Optional details</p>
      <div class="feedback-detail-list">
        ${starGroup("foodQuality", "🍕 Food Quality", true)}
        ${starGroup("taste", "😋 Taste")}
        ${starGroup("freshness", "🔥 Freshness")}
        ${starGroup("delivery", "🚚 Delivery Speed")}
        ${starGroup("service", "🤝 Service")}
        ${starGroup("valueForMoney", "💰 Value for Money")}
      </div>
      <div class="feedback-chips" aria-label="Quick feedback">
        ${["Great Taste","Fast Delivery","Good Service","Fresh Food","Value For Money"].map(label => `<button type="button" data-feedback-chip="${label}">${label}</button>`).join("")}
      </div>
      <textarea id="deliveryFeedbackText" placeholder="Optional comment" rows="3"></textarea>
      <button type="button" class="feedback-submit">Submit Feedback</button>
    </div>`;
  document.body.appendChild(popup);
  popup.querySelector(".feedback-close").addEventListener("click", () => popup.classList.remove("show"));
  popup.addEventListener("click", event => {
    if(event.target === popup) popup.classList.remove("show");
  });
  popup.querySelectorAll("[data-feedback-stars]").forEach(group => {
    group.dataset.value = "0";
    group.querySelectorAll("[data-rating]").forEach(button => {
      button.addEventListener("mouseenter", () => paintFeedbackStars(group, Number(button.dataset.rating), "preview"));
      button.addEventListener("focus", () => paintFeedbackStars(group, Number(button.dataset.rating), "preview"));
      button.addEventListener("click", () => {
        group.dataset.value = button.dataset.rating;
        paintFeedbackStars(group, Number(button.dataset.rating));
      });
    });
    group.addEventListener("mouseleave", () => paintFeedbackStars(group, Number(group.dataset.value || 0)));
    group.addEventListener("focusout", () => paintFeedbackStars(group, Number(group.dataset.value || 0)));
  });
  popup.querySelectorAll("[data-feedback-chip]").forEach(chip => {
    chip.addEventListener("click", () => {
      chip.classList.toggle("active");
      chip.setAttribute("aria-pressed", chip.classList.contains("active") ? "true" : "false");
    });
  });
  return popup;
}

function paintFeedbackStars(group, value, mode = "selected"){
  group.querySelectorAll("[data-rating]").forEach(star => {
    const active = Number(star.dataset.rating) <= value;
    star.classList.toggle("active", active && mode === "selected");
    star.classList.toggle("preview", active && mode === "preview");
  });
}

function feedbackStarValue(popup, key){
  return Number(popup.querySelector(`[data-feedback-stars="${key}"]`)?.dataset.value || 0);
}

function resetFeedbackStarValue(popup, key){
  const group = popup.querySelector(`[data-feedback-stars="${key}"]`);
  if(!group) return;
  group.dataset.value = "0";
  paintFeedbackStars(group, 0);
}

function markFeedbackPrompted(orderId){
  feedbackPromptedOrders.add(orderId);
  localStorage.setItem("magneetozFeedbackPromptedOrders", JSON.stringify([...feedbackPromptedOrders].slice(-60)));
}

function feedbackLocalAnalysis({ rating, message }){
  const text = String(message || "").toLowerCase();
  const negativeTerms = ["refund","late delivery","late","bad food","poor service","cold","wrong","missing","angry","frustrated"];
  const positiveTerms = ["happy","good","great","best","excellent","tasty","fresh","satisfied","excited"];
  const negativeHit = negativeTerms.find(term => text.includes(term));
  const positiveHit = positiveTerms.find(term => text.includes(term));
  const sentiment = rating <= 2 || negativeHit ? "negative" : rating >= 4 || positiveHit ? "positive" : "neutral";
  return {
    sentiment,
    sentimentScore:sentiment === "positive" ? 0.75 : sentiment === "negative" ? -0.75 : 0,
    emotion:sentiment === "positive" ? "Satisfied" : sentiment === "negative" ? "Frustrated" : "Neutral",
    highPriority:rating <= 2 || !!negativeHit,
    complaintType:negativeHit || "",
    recommendedAction:rating <= 2 || negativeHit ? "Contact customer and resolve quickly." : "Thank customer and send loyalty offer."
  };
}

async function analyzeFeedbackWithAI(feedbackId, payload){
  try{
    const response = await fetch("https://asia-south1-magneetoz.cloudfunctions.net/analyzeFeedbackAI", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ ...payload, feedbackId })
    });
    const data = await response.json().catch(() => ({}));
    return data.analysis || null;
  }catch(error){
    console.warn("Feedback AI unavailable:", error);
    return null;
  }
}

function showDeliveryFeedbackPopup(order){
  const popup = ensureFeedbackPopup();
  popup.dataset.orderId = order.id;
  ["overall","foodQuality","taste","freshness","delivery","service","valueForMoney"].forEach(key => resetFeedbackStarValue(popup, key));
  const text = popup.querySelector("#deliveryFeedbackText");
  if(text) text.value = "";
  popup.querySelectorAll("[data-feedback-chip]").forEach(chip => {
    chip.classList.remove("active");
    chip.setAttribute("aria-pressed", "false");
  });
  popup.querySelector(".feedback-submit").onclick = async () => {
    const rating = feedbackStarValue(popup, "overall");
    const comment = normalizeUnicodeText(popup.querySelector("#deliveryFeedbackText")?.value || "");
    const foodQuality = feedbackStarValue(popup, "foodQuality");
    if(rating < 1 || rating > 5){
      toastError("Please select overall rating.");
      return;
    }
    if(foodQuality < 1 || foodQuality > 5){
      toastError("Please select food quality rating.");
      return;
    }
    const taste = feedbackStarValue(popup, "taste") || rating;
    const freshness = feedbackStarValue(popup, "freshness") || rating;
    const delivery = feedbackStarValue(popup, "delivery") || rating;
    const service = feedbackStarValue(popup, "service") || rating;
    const valueForMoney = feedbackStarValue(popup, "valueForMoney") || rating;
    const quickFeedback = [...popup.querySelectorAll("[data-feedback-chip].active")].map(chip => chip.dataset.feedbackChip);
    const localAi = feedbackLocalAnalysis({ rating, message:comment });
    try{
      const feedbackRef = await addDoc(collection(db, "feedback"), {
        orderId:order.id,
        orderNumber:order.orderNumber || "",
        userId:auth.currentUser?.uid || order.userId || "",
        customerName:order.customerName || "",
        phone:order.phone || "",
        rating,
        foodQuality,
        foodRating:foodQuality,
        taste,
        freshness,
        delivery,
        deliveryRating:delivery,
        service,
        serviceRating:service,
        valueForMoney,
        quickFeedback,
        feedbackTags:quickFeedback,
        comment,
        message:comment,
        sentiment:localAi.sentiment,
        sentimentScore:localAi.sentimentScore,
        emotion:localAi.emotion,
        highPriority:localAi.highPriority,
        ai:localAi,
        source:"delivered_order_popup",
        feedbackType:"order_feedback",
        publicReviewOptIn:false,
        reviewStatus:"private",
        createdAt:serverTimestamp()
      });
      analyzeFeedbackWithAI(feedbackRef.id, {
        message:comment,
        rating,
        foodQuality,
        taste,
        freshness,
        delivery,
        service,
        valueForMoney,
        quickFeedback
      });
      await updateDoc(doc(db, "orders", order.id), {
        feedbackSubmitted:true,
        feedbackRating:rating,
        feedbackAt:serverTimestamp()
      }).catch(() => {});
      markFeedbackPrompted(order.id);
      popup.classList.remove("show");
      toastSuccess("Thank you for your feedback.");
    }catch(error){
      console.warn("Feedback save failed:", error);
      toastError("Unable to save feedback right now.");
    }
  };
  markFeedbackPrompted(order.id);
  popup.classList.add("show");
}

window.cancelPendingOrder = async function(orderId){
  try{
    await runTransaction(db, async transaction => {
      const orderRef = doc(db, "orders", orderId);
      const snap = await transaction.get(orderRef);
      if(!snap.exists()) throw new Error("Order not found.");
      const order = snap.data();
      if(order.status !== "Pending") throw new Error("This order is already being processed.");
      if(Date.now() >= timestampToMillis(order.cancelWindowEndsAt)) throw new Error("The cancellation window has closed.");
      transaction.update(orderRef, {
        status:"Cancelled",
        cancelledBy:"customer",
        cancelledAt:serverTimestamp(),
        riderStatus:"Cancelled by customer"
      });
    });
  }catch(error){
    alert(error.message || "Unable to cancel this order now.");
  }
};

/* Theme mode is controlled only from Theme Studio admin. */



window.toggleLocation = toggleLocation;

/* ================= EXPORT ================= */

window.addToCartFull = addToCartFull;
window.addToCartSimple = addToCartSimple;
window.changeQty = changeQty;
window.updatePrice = updatePrice;
window.removeItem = removeItem;
window.changeCartItemQty = changeCartItemQty;
window.toggleCart = toggleCart;
window.placeOrder = placeOrder;
window.codOrder = codOrder;
window.upiOrder = upiOrder;
window.closePaymentPopup = closePaymentPopup;
window.closeServicePopup = closeServicePopup;
window.trackOrderByPhone = trackOrderByPhone;
window.closeOrderPopup = closeOrderPopup;
window.closeMinOrderPopup = closeMinOrderPopup;

/* ================= AI UX GUARDS + MOTION ================= */

function installAIUXPolish(){
  document.body.classList.add("ai-ux-ready");

  document.addEventListener("click", (event) => {
    const interactive = event.target.closest("button,a,.cart-wrapper,.new-card");
    if(!interactive) return;
    const ripple = document.createElement("span");
    ripple.className = "ai-click-ripple";
    ripple.style.left = `${event.clientX}px`;
    ripple.style.top = `${event.clientY}px`;
    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 620);
  }, { passive:true });

  const markCards = () => {
    document.querySelectorAll(".new-card:not(.ai-card-enter)").forEach((card, index) => {
      card.classList.add("ai-card-enter");
      card.style.animationDelay = `${Math.min(index * 45, 420)}ms`;
    });
  };

  window.addEventListener("magneetoz:menu-rendered", markCards);
  markCards();

  const originalSimple = window.addToCartSimple;
  const originalFull = window.addToCartFull;
  const originalPlaceOrder = window.placeOrder;
  const originalUPI = window.upiOrder;

  window.addToCartSimple = function(btn, name){
    if(!btn || !btn.closest(".card")){
      alert("This item is not ready yet. Please refresh once.");
      return;
    }
    btn.classList.add("ai-loading");
    try{
      return originalSimple(btn, name);
    }finally{
      setTimeout(() => btn.classList.remove("ai-loading"), 520);
    }
  };

  window.addToCartFull = function(btn, name){
    if(!btn || !btn.closest(".card")){
      alert("This item is not ready yet. Please refresh once.");
      return;
    }
    btn.classList.add("ai-loading");
    try{
      return originalFull(btn, name);
    }finally{
      setTimeout(() => btn.classList.remove("ai-loading"), 520);
    }
  };

  window.placeOrder = async function(){
    const placeBtn = document.querySelector('[aria-label="Place order"]');
    placeBtn?.classList.add("ai-loading");
    try{
      return await originalPlaceOrder();
    }finally{
      setTimeout(() => placeBtn?.classList.remove("ai-loading"), 520);
    }
  };

  window.upiOrder = async function(){
    const upiBtn = document.getElementById("upiBtn");
    upiBtn?.classList.add("ai-loading");
    try{
      return await originalUPI();
    }finally{
      setTimeout(() => upiBtn?.classList.remove("ai-loading"), 520);
    }
  };
}

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", installAIUXPolish, { once:true });
}else{
  installAIUXPolish();
}
