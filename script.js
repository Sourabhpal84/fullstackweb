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
import { getIdToken, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
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
let checkoutLocationChoiceVersion = 0;
let deliveryDistanceUpdatedAt = 0;
let deliveryDistanceSignature = "";
let orderPerfDepth = 0;
let appPricing = {
  gstPercent:0,
  handlingCharge:0
};
let deliveryPricingSettings = {
  freeDeliveryEnabled:true,
  minimumOrderValue:0,
  flatDeliveryFee:30,
  maxDeliveryDistanceKm:6,
  whatsappNumber:"918303614331",
  zones:[
    { maxKm:1, threshold:149, fee:30 },
    { maxKm:2, threshold:199, fee:30 },
    { maxKm:3, threshold:249, fee:30 },
    { maxKm:4, threshold:299, fee:30 },
    { maxKm:5, threshold:349, fee:30 },
    { maxKm:6, threshold:399, fee:40 }
  ]
};
const DELIVERY_RULE_VERSION = "zone-fee-base-threshold-v3";
const AUTH_NULL_GRACE_MS = 10000;
let isOrderProcessing = false;
let lastOrderSignature = null;
let razorpayInFlight = false;
let activeCoupon = null;
let availableCoupons = [];
let activeBogoOffer = null;
let activeBogoOffers = [];
let bogoOfferAccepted = false;
let bogoOfferSignature = "";
let liveOfferCache = [];
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
const FIRST_ORDER_GUIDE_KEY = "magneetozFirstOrderGuideSeen";
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
const EXTRA_TOPPINGS = Object.freeze([
  { id:"extra_tomato", name:"Extra Tomato", price:20 },
  { id:"extra_onion", name:"Extra Onion", price:20 },
  { id:"extra_capsicum", name:"Extra Capsicum", price:20 },
  { id:"extra_sweet_corn", name:"Extra Sweet Corn", price:20 },
  { id:"extra_jalapeno", name:"Extra Jalapeno", price:20 },
  { id:"extra_black_olives", name:"Extra Black Olives", price:20 },
  { id:"extra_cheese", name:"Extra Cheese", price:40 }
]);
const CRUST_OPTIONS = Object.freeze([
  { id:"thin", label:"Thin Crust", description:"Crispy & Crunchy" },
  { id:"pan", label:"Pan Crust", description:"Soft & Fluffy" }
]);
const DEFAULT_CRUST_ID = "pan";
let resumeCheckoutAfterAuth = false;
let checkoutInFlightId = "";
let placeOrderInFlight = false;
let walletPointsAvailable = 0;
let walletPointsRequested = 0;
const WALLET_MAX_REDEEM_PERCENT = 10;
const WALLET_MAX_REDEEM_POINTS = 30;
const WALLET_MIN_REDEEM_ORDER = 199;
let guestCartAuthPrompted = false;
let orderTrackingUnsub = null;
let orderTrackingUserId = "";
let phoneTrackingUnsub = null;
let authSignOutClearTimer = null;
let authCacheNullTimer = null;
let orderTrackingPausedForAuthRefresh = false;
let menuDishesUnsub = null;
let allMenuDishes = [];
let menuImageByDishName = new Map();
let menuImageByCategoryName = new Map();
let smartAssistantIntent = "popular";
let heroSliderTimer = null;
let heroSliderIndex = 0;
let heroSwipeStartX = 0;
let heroSwipeStartY = 0;
let heroSwipeMoved = false;
let heroSwipeTracking = false;
let heroSwipeCapturedAt = 0;
let heroSlideOffers = [];

function renderHeroSliderDots(count = 0){
  const hero = document.getElementById("homeHero");
  if(!hero) return;
  let dots = document.getElementById("heroSliderDots");
  if(count <= 1){
    dots?.remove();
    return;
  }
  if(!dots){
    dots = document.createElement("div");
    dots.id = "heroSliderDots";
    dots.className = "hero-slider-dots";
    dots.setAttribute("aria-label", "Hero image slides");
    hero.appendChild(dots);
  }
  dots.innerHTML = Array.from({ length:count }, (_, index) => (
    `<button type="button" class="hero-slider-dot" aria-label="Show hero image ${index + 1}" data-hero-dot="${index}"></button>`
  )).join("");
  dots.querySelectorAll("button").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      setHeroSliderIndex(Number(button.dataset.heroDot || 0));
      startHeroSliderAuto(count);
    });
  });
}

function resetRazorpayCheckoutState({ clearCheckoutId = true } = {}){
  isOrderProcessing = false;
  razorpayInFlight = false;
  lastOrderSignature = null;
  if(clearCheckoutId) checkoutInFlightId = "";
}

function cancelRazorpayCheckout(){
  clearRazorpayPaymentRecovery();
  resetRazorpayCheckoutState();
  setCheckoutLoading(false);
}

function hasVisibleRazorpayCheckout(){
  return [...document.querySelectorAll(".razorpay-container, iframe[src*='razorpay'], iframe[name*='razorpay']")]
    .some(node => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
}

function isMobilePaymentDevice(){
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")
    || (window.matchMedia?.("(max-width: 768px)")?.matches === true);
}

function renderHeroPizzaSlider(images = [], imageSets = [], heroImages = []){
  const slider = document.getElementById("heroPizzaSlider");
  const bgSlider = document.getElementById("heroBgSlider");
  const managed = Array.isArray(heroImages) ? heroImages
    .filter(item => item && item.active !== false)
    .sort((a,b) => Number(a.order || 0) - Number(b.order || 0))
    .map(item => ({
      url:normalizeImageUrl(item.url || item.mobileUrl || item.desktopUrl),
      mobileUrl:normalizeImageUrl(item.mobileUrl || item.url),
      desktopUrl:normalizeImageUrl(item.desktopUrl || item.url),
      imageSet:{ url:item.url, variants:item.variants || {} }
    })) : [];
  const legacy = images
    .map((image, index) => ({
      url:normalizeImageUrl(image),
      mobileUrl:normalizeImageUrl(imageSets[index]?.variants?.mobile?.url || image),
      desktopUrl:normalizeImageUrl(imageSets[index]?.variants?.desktop?.url || image),
      imageSet:imageSets[index] || null
    }));
  const cleanImages = (managed.length ? managed : legacy)
    .filter(item => item.url)
    .slice(0, 12);
  const slides = cleanImages.length ? cleanImages : [{ url:"logo_tran.jpeg", imageSet:null }];
  const markup = slides.map((slide, index) => {
    const srcset = buildImageSrcset(slide.imageSet);
    const srcsetAttr = srcset ? `srcset="${escapeHTML(srcset)}" sizes="(max-width: 720px) 42vw, 420px"` : "";
    return `
    <img
      src="${escapeHTML(slide.mobileUrl || bestImageUrl(slide.url, slide.imageSet))}"
      ${srcsetAttr}
      alt="MAGNEETOZ pizza slide ${index + 1}"
      width="1080"
      height="1920"
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
      const srcsetAttr = srcset ? `srcset="${escapeHTML(srcset)}" sizes="(max-width: 720px) 100vw, 100vw"` : "";
      return `
      <img
        src="${escapeHTML(slide.desktopUrl || bestImageUrl(slide.url, slide.imageSet))}"
        ${srcsetAttr}
        alt=""
        width="1920"
        height="1080"
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
  setupHeroSwipeSlider(slides.length);
}

function comboHeroImage(combo = {}){
  return normalizeImageUrl(
    combo.heroImage ||
    combo.bannerImage ||
    combo.mobileHeroImage ||
    combo.desktopHeroImage ||
    combo.image ||
    "logo_tran.jpeg"
  );
}

function renderComboHeroSlides(combos = []){
  const slides = combos
    .filter(combo => combo && combo.active !== false && comboHeroImage(combo))
    .map(combo => ({
      id:combo.id,
      name:combo.name || "MAGNEETOZ Combo",
      badge:combo.badge || "Combo Offer",
      description:combo.description || combo.itemsIncluded || "Limited-time MAGNEETOZ combo deal",
      comboPrice:Number(combo.comboPrice || 0),
      originalPrice:Number(combo.originalPrice || combo.comboPrice || 0),
      url:comboHeroImage(combo),
      mobileUrl:normalizeImageUrl(combo.mobileHeroImage || combo.mobileImage || comboHeroImage(combo)),
      desktopUrl:normalizeImageUrl(combo.desktopHeroImage || combo.desktopImage || comboHeroImage(combo)),
      variants:combo.heroImageSet?.variants || combo.imageSet?.variants || {},
      order:Number(combo.displayOrder ?? combo.order ?? 999)
    }))
    .sort((a, b) => a.order - b.order)
    .slice(0, 8);
  if(!slides.length) return;
  heroSlideOffers = slides;
  renderHeroPizzaSlider([], [], slides.map((slide, index) => ({
    active:true,
    order:index,
    url:slide.url,
    mobileUrl:slide.mobileUrl,
    desktopUrl:slide.desktopUrl,
    variants:slide.variants
  })));
  syncHeroOfferCopy();
}

function currentHeroOffer(){
  if(!heroSlideOffers.length) return null;
  return heroSlideOffers[heroSliderIndex] || heroSlideOffers[0] || null;
}

function selectorEscape(value = ""){
  if(window.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

function syncHeroOfferCopy(){
  const primary = document.getElementById("heroPrimaryBtnText");
  const hero = document.getElementById("homeHero");
  const kicker = document.getElementById("heroKickerText");
  const title = document.getElementById("heroTitleText");
  const subtitle = document.getElementById("heroSubtitleText");
  const offer = currentHeroOffer();
  if(primary){
    primary.textContent = offer ? "Order Now" : (primary.textContent || "Order Now");
    primary.setAttribute("href", offer ? "#combosSection" : "#menuSection");
    primary.dataset.heroComboId = offer?.id || "";
    primary.setAttribute("aria-label", offer ? `Order ${offer.name}` : "Order Now");
  }
  if(hero){
    hero.dataset.heroComboId = offer?.id || "";
    hero.setAttribute("aria-label", offer ? `View ${offer.name} combo offer` : "Start your MAGNEETOZ order");
  }
  if(offer){
    const savings = Math.max(0, Number(offer.originalPrice || 0) - Number(offer.comboPrice || 0));
    if(kicker) kicker.textContent = `${offer.badge} • Tap Order Now`;
    if(title) title.textContent = offer.name;
    if(subtitle){
      subtitle.textContent = `${offer.description}${offer.comboPrice ? ` • ${formatCurrency(offer.comboPrice)}` : ""}${savings ? ` • Save ${formatCurrency(savings)}` : ""}`;
    }
  }
}

function focusComboOffer(comboId = ""){
  if(!comboId){
    document.getElementById("combosSection")?.scrollIntoView({ behavior:"smooth", block:"start" });
    return;
  }
  const comboCard = document.querySelector(`[data-combo-id="${selectorEscape(comboId)}"]`);
  const target = comboCard || document.getElementById("combosSection");
  target?.scrollIntoView({ behavior:"smooth", block:"center" });
  comboCard?.classList.add("combo-offer-active");
  setTimeout(() => comboCard?.classList.remove("combo-offer-active"), 1800);
}

function setHeroSliderIndex(index = 0){
  const bgSlides = [...document.querySelectorAll("#heroBgSlider img")];
  const pizzaSlides = [...document.querySelectorAll("#heroPizzaSlider img")];
  const count = Math.max(bgSlides.length, pizzaSlides.length);
  if(!count) return;
  heroSliderIndex = ((index % count) + count) % count;
  [bgSlides, pizzaSlides].forEach(slides => {
    slides.forEach((img, slideIndex) => {
      const active = slideIndex === heroSliderIndex;
      img.classList.toggle("hero-slide-active", active);
      img.setAttribute("data-hero-active", active ? "1" : "0");
      img.style.setProperty("animation", "none", "important");
      img.style.setProperty("opacity", active ? "1" : "0", "important");
      img.style.setProperty("pointer-events", "none", "important");
      img.style.setProperty("transition", "opacity .32s ease, transform .32s ease", "important");
      img.style.setProperty("transform", active
        ? (slides === bgSlides ? "scale(1.03) translateX(0)" : "translateX(0) scale(1) rotate(-4deg)")
        : (slides === bgSlides ? "scale(1.06) translateX(18px)" : "translateX(18px) scale(.96) rotate(-4deg)"),
        "important");
    });
  });
  document.querySelectorAll("#heroSliderDots .hero-slider-dot").forEach((dot, dotIndex) => {
    dot.classList.toggle("active", dotIndex === heroSliderIndex);
    dot.setAttribute("aria-current", dotIndex === heroSliderIndex ? "true" : "false");
  });
  syncHeroOfferCopy();
}

function startHeroSliderAuto(count = 0){
  clearInterval(heroSliderTimer);
  heroSliderTimer = null;
  if(count <= 1) return;
  heroSliderTimer = setInterval(() => setHeroSliderIndex(heroSliderIndex + 1), 4000);
}

function setupHeroSwipeSlider(count = 0){
  const hero = document.getElementById("homeHero");
  if(!hero) return;
  hero.classList.toggle("hero-swipe-enabled", count > 1);
  renderHeroSliderDots(count);
  setHeroSliderIndex(0);
  startHeroSliderAuto(count);
  if(hero.dataset.swipeBound === "1") return;
  hero.dataset.swipeBound = "1";
  const restartAuto = () => startHeroSliderAuto(document.querySelectorAll("#heroBgSlider img").length);
  const slideCount = () => Math.max(
    document.querySelectorAll("#heroBgSlider img").length,
    document.querySelectorAll("#heroPizzaSlider img").length
  );
  const swipeTargets = [
    hero,
    document.getElementById("heroBgSlider"),
    document.getElementById("heroPizzaSlider")
  ].filter(Boolean);
  const markSwipeStart = (clientX, clientY) => {
    heroSwipeStartX = clientX;
    heroSwipeStartY = clientY;
    heroSwipeMoved = false;
  };
  const markSwipeMove = (clientX, clientY) => {
    if(!heroSwipeStartX) return;
    const dx = Math.abs(clientX - heroSwipeStartX);
    const dy = Math.abs(clientY - heroSwipeStartY);
    if(dx > 10 && dx > dy) heroSwipeMoved = true;
  };
  const handleSwipeEnd = (clientX, clientY) => {
    if(!heroSwipeStartX) return;
    const dx = clientX - heroSwipeStartX;
    const dy = clientY - heroSwipeStartY;
    heroSwipeStartX = 0;
    heroSwipeStartY = 0;
    if(Math.abs(dx) < 42 || Math.abs(dx) < Math.abs(dy)) return;
    setHeroSliderIndex(heroSliderIndex + (dx < 0 ? 1 : -1));
    restartAuto();
    heroSwipeCapturedAt = Date.now();
    setTimeout(() => { heroSwipeMoved = false; }, 450);
  };
  swipeTargets.forEach(target => {
    target.addEventListener("pointerdown", event => {
      if(event.pointerType === "mouse" && event.button !== 0) return;
      markSwipeStart(event.clientX, event.clientY);
    }, { passive:true });
    target.addEventListener("pointermove", event => markSwipeMove(event.clientX, event.clientY), { passive:true });
    target.addEventListener("pointerup", event => handleSwipeEnd(event.clientX, event.clientY), { passive:true });
    target.addEventListener("touchstart", event => {
      const touch = event.touches?.[0];
      if(touch) markSwipeStart(touch.clientX, touch.clientY);
    }, { passive:true });
    target.addEventListener("touchmove", event => {
      const touch = event.touches?.[0];
      if(touch) markSwipeMove(touch.clientX, touch.clientY);
    }, { passive:true });
    target.addEventListener("touchend", event => {
      const touch = event.changedTouches?.[0];
      if(touch) handleSwipeEnd(touch.clientX, touch.clientY);
    }, { passive:true });
  });
  hero.addEventListener("click", event => {
    if(!heroSwipeMoved && Date.now() - heroSwipeCapturedAt > 700) return;
    event.preventDefault();
    event.stopPropagation();
    heroSwipeMoved = false;
  }, true);
  if(document.documentElement.dataset.heroDocumentSwipeBound !== "1"){
    document.documentElement.dataset.heroDocumentSwipeBound = "1";
    document.addEventListener("touchstart", event => {
      const target = event.target?.closest?.("#homeHero");
      if(!target) return;
      if(event.target?.closest?.("button,a,select,input,textarea")) return;
      const touch = event.touches?.[0];
      if(!touch) return;
      heroSwipeTracking = true;
      markSwipeStart(touch.clientX, touch.clientY);
    }, { passive:true, capture:true });
    document.addEventListener("touchmove", event => {
      if(!heroSwipeTracking) return;
      const touch = event.touches?.[0];
      if(!touch) return;
      markSwipeMove(touch.clientX, touch.clientY);
      if(heroSwipeMoved && slideCount() > 1){
        event.preventDefault();
      }
    }, { passive:false, capture:true });
    document.addEventListener("touchend", event => {
      if(!heroSwipeTracking) return;
      heroSwipeTracking = false;
      const touch = event.changedTouches?.[0];
      if(!touch) return;
      handleSwipeEnd(touch.clientX, touch.clientY);
    }, { passive:true, capture:true });
    document.addEventListener("click", event => {
      if(Date.now() - heroSwipeCapturedAt > 700) return;
      if(!event.target?.closest?.("#homeHero")) return;
      event.preventDefault();
      event.stopPropagation();
      heroSwipeMoved = false;
    }, true);
  }
}

function applyHeroLayoutSettings(hero = {}){
  const heroSection = document.querySelector(".hero");
  if(!heroSection) return;
  const imageOnly = hero.displayMode === "image_only";
  const containImage = hero.imageFit === "contain";
  heroSection.classList.toggle("hero-image-only", imageOnly);
  heroSection.classList.toggle("hero-image-contain", containImage);
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
    secondaryButton:document.getElementById("heroSecondaryBtnText")?.closest("button"),
    showcase:document.querySelector(".hero-showcase")
  };
  const visibility = hero.visibility || {};
  if(!isManaged){
    Object.values(fieldMap).forEach(el => el?.classList.remove("hero-field-hidden"));
    document.querySelector(".hero-local-line")?.classList.remove("hero-field-hidden");
    heroSection.classList.remove("hero-empty-text");
    return;
  }
  const textValues = Object.entries(fieldMap).map(([key, el]) => {
    const value = String(hero[key] || "").trim();
    const visibleByToggle = key === "primaryButton" || key === "secondaryButton"
      ? visibility.buttons !== false
      : key === "showcase"
        ? visibility.showcase !== false
        : visibility[key] !== false;
    const hidden = key === "showcase" ? !visibleByToggle : (!value || !visibleByToggle);
    el?.classList.toggle("hero-field-hidden", hidden);
    return value;
  });
  const isEmpty = hero.displayMode === "image_only" || textValues.every(value => !value);
  heroSection.classList.toggle("hero-empty-text", isEmpty);
  document.querySelector(".hero-local-line")?.classList.toggle("hero-field-hidden", isEmpty || visibility.subtitle === false);
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
  const mobile = isMobilePaymentDevice();
  const firstVisibleCheck = mobile ? 10 : 3;
  const maxChecks = mobile ? 45 : 12;
  const timer = setInterval(() => {
    checks += 1;
    if(!razorpayInFlight){
      clearInterval(timer);
      return;
    }
    if(!hasVisibleRazorpayCheckout() && checks >= firstVisibleCheck){
      cancelRazorpayCheckout();
      clearInterval(timer);
    }
    if(checks >= maxChecks && razorpayInFlight){
      cancelRazorpayCheckout();
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
  throw new Error("Legacy payment recovery needs backend verification. Please use Check payment status.");
}

async function checkPaymentSessionStatus(paymentSessionId){
  if(!paymentSessionId) throw new Error("Missing payment session.");
  return callPaymentFunction("checkPaymentSessionStatus", { paymentSessionId }, 15000);
}

async function pollPaymentSessionUntilPlaced(paymentSessionId, { timeoutMs = 60000, intervalMs = 3000 } = {}){
  const started = Date.now();
  let lastStatus = null;
  let warnedSlow = false;
  while(Date.now() - started < timeoutMs){
    lastStatus = await checkPaymentSessionStatus(paymentSessionId);
    if(lastStatus?.paid && lastStatus.orderNumber){
      return lastStatus;
    }
    if(!warnedSlow && Date.now() - started > 15000){
      warnedSlow = true;
      setCheckoutLoading(true, "Payment received. Still confirming with Razorpay...");
    }
    await sleep(intervalMs);
  }
  return lastStatus || { paid:false, paymentSessionId };
}

async function recoverPendingPaymentSession(paymentSessionId){
  setCheckoutLoading(true, "Payment received. Confirming your order...");
  const status = await pollPaymentSessionUntilPlaced(paymentSessionId);
  if(status?.paid && status.orderNumber){
    clearRazorpayPaymentRecovery();
    finishSuccessfulCheckout(status.orderNumber);
    return status;
  }
  setCheckoutRetry("Payment received but confirmation is taking longer. Do not pay again. We are checking your order.", async () => {
    await recoverPendingPaymentSession(paymentSessionId);
  });
  return status;
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
      finishSuccessfulCheckout(verifiedOrder.orderNumber);
      return;
    }
    if(recovery?.mode === "payment_session" && recovery.paymentSessionId){
      clearRazorpayPaymentRecovery();
      setCheckoutLoading(false);
      resetRazorpayCheckoutState();
      return;
    }
    if(recovery?.orderId || recovery?.paymentId){
      console.warn("Legacy payment recovery cannot mark order paid from client. Waiting for backend/webhook.", recovery);
    }
  }catch(error){
    console.warn("Payment recovery retry failed", error);
    if(/belongs to another user/i.test(error?.message || "")){
      clearRazorpayPaymentRecovery();
      setCheckoutLoading(false);
    }
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
let homepageSectionsUnsub = null;
let homepageSections = [];
let homepageDisplaySettings = { showBestSellers:true };
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

function comboIsOrderable(combo = {}){
  return combo && combo.active !== false && combo.deleted !== true && combo.stockOut !== true && combo.inStock !== false;
}

registerGlobalSnapshot(onSnapshot(doc(db, "settings", "homepage"), snap => {
  homepageDisplaySettings = snap.exists()
    ? { showBestSellers:snap.data().showBestSellers !== false }
    : { showBestSellers:true };
  renderBestSellers();
}, error => {
  console.warn("Homepage display settings failed:", error);
  homepageDisplaySettings = { showBestSellers:true };
  renderBestSellers();
}));

function cleanupCheckoutListeners(){
  try{ orderTrackingUnsub?.(); }catch(error){}
  try{ phoneTrackingUnsub?.(); }catch(error){}
  try{ categoriesUnsub?.(); }catch(error){}
  try{ menuDishesUnsub?.(); }catch(error){}
  try{ homepageSectionsUnsub?.(); }catch(error){}
  orderTrackingUnsub = null;
  phoneTrackingUnsub = null;
  categoriesUnsub = null;
  menuDishesUnsub = null;
  homepageSectionsUnsub = null;
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
  "Ready",
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
  const offerResult = calculateBogoOffer();
  const offerApplied = bogoOfferAccepted && offerResult.offerApplied;
  if(offerApplied){
    basePricing = calculateCouponPricingWithoutCoupon(subtotal);
  }
  const gstPercent = Math.max(0, Number(appPricing.gstPercent) || 0);
  const handlingCharge = Math.max(0, Math.round(Number(appPricing.handlingCharge) || 0));
  const offerDiscount = offerApplied ? offerResult.discount : 0;
  const discount = Math.max(0, Number(basePricing.couponDiscount || 0) + Number(basePricing.freeDeliveryDiscount || 0) + offerDiscount);
  const delivery = Math.max(0, Number(basePricing.deliveryCharge) || 0);
  const taxableAmount = Math.max(0, Number(subtotal) - Number(basePricing.couponDiscount || 0) - offerDiscount);
  const gstAmount = Math.round(taxableAmount * gstPercent / 100);
  const beforeWallet = Math.max(0, Math.round(taxableAmount + gstAmount + handlingCharge + delivery));
  const walletCap = beforeWallet >= WALLET_MIN_REDEEM_ORDER ? Math.min(Math.floor(beforeWallet * WALLET_MAX_REDEEM_PERCENT / 100), WALLET_MAX_REDEEM_POINTS) : 0;
  const walletDiscount = offerApplied ? 0 : Math.max(0, Math.min(walletPointsRequested, walletCap, walletPointsAvailable));
  const grandTotal = Math.max(0, beforeWallet - walletDiscount);
  return {
    ...basePricing,
    gstPercent,
    gstAmount,
    handlingCharge,
    discount,
    offerApplied,
    offerType:offerApplied ? offerResult.offer?.type || activeBogoOffer?.type || "" : "",
    offerDiscount,
    freeItems:offerApplied ? offerResult.freeItems : [],
    beforeWallet,
    walletDiscount,
    grandTotal,
    finalTotal:grandTotal
  };
}

function ensureCustomerDistanceBanner(){
  return document.getElementById("customerDistanceBanner");
}

function isTerminalOrderStatus(status = ""){
  return ["Delivered","Cancelled","Rejected","Failed"]
    .includes(normalizeTimelineStatus(status));
}

async function loadWalletForCheckout(user = auth.currentUser){
  const box = document.getElementById("walletRedeemBox");
  if(!user?.uid){ if(box) box.hidden = true; return; }
  try{
    const snap = await getDoc(doc(db,"users",user.uid));
    walletPointsAvailable = Math.max(0, Math.floor(Number(snap.data()?.walletPoints || 0)));
    if(box) box.hidden = walletPointsAvailable < 1;
    const text = document.getElementById("walletBalanceText");
    if(text) text.textContent = `${walletPointsAvailable} points available`;
    renderCouponPanel();
  }catch(error){ console.warn("Wallet balance load failed", error); }
}

function toggleWalletRedemption(){
  if(bogoOfferAccepted && calculateBogoOffer().offerApplied){
    toastError("Pizza Points cannot be used with Buy One Get One offers.");
    return;
  }
  const pricing = calculateInvoicePricing(getCartSubtotal());
  const walletCap = pricing.beforeWallet >= WALLET_MIN_REDEEM_ORDER ? Math.min(Math.floor(pricing.beforeWallet * WALLET_MAX_REDEEM_PERCENT / 100), WALLET_MAX_REDEEM_POINTS) : 0;
  if(!walletCap){
    toastError(`Pizza Points can be used on orders above ${formatCurrency(WALLET_MIN_REDEEM_ORDER)}.`);
    return;
  }
  walletPointsRequested = walletPointsRequested > 0 ? 0 : Math.min(walletPointsAvailable, walletCap);
  document.getElementById("walletRedeemBox")?.classList.toggle("active", walletPointsRequested > 0);
  const btn = document.getElementById("walletToggleBtn");
  if(btn) btn.textContent = walletPointsRequested ? `Remove ${walletPointsRequested} points` : "Use points";
  renderCouponPanel();
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
  const checkoutStatus = document.getElementById("checkoutLocationStatus");
  const banner = ensureCustomerDistanceBanner();
  const messages = {
    detecting:"GPS location detect ho rahi hai...",
    current:"Location selected",
    permission:"GPS permission nahi mili",
    lastSaved:"Saved location selected",
    idle:"GPS, search, ya manual address choose karein"
  };
  const text = detail || messages[state] || messages.idle;
  if(status) status.textContent = text;
  if(checkoutStatus){
    checkoutStatus.textContent = state === "detecting" ? "📍 Detecting your current location…"
      : state === "current" ? `✓ ${text}`
      : state === "lastSaved" ? `Saved location selected · ${detail || "GPS refresh kar sakte hain"}`
      : state === "permission" ? `⚠ ${text}`
      : `${text}`;
    checkoutStatus.dataset.state = state || "idle";
  }
  if(banner) {
    banner.textContent = state === "lastSaved" ? `📍 Saved location · ${detail || "Tap to refresh GPS"}` : `📍 ${text}`;
    banner.title = state === "lastSaved" ? "Saved location selected. Tap to refresh GPS." : "Tap to select location";
  }
  updateSelectedLocationUi(detail);
}

function locationDisplayParts(detail = ""){
  const address = normalizeUnicodeText(detail || document.getElementById("customerAddress")?.value || userLocation?.address || "");
  if(!address) return { title:"Select delivery location", address:"Tap to use your current location" };
  const parts = address.split(",").map(item => item.trim()).filter(Boolean);
  return {
    title:parts[0] || "Current location",
    address:parts.slice(1).join(", ") || address
  };
}

function calculateCartItemPayable(pricing = calculateInvoicePricing(getCartSubtotal())){
  const itemPayable = Number(pricing.subtotal || 0)
    - Number(pricing.couponDiscount || 0)
    - Number(pricing.offerDiscount || 0)
    + Number(pricing.gstAmount || 0)
    + Number(pricing.handlingCharge || 0);
  return Math.max(0, Math.round(itemPayable));
}

function updateSelectedLocationUi(detail = ""){
  const display = locationDisplayParts(detail);
  [["heroLocationTitle",display.title],["heroLocationAddress",display.address],["cartLocationTitle",display.title],["cartLocationAddress",display.address]]
    .forEach(([id,text]) => { const el = document.getElementById(id); if(el) el.textContent = text; });
}

function openLocationSelector(){
  const popup = document.getElementById("locationSelectorPopup");
  if(popup){
    popup.style.display = "flex";
    popup.setAttribute("aria-hidden", "false");
    document.body?.classList.add("location-selector-open");
    setTimeout(() => document.getElementById("addressSearchInput")?.focus(), 80);
  }
}

function closeLocationSelector(){
  const popup = document.getElementById("locationSelectorPopup");
  if(popup){
    popup.style.display = "none";
    popup.setAttribute("aria-hidden", "true");
    document.body?.classList.remove("location-selector-open");
  }
  updateCheckoutSteps();
}

function showLocationAddressForm(){
  const form = document.getElementById("locationAddressForm");
  const searchRow = document.querySelector("#locationSelectorPopup .location-search-row");
  const searchInput = document.getElementById("addressSearchInput");
  if(form){
    form.hidden = false;
    searchRow?.scrollIntoView({ behavior:"smooth", block:"start" });
    setTimeout(() => searchInput?.focus(), 180);
  }
}

function hideLocationAddressForm(){
  const form = document.getElementById("locationAddressForm");
  if(form) form.hidden = true;
}

async function saveLocationSelection(){
  let address = normalizeUnicodeText(document.getElementById("customerAddress")?.value || "");
  if(!address){ alert("Please enter a complete delivery address."); return; }
  if(!isUsableCoordinatePair(
    document.getElementById("customerLat")?.value,
    document.getElementById("customerLng")?.value
  )){
    try{
      const result = await callPaymentFunction("geocodeAddress", { address }, 15000);
      const selectedAddress = result.formattedAddress || address;
      address = selectedAddress;
      document.getElementById("customerAddress").value = selectedAddress;
      document.getElementById("customerLat").value = result.lat || "";
      document.getElementById("customerLng").value = result.lng || "";
      setCustomerLocation({
        lat:Number(result.lat),
        lng:Number(result.lng),
        address:selectedAddress,
        updatedAt:Date.now()
      }, "address_geocode_manual");
      await refreshDeliveryDistance({ force:true, maxAgeMs:0, routeTimeoutMs:12000 });
    }catch(error){
      alert(error.message || "We could not locate this address. Please search the area and try again.");
      return;
    }
  }
  updateSelectedLocationUi(address);
  checkoutLocationChoiceVersion++;
  setCheckoutMessage("");
  updateCheckoutSteps();
  persistGuestState();
  if(auth.currentUser) await saveCurrentAddressToBook().catch(error => console.warn("Address save skipped", error));
  closeLocationSelector();
}

window.openLocationSelector = openLocationSelector;
window.closeLocationSelector = closeLocationSelector;
window.showLocationAddressForm = showLocationAddressForm;
window.hideLocationAddressForm = hideLocationAddressForm;
window.saveLocationSelection = saveLocationSelection;

async function getLocationPermissionState(){
  try{
    if(!navigator.permissions?.query) return "unknown";
    const result = await navigator.permissions.query({ name:"geolocation" });
    return result.state || "unknown";
  }catch{
    return "unknown";
  }
}

function geolocationErrorMessage(error){
  const isiPhone = /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  if(error?.code === 1) return isiPhone
    ? "Location allow nahi hai. iPhone Settings/Safari me Location Allow karein, ya Search/Manual address use karein."
    : "Location permission blocked hai. Browser settings me Allow karein, ya Search/Manual address use karein.";
  if(error?.code === 2) return "GPS signal weak hai. Location ON rakhein, ya Search/Manual address use karein.";
  if(error?.code === 3 || /timed out|timeout/i.test(error?.message || "")) return "GPS slow ho raha hai. Retry karein, ya Search/Manual address use karein.";
  if(/not supported/i.test(error?.message || "")) return "Is browser me GPS support nahi hai. Search/Manual address use karein.";
  return "Location nahi mil pa rahi. Search address ya Manual address use karein.";
}

function requestGpsPosition(options = {}){
  return new Promise((resolve, reject) => {
    if(!navigator.geolocation){
      reject(new Error("Geolocation not supported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

async function requestFreshGpsPosition(){
  try{
    return await requestGpsPosition({
      enableHighAccuracy:true,
      maximumAge:0,
      timeout:16000
    });
  }catch(firstError){
    console.warn("[LOCATION]", { event:"high_accuracy_gps_failed_retrying_balanced", error:firstError?.message || String(firstError), code:firstError?.code });
    if(firstError?.code === 1) throw firstError;
    return requestGpsPosition({
      enableHighAccuracy:false,
      maximumAge:2 * 60 * 1000,
      timeout:12000
    }).catch(secondError => {
      secondError.firstGpsError = firstError;
      throw secondError;
    });
  }
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
    setLocationUiState("permission", "Location nahi mili. Address search/manual address use kar sakte hain.");
    return null;
  }
  userLocation = saved;
  userLocationUpdatedAt = saved.updatedAt || 0;
  updateCustomerDistanceGlobals();
  setLocationUiState("lastSaved", saved.address || "Saved delivery location");
  return saved;
}

async function fetchFreshCurrentLocation({ updateAddress = true, source = "fresh_gps", expectedChoiceVersion = null } = {}){
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
    if(expectedChoiceVersion !== null && checkoutLocationChoiceVersion !== expectedChoiceVersion){
      console.info("[LOCATION]", { event:"gps_result_ignored_manual_location_selected", source });
      return userLocation;
    }
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
      updateSelectedLocationUi(geocode.formattedAddress);
    }
    setLocationUiState("current", geocode?.formattedAddress || "Current location updated");
    updateCustomerDistanceGlobals();
    await refreshDeliveryDistance({ force:true, maxAgeMs:0, routeTimeoutMs:12000 }).catch(() => updateCustomerDistanceBanner());
    return userLocation;
  }catch(error){
    console.warn("[LOCATION]", { event:"fresh_location_failed", error:error?.message || String(error), code:error?.code, source });
    const message = geolocationErrorMessage(error);
    setLocationUiState("permission", message);
    showLocationAddressForm();
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

function dishImageSource(dish = {}){
  return dish.image
    || dish.imageUrl
    || dish.photo
    || dish.thumbnail
    || dish.mobileImage
    || dish.desktopImage
    || dish.heroImage
    || dish.bannerImage
    || "logo_tran.jpeg";
}

function dishImageSet(dish = {}){
  return dish.imageSet
    || dish.photoSet
    || dish.thumbnailSet
    || dish.heroImageSet
    || null;
}

function isFallbackDishImage(value = ""){
  const image = String(value || "").trim().toLowerCase();
  return !image
    || image === "logo_tran.jpeg"
    || image === "logo_tran.png"
    || image.endsWith("/logo_tran.jpeg")
    || image.endsWith("/logo_tran.png")
    || image.includes("company-logo")
    || image.includes("placeholder");
}

function isGenericBrokenBurgerImage(value = ""){
  const image = String(value || "").trim().toLowerCase();
  return image.includes("burger%2fburger.png")
    || image.includes("burger/burger.png")
    || image.includes("burger%2Fburger.png".toLowerCase());
}

function dishImageLookupKey(value = ""){
  return normalizeUnicodeText(value)
    .toLowerCase()
    .replace(/\bmagneetoz\b/g, "")
    .replace(/[^a-z0-9\u0900-\u097F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function categoryImageLookupKeys(value = ""){
  const key = dishImageLookupKey(value);
  const compact = key
    .replace(/\bclassic mania\b/g, "pizza")
    .replace(/\bmagneetoz special\b/g, "pizza")
    .replace(/\bmagneetoz burger\b/g, "burger")
    .replace(/\bfries sides\b/g, "garlic bread")
    .trim();
  const parts = compact.split(" ").filter(Boolean);
  return [...new Set([key, compact, ...parts].filter(Boolean))];
}

function rememberMenuDishImage(name = "", image = ""){
  const key = dishImageLookupKey(name);
  const src = normalizeImageUrl(image);
  if(!key || isFallbackDishImage(src)) return;
  if(!menuImageByDishName.has(key)) menuImageByDishName.set(key, src);
}

function rememberMenuCategoryImage(category = "", image = ""){
  const key = dishImageLookupKey(category);
  const src = normalizeImageUrl(image);
  if(!key || isFallbackDishImage(src)) return;
  if(!menuImageByCategoryName.has(key)) menuImageByCategoryName.set(key, src);
}

function rebuildMenuImageIndexFromDom(){
  const nextByName = new Map();
  const nextByCategory = new Map();
  document.querySelectorAll(".inline-menu-section .new-card[data-dish-name]").forEach(card => {
    const nameKey = dishImageLookupKey(card.dataset.dishName || "");
    const categoryKey = dishImageLookupKey(card.dataset.dishCategory || "");
    const src = normalizeImageUrl(card.dataset.dishImage || card.querySelector("img")?.currentSrc || card.querySelector("img")?.src || "");
    if(nameKey && !isFallbackDishImage(src) && !nextByName.has(nameKey)) nextByName.set(nameKey, src);
    if(categoryKey && !isFallbackDishImage(src) && !nextByCategory.has(categoryKey)) nextByCategory.set(categoryKey, src);
  });
  if(nextByName.size) menuImageByDishName = nextByName;
  if(nextByCategory.size) menuImageByCategoryName = nextByCategory;
}

document.addEventListener("load", event => {
  const img = event.target;
  if(!(img instanceof HTMLImageElement)) return;
  const card = img.closest?.(".inline-menu-section .new-card[data-dish-name]");
  if(!card) return;
  const src = normalizeImageUrl(img.currentSrc || img.src || img.getAttribute("src") || "");
  if(isFallbackDishImage(src) || img.naturalWidth <= 12) return;
  rememberMenuDishImage(card.dataset.dishName || "", src);
  rememberMenuCategoryImage(card.dataset.dishCategory || "", src);
  hydrateBestSellerImages();
}, true);

function imageCandidateScore(dish = {}){
  const source = normalizeImageUrl(dishImageSource(dish));
  let score = isFallbackDishImage(source) ? 0 : 100;
  const set = dishImageSet(dish);
  if(imageVariantUrl(set, "mobile")) score += 45;
  if(imageVariantUrl(set, "desktop")) score += 35;
  if(imageVariantUrl(set, "thumbnail")) score += 20;
  if(set?.url && !isFallbackDishImage(set.url)) score += 25;
  return score;
}

function dishImagePeer(dish = {}){
  const name = dishImageLookupKey(dish.name || "");
  if(!name || !Array.isArray(allMenuDishes) || allMenuDishes.length < 2) return dish;
  const category = normalizeUnicodeText(dish.category || "").toLowerCase();
  const currentScore = imageCandidateScore(dish);
  const sameName = allMenuDishes
    .filter(item => item && item !== dish && dishImageLookupKey(item.name || "") === name)
    .sort((a, b) => imageCandidateScore(b) - imageCandidateScore(a));
  const betterPeer = sameName.find(item => !category || normalizeUnicodeText(item.category || "").toLowerCase() === category)
    || sameName[0];
  return betterPeer && imageCandidateScore(betterPeer) > currentScore ? betterPeer : dish;
}

function dishBestImageUrl(dish = {}){
  const indexedImage = menuImageByDishName.get(dishImageLookupKey(dish.name || ""));
  if(indexedImage && !isFallbackDishImage(indexedImage)) return indexedImage;
  const categoryImage = menuImageByCategoryName.get(dishImageLookupKey(dish.category || ""));
  if(categoryImage && !isFallbackDishImage(categoryImage)) return categoryImage;
  const imageDish = dishImagePeer(dish);
  const directImage = normalizeImageUrl(dishImageSource(imageDish));
  if(directImage && !isFallbackDishImage(directImage)) return directImage;
  return bestImageUrl(directImage, dishImageSet(imageDish));
}

function dishImageSrcset(dish = {}){
  const imageDish = dishImagePeer(dish);
  const directImage = normalizeImageUrl(dishImageSource(imageDish));
  if(directImage && !isFallbackDishImage(directImage)) return "";
  return buildImageSrcset(dishImageSet(imageDish));
}

function imageFromRenderedMenuCard(name = "", category = ""){
  const nameKey = dishImageLookupKey(name);
  const categoryKey = dishImageLookupKey(category);
  const cards = [...document.querySelectorAll(".inline-menu-section .new-card[data-dish-name]")];
  const exact = cards.find(card => dishImageLookupKey(card.dataset.dishName || "") === nameKey);
  const categoryCard = cards.find(card => categoryKey && dishImageLookupKey(card.dataset.dishCategory || "") === categoryKey);
  const card = exact || categoryCard;
  const img = card?.querySelector("img");
  const src = normalizeImageUrl(img?.currentSrc || img?.src || img?.getAttribute("src") || card?.dataset.dishImage || "");
  return isFallbackDishImage(src) ? "" : src;
}

function imageFromCategoryButton(category = ""){
  const categoryKeys = categoryImageLookupKeys(category);
  if(!categoryKeys.length) return "";
  const buttons = [...document.querySelectorAll(".category-tab, [data-menu-category], [data-menu-group]")];
  const button = buttons.find(item => {
    const text = dishImageLookupKey(item.textContent || item.getAttribute("aria-label") || "");
    const data = dishImageLookupKey(item.dataset?.menuCategory || item.dataset?.menuGroup || "");
    return categoryKeys.some(key => text.includes(key) || key.includes(text) || data === key || data.includes(key) || key.includes(data));
  });
  const img = button?.querySelector("img");
  const src = normalizeImageUrl(img?.currentSrc || img?.src || img?.getAttribute("src") || "");
  return isFallbackDishImage(src) ? "" : src;
}

function bestSellerRepairImage(card){
  const img = card?.querySelector("img");
  if(!img) return;
  const name = card.dataset.dishName || "";
  const category = card.dataset.dishCategory || "";
  const current = normalizeImageUrl(img.currentSrc || img.src || img.getAttribute("src") || "");
  const burgerCategory = categoryImageLookupKeys(category).includes("burger");
  if(current && !isFallbackDishImage(current) && !isGenericBrokenBurgerImage(current) && img.complete && img.naturalWidth > 12) return;
  const repaired = menuImageByDishName.get(dishImageLookupKey(name))
    || imageFromRenderedMenuCard(name, category)
    || menuImageByCategoryName.get(dishImageLookupKey(category))
    || imageFromCategoryButton(category)
    || (burgerCategory ? imageFromCategoryButton("burger") : "");
  if(repaired && !isFallbackDishImage(repaired)){
    img.removeAttribute("srcset");
    img.src = repaired;
  }
}

function hydrateBestSellerImages(){
  document.querySelectorAll(".homepage-best-seller-card").forEach(card => {
    bestSellerRepairImage(card);
    const img = card.querySelector("img");
    if(img && !img.dataset.bestSellerRepairBound){
      img.dataset.bestSellerRepairBound = "1";
      img.addEventListener("error", () => bestSellerRepairImage(card));
      img.addEventListener("load", () => {
        if(img.naturalWidth <= 12) bestSellerRepairImage(card);
      });
    }
  });
}

function dishDataAttrs(d = {}){
  return `
    data-dish-name="${escapeHTML(normalizeUnicodeText(d.name || ""))}"
    data-dish-desc="${escapeHTML(normalizeUnicodeText(d.description || "Fresh MAGNEETOZ favourite"))}"
    data-dish-image="${escapeHTML(dishBestImageUrl(d))}"
    data-dish-category="${escapeHTML(d.category || "Recommended")}"
    data-dish-type="${escapeHTML(d.type || "size_based")}"
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
    image:dishBestImageUrl(dish),
    baseUnitPrice:variant.price,
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

function scoreBestSellerDish(dish = {}){
  const variant = dishLowestVariant(dish);
  const price = Number(variant.price || 0);
  if(!dish.available || !price) return -999;
  const text = textForDish(dish);
  let score = scoreSmartDish(dish, "popular");
  if(dish.bestSeller || dish.bestseller || dish.isBestSeller) score += 140;
  if(dish.popular || dish.isPopular) score += 110;
  if(dish.featured || dish.isFeatured) score += 70;
  score += Math.min(90, Number(dish.orderCount || dish.soldCount || dish.sales || dish.totalSold || 0) / 2);
  score += Math.min(35, Number(dish.rating || dish.avgRating || 0) * 7);
  score += Math.max(0, 160 - price) / 10;
  if(/best|seller|popular|special|loaded|magneetoz|signature|combo|pizza/.test(text)) score += 35;
  return score;
}

function bestSellerCardMarkup(dish = {}, index = 0){
  const variant = dishLowestVariant(dish);
  window.__magneetozMenuImages = menuImageByDishName;
  const resolvedImage = dishBestImageUrl(dish);
  const categoryButtonImage = imageFromCategoryButton(dish.category || "");
  const sourceLooksFallback = isFallbackDishImage(dishImageSource(dish));
  const burgerCategory = categoryImageLookupKeys(dish.category || "").includes("burger");
  const genericBurgerImage = isGenericBrokenBurgerImage(resolvedImage) || isGenericBrokenBurgerImage(dishImageSource(dish));
  const image = (sourceLooksFallback || isFallbackDishImage(resolvedImage) || genericBurgerImage || burgerCategory) && categoryButtonImage ? categoryButtonImage : resolvedImage;
  const srcset = dishImageSrcset(dish);
  const srcsetAttr = srcset ? `srcset="${escapeHTML(srcset)}" sizes="(max-width: 640px) 204px, 235px"` : "";
  return `
    <article class="homepage-best-seller-card" data-dish-name="${escapeHTML(dish.name || "")}" data-dish-category="${escapeHTML(dish.category || "")}">
      <span class="best-seller-rank">#${index + 1}</span>
      <img src="${escapeHTML(image)}" ${srcsetAttr} alt="${escapeHTML(dish.name || "MAGNEETOZ best seller")}" width="320" height="240" loading="${index < 3 ? "eager" : "lazy"}" decoding="async">
      <div>
        <small>${escapeHTML(dish.category || "Popular")}</small>
        <strong>${escapeHTML(dish.name || "MAGNEETOZ Item")}</strong>
        <p>${escapeHTML((dish.description || "Fresh customer favourite").slice(0, 68))}</p>
        <span>${formatCurrency(variant.price)}</span>
      </div>
      <button type="button" class="add-cart-btn" onclick="addBestSellerItem('${escapeHTML(String(dish.id || ""))}')">Add +</button>
    </article>
  `;
}

function renderBestSellers(){
  const section = document.getElementById("homepageBestSellers");
  const rail = document.getElementById("homepageBestSellersRail");
  if(!section || !rail) return;
  if(homepageDisplaySettings.showBestSellers === false){
    section.classList.remove("is-loading");
    section.setAttribute("aria-busy", "false");
    section.hidden = true;
    rail.innerHTML = "";
    return;
  }
  const dishes = [...allMenuDishes]
    .filter(dish => dish?.available && dishLowestVariant(dish).price > 0)
    .sort((a, b) => scoreBestSellerDish(b) - scoreBestSellerDish(a)
      || Number(a.order ?? Number.MAX_SAFE_INTEGER) - Number(b.order ?? Number.MAX_SAFE_INTEGER)
      || String(a.name || "").localeCompare(String(b.name || "")))
    .slice(0, 8);
  section.classList.remove("is-loading");
  section.setAttribute("aria-busy", "false");
  section.hidden = !dishes.length;
  if(!dishes.length){
    rail.innerHTML = "";
    return;
  }
  rail.innerHTML = dishes.map(bestSellerCardMarkup).join("");
  requestAnimationFrame(() => {
    hydrateBestSellerImages();
    setTimeout(hydrateBestSellerImages, 500);
    setTimeout(hydrateBestSellerImages, 1500);
  });
}

window.addBestSellerItem = function(dishId){
  const dish = allMenuDishes.find(item => String(item.id) === String(dishId));
  if(dish) addDishObjectToCart(dish, 1);
};

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
  const baseSubtotal = getCartBaseSubtotal();
  const freeDeliveryTarget = calculateDistanceDeliveryPricing(deliveryDistance, subtotal, baseSubtotal).threshold || DEFAULT_FREE_DELIVERY_MIN;
  const neededForFree = Math.max(0, freeDeliveryTarget - baseSubtotal);
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

const tasteQuizState = {
  mood:"cheesy",
  people:"1",
  budget:"300",
  crust:"any",
  avoid:"none",
  suggestions:[]
};

function quizPeopleCount(value = tasteQuizState.people){
  if(value === "family") return 5;
  if(value === "3-4") return 4;
  return Math.max(1, Number(value || 1));
}

function quizBudgetValue(value = tasteQuizState.budget){
  return value === "nolimit" ? Infinity : Number(value || 300);
}

function dishSearchText(dish = {}){
  return `${dish.name || ""} ${dish.description || ""} ${dish.category || ""} ${dish.itemsIncluded || ""}`.toLowerCase();
}

function quizDishAllowed(dish = {}, avoid = tasteQuizState.avoid){
  if(!dish?.available || dishLowestVariant(dish).price <= 0) return false;
  if(!avoid || avoid === "none") return true;
  const text = dishSearchText(dish);
  const avoidMap = {
    onion:["onion","pyaz"],
    capsicum:["capsicum","shimla"],
    cheese:["cheese","cheesy","mozzarella"]
  };
  return !(avoidMap[avoid] || [avoid]).some(word => text.includes(word));
}

function scoreTasteQuizDish(dish = {}, mood = tasteQuizState.mood){
  const variant = dishLowestVariant(dish);
  const price = Number(variant.price || 0);
  const text = dishSearchText(dish);
  let score = scoreBestSellerDish(dish);
  if(mood === "cheesy") score += /cheese|cheesy|paneer|mozzarella|loaded/.test(text) ? 160 : 0;
  if(mood === "spicy") score += /spicy|chilli|chili|masala|peri|tandoori|hot/.test(text) ? 160 : 0;
  if(mood === "light") score += /veg|corn|garlic|bread|light|classic/.test(text) ? 80 : 0;
  if(mood === "budget") score += Math.max(0, 220 - price);
  if(mood === "party") score += /combo|large|family|party|meal|pizza/.test(text) ? 130 : 0;
  return score;
}

function buildQuizCartCandidate(dishes = [], label = "Smart Cart", targetBudget = Infinity, maxItems = 3){
  const items = [];
  let total = 0;
  for(const dish of dishes){
    const variant = dishLowestVariant(dish);
    const price = Number(variant.price || 0);
    if(!price || items.some(item => String(item.dish.id) === String(dish.id))) continue;
    if(Number.isFinite(targetBudget) && items.length && total + price > targetBudget + 40) continue;
    items.push({ dish, variant });
    total += price;
    if(items.length >= maxItems) break;
  }
  return { label, items, total };
}

function buildTasteQuizSuggestions(){
  const budget = quizBudgetValue();
  const people = quizPeopleCount();
  const maxItems = people >= 4 ? 4 : people >= 2 ? 3 : 2;
  let pool = [...allMenuDishes]
    .filter(dish => quizDishAllowed(dish))
    .sort((a, b) => scoreTasteQuizDish(b) - scoreTasteQuizDish(a));
  if(!pool.length) pool = cartSmartDishSuggestions(8);
  const budgetPool = [...pool].sort((a, b) => dishLowestVariant(a).price - dishLowestVariant(b).price);
  const moodPool = [...pool].sort((a, b) => scoreTasteQuizDish(b, tasteQuizState.mood) - scoreTasteQuizDish(a, tasteQuizState.mood));
  const suggestions = [
    buildQuizCartCandidate(budgetPool, "Best Value", budget, maxItems),
    buildQuizCartCandidate(moodPool, tasteQuizState.mood === "spicy" ? "Most Spicy" : "Most Cheesy", budget, maxItems)
  ];
  if(people >= 4 || tasteQuizState.mood === "party"){
    suggestions.push(buildQuizCartCandidate(moodPool, "Family Saver", budget, 4));
  }
  tasteQuizState.suggestions = suggestions.filter(item => item.items.length).slice(0, 3);
  return tasteQuizState.suggestions;
}

function renderTasteQuizResults(){
  const host = document.getElementById("tasteQuizResults");
  if(!host) return;
  const suggestions = buildTasteQuizSuggestions();
  host.hidden = false;
  if(!suggestions.length){
    host.innerHTML = `<div class="taste-quiz-empty">Perfect match nahi mila. Best sellers loading hain, thoda retry karein.</div>`;
    return;
  }
  host.innerHTML = `<div class="taste-quiz-results-head"><strong>Your smart carts</strong><span>Live menu se banaye gaye suggestions</span></div><div class="taste-quiz-suggestion-list">${suggestions.map((suggestion, index) => `<article class="taste-quiz-suggestion"><div class="taste-quiz-suggestion-title"><span>${escapeHTML(suggestion.label)}</span><b>${formatCurrency(suggestion.total)}</b></div><div class="taste-quiz-items">${suggestion.items.map(entry => `<div><img src="${escapeHTML(normalizeImageUrl(entry.dish.image))}" alt="${escapeHTML(entry.dish.name || "MAGNEETOZ item")}" loading="lazy" onerror="this.onerror=null;this.src='logo_tran.jpeg';"><span><strong>${escapeHTML(entry.dish.name || "Item")}</strong><small>${escapeHTML(entry.variant.size)} • ${formatCurrency(entry.variant.price)}</small></span></div>`).join("")}</div><button type="button" onclick="addTasteQuizSuggestionToCart(${index})">Add Smart Combo to Cart</button></article>`).join("")}</div>`;
}

window.addTasteQuizSuggestionToCart = function(index){
  const suggestion = tasteQuizState.suggestions[Number(index)];
  if(!suggestion?.items?.length) return;
  const nextItems = suggestion.items.map(entry => {
    const item = {
      id:entry.dish.id || "",
      name:entry.dish.name || "MAGNEETOZ Item",
      size:entry.variant.size,
      qty:1,
      category:entry.dish.category || "Recommended",
      image:normalizeImageUrl(entry.dish.image),
      baseUnitPrice:entry.variant.price,
      unitPrice:entry.variant.price,
      price:entry.variant.price
    };
    if(tasteQuizState.crust !== "any" && isPizzaCartItem(item)){
      const crust = normalizeCrust(tasteQuizState.crust);
      item.crust = crust;
      item.crustType = crust.label;
      item.selectedCrust = crust.id;
    }
    return normalizeCartItemPricing(item);
  });
  cart = [...cart, ...nextItems];
  persistGuestState();
  updateCart();
  closeTasteQuiz();
  toggleCart(true);
  toastSuccess("Smart cart added. Checkout flow same rahega.");
};

function openTasteQuiz(){
  const modal = document.getElementById("tasteQuizModal");
  if(!modal) return;
  modal.hidden = false;
  document.body.classList.add("taste-quiz-open");
  renderTasteQuizResults();
}

function closeTasteQuiz(){
  const modal = document.getElementById("tasteQuizModal");
  if(!modal) return;
  modal.hidden = true;
  document.body.classList.remove("taste-quiz-open");
}

function bindTasteQuiz(){
  document.getElementById("openTasteQuizBtn")?.addEventListener("click", openTasteQuiz);
  document.getElementById("closeTasteQuizBtn")?.addEventListener("click", closeTasteQuiz);
  document.getElementById("buildTasteQuizBtn")?.addEventListener("click", renderTasteQuizResults);
  document.getElementById("tasteQuizModal")?.addEventListener("click", event => {
    if(event.target?.id === "tasteQuizModal") closeTasteQuiz();
  });
  document.getElementById("tasteQuizForm")?.addEventListener("click", event => {
    const button = event.target.closest("[data-value]");
    if(!button) return;
    const group = button.closest("[data-quiz-group]")?.dataset.quizGroup;
    if(!group) return;
    tasteQuizState[group] = button.dataset.value;
    button.parentElement.querySelectorAll("button").forEach(item => item.classList.toggle("active", item === button));
    renderTasteQuizResults();
  });
  document.querySelectorAll(".taste-quiz-group").forEach(group => {
    const key = group.dataset.quizGroup;
    group.querySelector(`[data-value="${tasteQuizState[key]}"]`)?.classList.add("active");
  });
}

function notifyPremiumUI(name, detail = {}){
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function toastSuccess(message){ window.MagneetozNotify?.success(message); }
function toastInfo(message){ window.MagneetozNotify?.info(message); }
function toastWarning(message){ window.MagneetozNotify?.warning(message); }
function toastError(message){ window.MagneetozNotify?.error(message); }

onAuthStateChanged(auth, user => {
  syncAuthenticatedCheckoutPhone(user);
  loadWalletForCheckout(user);
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
    }, AUTH_NULL_GRACE_MS);
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
  document.body?.classList.add("checkout-busy");
  loader.style.display = "flex";
  const isPaymentStatus = /payment|confirming|paid/i.test(message || "");
  loader.innerHTML = `<div class="checkout-loader-card"><b>${escapeHTML(message)}</b><span>Your cart is safe. Try again when the connection is stable.</span><button type="button" id="checkoutRetryBtn">${isPaymentStatus ? "Check payment status" : "Retry"}</button></div>`;
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

function rotateCheckoutAttempt(reason = "fresh_attempt"){
  checkoutInFlightId = "";
  clearRazorpayPaymentRecovery();
  console.info("[CHECKOUT_RECOVERY]", { reason, action:"rotated_checkout_attempt" });
}

async function createPaymentSessionWithRecovery(initialPayload){
  try{
    return await timedStep("upiOrder:createPaymentSession", () =>
      callPaymentFunction("createPaymentSession", initialPayload, 12000)
    );
  }catch(error){
    const message = String(error?.message || "");
    const staleCompletedSession = /already completed|reopen checkout|payment session/i.test(message);
    if(!staleCompletedSession) throw error;
    setCheckoutLoading(true, "Refreshing secure payment session...");
    rotateCheckoutAttempt("stale_completed_payment_session");
    const freshPayload = await timedStep("upiOrder:rebuildPaidOnlineOrderDraft", () => buildPaidOnlineOrderDraft());
    return timedStep("upiOrder:createFreshPaymentSession", () =>
      callPaymentFunction("createPaymentSession", freshPayload, 12000)
    );
  }
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
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function couponCodeList(coupon = {}){
  return Array.from(new Set(
    String(coupon.code || "")
      .split(",")
      .map(code => normalizeCouponKey(code))
      .filter(Boolean)
  ));
}

function couponWithMatchedCode(coupon, code){
  const matchedCode = normalizeCouponKey(code);
  if(!coupon || !matchedCode || !couponCodeList(coupon).includes(matchedCode)) return null;
  return { ...coupon, code:matchedCode, sourceCouponCode:coupon.code };
}

function findCouponByCode(code){
  const normalized = normalizeCouponKey(code);
  if(!normalized) return null;
  for(const coupon of availableCoupons){
    const matched = couponWithMatchedCode(coupon, normalized);
    if(matched) return matched;
  }
  return null;
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
  for(const coupon of availableCoupons){
    if(coupon.deleted === true || coupon.active === false || couponExpired(coupon)) continue;
    if(couponCode){
      const matched = couponWithMatchedCode(coupon, couponCode);
      if(matched) return matched;
    }
    if(pgCode && normalizeCouponKey(coupon.pgCode) === pgCode) return coupon;
    if(pgName && normalizeCouponKey(coupon.pgName || coupon.pg) === pgName) return coupon;
  }
  return null;
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
    address:normalizeUnicodeText(location.address || location.formattedAddress || ""),
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

function hasSelectedCheckoutLocation(){
  const fields = getCheckoutFields();
  return !!(fields.address && isUsableCoordinatePair(fields.lat, fields.lng));
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

function setCheckoutMessage(message = "", type = "info"){
  const box = document.getElementById("checkoutInlineMessage");
  if(!box) return;
  box.hidden = !message;
  box.textContent = message;
  box.dataset.type = type;
}

function checkoutAuthReady(){
  const user = auth.currentUser || cachedAuthUser;
  const phone = normalizeUnicodeText(document.getElementById("customerPhone")?.value || user?.phoneNumber || "");
  return !!(user?.uid && phone);
}

function checkoutMissingReason(){
  const fields = getCheckoutFields();
  if(!cart.length) return "Food select karo. Cart empty hai.";
  if(!fields.name) return "Name missing hai. Order kis naam se banana hai?";
  if(!(fields.address && isUsableCoordinatePair(fields.lat, fields.lng))) return "Location missing hai. Delivery charges aur service area check karna zaroori hai.";
  if(!checkoutAuthReady()) return "Login/OTP pending hai. Verified mobile ke bina order place nahi hoga.";
  return "";
}

function markCheckoutField(id, invalid = false){
  const el = document.getElementById(id);
  el?.classList.toggle("checkout-field-missing", invalid);
  el?.closest("label, .cart-location-card")?.classList.toggle("checkout-field-missing", invalid);
}

function updateCheckoutSteps(){
  const fields = getCheckoutFields();
  const hasFood = cart.length > 0;
  const hasName = !!fields.name;
  const hasLocation = !!(fields.address && isUsableCoordinatePair(fields.lat, fields.lng));
  const hasLogin = checkoutAuthReady();
  document.querySelector('[data-checkout-step="name"]')?.classList.toggle("complete", hasName);
  document.querySelector('[data-checkout-step="location"]')?.classList.toggle("complete", hasLocation);
  document.querySelector('[data-checkout-step="login"]')?.classList.toggle("complete", hasLogin);
  document.querySelector('[data-checkout-step="payment"]')?.classList.toggle("complete", hasName && hasLocation && hasLogin);
  document.querySelector('[data-checkout-step="payment"]')?.classList.toggle("active", hasName && hasLocation && hasLogin);
  document.querySelector('[data-checkout-step="name"]')?.classList.toggle("active", !hasName);
  document.querySelector('[data-checkout-step="location"]')?.classList.toggle("active", hasName && !hasLocation);
  document.querySelector('[data-checkout-step="login"]')?.classList.toggle("active", hasName && hasLocation && !hasLogin);
  const guideState = {
    food:hasFood,
    location:hasLocation,
    login:hasLogin,
    payment:hasFood && hasName && hasLocation && hasLogin
  };
  Object.entries(guideState).forEach(([key, complete]) => {
    const chip = document.querySelector(`[data-cart-guide="${key}"]`);
    chip?.classList.toggle("complete", complete);
    chip?.classList.toggle("missing", !complete && (key === "food" || (key === "location" && hasFood) || (key === "login" && hasFood && hasName && hasLocation) || (key === "payment" && hasFood && hasName && hasLocation && hasLogin)));
  });
  markCheckoutField("customerName", false);
  document.getElementById("cartLocationCard")?.classList.remove("checkout-field-missing");
}

function initFirstOrderGuide(){
  const guide = document.getElementById("firstOrderGuide");
  if(!guide) return;
  const seen = localStorage.getItem(FIRST_ORDER_GUIDE_KEY) === "1";
  guide.hidden = seen;
  if(!seen) localStorage.setItem(FIRST_ORDER_GUIDE_KEY, "1");
}

function syncAuthenticatedCheckoutPhone(user = auth.currentUser || cachedAuthUser){
  const phone = normalizeUnicodeText(user?.phoneNumber || document.getElementById("customerPhone")?.value || "");
  const hidden = document.getElementById("customerPhone");
  const label = document.getElementById("checkoutAuthPhoneValue");
  if(hidden) hidden.value = phone;
  if(label) label.textContent = phone || "Checking your verified mobile…";
  return phone;
}

async function resolveAuthenticatedCheckoutPhone(user = auth.currentUser || cachedAuthUser){
  if(!user?.uid) return "";
  let phone = normalizeUnicodeText(user.phoneNumber || "");
  if(!phone){
    try{
      await user.reload();
      phone = normalizeUnicodeText((auth.currentUser || user).phoneNumber || "");
    }catch(error){
      console.warn("Auth mobile refresh skipped:", error);
    }
  }
  if(!phone){
    try{
      const profile = await getDoc(doc(db,"users",user.uid));
      phone = normalizeUnicodeText(profile.data()?.phone || profile.data()?.customerPhone || "");
    }catch(error){
      console.warn("Saved mobile lookup skipped:", error);
    }
  }
  const hidden = document.getElementById("customerPhone");
  const label = document.getElementById("checkoutAuthPhoneValue");
  if(hidden) hidden.value = phone;
  if(label) label.textContent = phone || "Please sign in again to verify your mobile";
  return phone;
}

async function promptVerifiedMobileLogin(){
  const existingUser = auth.currentUser || cachedAuthUser;
  const label = document.getElementById("checkoutAuthPhoneValue");
  if(label) label.textContent = "Login to verify mobile";
  setCheckoutMessage("Mobile verification required hai. Login popup open ho raha hai.", "warning");
  if(existingUser?.uid){
    console.warn("Verified mobile missing; signing out before re-verification.", { uid:existingUser.uid });
    document.body?.classList.add("auth-needs-verification");
    try{
      await signOut(auth);
    }catch(error){
      console.warn("Auto sign-out for mobile verification failed:", error);
    }
  }
  if(typeof window.requireMagneetozAuth === "function"){
    await window.requireMagneetozAuth("mobile_verification");
  }else if(typeof window.openMagneetozAuth === "function"){
    window.openMagneetozAuth("mobile_verification");
  }
}

function mobileLoginRequiredError(){
  const error = new Error("Please login again to verify your mobile.");
  error.mobileLoginRequired = true;
  return error;
}

async function resolveAuthenticatedCheckoutName(user = auth.currentUser || cachedAuthUser){
  const input = document.getElementById("customerName");
  return normalizeUnicodeText(input?.value || "");
}

function focusMissingCheckoutField(){
  const checkout = getCheckoutFields();
  const missingName = !checkout.name;
  const missingLocation = !(checkout.address && isUsableCoordinatePair(checkout.lat, checkout.lng));
  if(!missingName && !missingLocation) return false;
  setCheckoutFieldsCollapsed(false);
  toggleCart(true);
  if(missingLocation && !missingName){
    markCheckoutField("customerName", false);
    document.getElementById("cartLocationCard")?.classList.add("checkout-field-missing");
    setCheckoutMessage("Delivery location required hai. Use current location ya address select karein.", "warning");
    openLocationSelector();
    showLocationAddressForm();
  }else{
    const el = document.getElementById("customerName");
    markCheckoutField("customerName", true);
    document.getElementById("cartLocationCard")?.classList.toggle("checkout-field-missing", missingLocation);
    setCheckoutMessage("Please apna name enter karein, fir location confirm karke payment continue hoga.", "warning");
    el?.scrollIntoView({ behavior:"smooth", block:"center" });
    setTimeout(() => el?.focus(), 250);
  }
  updateCheckoutSteps();
  return true;
}

function restoreCheckoutFields(state = readJSON(CHECKOUT_STATE_KEY, {}), force = false){
  const map = {
    customerAddress:state.address,
    customerLandmark:state.landmark,
    customerLat:state.lat,
    customerLng:state.lng
  };
  Object.entries(map).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if(el && value && (force || !el.value)) el.value = value;
  });
  updateCheckoutSteps();
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
  const cards = document.getElementById("savedAddressCards");
  if(cards){
    cards.innerHTML = valid.length ? valid.map((item, index) => `
      <article class="saved-address-card ${select.value === String(index) ? "active" : ""}">
        <button type="button" class="saved-address-main" onclick="selectSavedAddressCard(${index})">
          <span>⌂</span>
          <span><strong>${escapeHTML(item.landmark || item.label || `Address ${index + 1}`)}</strong><small>${escapeHTML(item.address || "")}</small></span>
        </button>
        <div class="saved-address-card-actions">
          <button type="button" onclick="editSavedAddressCard(${index})">Edit</button>
          <button type="button" class="delete" onclick="deleteSavedAddressCard(${index})">Delete</button>
        </div>
      </article>
    `).join("") : `<div class="saved-address-empty">No saved addresses yet</div>`;
  }
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
      setLocationUiState("lastSaved", valid[0].address || valid[0].label || "Saved delivery location");
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
    ["customerName","customerAddress","customerLandmark"].forEach(id => {
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
  checkoutLocationChoiceVersion++;
  restoreCheckoutFields(item, true);
  updateSelectedLocationUi(item.address || item.label || "");
  if(isUsableLocation(item)){
    setCustomerLocation({
      lat:Number(item.lat),
      lng:Number(item.lng),
      accuracy:item.accuracy || null,
      address:item.address || item.label || "",
      updatedAt:Number(item.updatedAt || Date.now()),
      mapLink:`https://www.google.com/maps?q=${item.lat},${item.lng}`
    }, "last_saved_address_selected");
    setLocationUiState("lastSaved", item.address || item.label || "Saved delivery location");
    refreshDeliveryDistance({ force:true, maxAgeMs:0, routeTimeoutMs:12000 }).catch(() => updateCustomerDistanceBanner());
  }
  setCheckoutFieldsCollapsed(true);
  persistGuestState();
  closeLocationSelector();
}

window.selectSavedAddressCard = function(index){
  const select = document.getElementById("savedAddressSelect");
  if(select) select.value = String(index);
  applySavedAddress(String(index));
};

function deliverySettingNumber(value, fallback, legacyValue){
  const parsed = Math.max(0, Number(value ?? fallback));
  return parsed === legacyValue ? fallback : parsed;
}

window.editSavedAddressCard = function(index){
  const select = document.getElementById("savedAddressSelect");
  if(select) select.value = String(index);
  applySavedAddress(String(index));
  showLocationAddressForm();
};

window.deleteSavedAddressCard = async function(index){
  const select = document.getElementById("savedAddressSelect");
  if(select) select.value = String(index);
  await deleteSelectedAddress();
};

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
  fields.phone = await resolveAuthenticatedCheckoutPhone();
  if(!fields.phone) throw new Error("We could not verify your mobile. Please sign out and sign in again.");
  if(!fields.name || !fields.address) throw new Error("Fill name & address first.");
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
  const status = document.getElementById("locationStatus");
  try{
    if(btn) btn.disabled = true;
    if(status) status.textContent = "Detecting your current location…";
    await fetchFreshCurrentLocation({ updateAddress:true, source:"fresh_gps:address_button" });
  }catch(error){
    const message = geolocationErrorMessage(error);
    if(status) status.textContent = message;
    showLocationAddressForm();
    alert(message);
  }finally{
    if(btn) btn.disabled = false;
  }
}

async function saveLoginCurrentLocation(user = auth.currentUser){
  if(!user?.uid) return;
  const fields = getCheckoutFields();
  if(!fields.address || !isUsableCoordinatePair(fields.lat, fields.lng)) return;
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() || {} : {};
  const existing = Array.isArray(data.savedAddresses) ? data.savedAddresses : [];
  const nextAddress = {
    address:fields.address,
    landmark:fields.landmark || "",
    lat:fields.lat,
    lng:fields.lng,
    label:fields.address,
    source:"current_location",
    updatedAt:Date.now()
  };
  const signature = addressSignature(nextAddress);
  const deduped = [nextAddress, ...existing.filter(item => addressSignature(item) !== signature)].slice(0, 8);
  await setDoc(ref, {
    uid:user.uid,
    defaultAddress:nextAddress,
    savedAddresses:deduped,
    updatedAt:serverTimestamp()
  }, { merge:true });
  renderSavedAddresses(deduped);
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
    const selectedAddress = result.formattedAddress || query;
    checkoutLocationChoiceVersion++;
    document.getElementById("customerAddress").value = selectedAddress;
    document.getElementById("customerLat").value = result.lat || "";
    document.getElementById("customerLng").value = result.lng || "";
    setCustomerLocation({
      lat:Number(result.lat),
      lng:Number(result.lng),
      updatedAt:Date.now(),
      mapLink:`https://www.google.com/maps?q=${result.lat},${result.lng}`
    }, "address_geocode_search");
    setCheckoutFieldsCollapsed(false);
    updateSelectedLocationUi(selectedAddress);
    showLocationAddressForm();
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
  updateSelectedLocationUi("");
  toastSuccess?.("Address deleted");
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

function normalizeCartExtras(extras = []){
  const allowed = new Map(EXTRA_TOPPINGS.map(item => [item.id, item]));
  return (Array.isArray(extras) ? extras : [])
    .map(extra => {
      const id = String(extra.id || extra.key || extra.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      const canonical = allowed.get(id) || EXTRA_TOPPINGS.find(item => item.name.toLowerCase() === String(extra.name || "").toLowerCase());
      if(!canonical) return null;
      return { id:canonical.id, name:canonical.name, price:Number(canonical.price || 0) };
    })
    .filter(Boolean)
    .filter((extra, index, arr) => arr.findIndex(item => item.id === extra.id) === index);
}

function extrasTotalPerUnit(extras = []){
  return normalizeCartExtras(extras).reduce((sum, extra) => sum + Number(extra.price || 0), 0);
}

function normalizeCrust(value){
  const raw = typeof value === "object" && value ? (value.id || value.type || value.label || value.name) : value;
  const key = String(raw || DEFAULT_CRUST_ID).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const option = CRUST_OPTIONS.find(item => item.id === key)
    || CRUST_OPTIONS.find(item => item.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") === key)
    || CRUST_OPTIONS.find(item => item.id === DEFAULT_CRUST_ID);
  return { ...option };
}

function isPizzaCartItem(item = {}){
  const text = `${item.category || ""} ${item.dishCategory || ""} ${item.name || ""} ${item.size || ""}`.toLowerCase();
  if(item.comboId || text.includes("combo")) return false;
  return /pizza|pizaa|piza|margherita|marg[h]?rita/.test(text);
}

function normalizeCartItemPricing(item = {}){
  const qty = Math.max(1, Number(item.qty || item.quantity || 1) || 1);
  const existingExtras = normalizeCartExtras(item.extras || item.addOns || item.addons || item.extraToppings);
  const pizzaItem = isPizzaCartItem(item);
  const crust = pizzaItem ? normalizeCrust(item.crust || item.crustType || item.selectedCrust) : null;
  const baseUnitPrice = Number(item.baseUnitPrice || item.unitPrice || (qty ? Number(item.price || 0) / qty - extrasTotalPerUnit(existingExtras) : item.price) || 0);
  const extrasTotal = extrasTotalPerUnit(existingExtras);
  const normalized = {
    ...item,
    qty,
    quantity:qty,
    baseUnitPrice,
    unitPrice:baseUnitPrice,
    extras:existingExtras,
    addOns:existingExtras,
    extrasTotal,
    price:Math.round((baseUnitPrice + extrasTotal) * qty)
  };
  if(pizzaItem){
    normalized.crust = crust;
    normalized.crustType = crust.label;
    normalized.selectedCrust = crust.id;
  }else{
    delete normalized.crust;
    delete normalized.crustType;
    delete normalized.selectedCrust;
  }
  return normalized;
}

function cartItemTotal(item = {}){
  const normalized = normalizeCartItemPricing(item);
  return normalized.price;
}

function normalizeCartPricing(){
  cart = (Array.isArray(cart) ? cart : []).map(normalizeCartItemPricing);
}

function compactCartForStorage(items = []){
  return (Array.isArray(items) ? items : []).map(item => {
    const image = String(item.image || item.imageUrl || item.thumbnail || "");
    const qty = Number(item.qty || item.quantity || 1);
    const baseUnitPrice = Number(item.baseUnitPrice || item.unitPrice || (qty ? Number(item.price || 0) / qty : item.price) || 0);
    const extras = normalizeCartExtras(item.extras || item.addOns || item.addons || item.extraToppings);
    const pizzaItem = isPizzaCartItem(item);
    const crust = pizzaItem ? normalizeCrust(item.crust || item.crustType || item.selectedCrust) : null;
    const extrasTotal = extrasTotalPerUnit(extras);
    const compact = {
      id:String(item.id || "").slice(0, 120),
      name:String(item.name || "").slice(0, 160),
      size:String(item.size || "").slice(0, 80),
      category:String(item.category || "").slice(0, 120),
      baseUnitPrice,
      unitPrice:baseUnitPrice,
      extras,
      addOns:extras,
      extrasTotal,
      price:cartItemTotal({ ...item, qty, baseUnitPrice, unitPrice:baseUnitPrice, extras }),
      qty,
      quantity:qty,
      image:!image || /^data:/i.test(image) ? "" : image.slice(0, 700)
    };
    if(pizzaItem){
      compact.crust = crust;
      compact.crustType = crust.label;
      compact.selectedCrust = crust.id;
    }
    return compact;
  });
}

function orderItemsForReorder(order = {}){
  return Array.isArray(order.items) && order.items.length
    ? order.items
    : (Array.isArray(order.cart) ? order.cart : []);
}

function reorderLookupText(value = ""){
  return normalizeUnicodeText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function menuDishAvailableForReorder(dish = {}){
  return !!(dish && dish.available !== false && dish.active !== false && dish.deleted !== true && dish.category);
}

async function getReorderMenuDishes(){
  if(Array.isArray(allMenuDishes) && allMenuDishes.length) return allMenuDishes;
  try{
    const snapshot = await getDocs(collection(db, "dishes"));
    allMenuDishes = snapshot.docs
      .map(docSnap => ({ id:docSnap.id, ...docSnap.data() }))
      .filter(menuDishAvailableForReorder);
  }catch(error){
    console.warn("Reorder menu refresh failed:", error);
  }
  return allMenuDishes || [];
}

async function getReorderCombos(){
  const cached = (window.__magneetozActiveCombos || []).filter(comboIsOrderable);
  if(cached.length) return cached;
  try{
    const snapshot = await getDocs(collection(db, "combos"));
    const combos = snapshot.docs
      .map(docSnap => ({ id:docSnap.id, ...docSnap.data() }))
      .filter(comboIsOrderable);
    window.__magneetozActiveCombos = combos;
    return combos;
  }catch(error){
    console.warn("Reorder combo refresh failed:", error);
    return [];
  }
}

function findMenuDishForOrderItem(item = {}, dishes = []){
  const ids = [
    item.dishId,
    item.productId,
    item.menuItemId,
    item.itemId,
    item.id
  ].map(value => String(value || "").trim()).filter(Boolean);
  const byId = dishes.find(dish => ids.some(id => String(dish.id || "") === id));
  if(byId) return byId;
  const itemName = reorderLookupText(item.name || item.itemName || "");
  const itemCategory = reorderLookupText(item.category || item.dishCategory || "");
  if(!itemName) return null;
  return dishes.find(dish => {
    const sameName = reorderLookupText(dish.name || "") === itemName;
    if(!sameName) return false;
    if(!itemCategory) return true;
    return reorderLookupText(dish.category || "") === itemCategory;
  }) || dishes.find(dish => reorderLookupText(dish.name || "") === itemName);
}

function findComboForOrderItem(item = {}, combos = []){
  const ids = [item.comboId, item.offerId, item.id].map(value => String(value || "").trim()).filter(Boolean);
  const byId = combos.find(combo => ids.some(id => String(combo.id || "") === id));
  if(byId) return byId;
  const itemName = reorderLookupText(item.comboName || item.name || "");
  if(!itemName) return null;
  return combos.find(combo => reorderLookupText(combo.name || "") === itemName);
}

function dishVariantForReorder(dish = {}, item = {}){
  const requestedSize = reorderLookupText(item.size || "Regular");
  if(dish.type === "simple"){
    const price = Number(dish.price || 0);
    return price > 0
      ? { size:"Regular", price, market:Number(dish.marketPrice || price + 20) }
      : null;
  }
  const sizes = dish.sizes || {};
  const entries = Object.entries(sizes).map(([key, value]) => {
    const price = typeof value === "object" ? Number(value.price || 0) : Number(value || 0);
    const market = typeof value === "object" ? Number(value.market || price + 50) : price + 50;
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    return { key, size:label, price, market };
  }).filter(variant => variant.price > 0);
  if(!entries.length) return null;
  return entries.find(variant => reorderLookupText(variant.size) === requestedSize || reorderLookupText(variant.key) === requestedSize) || null;
}

function rebuildComboCartItemFromOrder(item = {}, combo = {}){
  const qty = Math.max(1, Number(item.qty || item.quantity || 1) || 1);
  const price = Number(combo.comboPrice || item.baseUnitPrice || item.unitPrice || (qty ? Number(item.price || 0) / qty : 0)) || 0;
  return normalizeCartItemPricing({
    id:combo.id || item.comboId || "",
    name:combo.name || item.name || "MAGNEETOZ Combo",
    size:"Combo",
    qty,
    category:"Combo",
    image:normalizeImageUrl(combo.image || item.image || "logo_tran.jpeg"),
    baseUnitPrice:price,
    unitPrice:price,
    price:price * qty,
    comboId:combo.id || item.comboId || "",
    itemsIncluded:combo.itemsIncluded || item.itemsIncluded || ""
  });
}

function rebuildCartItemFromOrder(item = {}, menuDish = null){
  const qty = Math.max(1, Number(item.qty || item.quantity || 1));
  const extras = normalizeCartExtras(item.extras || item.addOns || item.addons || item.extraToppings);
  const crust = normalizeCrust(item.crust || item.crustType || item.selectedCrust);
  const variant = menuDish ? dishVariantForReorder(menuDish, item) : null;
  const baseUnitPrice = Number(variant?.price || item.baseUnitPrice || item.unitPrice || (qty ? Number(item.price || 0) / qty - extrasTotalPerUnit(extras) : 0)) || 0;
  return normalizeCartItemPricing({
    id:menuDish?.id || item.id || item.dishId || "",
    name:menuDish?.name || item.name || "MAGNEETOZ Item",
    size:variant?.size || item.size || "Regular",
    qty,
    category:menuDish?.category || item.category || item.dishCategory || "Recommended",
    image:normalizeImageUrl(bestImageUrl(menuDish?.image, menuDish?.imageSet) || item.image || "logo_tran.jpeg"),
    baseUnitPrice,
    unitPrice:baseUnitPrice,
    extras,
    addOns:extras,
    crust,
    crustType:crust.label,
    selectedCrust:crust.id,
    comboId:item.comboId || "",
    itemsIncluded:item.itemsIncluded || ""
  });
}

function orderCanBeReordered(order = {}){
  return normalizeTimelineStatus(order.status || order.orderStatus || order.lifecycleStatus) === "Delivered"
    && orderItemsForReorder(order).length > 0;
}

window.orderAgain = async function(orderId = ""){
  const order = (liveOrders || []).find(item => String(item.id) === String(orderId));
  if(!order || !orderCanBeReordered(order)){
    toastWarning("Order Again sirf delivered orders ke liye available hai.");
    return;
  }
  const [dishes, combos] = await Promise.all([getReorderMenuDishes(), getReorderCombos()]);
  const skipped = [];
  const rebuilt = orderItemsForReorder(order).map(orderItem => {
    const isComboItem = String(orderItem.comboId || orderItem.category || orderItem.size || "").toLowerCase().includes("combo");
    if(isComboItem){
      const combo = findComboForOrderItem(orderItem, combos);
      if(!combo){
        skipped.push(orderItem.name || "Combo");
        return null;
      }
      return rebuildComboCartItemFromOrder(orderItem, combo);
    }
    const menuDish = findMenuDishForOrderItem(orderItem, dishes);
    const variant = menuDish ? dishVariantForReorder(menuDish, orderItem) : null;
    if(!menuDish || !menuDishAvailableForReorder(menuDish)){
      skipped.push(orderItem.name || "Item");
      return null;
    }
    if(!variant){
      skipped.push(`${orderItem.name || menuDish.name || "Item"} (${orderItem.size || "size unavailable"})`);
      return null;
    }
    return rebuildCartItemFromOrder(orderItem, menuDish);
  }).filter(item => item && item.name && item.price >= 0);
  if(!rebuilt.length){
    toastWarning("Is order ke items ab menu me available nahi hain.");
    return;
  }
  cart = rebuilt;
  bogoOfferAccepted = false;
  activeCoupon = null;
  const couponInput = document.getElementById("couponInput");
  if(couponInput) couponInput.value = "";
  walletPointsRequested = 0;
  persistGuestState();
  updateCart();
  toggleCart(true);
  if(skipped.length){
    toastWarning(`${skipped.length} item skip hua: ${skipped.slice(0, 2).join(", ")}${skipped.length > 2 ? "..." : ""}`);
  }
  toastSuccess(`${rebuilt.length} item cart me add ho gaye. Charges/coupons fresh calculate honge.`);
};

function estimateJsonBytes(value){
  try{
    return new Blob([JSON.stringify(value)]).size;
  }catch(_error){
    return 0;
  }
}

function persistGuestState(){
  clearTimeout(guestStatePersistTimer);
  guestStatePersistTimer = setTimeout(() => {
    const compactCart = compactCartForStorage(cart);
    localStorage.setItem(GUEST_CART_KEY, JSON.stringify({
      cart:compactCart,
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
    const found = findCouponByCode(saved.activeCouponCode);
    if(found) activeCoupon = found;
  }
  if(!activeCoupon) applyReferralCouponIfPossible();
  updateCart();
  if(user?.uid){
    const compactCart = compactCartForStorage(cart);
    await setDoc(doc(db, "users", user.uid), {
      uid:user.uid,
      guestCartMergedAt:serverTimestamp(),
      lastCheckoutState:{
        cart:compactCart,
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
    try{ new Audio("order-alert.mpeg").play().catch(() => {}); }catch(_){}
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
  const explicitGroup = String(category.parent || category.group || category.mainCategory || "").trim();
  if(explicitGroup){
    return {
      key:normalizeCategoryId(explicitGroup),
      label:explicitGroup
    };
  }
  const raw = String(category.type || category.name || "Recommended").trim();
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

function directCategoryForGroup(group = {}){
  const categories = Array.isArray(group.categories) ? group.categories : [];
  if(categories.length === 1) return categories[0];
  const sameNameCategories = categories.filter(category => normalizeCategoryId(category.name) === normalizeCategoryId(group.label));
  if(sameNameCategories.length) return sameNameCategories[0];
  const directCategories = categories.filter(category => category.buttonIsCategory === true);
  if(directCategories.length === categories.length && directCategories[0]) return directCategories[0];
  return null;
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
  const priority = { pizza:0, burger:1 };
  return [...map.values()].sort((a,b) =>
    (priority[a.key] ?? 99) - (priority[b.key] ?? 99) ||
    a.label.localeCompare(b.label)
  );
}

function renderMenuGroupNav(groups = []){
  const nav = document.getElementById("categoryNav");
  if(!nav) return;
  const menuGroups = groups.filter(group => group.key !== "combo");
  nav.innerHTML = `
    <button type="button" class="category-tab menu-special-tab active" data-menu-action="all">
      <span class="category-special-icon">ALL</span>
      <span class="category-tab-label">All</span>
    </button>
    <button type="button" class="category-tab menu-special-tab" data-menu-action="combo">
      <span class="category-special-icon">🍕+</span>
      <span class="category-tab-label">Combo</span>
    </button>
  ` + menuGroups.map((group, index) => `
    <button type="button" class="category-tab menu-group-tab" data-menu-group="${escapeHTML(group.key)}">
      ${categoryImageMarkup({ ...(group.categories[0] || {}), groupImage:group.groupImage }, group.label)}
      <span class="category-tab-label">${escapeHTML(group.label)}</span>
    </button>
  `).join("");
  nav.querySelector('[data-menu-action="all"]')?.addEventListener("click", () => {
    closeMenuBrowser();
    document.querySelectorAll("[data-menu-action]").forEach(button => button.classList.toggle("active", button.dataset.menuAction === "all"));
    document.getElementById("menuSection")?.scrollIntoView({ behavior:"smooth", block:"start" });
  });
  nav.querySelector('[data-menu-action="combo"]')?.addEventListener("click", () => {
    closeMenuBrowser();
    document.querySelectorAll("[data-menu-action]").forEach(button => button.classList.toggle("active", button.dataset.menuAction === "combo"));
    document.getElementById("combosSection")?.scrollIntoView({ behavior:"smooth", block:"start" });
  });
  nav.querySelectorAll("[data-menu-group]").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-menu-action]").forEach(item => item.classList.remove("active"));
      const group = menuCategoryGroups.find(item => item.key === button.dataset.menuGroup);
      const directCategory = directCategoryForGroup(group);
      if(directCategory){
        document.querySelectorAll("[data-menu-group]").forEach(item => item.classList.toggle("active", item.dataset.menuGroup === group.key));
        menuBrowserOpen = true;
        activeMenuGroup = group.key;
        selectMenuCategory(directCategory.id);
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
    block.hidden = false;
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
  if(menuBrowserOpen && activeMenuGroup === group.key){
    closeMenuBrowser();
    return;
  }
  menuBrowserOpen = true;
  menuBrowserHideOnNextScroll = false;
  activeMenuGroup = group.key;
  activeMenuCategory = "";
  document.querySelectorAll("[data-menu-group]").forEach(button => {
    button.classList.toggle("active", button.dataset.menuGroup === activeMenuGroup);
  });
  renderVisibleMenuCategories();
  document.querySelectorAll(".category-block").forEach(block => {
    block.hidden = true;
    block.classList.remove("menu-category-active");
  });
  if(shouldScroll){
    requestAnimationFrame(() => {
      const target = document.getElementById("menuCategoryBrowser");
      if(!target) return;
      const sticky = document.querySelector(".sticky-area");
      const offset = (sticky?.getBoundingClientRect().height || 0) + 10;
      window.scrollTo({
        top:Math.max(0,target.getBoundingClientRect().top + window.scrollY - offset),
        behavior:"smooth"
      });
    });
  }
}

function selectMenuCategory(categoryId){
  activeMenuCategory = categoryId || activeMenuCategory;
  menuBrowserHideOnNextScroll = false;
  renderVisibleMenuCategories();
  menuBrowserOpen = false;
  const browser = document.getElementById("menuCategoryBrowser");
  if(browser) browser.innerHTML = "";
  requestAnimationFrame(() => {
    const target = document.getElementById(activeMenuCategory);
    if(!target) return;
    const sticky = document.querySelector(".sticky-area");
    const offset = (sticky?.getBoundingClientRect().height || 0) + 10;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top:Math.max(0, top), behavior:"smooth" });
  });
}

function orderedGroupCategoryIds(group){
  if(!group) return [];
  const ids = group.categories.map(category => category.id);
  return activeMenuCategory && ids.includes(activeMenuCategory) ? [activeMenuCategory] : [];
}

function scrollToBogoTarget(){
  const category = (activeBogoOffer?.eligibleCategories || []).find(Boolean);
  if(category){
    const targetId = `grid-cat-${normalizeCategoryId(category)}`;
    const target = document.getElementById(targetId);
    if(target){
      closeMenuBrowser();
      document.getElementById("menuSection")?.scrollIntoView({ behavior:"smooth", block:"start" });
      requestAnimationFrame(() => {
        const sticky = document.querySelector(".sticky-area");
        const offset = (sticky?.getBoundingClientRect().height || 0) + 10;
        const top = target.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({ top:Math.max(0, top), behavior:"smooth" });
        target.classList.add("menu-category-active");
        setTimeout(() => target.classList.remove("menu-category-active"), 1600);
      });
      return;
    }
  }
  document.getElementById("offersSection")?.scrollIntoView({ behavior:"smooth", block:"start" });
}

function bindHeroOfferActions(){
  const comboBtn = document.getElementById("heroComboJumpBtn");
  const bogoBtn = document.getElementById("heroBogoJumpBtn");
  const bestSellerBtn = document.getElementById("heroBestSellerJumpBtn");
  const heroBestSellerBtn = document.getElementById("heroBestSellerBtn");
  const scrollToBestSellers = () => {
    document.getElementById("homepageBestSellers")?.scrollIntoView({ behavior:"smooth", block:"start" });
    requestAnimationFrame(() => {
      const firstCategory = document.querySelector(".homepage-best-seller-card, .inline-menu-section .category-block, .inline-menu-section .new-card");
      firstCategory?.classList.add("menu-category-active");
      setTimeout(() => firstCategory?.classList.remove("menu-category-active"), 1400);
    });
  };
  comboBtn?.addEventListener("click", () => document.getElementById("combosSection")?.scrollIntoView({ behavior:"smooth", block:"start" }));
  bogoBtn?.addEventListener("click", scrollToBogoTarget);
  bestSellerBtn?.addEventListener("click", scrollToBestSellers);
  heroBestSellerBtn?.addEventListener("click", scrollToBestSellers);
}

function updateHeroBogoButton(){
  const bogoBtn = document.getElementById("heroBogoJumpBtn");
  if(!bogoBtn) return;
  if(!activeBogoOffers.length && !activeBogoOffer){
    bogoBtn.textContent = "BOGO";
    bogoBtn.disabled = true;
    bogoBtn.title = "No BOGO offer live right now";
    return;
  }
  const offers = activeBogoOffers.length ? activeBogoOffers : [activeBogoOffer];
  const fallback = offers.length > 1 ? "B1G1 + B2G1" : offers[0].type === "buy_2_get_1" ? "BUY 2 GET 1" : "BUY 1 GET 1";
  bogoBtn.textContent = String(offers.length > 1 ? fallback : (offers[0].offerName || fallback)).toUpperCase();
  bogoBtn.disabled = false;
  bogoBtn.title = "View live BOGO offer";
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
      <div>
        <span>${escapeHTML(group.label)}</span>
        <strong>${group.categories.length} categories</strong>
      </div>
      <button type="button" class="menu-browser-close" aria-label="Hide ${escapeHTML(group.label)} categories">
        Hide <b aria-hidden="true">×</b>
      </button>
    </div>
    ${renderMenuSubcategoryNav(group)}
  `;
  browser.querySelector(".menu-browser-close")?.addEventListener("click", closeMenuBrowser);
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
  return "";
}

function dishToppingText(d = {}){
  const raw = d.toppings || d.topping || d.ingredients || d.description || "";
  if(Array.isArray(raw)) return raw.filter(Boolean).slice(0, 4).join(", ");
  return String(raw || "Classic MAGNEETOZ toppings").slice(0, 90);
}

function bogoDishEligibleForOffer(d = {}, offer = activeBogoOffer){
  if(!offer) return false;
  const allowed = new Set((offer.eligibleCategories || []).map(normalizeOfferCategory).filter(Boolean));
  const category = normalizeOfferCategory(d.category || d.dishCategory || "");
  return allowed.size ? allowed.has(category) : /pizza/i.test(`${d.productType || ""} ${d.category || ""} ${d.name || ""}`);
}

function bogoDishEligible(d = {}){
  return activeBogoOffers.some(offer => bogoDishEligibleForOffer(d, offer));
}

function bogoSizeLabel(offer = activeBogoOffer){
  const codeBySize = {
    regular:"R",
    small:"R",
    medium:"M",
    large:"L"
  };
  const order = ["medium", "large", "regular", "small"];
  const normalized = [...new Set((offer?.eligibleSizes || []).map(normalizeOfferSize).filter(Boolean))];
  if(!normalized.length) return "ALL";
  const ordered = [
    ...order.filter(size => normalized.includes(size)),
    ...normalized.filter(size => !order.includes(size))
  ];
  return ordered.map(size => codeBySize[size] || size.slice(0, 1).toUpperCase()).join(" ");
}

function bogoCardBadge(d = {}){
  const offers = activeBogoOffers.filter(offer => bogoDishEligibleForOffer(d, offer));
  if(!offers.length) return "";
  const label = offers.map(offer => `${offer.type === "buy_2_get_1" ? "B2G1" : "B1G1"} ${bogoSizeLabel(offer)}`).join(" / ");
  return `<span class="bogo-menu-badge">${escapeHTML(label)}</span>`;
}

function bogoSizeEligibleLabel(size = ""){
  const offers = activeBogoOffers.length ? activeBogoOffers : (activeBogoOffer ? [activeBogoOffer] : []);
  if(!offers.length) return false;
  const normalizedSize = normalizeOfferSize(size);
  return offers.some(offer => {
  const allowedSizes = new Set((offer?.eligibleSizes || []).map(normalizeOfferSize).filter(Boolean));
  return !allowedSizes.size || allowedSizes.has(normalizedSize);
  });
}

function dishCardMarkup(d = {}, className = ""){
  const safeCallName = String(d.name || "").replace(/\\/g,"\\\\").replace(/'/g,"\\'");
  const dishAttrs = dishDataAttrs(d);
  if(d.type === "simple"){
    return `
      <div class="card new-card ${className}" ${dishAttrs}>
        <button type="button" class="quick-preview-btn" data-preview>Preview</button>
        ${bogoCardBadge(d)}
        <div class="card-img">${imageMarkup(d.image, d.name, d.imageSet)}</div>
        <div class="card-body">
          <h3>${escapeHTML(d.name || "")}</h3>
          <p>${escapeHTML(d.description || "")}</p>
          <div class="card-footer">
            <div class="price-box">
              <span class="offer" data-base="${d.price || 0}">${formatCurrency(d.price)}</span>
              <span class="market" data-base="${d.marketPrice || (Number(d.price || 0) + 20)}">${formatCurrency(d.marketPrice || (Number(d.price || 0) + 20))}</span>
            </div>
            <button class="add-cart-btn" onclick="addToCartSimple(this,'${safeCallName}')">Add +</button>
          </div>
        </div>
      </div>`;
  }
  if(!d.sizes) return "";
  const getSize = size => !size ? { price:0, market:50 } : typeof size === "object" ? size : { price:size, market:Number(size) + 50 };
  const small = getSize(d.sizes.small);
  const medium = getSize(d.sizes.medium);
  const large = getSize(d.sizes.large);
  const sizeButtons = [
    ["Regular", small],
    ["Medium", medium],
    ["Large", large]
  ].map(([label, size], index) => `
    <button type="button" class="size-option ${index === 0 ? "active" : ""}" data-size="${label}" data-price="${size.price}" data-market="${size.market}" onclick="selectPizzaSize(this)">
      <span>${label}</span><b>${formatCurrency(size.price)}</b>${bogoDishEligible(d) && bogoSizeEligibleLabel(label) ? `<em>BOGO</em>` : ""}
    </button>
  `).join("");
  return `
    <div class="card new-card ${className}" ${dishAttrs}>
      <button type="button" class="quick-preview-btn" data-preview>Preview</button>
      ${bogoCardBadge(d)}
      <div class="card-img">${imageMarkup(d.image, d.name, d.imageSet)}</div>
      <div class="card-body">
        <h3>${escapeHTML(d.name || "")}</h3>
        <div class="size-options" role="radiogroup" aria-label="Choose pizza size">${sizeButtons}</div>
        <div class="topping-pill"><span>Topping</span><b>${escapeHTML(dishToppingText(d))}</b></div>
        <div class="card-footer">
          <div class="price-box">
            <span class="offer" data-base="${small.price}">${formatCurrency(small.price)}</span>
            <span class="market" data-base="${small.market}">${formatCurrency(small.market)}</span>
          </div>
          <button class="add-cart-btn" onclick="addToCartFull(this,'${safeCallName}')">Add +</button>
        </div>
      </div>
    </div>`;
}

function renderHomepageSections(){
  const host = document.getElementById("homepageFeaturedSections");
  if(!host) return;
  host.classList.remove("is-loading");
  host.setAttribute("aria-busy","false");
  const dishMap = new Map(allMenuDishes.map(dish => [dish.id, dish]));
  const sections = homepageSections
    .filter(section => section.active !== false)
    .sort((a,b) => Number(a.order || 0) - Number(b.order || 0))
    .map(section => ({
      ...section,
      dishes:(Array.isArray(section.productIds) ? section.productIds : [])
        .map(id => dishMap.get(id))
        .filter(dish => dish?.available)
    }))
    .filter(section => section.dishes.length);
  host.innerHTML = sections.map(section => `
    <section class="homepage-featured-section" aria-labelledby="featured-${escapeHTML(section.id)}">
      <div class="homepage-featured-head">
        <div>
          <p>${escapeHTML(section.subtitle || "Popular picks near you")}</p>
          <h2 id="featured-${escapeHTML(section.id)}">${escapeHTML(section.title || "Featured food")}</h2>
        </div>
        <span>${section.dishes.length} items</span>
      </div>
      <div class="homepage-featured-rail">
        ${section.dishes.map(dish => dishCardMarkup(dish, "homepage-featured-card")).join("")}
      </div>
    </section>
  `).join("");
  host.hidden = !sections.length;
  if(sections.length){
    warmVisibleMenuImages();
    applyRestaurantAvailability();
  }
}

const fallbackCustomerLoveReviews = [
  {
    title:"Fresh and hot",
    message:"Pizza arrived warm and tasted fresh. Checkout was simple.",
    name:"Greater Noida customer"
  },
  {
    title:"Easy tracking",
    message:"Live order updates made it easy to know when food was coming.",
    name:"Regular customer"
  },
  {
    title:"Good value",
    message:"Combos are filling, tasty, and perfect for quick cravings.",
    name:"MAGNEETOZ fan"
  }
];

function customerReviewCard(review = {}){
  const rating = Math.max(1, Math.min(5, Number(review.rating || 5)));
  const message = normalizeUnicodeText(review.message || review.comment || review.text || "");
  const name = normalizeUnicodeText(review.customerName || review.name || review.displayName || "MAGNEETOZ customer");
  return `
    <article>
      <div class="customer-love-stars" aria-label="${rating} star rating">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</div>
      <strong>${escapeHTML(review.title || (rating >= 5 ? "Loved the food" : "Happy customer"))}</strong>
      <p>${escapeHTML((message || "Fresh food, smooth ordering, and helpful delivery updates.").slice(0, 120))}</p>
      <span>${escapeHTML(name)}</span>
    </article>
  `;
}

function renderCustomerLoveReviews(reviews = fallbackCustomerLoveReviews, source = "fallback"){
  const grid = document.getElementById("customerLoveGrid");
  const sourceLabel = document.getElementById("customerLoveSource");
  if(!grid) return;
  const safeReviews = (Array.isArray(reviews) && reviews.length ? reviews : fallbackCustomerLoveReviews).slice(0, 3);
  grid.innerHTML = safeReviews.map(customerReviewCard).join("");
  if(sourceLabel) sourceLabel.textContent = source === "live" ? "Latest approved reviews" : "Customer favourites";
}

async function loadCustomerLoveReviews(){
  renderCustomerLoveReviews(fallbackCustomerLoveReviews, "fallback");
  try{
    const snapshot = await getDocs(query(collection(db, "feedback"), orderBy("createdAt", "desc")));
    const approved = snapshot.docs
      .map(item => ({ id:item.id, ...item.data() }))
      .filter(item => item.reviewStatus === "approved" && Number(item.rating || 0) >= 4)
      .slice(0, 3);
    if(approved.length) renderCustomerLoveReviews(approved, "live");
  }catch(error){
    console.warn("Customer love reviews fallback used:", error);
  }
}

function loadHomepageSections(){
  homepageSectionsUnsub?.();
  homepageSectionsUnsub = onSnapshot(
    query(collection(db,"homepageSections"), orderBy("order","asc")),
    snapshot => {
      homepageSections = snapshot.docs.map(item => ({ id:item.id, ...item.data() }));
      renderHomepageSections();
    },
    error => {
      console.warn("Homepage sections failed:", error);
      const host = document.getElementById("homepageFeaturedSections");
      if(host) host.hidden = true;
    }
  );
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
loadHomepageSections();
loadCustomerLoveReviews();

/* LOAD DELIVERY SETTINGS */

registerGlobalSnapshot(onSnapshot(
  doc(db,"settings","delivery"),
  (snap)=>{

    if(!snap.exists()) return;

    const data = snap.data();

    MAX_DELIVERY_DISTANCE =
      data.maxDeliveryDistanceKm || data.maxDistance || 6;

    ALL_INDIA_DELIVERY = false;
    VIP_DELIVERY_ENABLED = false;

    googleMapsApiKey =
      data.googleMapsApiKey || data.mapsApiKey || "";
    deliveryPricingSettings = {
      ...deliveryPricingSettings,
      freeDeliveryEnabled:data.freeDeliveryEnabled !== false,
      minimumOrderValue:Math.max(0, Number(data.minimumOrderValue ?? 0)) === 99 ? 0 : Math.max(0, Number(data.minimumOrderValue ?? 0)),
      flatDeliveryFee:deliverySettingNumber(data.flatDeliveryFee, 30, 24),
      maxDeliveryDistanceKm:MAX_DELIVERY_DISTANCE,
      whatsappNumber:String(data.whatsappNumber || deliveryPricingSettings.whatsappNumber).replace(/\D/g,""),
      zones:[
        { maxKm:1, threshold:deliverySettingNumber(data.zone1Threshold, 149, 99), fee:deliverySettingNumber(data.zone1Fee, 30, 24) },
        { maxKm:2, threshold:deliverySettingNumber(data.zone2Threshold, 199, 149), fee:deliverySettingNumber(data.zone2Fee, 30, 24) },
        { maxKm:3, threshold:deliverySettingNumber(data.zone3Threshold, 249, 199), fee:deliverySettingNumber(data.zone3Fee, 30, 24) },
        { maxKm:4, threshold:deliverySettingNumber(data.zone4Threshold, 299, 249), fee:deliverySettingNumber(data.zone4Fee, 30, 40) },
        { maxKm:5, threshold:deliverySettingNumber(data.zone5Threshold, 349, 299), fee:deliverySettingNumber(data.zone5Fee, 30, 50) },
        { maxKm:MAX_DELIVERY_DISTANCE, threshold:deliverySettingNumber(data.zone6Threshold, 399, 299), fee:deliverySettingNumber(data.zone6Fee, 40, 50) }
      ]
    };
    updateCart();

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
  applyHeroLayoutSettings(hero);
  syncHeroEmptyState(hero);
  renderHeroPizzaSlider(
    Array.isArray(hero.images) ? hero.images : [],
    Array.isArray(hero.imageSets) ? hero.imageSets : [],
    Array.isArray(hero.heroImages) ? hero.heroImages : []
  );
  setThemeParticles(String(vars["--particle-bg"] || "").trim() === "founder-gold");
  if((window.__magneetozActiveCombos || []).length){
    renderComboHeroSlides(window.__magneetozActiveCombos);
  }
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
      .filter(d => d.available && d.category)
      .sort((a,b) => Number(a.order ?? Number.MAX_SAFE_INTEGER) - Number(b.order ?? Number.MAX_SAFE_INTEGER)
        || String(a.name || "").localeCompare(String(b.name || "")));
    menuImageRenderIndex = 0;

    allMenuDishes.forEach(d => {
      if(!d.available || !d.category) return;
      rememberMenuDishImage(d.name, dishImageSource(d));
      rememberMenuCategoryImage(d.category, dishImageSource(d));

      const gridId = "grid-cat-" + normalize(d.category);

      if(categoriesReady && !categoryGridIds.has(gridId)){
        console.debug("Dish skipped because category section is unavailable:", d.category);
        return;
      }

      // 🟢 SIMPLE CARD
      if(d.type === "simple"){
        appendDish(gridId, dishCardMarkup(d));
      }

      // 🔵 SIZE BASED CARD
      else {

        if (!d.sizes) {
          console.error("❌ sizes missing in:", d.name);
          return;
        }

        appendDish(gridId, dishCardMarkup(d));
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
      rebuildMenuImageIndexFromDom();
      warmVisibleMenuImages();
      renderBestSellers();
      renderHomepageSections();
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
  window.open(`https://wa.me/${deliveryPricingSettings.whatsappNumber}?text=${encodeURIComponent(message)}`, "_blank");
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
  if(!hasSelectedCheckoutLocation() && !isFreshCustomerLocation(CHECKOUT_LOCATION_REUSE_MAX_AGE_MS)){
    await timedStep("ensureDeliveryEligible:getCurrentPosition", () => getUserLocation()).catch(() => null);
  }
  if(!hasSelectedCheckoutLocation() && !isFreshCustomerLocation(CHECKOUT_LOCATION_REUSE_MAX_AGE_MS)){
    updateCustomerDistanceBanner("📍 Select current location or search your address to check delivery.");
    openLocationSelector();
    showLocationAddressForm();
    showServiceAreaPopup("Current location nahi mil pa rahi. Please location allow karke retry karein, ya address search/manual address select karein.", {
      title:"Location Needed",
      icon:"📍",
      showContact:false,
      showRadius:false
    });
    logDistanceDebug("delivery_blocked_customer_location_missing_or_stale");
    return false;
  }
  const hasRouteDistance = await timedStep("ensureDeliveryEligible:refreshDeliveryDistance", () => refreshDeliveryDistance({ force:true, maxAgeMs:0, routeTimeoutMs:12000 }));
  if(!hasRouteDistance || distanceSource !== "google_routes_backend"){
    openLocationSelector();
    showServiceAreaPopup("Road route calculate nahi ho pa raha. Please address search se exact area select karein ya current location retry karein.", {
      title:"Route Check Failed",
      icon:"🛣️",
      showContact:false,
      showRadius:false
    });
    logDistanceDebug("delivery_blocked_route_distance_required");
    return false;
  }
  if(!ALL_INDIA_DELIVERY && !VIP_DELIVERY_ENABLED && deliveryDistance > MAX_DELIVERY_DISTANCE){
    showServiceAreaPopup("Sorry, we are not available at your location yet.");
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
    const message = geolocationErrorMessage(error);
    updateCustomerDistanceBanner(`📍 ${message}`);
    openLocationSelector();
    showLocationAddressForm();
    alert(message);
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
    setLocationUiState("lastSaved", saved.address || readJSON(CHECKOUT_STATE_KEY, {})?.address || "Saved delivery location");
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
  if(savedCart?.cartOpen || location.hash === "#cart"){
    setTimeout(() => toggleCart(true), 250);
  }

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
function calculateDeliveryCharge(subtotal, eligibleSubtotal = getCartBaseSubtotal()){

const pricing = calculateDistanceDeliveryPricing(deliveryDistance, subtotal, eligibleSubtotal);

if(!pricing.minimumOrderMet){

showMinOrderPopup(pricing.minimumRemaining);

return false;

}

if(!pricing.serviceable){
  showServiceAreaPopup("Sorry, we are not available at your location yet.");
  return false;
}
deliveryCharge = pricing.deliveryCharge;

return true;

}

function calculateDistanceDeliveryPricing(distanceKm = deliveryDistance, subtotal = getCartSubtotal(), eligibleSubtotal = getCartBaseSubtotal()){
  const distance = Math.max(0, Number(distanceKm) || 0);
  const deliveryEligibleSubtotal = Math.max(0, Number(eligibleSubtotal) || 0);
  const maxDistance = Math.max(0, Number(deliveryPricingSettings.maxDeliveryDistanceKm) || 6);
  const locationAvailable = distance > 0;
  const serviceable = locationAvailable && distance <= maxDistance;
  const zone = locationAvailable ? deliveryPricingSettings.zones.find(item => distance <= item.maxKm) : null;
  const threshold = Math.max(0, Number(zone?.threshold) || 0);
  const minimumOrderValue = Math.max(0, Number(deliveryPricingSettings.minimumOrderValue ?? 0));
  const minimumOrderMet = deliveryEligibleSubtotal >= minimumOrderValue;
  const baseCharge = Math.max(0, Number(zone?.fee ?? deliveryPricingSettings.flatDeliveryFee) || 30);
  const campaignFree = serviceable && minimumOrderMet && deliveryPricingSettings.freeDeliveryEnabled && deliveryEligibleSubtotal >= threshold;
  return {
    serviceable,
    locationAvailable,
    threshold,
    baseCharge,
    deliveryCharge:serviceable && minimumOrderMet && !campaignFree ? baseCharge : 0,
    freeDeliveryDiscount:campaignFree ? baseCharge : 0,
    eligibleSubtotal:deliveryEligibleSubtotal,
    remaining:Math.max(0, threshold - deliveryEligibleSubtotal),
    minimumOrderValue,
    minimumOrderMet,
    minimumRemaining:Math.max(0, minimumOrderValue - deliveryEligibleSubtotal),
    progress:threshold ? Math.min(100, Math.round(deliveryEligibleSubtotal / threshold * 100)) : 0,
    freeDelivery:campaignFree,
    deliveryRuleVersion:DELIVERY_RULE_VERSION
  };
}

function getDeliveryPolicyRows(){
  const zones = Array.isArray(deliveryPricingSettings.zones) ? deliveryPricingSettings.zones : [];
  return zones
    .map((zone, index) => {
      const fromKm = index === 0 ? 0 : Number(zones[index - 1]?.maxKm) || 0;
      const toKm = Number(zone?.maxKm) || 0;
      const threshold = Math.max(0, Number(zone?.threshold) || 0);
      const fee = Math.max(0, Number(zone?.fee ?? deliveryPricingSettings.flatDeliveryFee) || 0);
      if(!toKm || toKm <= fromKm) return "";
      return `<p><b>${fromKm}-${toKm} KM</b><span>Free above ${formatCurrency(threshold)}, else ${formatCurrency(fee)}</span></p>`;
    })
    .filter(Boolean);
}

function renderDeliveryPolicyRules(){
  const host = document.getElementById("deliveryPolicyRules");
  if(!host) return;
  const rows = getDeliveryPolicyRows();
  rows.push(`<p><b>Note</b><span>Free delivery rule uses base item amount only</span></p>`);
  rows.push(`<p><b>Above ${deliveryPricingSettings.maxDeliveryDistanceKm || 6} KM</b><span>Not Available</span></p>`);
  host.innerHTML = rows.join("");
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

function useCouponSnapshot(snapshot){
  availableCoupons = snapshot.docs.map(item => ({ id:item.id, ...item.data() }));
  const referral = capturePgReferralCoupon();
  const referralCoupon = findReferralCoupon(referral);
  if(referralCoupon) activeCoupon = referralCoupon;
  if(!activeCoupon){
    const saved = readJSON(GUEST_CART_KEY, null);
    const code = saved?.activeCouponCode || readJSON(CHECKOUT_STATE_KEY, {})?.activeCouponCode || "";
    const found = findCouponByCode(code);
    if(found) activeCoupon = found;
    if(!found) applyReferralCouponIfPossible();
  }
  if(activeCoupon) fillReferralCouponField(activeCoupon);
  renderAvailableCoupons();
  if(activeCoupon) validateActiveCoupon();
  updateCart();
}

registerGlobalSnapshot(onSnapshot(collection(db, "coupons"), useCouponSnapshot, async error => {
  console.warn("Coupon live updates unavailable; using one-time load.", error);
  try{
    useCouponSnapshot(await getDocs(collection(db, "coupons")));
  }catch(loadError){
    console.warn("Coupon load failed.", loadError);
    renderAvailableCoupons();
  }
}));
getDocs(collection(db, "coupons"))
  .then(useCouponSnapshot)
  .catch(error => console.warn("Initial coupon load failed.", error));

function useBogoOfferSnapshot(snapshot){
  const data = snapshot.exists() ? snapshot.data() : null;
  const commonCategories = Array.isArray(data?.eligibleCategories) ? data.eligibleCategories : [];
  const commonSizes = Array.isArray(data?.eligibleSizes) ? data.eligibleSizes : [];
  const offers = [];
  if(data?.buy1Get1Active === true || (data?.active === true && data?.type === "buy_1_get_1")){
    offers.push({
      ...data,
      active:true,
      type:"buy_1_get_1",
      offerName:data.buy1OfferName || data.offerName || "Buy 1 Get 1",
      eligibleCategories:Array.isArray(data.buy1EligibleCategories) ? data.buy1EligibleCategories : commonCategories,
      eligibleSizes:Array.isArray(data.buy1EligibleSizes) ? data.buy1EligibleSizes : commonSizes
    });
  }
  if(data?.buy2Get1Active === true || (data?.active === true && data?.type === "buy_2_get_1")){
    offers.push({
      ...data,
      active:true,
      type:"buy_2_get_1",
      offerName:data.buy2OfferName || data.offerName || "Buy 2 Get 1",
      eligibleCategories:Array.isArray(data.buy2EligibleCategories) ? data.buy2EligibleCategories : commonCategories,
      eligibleSizes:Array.isArray(data.buy2EligibleSizes) ? data.buy2EligibleSizes : commonSizes
    });
  }
  if(!offers.length && data?.active === true) offers.push(data);
  activeBogoOffers = offers;
  activeBogoOffer = offers[0] || null;
  if(!activeBogoOffers.length) bogoOfferAccepted = false;
  renderOfferRail();
  updateHeroBogoButton();
  if(menuListenerStarted){
    menuListenerStarted = false;
    loadMenu();
  }
  updateCart();
}

registerGlobalSnapshot(onSnapshot(doc(db, "settings", "offerEngine"), useBogoOfferSnapshot, async error => {
  console.warn("BOGO live updates unavailable; using one-time load.", error);
  try{
    useBogoOfferSnapshot(await getDoc(doc(db, "settings", "offerEngine")));
  }catch(loadError){
    console.warn("BOGO settings load failed.", loadError);
    activeBogoOffer = null;
    activeBogoOffers = [];
    updateCart();
  }
}));
getDoc(doc(db, "settings", "offerEngine"))
  .then(useBogoOfferSnapshot)
  .catch(error => console.warn("Initial BOGO load failed.", error));

function bogoOfferLabels(){
  const offer = calculateBogoOffer().offer || activeBogoOffer;
  const categories = (offer?.eligibleCategories || []).filter(Boolean);
  const sizes = (offer?.eligibleSizes || []).filter(Boolean);
  return {
    categories:categories.length ? categories.join(", ") : "Pizza",
    sizes:sizes.length ? sizes.join(", ") : "All sizes"
  };
}

function renderBogoLiveOfferCard(){
  if(!activeBogoOffers.length && !activeBogoOffer) return "";
  const cards = (activeBogoOffers.length ? activeBogoOffers : [activeBogoOffer]).map(offer => {
  const labels = {
    categories:(offer?.eligibleCategories || []).filter(Boolean).join(", ") || "Pizza",
    sizes:(offer?.eligibleSizes || []).filter(Boolean).join(", ") || "All sizes"
  };
  const typeLabel = offer.type === "buy_2_get_1" ? "Buy 2 Get 1 Free" : "Buy 1 Get 1 Free";
  return `
    <article class="offer-card offer-card-simple bogo-live-card">
      <img src="logo_tran.jpeg" alt="${escapeHTML(typeLabel)}" width="92" height="92" loading="lazy" decoding="async">
      <div>
        <span>Checkout offer live</span>
        <h3>${escapeHTML(typeLabel)}</h3>
        <p>Applicable on ${escapeHTML(labels.categories)} category. Size: ${escapeHTML(labels.sizes)}.</p>
        <button type="button" onclick="toggleCart(true)">View offer</button>
      </div>
    </article>
  `;
  });
  return cards.join("");
}

function renderOfferRail(){
  const host = document.getElementById("offerRail");
  if(!host) return;
  const offers = liveOfferCache
    .filter(offer => offer.active !== false && offer.deleted !== true)
    .slice(0, 8);
  const cards = [renderBogoLiveOfferCard(), ...offers.map(renderLiveOfferCard)].filter(Boolean);
  host.innerHTML = cards.join("") || `<p class="coupon-empty">Fresh offers will appear here.</p>`;
  const newest = offers[0];
  if(newest && sessionStorage.getItem("lastOfferSeen") !== newest.id){
    sessionStorage.setItem("lastOfferSeen", newest.id);
    notifyPremiumUI("magneetoz:offer-live", newest);
  }
}

registerGlobalSnapshot(onSnapshot(query(collection(db, "offers"), orderBy("createdAt", "desc")), (snapshot) => {
  liveOfferCache = snapshot.docs.map(item => ({ id:item.id, ...item.data() }));
  renderOfferRail();
}));

function offerSizeRows(offer = {}){
  const raw = offer.sizePrices || offer.sizes || offer.variants || offer.priceOptions || [];
  if(Array.isArray(raw)){
    return raw.map(item => ({
      label:item.label || item.name || item.size || "",
      price:Number(item.price || item.offerPrice || item.discountedPrice || 0),
      oldPrice:Number(item.oldPrice || item.originalPrice || item.marketPrice || 0)
    })).filter(item => item.label && item.price > 0).slice(0, 4);
  }
  if(raw && typeof raw === "object"){
    return Object.entries(raw).map(([label, value]) => ({
      label,
      price:Number(typeof value === "object" ? (value.price || value.offerPrice || value.discountedPrice) : value),
      oldPrice:Number(typeof value === "object" ? (value.oldPrice || value.originalPrice || value.marketPrice || 0) : 0)
    })).filter(item => item.label && item.price > 0).slice(0, 4);
  }
  return [];
}

function renderLiveOfferCard(offer = {}){
  const code = String(offer.couponCode || "").trim();
  const image = normalizeImageUrl(offer.image || offer.imageUrl || offer.photo || "logo_tran.jpeg");
  const sizes = offerSizeRows(offer);
  const isSizeBased = sizes.length || offer.cardType === "size_based" || offer.offerType === "size_based";
  return `
    <article class="offer-card ${isSizeBased ? "offer-card-size" : "offer-card-simple"}">
      <img src="${escapeHTML(image)}" alt="${escapeHTML(offer.title || "Offer")}" width="92" height="92" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='logo_tran.jpeg';">
      <div>
        <span>${isSizeBased ? "Size based offer" : (code ? "Use code" : "Magneetoz offer")}</span>
        <h3>${escapeHTML(offer.title || "Special Offer")}</h3>
        <p>${escapeHTML(offer.description || offer.notificationBody || "")}</p>
        ${isSizeBased ? `
          <div class="offer-size-list">
            ${sizes.map(size => `
              <div class="offer-size-row">
                <b>${escapeHTML(size.label)}</b>
                <strong>${formatCurrency(size.price)}</strong>
                ${size.oldPrice ? `<del>${formatCurrency(size.oldPrice)}</del>` : ""}
              </div>
            `).join("") || `<div class="offer-size-row"><b>Multiple sizes</b><strong>Live</strong></div>`}
          </div>
        ` : ""}
        ${code ? `<button type="button" onclick="applyCoupon('${escapeHTML(code)}')">${escapeHTML(code)}</button>` : ""}
      </div>
    </article>
  `;
}

function comboSavingsPercent(combo = {}){
  const original = Number(combo.originalPrice || combo.marketPrice || combo.comboPrice || 0);
  const price = Number(combo.comboPrice || 0);
  if(!original || original <= price) return 0;
  return Math.max(0, Math.round(((original - price) / original) * 100));
}

function comboHighlights(combo = {}, limit = 4){
  return String(combo.highlights || combo.itemsIncluded || combo.description || "")
    .split(/,|\n|•/)
    .map(text => text.trim())
    .filter(Boolean)
    .slice(0, limit);
}

registerGlobalSnapshot(onSnapshot(query(collection(db, "combos"), orderBy("createdAt", "desc")), (snapshot) => {
  const host = document.getElementById("comboRail");
  const featuredHost = document.getElementById("comboFeatured");
  if(!host) return;
  const combos = snapshot.docs
    .map(item => ({ id:item.id, ...item.data() }))
    .filter(comboIsOrderable)
    .sort((a,b) => Number(b.featured === true) - Number(a.featured === true) || Number(a.displayOrder ?? 999) - Number(b.displayOrder ?? 999))
    .slice(0, 12);
  const featured = combos.find(combo => combo.featured === true) || combos[0];
  const secondaryCombos = featured ? combos.filter(combo => combo.id !== featured.id) : combos;
  if(featuredHost){
    const featuredSave = Math.max(0, Number(featured?.originalPrice || 0) - Number(featured?.comboPrice || 0));
    const featuredPercent = comboSavingsPercent(featured || {});
    const featuredHighlights = comboHighlights(featured || {}, 5);
    featuredHost.innerHTML = featured ? `
      <article class="combo-feature-card" data-combo-id="${escapeHTML(featured.id)}" style="--combo-accent:${escapeHTML(featured.accentColor || "#ff6b00")}">
        <div class="combo-feature-visual">
          <img src="${escapeHTML(normalizeImageUrl(featured.image))}" alt="${escapeHTML(featured.name || "Featured combo")}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='logo_tran.jpeg';">
          ${featuredPercent ? `<span>${featuredPercent}% OFF</span>` : ""}
        </div>
        <div class="combo-feature-copy">
          <span class="combo-badge">${escapeHTML(featured.badge || "Best Value Combo")}</span>
          <p>${escapeHTML(featured.subtitle || "Perfect for sharing")}</p>
          <h3>${escapeHTML(featured.name || "MAGNEETOZ Combo")}</h3>
          <strong>${escapeHTML(featured.description || featured.itemsIncluded || "")}</strong>
          <div class="combo-highlights">
            ${featuredHighlights.map(text=>`<span>${escapeHTML(text)}</span>`).join("")}
          </div>
          <div class="combo-feature-bottom">
            <div class="combo-feature-price">
              <small>Combo price</small>
              <b>${formatCurrency(featured.comboPrice || 0)}</b>
              ${Number(featured.originalPrice || 0) > Number(featured.comboPrice || 0) ? `<s>${formatCurrency(featured.originalPrice || 0)}</s>` : ""}
              ${featuredSave ? `<em>Save ${formatCurrency(featuredSave)}</em>` : ""}
            </div>
            <button type="button" onclick="addComboToCart('${escapeHTML(featured.id)}')">${escapeHTML(featured.ctaText || "Add Combo")}</button>
          </div>
        </div>
      </article>` : "";
  }
  host.hidden = secondaryCombos.length === 0;
  host.innerHTML = secondaryCombos.map(combo => {
    const save = Math.max(0, Number(combo.originalPrice || 0) - Number(combo.comboPrice || 0));
    const percent = comboSavingsPercent(combo);
    const highlights = comboHighlights(combo, 3);
    return `
    <article class="combo-card" data-combo-id="${escapeHTML(combo.id)}" style="--combo-accent:${escapeHTML(combo.accentColor || "#ff6b00")}">
      <div class="combo-card-media">
        <img src="${escapeHTML(normalizeImageUrl(combo.image))}" alt="${escapeHTML(combo.name || "Combo")}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='logo_tran.jpeg';">
        ${percent ? `<span>${percent}% OFF</span>` : ""}
      </div>
      <div>
        <span>${escapeHTML(combo.badge || "Combo deal")}</span>
        <h3>${escapeHTML(combo.name || "MAGNEETOZ Combo")}</h3>
        <p>${escapeHTML(combo.description || combo.itemsIncluded || "")}</p>
        ${highlights.length ? `<div class="combo-mini-highlights">${highlights.map(text => `<small>${escapeHTML(text)}</small>`).join("")}</div>` : ""}
        <div class="combo-price-row">
          <b>${formatCurrency(combo.comboPrice || 0)}</b>
          ${Number(combo.originalPrice || 0) > Number(combo.comboPrice || 0) ? `<s>${formatCurrency(combo.originalPrice || 0)}</s>` : ""}
          ${save ? `<em>Save ${formatCurrency(save)}</em>` : ""}
        </div>
        <button type="button" onclick="addComboToCart('${escapeHTML(combo.id)}')">${escapeHTML(combo.ctaText || "Add Combo")}</button>
      </div>
    </article>
  `;
  }).join("");
  window.__magneetozActiveCombos = combos;
  renderComboHeroSlides(combos);
}));

function getCartSubtotal(){
  normalizeCartPricing();
  return cart.reduce((sum, item) => sum + item.price, 0);
}

function getCartBaseSubtotal(){
  normalizeCartPricing();
  return cart.reduce((sum, item) => sum + (Number(item.baseUnitPrice || item.unitPrice || 0) * Number(item.qty || item.quantity || 1)), 0);
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
  const distancePricing = calculateDistanceDeliveryPricing(deliveryDistance, subtotal);
  deliveryCharge = distancePricing.deliveryCharge;
  let couponDiscount = 0;
  let freeDeliveryDiscount = distancePricing.freeDeliveryDiscount;
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

function calculateCouponPricingWithoutCoupon(subtotal = getCartSubtotal()){
  const distancePricing = calculateDistanceDeliveryPricing(deliveryDistance, subtotal);
  deliveryCharge = distancePricing.deliveryCharge;
  return {
    subtotal,
    couponDiscount:0,
    deliveryCharge,
    freeDeliveryDiscount:distancePricing.freeDeliveryDiscount,
    finalTotal:Math.max(0, subtotal + deliveryCharge)
  };
}

function cartSmartDishSuggestions(limit = 4){
  return [...(allMenuDishes || [])]
    .filter(dish => dish?.available && dishLowestVariant(dish).price > 0)
    .sort((a, b) => scoreBestSellerDish(b) - scoreBestSellerDish(a)
      || Number(a.order ?? Number.MAX_SAFE_INTEGER) - Number(b.order ?? Number.MAX_SAFE_INTEGER)
      || String(a.name || "").localeCompare(String(b.name || "")))
    .slice(0, limit);
}

function cartSmartComboSuggestions(limit = 3){
  return [...(window.__magneetozActiveCombos || [])]
    .filter(combo => combo && combo.active !== false && combo.deleted !== true && Number(combo.comboPrice || 0) > 0)
    .sort((a, b) => Number(b.featured === true) - Number(a.featured === true)
      || Number(a.displayOrder ?? 999) - Number(b.displayOrder ?? 999))
    .slice(0, limit);
}

function cartSuggestionCard(item = {}, type = "dish"){
  const isCombo = type === "combo";
  const price = isCombo ? Number(item.comboPrice || 0) : Number(dishLowestVariant(item).price || 0);
  const name = item.name || (isCombo ? "MAGNEETOZ Combo" : "MAGNEETOZ Item");
  const image = normalizeImageUrl(bestImageUrl(item.image, item.imageSet) || "logo_tran.jpeg");
  const action = isCombo
    ? `addComboToCart('${escapeHTML(String(item.id || ""))}')`
    : `addBestSellerItem('${escapeHTML(String(item.id || ""))}')`;
  return `
    <article class="cart-suggestion-card">
      <img src="${escapeHTML(image)}" alt="${escapeHTML(name)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='logo_tran.jpeg';">
      <div>
        <small>${escapeHTML(isCombo ? "Combo" : (item.category || "Best seller"))}</small>
        <strong>${escapeHTML(name)}</strong>
        <span>${formatCurrency(price)}</span>
      </div>
      <button type="button" onclick="${action}">Add</button>
    </article>
  `;
}

function renderCartSmartSuggestions(total = getCartSubtotal()){
  const host = document.getElementById("cartSmartSuggestions");
  if(!host) return;
  const baseSubtotal = getCartBaseSubtotal();
  const pricing = calculateDistanceDeliveryPricing(deliveryDistance, total, baseSubtotal);
  const hasItems = cart.length > 0;
  const remainingForFree = Math.max(0, Number(pricing.threshold || DEFAULT_FREE_DELIVERY_MIN) - baseSubtotal);
  const combos = cartSmartComboSuggestions(hasItems ? 2 : 3);
  const dishes = cartSmartDishSuggestions(hasItems ? 3 : 4);
  const suggestions = [
    ...combos.map(item => ({ type:"combo", item })),
    ...dishes.map(item => ({ type:"dish", item }))
  ].slice(0, hasItems ? 4 : 6);

  if(!suggestions.length || (hasItems && remainingForFree <= 0)){
    host.innerHTML = "";
    host.hidden = true;
    return;
  }

  const title = hasItems
    ? (remainingForFree > 0 ? `Add ${formatCurrency(remainingForFree)} more to save delivery fee` : "You unlocked the best cart value")
    : "Start with best sellers";
  const subtitle = hasItems
    ? "Base item amount count hota hai. Extra toppings minimum/free delivery me count nahi hote."
    : "Popular items aur combos direct cart me add karein.";

  host.hidden = false;
  host.innerHTML = `
    <div class="cart-suggestion-head">
      <div><strong>${escapeHTML(title)}</strong><span>${escapeHTML(subtitle)}</span></div>
      ${hasItems && remainingForFree > 0 ? `<b>${formatCurrency(baseSubtotal)} / ${formatCurrency(pricing.threshold || DEFAULT_FREE_DELIVERY_MIN)}</b>` : ""}
    </div>
    <div class="cart-suggestion-rail">
      ${suggestions.map(entry => cartSuggestionCard(entry.item, entry.type)).join("")}
    </div>
  `;
}

function normalizeOfferCategory(value = ""){
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function normalizeOfferSize(value = ""){
  const text = String(value || "").trim().toLowerCase();
  if(["regular", "small", "personal"].includes(text)) return "regular";
  if(["medium", "med"].includes(text)) return "medium";
  if(["large", "big"].includes(text)) return "large";
  return text.replace(/\s+/g, " ");
}

function calculateBogoOfferForOffer(offer){
  const originalTotal = getCartSubtotal();
  const requiredItemCount = offer?.type === "buy_2_get_1" ? 3 : 2;
  if(!offer || offer.active !== true){
    return { originalTotal, discount:0, finalTotal:originalTotal, freeItems:[], offerApplied:false, eligibleItemCount:0, requiredItemCount };
  }
  const allowed = new Set((offer.eligibleCategories || []).map(normalizeOfferCategory).filter(Boolean));
  const allowedSizes = new Set((offer.eligibleSizes || []).map(normalizeOfferSize).filter(Boolean));
  const units = [];
  cart.forEach(item => {
    const category = normalizeOfferCategory(item.category || item.dishCategory || "");
    const eligible = allowed.size ? allowed.has(category) : /pizza/i.test(`${item.productType || ""} ${item.category || ""} ${item.name || ""}`);
    if(!eligible) return;
    const size = normalizeOfferSize(item.size || "Regular");
    if(allowedSizes.size && !allowedSizes.has(size)) return;
    const qty = Math.max(1, Number(item.qty) || 1);
    const unitPrice = Number(item.unitPrice || Number(item.price || 0) / qty) || 0;
    for(let index = 0; index < qty; index++){
      units.push({ id:item.id || item.dishId || item.name, name:item.name || "Pizza", price:unitPrice });
    }
  });
  units.sort((a,b) => a.price - b.price);
  const freeUnitCount = Math.floor(units.length / requiredItemCount);
  const freeUnits = units.slice(0, freeUnitCount);
  const discount = Math.round(freeUnits.reduce((sum,item) => sum + item.price, 0));
  const grouped = new Map();
  freeUnits.forEach(item => {
    const key = `${item.id}:${item.price}`;
    const current = grouped.get(key) || { ...item, qty:0 };
    current.qty += 1;
    grouped.set(key, current);
  });
  return {
    originalTotal,
    discount,
    finalTotal:Math.max(0, originalTotal - discount),
    freeItems:[...grouped.values()],
    offerApplied:discount > 0,
    eligibleItemCount:units.length,
    requiredItemCount,
    offer
  };
}

function calculateBogoOffer(){
  const originalTotal = getCartSubtotal();
  const offers = activeBogoOffers.length ? activeBogoOffers : (activeBogoOffer ? [activeBogoOffer] : []);
  if(!offers.length) return { originalTotal, discount:0, finalTotal:originalTotal, freeItems:[], offerApplied:false, eligibleItemCount:0, requiredItemCount:2 };
  return offers
    .map(calculateBogoOfferForOffer)
    .sort((a,b) => b.discount - a.discount || a.requiredItemCount - b.requiredItemCount)[0];
}

function renderBogoOfferPanel(){
  const host = document.getElementById("bogoOfferPanel");
  if(!host) return;
  if(!activeBogoOffers.length && !activeBogoOffer){
    host.innerHTML = "";
    return;
  }
  const result = calculateBogoOffer();
  const offer = result.offer || activeBogoOffer;
  const applied = bogoOfferAccepted && result.offerApplied;
  const typeLabel = offer?.type === "buy_2_get_1" ? "Buy 2 Get 1 Free" : "Buy 1 Get 1 Free";
  const labels = bogoOfferLabels();
  const remaining = Math.max(0, result.requiredItemCount - result.eligibleItemCount);
  const freeItems = result.freeItems || [];
  const freeText = freeItems.length
    ? freeItems.map(item => `${escapeHTML(item.name)}${item.qty > 1 ? ` x${item.qty}` : ""}`).join(", ")
    : "Cheapest eligible item will be free";
  const progress = Math.min(100, Math.round((Math.min(result.eligibleItemCount, result.requiredItemCount) / Math.max(1, result.requiredItemCount)) * 100));
  const statusText = result.offerApplied
    ? `Ready: ${freeText}`
    : `Add ${remaining} more eligible item${remaining === 1 ? "" : "s"} to unlock free item`;
  host.innerHTML = `
    <div class="bogo-cart-card ${applied ? "is-applied" : ""}">
      <div class="bogo-cart-head">
        <div>
          <span>Live BOGO offer</span>
          <strong>${escapeHTML(typeLabel)}</strong>
        </div>
        <button type="button" onclick="applyBogoOffer()" ${!result.offerApplied || applied ? "disabled" : ""}>${applied ? "Applied" : "Apply Offer"}</button>
      </div>
      <div class="bogo-rule-grid">
        <p><span>Valid category</span><b>${escapeHTML(labels.categories)}</b></p>
        <p><span>Valid size</span><b>${escapeHTML(labels.sizes)}</b></p>
        <p><span>Offer rule</span><b>Add ${result.requiredItemCount}, get ${offer?.type === "buy_2_get_1" ? "1" : "1"} free</b></p>
      </div>
      <div class="bogo-progress-row">
        <div><span>Eligible items</span><b>${result.eligibleItemCount}/${result.requiredItemCount}</b></div>
        <i><em style="width:${progress}%"></em></i>
      </div>
      <div class="bogo-free-preview ${result.offerApplied ? "ready" : ""}">
        <span>${result.offerApplied ? "Free item" : "Next step"}</span>
        <strong>${statusText}</strong>
      </div>
      ${applied ? `<small class="bogo-applied-note">Coupon and Pizza Points are disabled while this BOGO offer is applied.</small>` : ""}
    </div>`;
}

window.applyBogoOffer = function(){
  const result = calculateBogoOffer();
  if(!result.offerApplied) return;
  bogoOfferAccepted = true;
  activeCoupon = null;
  walletPointsRequested = 0;
  const couponInput = document.getElementById("couponInput");
  if(couponInput) couponInput.value = "";
  updateCart();
};

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
    const itemPayable = calculateCartItemPayable(result);
    breakdown.innerHTML = `
      <div><span>Subtotal</span><b>${formatCurrency(result.subtotal)}</b></div>
      ${result.offerApplied ? `<div><span>Offer Discount</span><b>-${formatCurrency(result.offerDiscount)}</b></div>` : `<div><span>Coupon Savings</span><b>-${formatCurrency(result.couponDiscount)}</b></div>`}
      <div><span>GST (${result.gstPercent || 0}%)</span><b>${formatCurrency(result.gstAmount || 0)}</b></div>
      <div><span>Handling Charges</span><b>${formatCurrency(result.handlingCharge || 0)}</b></div>
      <div class="grand"><span>Item Total</span><b>${formatCurrency(itemPayable)}</b></div>
    `;
  }
}

function renderAvailableCoupons(){
  const host = document.getElementById("availableCoupons");
  if(!host) return;
  if(bogoOfferAccepted && calculateBogoOffer().offerApplied){
    host.innerHTML = `<p class="coupon-empty">Coupons cannot be used with the active BOGO offer.</p>`;
    return;
  }
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
    .slice(0, 6)
    .map(coupon => {
      const valid = validateCoupon(coupon, subtotal);
      const label = coupon.freeDelivery ? "Free delivery" :
        coupon.freeItem ? `Free ${coupon.freeItem.name || coupon.freeItem}` :
        coupon.type === "percentage" ? `${coupon.discountValue}% OFF` :
        `${formatCurrency(coupon.discountValue)} OFF`;
      const displayCode = couponCodeList(coupon)[0] || coupon.code;
      return `<button type="button" class="coupon-card ${valid.ok ? "" : "disabled"}" onclick="applyCoupon('${escapeHTML(displayCode)}')">
        <strong>${escapeHTML(displayCode)}</strong>
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

function renderDeliveryCampaign(subtotal = getCartSubtotal()){
  renderDeliveryPolicyRules();
  const pricing = calculateDistanceDeliveryPricing(deliveryDistance, subtotal);
  const eligibleSubtotal = Number(pricing.eligibleSubtotal ?? getCartBaseSubtotal());
  const hosts = [document.getElementById("freeDeliveryHint")].filter(Boolean);
  const message = !pricing.minimumOrderMet
    ? `Add ${formatCurrency(pricing.minimumRemaining)} more in base items to reach minimum order value.`
    : !deliveryDistance
      ? "Enable location to check delivery availability."
      : !pricing.serviceable
        ? "Sorry, we are not available at your location yet."
        : pricing.freeDelivery
          ? "Free delivery unlocked 🎉"
          : `Delivery charge ${formatCurrency(pricing.baseCharge)} applied. Add ${formatCurrency(pricing.remaining)} more for FREE delivery 🚚`;
  const markup = `<div class="delivery-campaign ${pricing.freeDelivery ? "unlocked" : ""} ${!pricing.serviceable && deliveryDistance ? "blocked" : ""}">
    <strong>${message}</strong>
    ${pricing.minimumOrderMet && pricing.serviceable && !pricing.freeDelivery ? `<div class="delivery-progress-meta"><span>${formatCurrency(eligibleSubtotal)} / ${formatCurrency(pricing.threshold)}</span><span>${pricing.progress}%</span></div><div class="delivery-progress"><i style="width:${pricing.progress}%"></i></div>` : ""}
  </div>`;
  hosts.forEach(host => host.innerHTML = markup);
  const largeOrder = document.getElementById("largeOrderAssistance");
  if(largeOrder){
    largeOrder.hidden = subtotal <= 299;
    const fields = getCheckoutFields();
    const items = cart.map(item => `${item.name} x${item.qty || 1}`).join(", ");
    const message = [
      "Hello MAGNEETOZ, I need assistance with a large order.",
      `Name: ${fields.name || "Not provided"}`,
      `Mobile: ${fields.phone || "Not provided"}`,
      `Cart value: ${formatCurrency(subtotal)}`,
      `Location: ${fields.address || userLocation?.address || "Not provided"}`,
      `Distance: ${deliveryDistance ? `${Number(deliveryDistance).toFixed(1)} KM` : "Not available"}`,
      `Items: ${items || "Not available"}`
    ].join("\n");
    largeOrder.querySelector("a")?.setAttribute("href", `https://wa.me/${deliveryPricingSettings.whatsappNumber}?text=${encodeURIComponent(message)}`);
  }
  const blocked = deliveryDistance > 0 && !pricing.serviceable;
  document.querySelectorAll("[aria-label='Place order'], #codBtn, #upiBtn").forEach(button => {
    button.disabled = blocked || !pricing.minimumOrderMet;
    button.title = blocked ? "Sorry, we are not available at your location yet." : !pricing.minimumOrderMet ? "Minimum base order value not met." : "";
  });
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
  let user = await timedStep("createOrderSafely:waitForAuthReady", () => waitForAuthReady());
  if(!user?.uid) throw new Error("Please login again to place this order.");
  if(!cart.length) throw new Error("Cart empty");

  const fields = getCheckoutFields();
  fields.phone = await resolveAuthenticatedCheckoutPhone(user);
  if(!fields.phone){
    await promptVerifiedMobileLogin();
    user = auth.currentUser || cachedAuthUser;
    if(!user?.uid) throw mobileLoginRequiredError();
    fields.phone = await resolveAuthenticatedCheckoutPhone(user);
    if(!fields.phone) throw mobileLoginRequiredError();
  }
  if(!fields.name || !fields.address) throw new Error("Fill name & address");
  const normalizedPaymentMethod = String(paymentMethod || "").toLowerCase();
  const normalizedPaymentStatus = String(paymentStatus || "pending").toLowerCase();
  if(!["cod", "online", "upi"].includes(normalizedPaymentMethod)) throw new Error("Invalid payment method");

  const subtotal = getCartSubtotal();
  const baseSubtotal = getCartBaseSubtotal();
  if(!(await timedStep("createOrderSafely:ensureDeliveryEligible", () => ensureDeliveryEligible()))) throw new Error("Delivery is not available for this location.");
  if(!calculateDeliveryCharge(subtotal, baseSubtotal)) throw new Error("Delivery is not available for this location.");
  let securedDelivery;
  try{
    securedDelivery = await timedStep("createOrderSafely:validateDeliveryPricing", () => callPaymentFunction("validateDeliveryPricing", {
      cart:compactCartForStorage(cart),
      orderDraft:{
        userId:user.uid,
        subtotalAmount:subtotal,
        baseSubtotalAmount:baseSubtotal,
        subtotal,
        baseSubtotal,
        couponDiscount:calculateCouponPricing(subtotal).couponDiscount,
        restaurantLocation:getRestaurantLocation(),
        location:userLocation
      }
    }, 18000));
  }catch(error){
    const localRule = calculateDistanceDeliveryPricing(deliveryDistance, subtotal, baseSubtotal);
    const safeDistance = Number(actualRoadDistance || deliveryDistance || localRule.distance || 0);
    const safeCharge = Number(localRule.deliveryCharge ?? calculateDeliveryCharge(subtotal, baseSubtotal) ?? 0);
    if(!Number.isFinite(safeDistance) || safeDistance <= 0 || !Number.isFinite(safeCharge) || safeCharge < 0){
      throw error;
    }
    console.warn("[DELIVERY PRICING FALLBACK]", {
      reason:error?.message || "pricing service unavailable",
      deliveryDistance:safeDistance,
      deliveryCharge:safeCharge
    });
    securedDelivery = {
      ok:true,
      deliveryDistance:safeDistance,
      deliveryCharge:safeCharge,
      source:"verified_client_fallback"
    };
  }
  deliveryDistance = Number(securedDelivery.deliveryDistance || deliveryDistance);
  actualRoadDistance = deliveryDistance;
  deliveryCharge = Number(securedDelivery.deliveryCharge || 0);

  validateActiveCoupon();
  const [usageValidation, inventory] = await timedStep("createOrderSafely:couponAndInventory", () => Promise.all([
    activeCoupon ? validateCouponUsage(activeCoupon) : Promise.resolve({ ok:true }),
    validateCartInventory()
  ]));
  if(!usageValidation.ok) throw new Error(usageValidation.message);
  if(!inventory.ok) throw new Error(inventory.message);

  const pricing = calculateInvoicePricing(subtotal);
  const deliveryRule = calculateDistanceDeliveryPricing(deliveryDistance, subtotal, baseSubtotal);
  const orderTotalBeforeWallet = pricing.beforeWallet;
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
  const itemsSnapshot = compactCartForStorage(cart);

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
        baseSubtotalAmount:baseSubtotal,
        totalAmount:orderTotalBeforeWallet,
        deliveryDistance,
        ...deliveryMetrics(),
        deliveryCharge:pricing.deliveryCharge,
        deliveryFee:pricing.deliveryCharge,
        originalDeliveryCharge:deliveryCharge,
        distanceKm:deliveryDistance,
        freeDeliveryApplied:securedDelivery.freeDeliveryApplied === true,
        freeDeliveryThreshold:Number(securedDelivery.freeDeliveryThreshold || 0),
        amountNeededForFreeDelivery:Number(securedDelivery.amountNeededForFreeDelivery || 0),
        deliveryServiceable:securedDelivery.deliveryServiceable !== false,
        minimumOrderValue:Number(securedDelivery.minimumOrderValue || 0),
        deliveryRuleVersion:securedDelivery.deliveryRuleVersion || DELIVERY_RULE_VERSION,
        couponId:activeCoupon?.id || "",
        couponCode:activeCoupon?.code || "",
        couponPgName:activeCoupon?.pgName || activeCoupon?.pg || "",
        couponPgCode:activeCoupon?.pgCode || "",
        couponDiscount:pricing.couponDiscount,
        walletPointsRequested:pricing.walletDiscount,
        walletPointsUsed:0,
        freeDelivery:securedDelivery.freeDeliveryApplied === true || !!activeCoupon?.freeDelivery,
        gstPercent:pricing.gstPercent,
        gstAmount:pricing.gstAmount,
        handlingCharge:pricing.handlingCharge,
        subtotal,
        baseSubtotal,
        grandTotal:orderTotalBeforeWallet,
        invoiceNumber:buildInvoiceNumber(orderRef.id),
        invoiceGeneratedAt:serverTimestamp(),
        finalAmount:orderTotalBeforeWallet,
        paymentMethod:normalizedPaymentMethod === "upi" ? "online" : normalizedPaymentMethod,
        paymentStatus:normalizedPaymentStatus,
        paymentRequired:orderTotalBeforeWallet > 0,
        paymentCompleted:normalizedPaymentStatus === "paid",
        amountDue:normalizedPaymentStatus === "paid" ? 0 : orderTotalBeforeWallet,
        amountPaid:normalizedPaymentStatus === "paid" ? orderTotalBeforeWallet : 0,
        amountToCollect:normalizedPaymentStatus === "paid" ? 0 : orderTotalBeforeWallet,
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
      const estimatedOrderBytes = estimateJsonBytes(orderData);
      if(estimatedOrderBytes > 850000){
        console.warn("[ORDER PAYLOAD] Large order payload trimmed", {
          estimatedOrderBytes,
          itemCount:itemsSnapshot.length
        });
        orderData.items = compactCartForStorage(itemsSnapshot).map(item => ({
          id:item.id,
          name:item.name,
          size:item.size,
          category:item.category,
          baseUnitPrice:item.baseUnitPrice,
          unitPrice:item.unitPrice,
          extras:item.extras || [],
          addOns:item.addOns || item.extras || [],
          extrasTotal:item.extrasTotal || 0,
          price:item.price,
          qty:item.qty,
          quantity:item.quantity,
          image:""
        }));
      }
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
  let user = await waitForAuthReady();
  if(!user?.uid) throw new Error("Please login again to place this order.");
  if(!cart.length) throw new Error("Cart empty");
  const fields = getCheckoutFields();
  fields.phone = await resolveAuthenticatedCheckoutPhone(user);
  if(!fields.phone){
    await promptVerifiedMobileLogin();
    user = auth.currentUser || cachedAuthUser;
    if(!user?.uid) throw mobileLoginRequiredError();
    fields.phone = await resolveAuthenticatedCheckoutPhone(user);
    if(!fields.phone) throw mobileLoginRequiredError();
  }
  if(!fields.name || !fields.address) throw new Error("Fill name & address");

  const subtotal = getCartSubtotal();
  const baseSubtotal = getCartBaseSubtotal();
  if(!(await ensureDeliveryEligible())) throw new Error("Delivery is not available for this location.");
  if(!calculateDeliveryCharge(subtotal, baseSubtotal)) throw new Error("Delivery is not available for this location.");

  validateActiveCoupon();
  const [usageValidation, inventory] = await Promise.all([
    activeCoupon ? validateCouponUsage(activeCoupon) : Promise.resolve({ ok:true }),
    validateCartInventory()
  ]);
  if(!usageValidation.ok) throw new Error(usageValidation.message);
  if(!inventory.ok) throw new Error(inventory.message);

  const pricing = calculateInvoicePricing(subtotal);
  const deliveryRulePaid = calculateDistanceDeliveryPricing(deliveryDistance, subtotal, baseSubtotal);
  const checkoutId = checkoutInFlightId || `co_${user.uid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  checkoutInFlightId = checkoutId;
  const itemsSnapshot = compactCartForStorage(cart);

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
      baseSubtotalAmount:baseSubtotal,
      totalAmount:pricing.grandTotal,
      deliveryDistance,
      ...deliveryMetrics(),
      deliveryCharge:pricing.deliveryCharge,
      deliveryFee:pricing.deliveryCharge,
      originalDeliveryCharge:deliveryCharge,
      distanceKm:deliveryDistance,
      freeDeliveryApplied:deliveryRulePaid.freeDelivery,
      freeDeliveryThreshold:deliveryRulePaid.threshold,
      amountNeededForFreeDelivery:deliveryRulePaid.remaining,
      deliveryServiceable:deliveryRulePaid.serviceable,
      minimumOrderValue:deliveryRulePaid.minimumOrderValue,
      deliveryRuleVersion:DELIVERY_RULE_VERSION,
      couponId:activeCoupon?.id || "",
      couponCode:activeCoupon?.code || "",
      couponPgName:activeCoupon?.pgName || activeCoupon?.pg || "",
      couponPgCode:activeCoupon?.pgCode || "",
      couponDiscount:pricing.couponDiscount,
      walletPointsRequested:pricing.walletDiscount,
      walletDiscount:pricing.walletDiscount,
      freeDelivery:deliveryRulePaid.freeDelivery || !!activeCoupon?.freeDelivery,
      gstPercent:pricing.gstPercent,
      gstAmount:pricing.gstAmount,
      handlingCharge:pricing.handlingCharge,
      subtotal,
      baseSubtotal,
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
  if(bogoOfferAccepted && calculateBogoOffer().offerApplied){
    alert("Coupons cannot be used with Buy One Get One offers.");
    return;
  }
  const input = document.getElementById("couponInput");
  const code = String(codeFromCard || input?.value || "").trim().toUpperCase();
  const coupon = findCouponByCode(code);
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

  normalizeCartPricing();
  let itemsHTML = "";
  let total = 0;
  const totalQty = cart.reduce((sum, item) => sum + (Number(item.qty) || 1), 0);
  const offerStateSignature = (activeBogoOffers.length ? activeBogoOffers : (activeBogoOffer ? [activeBogoOffer] : []))
    .map(offer => `${offer.type}:${offer.active === true}:${(offer.eligibleCategories || []).join("|")}:${(offer.eligibleSizes || []).join("|")}`)
    .join("~") || "none";
  const nextOfferSignature = `${offerStateSignature}:${cart.map(item => `${item.id || item.name}:${item.qty}:${item.price}:${item.category || ""}:${item.size || ""}`).join("|")}`;
  if(bogoOfferSignature && bogoOfferSignature !== nextOfferSignature) bogoOfferAccepted = false;
  bogoOfferSignature = nextOfferSignature;

  cart.forEach((item, index) => {
    total += item.price;
    const extras = normalizeCartExtras(item.extras);
    const baseLineTotal = Number(item.baseUnitPrice || item.unitPrice || 0) * Number(item.qty || 1);
    const extrasLineTotal = extrasTotalPerUnit(extras) * Number(item.qty || 1);
    const priceBreakdown = `
      <div class="cart-item-price-breakdown">
        <p><span>${escapeHTML(item.name)} base</span><b>${formatCurrency(baseLineTotal)}</b></p>
        ${extras.map(extra => `<p><span>${escapeHTML(extra.name)}</span><b>${formatCurrency(Number(extra.price || 0) * Number(item.qty || 1))}</b></p>`).join("")}
        ${extrasLineTotal > 0 ? `<p class="cart-item-total"><span>Item total</span><b>${formatCurrency(item.price)}</b></p>` : ""}
      </div>
    `;
    const extrasControls = EXTRA_TOPPINGS.map(extra => {
      const checked = extras.some(selected => selected.id === extra.id);
      return `<label><input type="checkbox" ${checked ? "checked" : ""} onchange="toggleCartExtra(${index}, '${extra.id}', this.checked)"> <span>${escapeHTML(extra.name)}</span><b>${formatCurrency(extra.price)}</b></label>`;
    }).join("");
    const pizzaItem = isPizzaCartItem(item);
    const crust = pizzaItem ? normalizeCrust(item.crust) : null;
    const crustControls = pizzaItem ? CRUST_OPTIONS.map(option => `
      <label>
        <input type="radio" name="cart-crust-${index}" ${crust.id === option.id ? "checked" : ""} onchange="setCartCrust(${index}, '${option.id}')">
        <span>${escapeHTML(option.label)}</span>
        <small>${escapeHTML(option.description)}</small>
      </label>
    `).join("") : "";
    itemsHTML += `
  <div class="cart-item cart-item-pro">
    <img src="${escapeHTML(normalizeImageUrl(item.image))}" alt="${escapeHTML(item.name)}" onerror="this.onerror=null;this.src='logo_tran.jpeg';">
    <div>
      <strong>${escapeHTML(item.name)}</strong><br>
      <small>${escapeHTML(item.size || "Regular")} x ${item.qty}${pizzaItem ? ` • ${escapeHTML(crust.label)}` : ""}</small>
      ${pizzaItem ? `<div class="cart-crust-picker" aria-label="Crust option">${crustControls}</div>` : ""}
      ${priceBreakdown}
      <details class="cart-extras-picker">
        <summary>Extra Toppings / Add-ons</summary>
        <div>${extrasControls}</div>
      </details>
    </div>
    <div class="cart-line-actions">
      <b>${formatCurrency(item.price)}</b>
      <div class="cart-qty-controls" aria-label="Quantity controls">
        <button type="button" onclick="changeCartItemQty(${index}, -1)">-</button>
        <span>${item.qty}</span>
        <button type="button" onclick="changeCartItemQty(${index}, 1)">+</button>
      </div>
    </div>
     </div>
    `;
  });

  const cartItems = document.getElementById("cartItems");
  const totalEl = document.getElementById("total");
  const countEl = document.getElementById("cartCount");
  const headerTitle = document.querySelector("#cartPanel .cart-header h3");
  const emptyState = document.getElementById("emptyCartState");
  const cartPanel = document.getElementById("cartPanel");
  const placeOrderButton = document.querySelector("#cartPanel > button[aria-label='Place order']");
  const hasItems = totalQty > 0;
  cartPanel?.classList.toggle("cart-is-empty", !hasItems);
  if(emptyState) emptyState.hidden = hasItems;
  if(placeOrderButton){
    placeOrderButton.hidden = !hasItems;
    placeOrderButton.disabled = !hasItems || isOrderProcessing;
  }
  if(cartItems){
    cartItems.innerHTML = totalQty
      ? `<div class="cart-items-title">Items in cart <b>${totalQty}</b></div>${itemsHTML}`
      : "";
  }
  renderCartSmartSuggestions(total);
  const couponResult = calculateInvoicePricing(total);
  const offerIsApplied = couponResult.offerApplied === true;
  const couponInput = document.getElementById("couponInput");
  const couponApplyButton = couponInput?.parentElement?.querySelector("button");
  if(couponInput){
    couponInput.disabled = offerIsApplied;
    couponInput.placeholder = offerIsApplied ? "Coupon disabled with BOGO" : "Enter Coupon";
  }
  if(couponApplyButton) couponApplyButton.disabled = offerIsApplied;
  const walletBox = document.getElementById("walletRedeemBox");
  if(walletBox) walletBox.hidden = offerIsApplied || walletPointsAvailable < 1;
  renderBogoOfferPanel();
  renderAvailableCoupons();
  if(totalEl) totalEl.innerText = formatCurrency(couponResult.finalTotal);
  const stickyTotal = document.getElementById("stickyCheckoutTotal");
  const stickyTotalLabel = document.querySelector(".checkout-bar-total small");
  const cartItemPayable = calculateCartItemPayable(couponResult);
  if(stickyTotalLabel) stickyTotalLabel.textContent = "Item Total";
  if(stickyTotal) stickyTotal.textContent = formatCurrency(cartItemPayable);
  if(countEl) countEl.innerText = totalQty;
  if(headerTitle) headerTitle.textContent = `Your Cart (${totalQty} ${totalQty === 1 ? "item" : "items"})`;
  if(hasItems){
    renderCouponPanel(couponResult);
    renderDeliveryCampaign(total);
  }else{
    const breakdown = document.getElementById("cartPriceBreakdown");
    const freeHint = document.getElementById("freeDeliveryHint");
    const applied = document.getElementById("appliedCoupon");
    if(breakdown) breakdown.innerHTML = "";
    if(freeHint) freeHint.innerHTML = "";
    if(applied) applied.innerHTML = "";
  }
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
  const unit = Number(item.baseUnitPrice || item.unitPrice || (item.qty ? item.price / item.qty : item.price)) || 0;
  const nextQty = Number(item.qty || 1) + delta;
  if(nextQty <= 0){
    cart.splice(index, 1);
    if(activeCoupon) validateActiveCoupon();
    updateCart();
    return;
  }
  item.qty = nextQty;
  item.quantity = nextQty;
  item.baseUnitPrice = unit;
  item.unitPrice = unit;
  Object.assign(item, normalizeCartItemPricing(item));
  updateCart();
}

window.toggleCartExtra = function(index, extraId, checked){
  const item = cart[index];
  if(!item) return;
  const extra = EXTRA_TOPPINGS.find(option => option.id === extraId);
  if(!extra) return;
  const selected = normalizeCartExtras(item.extras);
  const next = checked
    ? [...selected, extra]
    : selected.filter(option => option.id !== extraId);
  item.extras = normalizeCartExtras(next);
  item.addOns = item.extras;
  Object.assign(item, normalizeCartItemPricing(item));
  if(activeCoupon) validateActiveCoupon();
  updateCart();
};

window.setCartCrust = function(index, crustId){
  const item = cart[index];
  if(!item) return;
  if(!isPizzaCartItem(item)) return;
  const crust = normalizeCrust(crustId);
  item.crust = crust;
  item.crustType = crust.label;
  item.selectedCrust = crust.id;
  Object.assign(item, normalizeCartItemPricing(item));
  updateCart();
};

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

function selectPizzaSize(button){
  const card = button.closest(".new-card");
  if(!card) return;
  card.querySelectorAll(".size-option").forEach(option => {
    const active = option === button;
    option.classList.toggle("active", active);
    option.setAttribute("aria-checked", active ? "true" : "false");
  });
  const offerPrice = Number(button.dataset.price || 0);
  const marketPrice = Number(button.dataset.market || 0);
  const offerEl = card.querySelector(".offer");
  const marketEl = card.querySelector(".market");
  if(!offerEl || !marketEl) return;
  offerEl.textContent = formatCurrency(offerPrice);
  marketEl.textContent = formatCurrency(marketPrice);
  offerEl.dataset.base = offerPrice;
  marketEl.dataset.base = marketPrice;
}

/* ================= ADD TO CART ================= */

function promptGuestLoginAfterCartAction(){
  if(auth.currentUser) return;
  guestCartAuthPrompted = false;
  toastInfo("Item added. Login will be needed at checkout.");
}

function addToCartFull(btn, name){
  if(restaurantUnavailable()){
    alert(restaurantState.unavailableMessage || "Restaurant currently closed");
    applyRestaurantAvailability();
    return;
  }

  const card = btn.closest(".card");

  const selectedSize = card.querySelector(".size-option.active") || card.querySelector(".size-option");
  const size = selectedSize?.dataset.size || "Regular";
  const price = Number(selectedSize?.dataset.price || parseCurrency(card.querySelector(".offer")?.innerText || "0"));
  const qty = 1;

  cart.push({
    name,
    size,
    qty,
    category: card.dataset.dishCategory || "",
    image: card.dataset.dishImage || card.querySelector("img")?.getAttribute("src") || "logo_tran.jpeg",
    baseUnitPrice: price,
    unitPrice: price,
    price: price * qty
  });

  persistGuestState();
  updateCart();
  notifyPremiumUI("magneetoz:item-added", { name, qty, price: price * qty });
  promptGuestLoginAfterCartAction();

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

  const priceEl = card.querySelector(".offer");
  const price = parseCurrency(priceEl.innerText);
  const qty = 1;

  cart.push({
    name,
    size:"Regular",
    qty,
    category: card.dataset.dishCategory || "",
    image: card.dataset.dishImage || card.querySelector("img")?.getAttribute("src") || "logo_tran.jpeg",
    baseUnitPrice: price,
    unitPrice: price,
    price
  });

  persistGuestState();
  updateCart();
  notifyPremiumUI("magneetoz:item-added", { name, qty, price });
  promptGuestLoginAfterCartAction();

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
  if(!combo || !comboIsOrderable(combo)){
    alert("This combo is currently out of stock.");
    return;
  }
  const price = Number(combo.comboPrice || 0);
  cart.push({
    name:combo.name || "MAGNEETOZ Combo",
    size:"Combo",
    qty:1,
    category:"Combo",
    image:combo.image || "logo_tran.jpeg",
    baseUnitPrice:price,
    unitPrice:price,
    price,
    comboId:id,
    itemsIncluded:combo.itemsIncluded || ""
  });
  persistGuestState();
  updateCart();
  notifyPremiumUI("magneetoz:item-added", { name:combo.name || "Combo", qty:1, price });
  promptGuestLoginAfterCartAction();
};





function showFreeDeliveryHint(subtotal){
  const hintText = document.getElementById("freeDeliveryHint");
  const summaryHint = document.getElementById("summaryFreeDelivery");
  const pricing = calculateDistanceDeliveryPricing(deliveryDistance, subtotal);
  let message = "";
  let state = "";

  if(!pricing.locationAvailable){
    message = "Select your delivery location to check delivery charges.";
    state = "pending";
  }else if(!pricing.serviceable){
    message = "Delivery is not available at this location.";
    state = "blocked";
  }else if(pricing.freeDelivery){
    message = `Free delivery unlocked for ${Number(deliveryDistance).toFixed(1)} km 🎉`;
    state = "unlocked";
  }else{
    message = `Add ${formatCurrency(pricing.remaining)} more for free delivery in your distance zone.`;
    state = "pending";
  }

  [hintText, summaryHint].filter(Boolean).forEach(element => {
    element.textContent = message;
    element.classList.remove("unlocked", "pending", "blocked");
    element.classList.add(state);
    element.style.color = "";
  });
}

/* ================= ORDER ================= */

async function placeOrder(){
if(placeOrderInFlight){
  toastInfo("Checkout is already opening...");
  return;
}
placeOrderInFlight = true;
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

if (cart.length === 0) {
alert("Cart empty");
return;
}

persistGuestState();

const preAuthMissing = checkoutMissingReason();
if(preAuthMissing && !preAuthMissing.startsWith("Login/OTP")){
  setCheckoutMessage(preAuthMissing, "warning");
  focusMissingCheckoutField();
  return;
}

if(!auth.currentUser){
  setCheckoutMessage("Login/OTP pending hai. Verified mobile ke bina order place nahi hoga.", "warning");
  updateCheckoutSteps();
  resumeCheckoutAfterAuth = true;
  await timedStep("placeOrder:auth", () => window.requireMagneetozAuth?.("checkout"));
  if(!auth.currentUser){
    resumeCheckoutAfterAuth = false;
    toastInfo("Login complete karne ke baad Place Order continue hoga.");
    return;
  }
  await timedStep("placeOrder:mergeGuestCart", () => mergeGuestCartWithUser(auth.currentUser));
  resumeCheckoutAfterAuth = false;
}

if(!hasSelectedCheckoutLocation() && !isFreshCustomerLocation(CHECKOUT_LOCATION_REUSE_MAX_AGE_MS)){
  setCheckoutLoading(true, "Fetching your current delivery location...");
  await timedStep("placeOrder:autoLocation", () =>
    fetchFreshCurrentLocation({ updateAddress:true, source:"fresh_gps:auto_checkout" })
  ).catch(error => console.warn("Automatic checkout location failed", error));
  setCheckoutLoading(false);
}

const name = await resolveAuthenticatedCheckoutName(auth.currentUser || cachedAuthUser);
const phone = await resolveAuthenticatedCheckoutPhone(auth.currentUser || cachedAuthUser);
const address = normalizeUnicodeText(document.getElementById("customerAddress").value);

let verifiedPhone = phone;
if(!verifiedPhone){
  await promptVerifiedMobileLogin();
  verifiedPhone = await resolveAuthenticatedCheckoutPhone(auth.currentUser || cachedAuthUser);
  if(!verifiedPhone){
    setCheckoutMessage("OTP login complete karke Place Order dobara tap karein.", "warning");
    return;
  }
}

if(!name || !address){
  setCheckoutMessage(checkoutMissingReason() || "Required details complete karo, phir order place hoga.", "warning");
  focusMissingCheckoutField();
  return;
}

await timedStep("placeOrder:saveCustomerProfile", () => saveCustomerProfile(auth.currentUser || cachedAuthUser));
await timedStep("placeOrder:saveAddressBook", () => saveCurrentAddressToBook().catch(error => console.warn("Address book save skipped", error)));

const subtotal = getCartSubtotal();
const baseSubtotal = getCartBaseSubtotal();

// ⭐ Minimum order check
if(baseSubtotal < deliveryPricingSettings.minimumOrderValue){

showMinOrderPopup(deliveryPricingSettings.minimumOrderValue - baseSubtotal);

return false;

}

if(!(await timedStep("placeOrder:ensureDeliveryEligible", () => ensureDeliveryEligible()))) return;

// delivery condition check
if(!calculateDeliveryCharge(subtotal, baseSubtotal)){
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
  placeOrderInFlight = false;
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

  const subtotal = getCartSubtotal();
  const baseSubtotal = getCartBaseSubtotal();

  if (subtotal > 2000) {
    alert(`For large orders above ${formatCurrency(2000)} please contact via WhatsApp`);
  }

  if (!calculateDeliveryCharge(subtotal, baseSubtotal)) return;

  const pricing = calculateInvoicePricing(subtotal);

  // Fill summary box
  document.getElementById("summaryDetails").innerHTML = `
    Subtotal: ${formatCurrency(pricing.subtotal)} <br>
    Coupon Discount: -${formatCurrency(pricing.couponDiscount)} <br>
    GST (${pricing.gstPercent}%): ${formatCurrency(pricing.gstAmount)} <br>
    Handling: ${formatCurrency(pricing.handlingCharge)} <br>
    Distance: ${deliveryDistance} km ${estimatedTravelTime ? `(${estimatedTravelTime})` : ""}<br>
    Delivery charge added: ${pricing.deliveryCharge ? formatCurrency(pricing.deliveryCharge) : "FREE"} <br>
    ${pricing.walletDiscount ? `Pizza Points: -${formatCurrency(pricing.walletDiscount)} <br>` : ""}
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
    if(walletPointsRequested > 0){
      const walletResult = await callPaymentFunction("applyWalletToOrder", {
        orderId:result.orderId,
        requestedPoints:walletPointsRequested
      }, 15000);
      walletPointsAvailable = Number(walletResult.walletBalance || 0);
      walletPointsRequested = 0;
    }
    finishSuccessfulCheckout(result.orderNumber);

  }catch(e){

    console.error("COD ERROR:",e);
    lastOrderSignature = null;
    if(e?.mobileLoginRequired){
      keepRetryOverlay = false;
      return;
    }
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

const subtotal = getCartSubtotal();
const baseSubtotal = getCartBaseSubtotal();

if(!(await timedStep("upiOrder:ensureDeliveryEligible", () => ensureDeliveryEligible()))){
resetRazorpayCheckoutState();
return;
}

if(!calculateDeliveryCharge(subtotal, baseSubtotal)){
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
let orderDraftPayload = await timedStep("upiOrder:buildPaidOnlineOrderDraft", () => buildPaidOnlineOrderDraft());
let paymentSession = await createPaymentSessionWithRecovery(orderDraftPayload);
if(paymentSession?.idempotencyKey && paymentSession.idempotencyKey !== orderDraftPayload.idempotencyKey){
  orderDraftPayload = await timedStep("upiOrder:syncPaidOnlineOrderDraft", () => buildPaidOnlineOrderDraft());
}
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
prefill:{
  contact:orderDraftPayload.orderDraft?.phone || "",
  name:orderDraftPayload.orderDraft?.customerName || "",
  email:auth.currentUser?.email || ""
},
theme:{
  color:"#ff7b00"
},
method:{
  upi:true,
  card:true,
  netbanking:true,
  wallet:true
},
retry:{
  enabled:true,
  max_count:2
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
    try{
      await recoverPendingPaymentSession(paymentSession.paymentSessionId);
    }catch(statusError){
      setCheckoutRetry(statusError?.message || retryError?.message || "Still retrying paid order recovery.", async () => recoverPendingPaymentSession(paymentSession.paymentSessionId));
    }
  }
});
recoverPendingPaymentSession(paymentSession.paymentSessionId).catch(() => {});
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
cancelRazorpayCheckout();
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

cancelRazorpayCheckout();
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

}catch(error){
console.error("UPI OPEN ERROR:", error);
setCheckoutLoading(false);
resetRazorpayCheckoutState();
if(error?.mobileLoginRequired) return;
setCheckoutRetry(error?.message || "Payment could not open. Please try again.", () => upiOrder());
}finally{
if(!razorpayOpened && razorpayInFlight) resetRazorpayCheckoutState();
perfEnd("upiOrder");
console.timeEnd("UPI_ORDER_TOTAL");
}
}

async function payPendingOrder(orderId){
  if(!orderId) return;
  if (typeof Razorpay === "undefined") {
    alert("Payment gateway is loading. Please try again in a moment.");
    return;
  }
  if(razorpayInFlight){
    alert("Payment is already opening. Please wait.");
    return;
  }
  razorpayInFlight = true;
  isOrderProcessing = true;
  let razorpayOpened = false;
  let paymentSession = null;
  try{
    setCheckoutLoading(true, "Opening secure payment...");
    paymentSession = await callPaymentFunction("resumeOrderPayment", { orderId }, 20000);
    if(paymentSession.alreadyPaid){
      finishSuccessfulCheckout(paymentSession.orderNumber, { clearCart:false });
      return;
    }
    const sessionAmount = Number(paymentSession.amount);
    const sessionAmountPaise = Number(paymentSession.amountPaise || Math.round(sessionAmount * 100));
    if(!paymentSession.paymentSessionId || !paymentSession.razorpayOrderId || !paymentSession.keyId || !Number.isFinite(sessionAmountPaise) || sessionAmountPaise <= 0){
      throw new Error("Payment session was not created correctly. Please try again.");
    }
    rememberPaymentSessionRecovery({
      paymentSessionId:paymentSession.paymentSessionId,
      razorpayOrderId:paymentSession.razorpayOrderId,
      amount:sessionAmount
    });
    setCheckoutLoading(false);
    const options = {
      key:paymentSession.keyId,
      amount:sessionAmountPaise,
      currency:String(paymentSession.currency || "INR").toUpperCase(),
      name:"Magneetoz",
      description:"Complete your order payment",
      order_id:String(paymentSession.razorpayOrderId),
      method:{
        upi:true,
        card:true,
        netbanking:true,
        wallet:true
      },
      retry:{
        enabled:true,
        max_count:2
      },
      theme:{ color:"#ff7b00" },
      handler:async function(response){
        let keepRetryOverlay = false;
        try{
          rememberPaymentSessionRecovery({
            paymentId:response.razorpay_payment_id,
            razorpayOrderId:response.razorpay_order_id,
            razorpaySignature:response.razorpay_signature,
            paymentSessionId:paymentSession.paymentSessionId,
            amount:sessionAmount
          });
          setCheckoutLoading(true, "Verifying payment and updating your order...");
          const verifiedOrder = await callPaymentFunction("verifyPaymentAndCreateOrder", {
            paymentSessionId:paymentSession.paymentSessionId,
            razorpay_order_id:response.razorpay_order_id,
            razorpay_payment_id:response.razorpay_payment_id,
            razorpay_signature:response.razorpay_signature
          }, 35000);
          clearRazorpayPaymentRecovery();
          finishSuccessfulCheckout(verifiedOrder.orderNumber, { clearCart:false });
        }catch(error){
          console.error("PAY NOW ERROR:", error);
          keepRetryOverlay = true;
          setCheckoutRetry("Payment received. We are updating your order safely.", async () => {
            await recoverPendingPaymentSession(paymentSession.paymentSessionId);
          });
          recoverPendingPaymentSession(paymentSession.paymentSessionId).catch(() => {});
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
          cancelRazorpayCheckout();
        }
      }
    };
    const rzp = new Razorpay(options);
    rzp.on("payment.failed", function(response){
      cancelRazorpayCheckout();
      alert(response?.error?.description || "Payment failed. You can try again from this order.");
    });
    razorpayOpened = true;
    rzp.open();
    armRazorpayOpenWatchdog();
  }catch(error){
    console.error("PAY NOW OPEN ERROR:", error);
    setCheckoutRetry(error?.message || "Payment could not open. Please try again.", () => payPendingOrder(orderId));
  }finally{
    if(!razorpayOpened && razorpayInFlight) resetRazorpayCheckoutState();
  }
}

window.payPendingOrder = payPendingOrder;

async function cancelUnpaidPaymentOrder(orderId){
  if(!orderId) return;
  const ok = confirm("Remove this unpaid payment order? If you already paid, choose Cancel and use Pay now / Check status instead.");
  if(!ok) return;
  try{
    setCheckoutLoading(true, "Removing unpaid payment order...");
    await callPaymentFunction("cancelUnpaidPaymentOrder", { orderId }, 20000);
    clearRazorpayPaymentRecovery();
    liveOrders = liveOrders.map(order => order.id === orderId
      ? { ...order, status:"Cancelled", orderStatus:"Cancelled", paymentStatus:"cancelled" }
      : order);
    toastSuccess?.("Pending payment order removed.");
    renderOrders();
  }catch(error){
    alert(error?.message || "Unable to remove this pending payment order.");
  }finally{
    setCheckoutLoading(false);
  }
}

window.cancelUnpaidPaymentOrder = cancelUnpaidPaymentOrder;

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

function finishSuccessfulCheckout(orderNumber, options = {}){
  const shouldClearCart = options.clearCart !== false;
  try{ setCheckoutLoading(false); }catch(error){ console.warn("Checkout loader close skipped", error); }
  try{ resetRazorpayCheckoutState(); }catch(error){ console.warn("Razorpay state reset skipped", error); }
  try{ closePaymentPopup(); }catch(error){ console.warn("Payment popup close skipped", error); }
  try{ showOrderSuccess(orderNumber); }catch(error){ console.warn("Order success popup skipped", error); }
  if(shouldClearCart) try{ resetCart(); }catch(error){ console.warn("Cart reset skipped", error); }
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

text.innerText = `Minimum base order value not met. Add ${formatCurrency(amount)} more in base items.`;

popup.style.display = "flex";

}

function closeMinOrderPopup(){

const popup = document.getElementById("minOrderPopup");
if(popup) popup.style.display="none";

}

document.addEventListener("DOMContentLoaded", () => {
  initFirstOrderGuide();
  bindTasteQuiz();
  bindHeroOfferActions();
  updateHeroBogoButton();

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
    }catch(error){
      const message = geolocationErrorMessage(error);
      openLocationSelector();
      showLocationAddressForm();
      alert(message);
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
  document.getElementById("heroLocationPill")?.addEventListener("click", event => {
    event.stopPropagation();
    openLocationSelector();
  });
  document.getElementById("heroPrimaryBtnText")?.addEventListener("click", event => {
    const comboId = event.currentTarget?.dataset?.heroComboId || currentHeroOffer()?.id || "";
    if(!comboId) return;
    event.preventDefault();
    event.stopPropagation();
    focusComboOffer(comboId);
  });
  document.querySelector(".hero")?.addEventListener("click", event => {
    if(heroSwipeMoved){
      event.preventDefault();
      event.stopPropagation();
      heroSwipeMoved = false;
      return;
    }
    if(event.target.closest("button,a,select,input,textarea")) return;
    const comboId = currentHeroOffer()?.id || "";
    if(comboId) focusComboOffer(comboId);
    else document.getElementById("homepageBestSellers")?.scrollIntoView({ behavior:"smooth", block:"start" });
  });
  document.querySelector(".hero")?.addEventListener("keydown", event => {
    if(event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const comboId = currentHeroOffer()?.id || "";
    if(comboId) focusComboOffer(comboId);
    else document.getElementById("homepageBestSellers")?.scrollIntoView({ behavior:"smooth", block:"start" });
  });
  ["customerName","customerAddress","customerLandmark"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", () => {
      if(id === "customerAddress"){
        const lat = document.getElementById("customerLat");
        const lng = document.getElementById("customerLng");
        if(lat) lat.value = "";
        if(lng) lng.value = "";
      }
      setCheckoutFieldsCollapsed(false);
      setCheckoutMessage("");
      updateCheckoutSteps();
      persistGuestState();
    });
  });
  ["customerLat","customerLng"].forEach(id => {
    document.getElementById(id)?.addEventListener("change", updateCheckoutSteps);
  });
  updateCheckoutSteps();

});

let scrollUiCache = {
  categoryControls:null,
  bottomNavigation:null,
  lastCategoryScan:0
};

window.addEventListener("scroll", ()=>{
  scrollUiCache.categoryControls ||= document.querySelector(".sticky-area");
  scrollUiCache.bottomNavigation ||= document.querySelector(".bottom-nav");
  const categoryControls = scrollUiCache.categoryControls;
  const bottomNavigation = scrollUiCache.bottomNavigation;
  if(categoryControls && !categoryControls.classList.contains("category-controls-visible")){
    categoryControls.classList.remove("category-controls-hidden");
    categoryControls.classList.add("category-controls-visible");
  }
  if(bottomNavigation && !bottomNavigation.classList.contains("scroll-controls-visible")){
    bottomNavigation.classList.remove("scroll-controls-hidden");
    bottomNavigation.classList.add("scroll-controls-visible");
  }
  if(menuBrowserHideOnNextScroll){
    hideMenuCategoryPicker();
    return;
  }
  if(menuCategoryGroups.length) return;
  if(categoryScrollRaf) return;
  categoryScrollRaf = true;
  requestAnimationFrame(() => {
    categoryScrollRaf = false;
    const now = performance.now();
    if(now - scrollUiCache.lastCategoryScan < 120) return;
    scrollUiCache.lastCategoryScan = now;
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
      await saveLoginCurrentLocation(user).catch(error => console.warn("Login location save skipped", error));
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
const trackingStatusStrip =
document.getElementById("trackingStatusStrip");
const globalOrderStatusStrip =
document.getElementById("globalOrderStatusStrip");

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

function isActiveCustomerOrder(order = {}){
  const status = normalizeTimelineStatus(order.status || order.orderStatus || order.lifecycleStatus || "");
  const paymentStatus = String(order.paymentStatus || "").toLowerCase();
  if(["Delivered","Cancelled","Rejected"].includes(status)) return false;
  if(["delivered","cancelled","rejected","failed"].includes(String(order.status || "").toLowerCase())) return false;
  if(status === "payment_pending" || status === "Payment Pending") return true;
  if(String(order.paymentMethod || "").toLowerCase() === "online" && paymentStatus !== "paid" && order.paymentCaptured !== true) return true;
  return true;
}

function orderStatusDisplay(order = {}){
  const status = normalizeTimelineStatus(order.status || order.orderStatus || order.lifecycleStatus || "Pending");
  const paymentStatus = String(order.paymentStatus || "").toLowerCase();
  if((status === "payment_pending" || status === "Payment Pending") || (String(order.paymentMethod || "").toLowerCase() === "online" && paymentStatus !== "paid" && order.paymentCaptured !== true)){
    return { label:"Payment Pending", icon:"🟡" };
  }
  const labels = {
    Pending:{ label:"Order Received", icon:"🟢" },
    Accepted:{ label:"Order Accepted", icon:"🟢" },
    Preparing:{ label:"Preparing Your Order", icon:"👨‍🍳" },
    Ready:{ label:"Ready For Pickup", icon:"✅" },
    "Searching For Rider":{ label:"Finding Rider", icon:"🔎" },
    "Rider Assigned":{ label:"Rider Assigned", icon:"🚴" },
    "Picked Up":{ label:"Rider Picked Up Order", icon:"🛵" },
    "Out For Delivery":{ label:"Out For Delivery", icon:"🛵" },
    Nearby:{ label:"Arriving Soon", icon:"📍" },
    "Delivery Code Pending":{ label:"Delivery OTP Ready", icon:"🔐" },
    "Payment Completed":{ label:"Payment Completed", icon:"✅" },
    Delivered:{ label:"Delivered", icon:"✅" },
    Cancelled:{ label:"Order Cancelled", icon:"🚫" },
    Rejected:{ label:"Order Rejected", icon:"❌" },
    Failed:{ label:"Order Failed", icon:"⚠️" }
  };
  return labels[status] || { label:status || "Order Updating", icon:"🟢" };
}

function latestActiveOrder(orders = liveOrders){
  return [...(orders || [])]
    .filter(isActiveCustomerOrder)
    .sort((a,b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt))[0] || null;
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
    updateHeaderOrderStatusChip();
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
      const orderData = previous
        && !isTerminalOrderStatus(incoming.status || incoming.orderStatus)
        && statusRank(incoming.status) < statusRank(previous.status)
        ? { ...incoming, status:previous.status, orderStatus:previous.status }
        : incoming;
      if(previous
        && !isTerminalOrderStatus(incoming.status || incoming.orderStatus)
        && statusRank(incoming.status) < statusRank(previous.status)){
        logStructured("ORDER STATUS", { event:"ignored_backward_status", orderId:docSnap.id, incoming:incoming.status, kept:previous.status });
      }
      nextOrders.push(orderData);
      if(previous
        && !isTerminalOrderStatus(previous.status || previous.orderStatus)
        && isTerminalOrderStatus(orderData.status || orderData.orderStatus)){
        const terminalStatus = normalizeTimelineStatus(orderData.status || orderData.orderStatus);
        if(terminalStatus === "Rejected") toastError("Restaurant rejected this order. Check Cancelled Orders for details.");
        if(terminalStatus === "Cancelled") toastError("This order has been cancelled.");
      }
      if(orderData.status === "Delivered" && !feedbackPromptedOrders.has(docSnap.id) && !orderData.feedbackSubmitted){
        setTimeout(() => showDeliveryFeedbackPopup(orderData), 500);
      }

    });

    nextOrders.sort((a,b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt));
    liveOrders = nextOrders;
    cacheLiveOrdersForUser(user.uid, nextOrders);
    nextOrders.forEach(order => migrateLegacyPaymentFields(order));
    updateHeaderOrderStatusChip(nextOrders);
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

globalOrderStatusStrip?.addEventListener("click", async ()=>{
  if(!auth.currentUser){
    await window.requireMagneetozAuth?.("order_tracking");
    if(!auth.currentUser) return;
  }
  trackingOverlay?.classList.add("active");
  document.body.style.overflow = "hidden";
});

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
    }, AUTH_NULL_GRACE_MS);
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
  updateHeaderOrderStatusChip(liveOrders);
  if(!ordersContainer || !emptyOrders) return;

  ordersContainer.innerHTML = "";

  let filtered = liveOrders.filter(order=>{

    if(currentFilter === "active"){

      return isActiveCustomerOrder(order);

    }

    if(currentFilter === "cancelled"){
      const status = normalizeTimelineStatus(order.status || order.orderStatus);
      return status === "Cancelled" || status === "Rejected" || status === "Failed";
    }

    return (
      order.status === "Delivered"
    );

  });
  updateTrackingStatusStrip(filtered);

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
  "Ready",
  "Rider Assigned",
  "Out For Delivery",
  "Nearby",
  "Delivered"

];

const normalizedOrderStatus = normalizeTimelineStatus(order.status);
const exactStepIndex = timelineSteps.findIndex(step => step === normalizedOrderStatus);
const currentStepIndex = exactStepIndex >= 0
  ? exactStepIndex
  : Math.max(0, timelineSteps.reduce((bestIndex, step, index) => {
      return statusRank(step) <= statusRank(order.status) ? index : bestIndex;
    }, 0));

const cancelHTML = buildCancelWindowHTML(order);
const payNowHTML = buildPayNowActionHTML(order);
const paymentHTML = buildPaymentTrackingHTML(order);
const riderLiveMapHTML = buildRiderLiveMapHTML(order);
const orderAgainHTML = orderCanBeReordered(order)
  ? `<button type="button" class="order-again-btn" onclick="orderAgain('${escapeHTML(order.id)}')">Order Again</button>`
  : "";

const timelineHTML = `

<section class="timeline-journey" aria-label="Order journey">
  <div class="timeline-journey-head">
    <div>
      <span>Live journey</span>
      <strong>${escapeHTML(order.status || "Pending")}</strong>
    </div>
    <small>${currentStepIndex + 1} of ${timelineSteps.length}</small>
  </div>
  <div class="timeline">

  ${
    timelineSteps.map((step,index)=>`

      <div class="
      timeline-step
      ${index <= currentStepIndex ? "active" : ""}
      ${index === currentStepIndex ? "current" : ""}
      ">

        <div class="timeline-dot">${index < currentStepIndex ? "✓" : index + 1}</div>

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
</section>`;

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

      ${timelineHTML}

      ${payNowHTML}

      <!-- ITEMS -->

      <div class="order-items">

        ${
          (order.items || [])
          .map(item=>{
            const extras = orderItemExtras(item);
            return `

            <div class="order-item">

              <span>
                ${escapeHTML(item.name || "Item")}
                × ${item.qty}
                ${orderItemBreakdownHTML(item)}
              </span>

              <strong>
                ${formatCurrency(item.price)}
              </strong>

            </div>

          `}).join("")
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
      ${orderAgainHTML}

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

function updateTrackingStatusStrip(orders = []){
  if(!trackingStatusStrip) return;
  const active = orders.filter(isActiveCustomerOrder);
  if(!active.length){
    trackingStatusStrip.classList.remove("show");
    trackingStatusStrip.innerHTML = "";
    return;
  }
  const latest = active[0];
  const display = orderStatusDisplay(latest);
  const totalActive = active.length;
  trackingStatusStrip.classList.add("show");
  trackingStatusStrip.innerHTML = `
    <span class="tracking-status-dot"></span>
    <strong>${escapeHTML(display.label || "Order updating")}</strong>
    <small>${totalActive > 1 ? `${totalActive} active orders` : `Order #${escapeHTML(latest.orderNumber || latest.id || "")}`}</small>
  `;
}

function updateHeaderOrderStatusChip(orders = liveOrders){
  if(!globalOrderStatusStrip) return;
  const order = latestActiveOrder(orders);
  if(!order){
    globalOrderStatusStrip.hidden = true;
    globalOrderStatusStrip.classList.remove("show");
    globalOrderStatusStrip.innerHTML = `<span class="status-dot"></span><strong>Order updating</strong><small>Tap to track</small>`;
    return;
  }
  const display = orderStatusDisplay(order);
  globalOrderStatusStrip.hidden = false;
  globalOrderStatusStrip.classList.add("show");
  globalOrderStatusStrip.innerHTML = `
    <span class="status-dot"></span>
    <strong>${escapeHTML(display.icon)} ${escapeHTML(display.label)}</strong>
    <small>${escapeHTML(order.orderNumber ? `#${order.orderNumber}` : "Tap to track")}</small>
  `;
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
  const updatedMillis = timestampToMillis(order.riderLocationUpdatedAt) || (location.updatedAt ? Date.parse(location.updatedAt) : 0);
  const isStale = !updatedMillis || Date.now() - updatedMillis > 60 * 1000;
  if(isStale){
    return `
      <div class="rider-live-map rider-live-map-pending">
        <div class="rider-live-map-head">
          <strong>Live rider map</strong>
          <span>Location updating</span>
        </div>
        <p>Rider GPS is refreshing. We will show the live map again after a fresh update.</p>
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
  const updatedAt = new Date(updatedMillis).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
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
  if(status === "Ready" || status === "ready_for_pickup") return "Ready";
  if(status === "rider_searching") return "Searching For Rider";
  if(status === "rider_assigned" || status === "rider_accepted") return "Rider Assigned";
  if(status === "picked_up") return "Picked Up";
  if(status === "out_for_delivery") return "Out For Delivery";
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

function hasField(object, key){
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function paymentRequiredForOrder(order = {}, amountDue = 0){
  if(hasField(order, "paymentRequired")) return order.paymentRequired !== false;
  const method = String(order.paymentMethod || order.paymentMode || "").toLowerCase();
  const source = String(order.checkoutSource || order.orderSource || "").toLowerCase();
  if(method === "online" || method === "upi") return true;
  if(source.includes("razorpay") || source.includes("payment")) return true;
  return Number(amountDue) > 0;
}

function paymentDecisionForOrder(order = {}){
  const statusText = normalizeTimelineStatus(order.status || order.orderStatus || order.lifecycleStatus || "");
  const paymentStatus = String(order.paymentStatus || "pending").toLowerCase();
  const paymentMethod = String(order.paymentMethod || order.paymentMode || "").toLowerCase();
  const totalAmount = Number(order.totalAmount || order.amount || order.grandTotal || order.finalAmount || 0);
  const amountPaid = Number(order.amountPaid || 0);
  const amountDue = Math.max(0, Number(
    hasField(order, "amountDue")
      ? order.amountDue
      : hasField(order, "amountToCollect")
        ? order.amountToCollect
        : totalAmount - amountPaid
  ) || 0);
  const paymentRequired = paymentRequiredForOrder(order, amountDue);
  const paid = paymentStatus === "paid"
    || paymentStatus === "success"
    || paymentStatus === "collected"
    || order.paymentCompleted === true
    || order.paymentCaptured === true
    || !!order.razorpayPaymentId
    || !!order.transactionId;
  const blockedStatus = ["Delivered","Cancelled","Rejected","Failed"].includes(statusText);
  const refunded = paymentStatus === "refunded" || order.refunded === true || order.refundStatus === "refunded";
  const validMethod = ["cod", "cash", "online", "upi", ""].includes(paymentMethod);
  const visible = !!order.id
    && paymentRequired
    && !paid
    && !blockedStatus
    && !refunded
    && validMethod
    && (amountDue >= 1 || totalAmount >= 1);
  const decision = {
    orderId:order.id || order.orderId || "",
    paymentStatus,
    paymentMethod:paymentMethod || "(missing)",
    paymentRequired,
    paymentCompleted:paid,
    amountDue,
    amountPaid,
    orderStatus:statusText,
    visible,
    reason:visible ? "payment_pending_required" : blockedStatus ? "order_not_payable" : refunded ? "refunded" : paid ? "already_paid" : !paymentRequired ? "payment_not_required" : !validMethod ? "invalid_payment_method" : "no_payable_amount"
  };
  console.info("[PAYMENT DIAGNOSTIC]", decision);
  return decision;
}

function canPayForOrder(order = {}){
  return paymentDecisionForOrder(order).visible;
}

async function migrateLegacyPaymentFields(order = {}){
  if(!order.id || order._paymentMigrationChecked) return;
  const decision = paymentDecisionForOrder(order);
  const missingCanonicalFields = !hasField(order, "paymentRequired")
    || !hasField(order, "paymentCompleted")
    || !hasField(order, "amountDue")
    || !hasField(order, "amountPaid")
    || !String(order.paymentStatus || "")
    || !String(order.paymentMethod || order.paymentMode || "");
  if(!missingCanonicalFields) return;
  order._paymentMigrationChecked = true;
  try{
    await updateDoc(doc(db, "orders", order.id), {
      paymentStatus:decision.paymentStatus || "pending",
      paymentMethod:String(order.paymentMethod || order.paymentMode || "cod").toLowerCase(),
      paymentRequired:decision.paymentRequired,
      paymentCompleted:decision.paymentCompleted,
      amountDue:decision.amountDue,
      amountPaid:decision.amountPaid,
      paymentSchemaMigratedAt:serverTimestamp()
    });
    console.info("[PAYMENT MIGRATION]", {
      orderId:order.id,
      paymentStatus:decision.paymentStatus,
      paymentMethod:order.paymentMethod || order.paymentMode || "cod",
      paymentRequired:decision.paymentRequired,
      amountDue:decision.amountDue
    });
  }catch(error){
    console.warn("[PAYMENT MIGRATION] skipped", { orderId:order.id, error:error?.message || error });
  }
}

function buildPayNowActionHTML(order = {}){
  if(!canPayForOrder(order)) return "";
  const method = String(order.paymentMethod || order.paymentMode || "").toLowerCase();
  const label = method === "cod" || method === "cash"
    ? "Want to pay online now?"
    : "Payment pending";
  return `
    <div class="order-pay-now-card">
      <div>
        <strong>${escapeHTML(label)}</strong>
        <span>Complete payment safely, or remove this unpaid order if you do not want to pay.</span>
      </div>
      <div class="order-pay-actions">
        <button type="button" class="pay-now-order-btn" onclick="payPendingOrder('${escapeHTML(order.id)}')">Pay now</button>
        <button type="button" class="remove-pending-payment-btn" onclick="cancelUnpaidPaymentOrder('${escapeHTML(order.id)}')">Remove</button>
      </div>
    </div>
  `;
}

function buildPaymentTrackingHTML(order){
  const statusText = normalizeTimelineStatus(order.status || order.orderStatus || order.lifecycleStatus || "");
  const paymentStatus = String(order.paymentStatus || "").toLowerCase();
  const paymentMethod = String(order.paymentMethod || order.paymentMode || "").toLowerCase();
  const paid = paymentStatus === "paid" || paymentStatus === "collected" || order.paymentCaptured === true || !!order.razorpayPaymentId;
  const canPayNow = canPayForOrder(order);
  if(!canPayNow && !["Out For Delivery","Reached Nearby","Nearby","Collect Payment","Cash Collected","Payment Settled","Payment Completed","Delivery Code Pending","Delivered"].includes(statusText)) return "";
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
      ${canPayNow ? `<div class="order-pay-actions"><button type="button" class="pay-now-order-btn" onclick="payPendingOrder('${escapeHTML(order.id)}')">Pay now</button><button type="button" class="remove-pending-payment-btn" onclick="cancelUnpaidPaymentOrder('${escapeHTML(order.id)}')">Remove</button></div>` : ""}
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

function orderItemExtras(item = {}){
  const extras = Array.isArray(item.extras) ? item.extras : (Array.isArray(item.addOns) ? item.addOns : []);
  return extras.filter(extra => extra && extra.name);
}

function orderItemBaseLineTotal(item = {}){
  const qty = Number(item.qty || item.quantity || 1);
  const extras = orderItemExtras(item);
  const extrasTotal = extras.reduce((sum, extra) => sum + Number(extra.price || 0), 0) * qty;
  const storedBase = Number(item.baseUnitPrice || item.unitPrice || 0);
  if(storedBase > 0) return storedBase * qty;
  return Math.max(0, Number(item.price || 0) - extrasTotal);
}

function orderItemBreakdownHTML(item = {}, moneyFormatter = formatCurrency){
  const qty = Number(item.qty || item.quantity || 1);
  const extras = orderItemExtras(item);
  const lines = [];
  if(isPizzaCartItem(item)){
    const crust = normalizeCrust(item.crust || item.crustType || item.selectedCrust);
    lines.push(`Crust: ${crust.label} - ${crust.description}`);
  }
  lines.push(`Base: ${moneyFormatter(orderItemBaseLineTotal(item))}`);
  extras.forEach(extra => {
    lines.push(`${extra.name}: ${moneyFormatter(Number(extra.price || 0) * qty)}`);
  });
  return lines.map(line => `<small>${escapeHTML(line)}</small>`).join("");
}

function loadExternalScriptOnce(src, globalCheck){
  if(typeof globalCheck === "function" && globalCheck()) return Promise.resolve();
  window.__magneetozScriptLoads = window.__magneetozScriptLoads || {};
  if(window.__magneetozScriptLoads[src]) return window.__magneetozScriptLoads[src];
  window.__magneetozScriptLoads[src] = new Promise((resolve, reject) => {
    const existing = [...document.scripts].find(script => script.src === src);
    if(existing){
      existing.addEventListener("load", () => resolve(), { once:true });
      existing.addEventListener("error", () => reject(new Error(`Unable to load ${src}`)), { once:true });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Unable to load ${src}`));
    document.head.appendChild(script);
  });
  return window.__magneetozScriptLoads[src];
}

async function ensureInvoicePdfTools(){
  await loadExternalScriptOnce(
    "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
    () => !!window.html2canvas
  );
  await loadExternalScriptOnce(
    "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
    () => !!window.jspdf?.jsPDF
  );
  return {
    html2canvas:window.html2canvas,
    jsPDF:window.jspdf?.jsPDF
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
  let tools;
  try{
    tools = await ensureInvoicePdfTools();
  }catch(error){
    console.warn("Invoice PDF tools failed to load:", error);
    alert("Invoice PDF tool load nahi ho pa raha. Please internet check karke retry karein.");
    return;
  }
  const jsPDF = tools.jsPDF;
  const money = value => `Rs. ${Math.round(Number(value) || 0).toLocaleString("en-IN")}`;
  const rows = (order.items || []).map(item => {
    const qty = Number(item.qty || 1);
    const total = Number(item.price || 0);
    const baseTotal = orderItemBaseLineTotal(item);
    const unit = qty ? baseTotal / qty : baseTotal;
    const size = item.size ? `<div class="muted">Size: ${escapeHTML(item.size)}</div>` : "";
    const combo = item.comboName ? `<div class="muted">Combo: ${escapeHTML(item.comboName)}</div>` : "";
    const crust = isPizzaCartItem(item) ? normalizeCrust(item.crust || item.crustType || item.selectedCrust) : null;
    const crustLine = crust ? `<div class="muted">Crust: ${escapeHTML(crust.label)} - ${escapeHTML(crust.description)}</div>` : "";
    const extras = orderItemExtras(item);
    const extrasLine = extras.length
      ? `<div class="muted">Extras: ${extras.map(extra => `${escapeHTML(extra.name)} ${money(Number(extra.price || 0) * qty)}`).join(", ")}</div>`
      : "";
    const baseLine = `<div class="muted">Base: ${money(baseTotal)}</div>`;
    const itemName = cleanInvoiceItemName(item.name || "Item");
    return `<tr>
      <td><strong>${escapeHTML(itemName)}</strong>${size}${combo}${crustLine}${baseLine}${extrasLine}</td>
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
      <h2 id="deliveryFeedbackTitle">Give feedback and earn reward 🍕</h2>
      <div class="feedback-reward-banner" id="feedbackRewardBanner">Earn Pizza Points for this delivered order</div>
      <p class="feedback-step-label">Overall rating *</p>
      <div class="feedback-stars feedback-overall-stars" data-feedback-stars="overall" aria-label="Overall rating">
        ${[1,2,3,4,5].map(i => `<button type="button" data-rating="${i}" aria-label="${i} star">★</button>`).join("")}
      </div>
      <div class="feedback-detail-list">
        ${starGroup("foodQuality", "🍕 Food Quality", true)}
        ${starGroup("taste", "😋 Taste")}
        ${starGroup("freshness", "🌿 Freshness")}
        ${starGroup("delivery", "🛵 Delivery")}
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
  const eligibleAmount = Number(order.subtotalAmount || order.subtotal || order.grandTotal || order.totalAmount || 0);
  const rewardPoints = eligibleAmount >= 500 ? 20
    : eligibleAmount >= 400 ? 15
    : eligibleAmount >= 300 ? 10
    : eligibleAmount >= 200 ? 5
    : eligibleAmount >= 100 ? 3
    : 0;
  const rewardBanner = popup.querySelector("#feedbackRewardBanner");
  if(rewardBanner) rewardBanner.textContent = rewardPoints
    ? `Submit feedback and get ${rewardPoints} Pizza Points`
    : "Orders below ₹100 are not eligible for Pizza Points";
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
      toastSuccess(rewardPoints ? `Thank you! ${rewardPoints} Pizza Points will be credited.` : "Thank you for your feedback.");
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
        orderStatus:"Cancelled",
        cancelledBy:"customer",
        cancelledAt:serverTimestamp(),
        riderStatus:"Cancelled by customer",
        pizzaPointsRefundEligible:false,
        pizzaPointsForfeited:Number(order.walletPointsUsed || order.walletDiscount || 0),
        pizzaPointsForfeitureReason:"customer_cancelled_order"
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
window.selectPizzaSize = selectPizzaSize;
window.updatePrice = updatePrice;
window.removeItem = removeItem;
window.changeCartItemQty = changeCartItemQty;
window.toggleCart = toggleCart;
window.placeOrder = placeOrder;
window.toggleWalletRedemption = toggleWalletRedemption;
document.getElementById("walletToggleBtn")?.addEventListener("click", toggleWalletRedemption);
window.codOrder = codOrder;
window.upiOrder = upiOrder;
window.closePaymentPopup = closePaymentPopup;
window.closeServicePopup = closeServicePopup;
window.trackOrderByPhone = trackOrderByPhone;
window.closeOrderPopup = closeOrderPopup;
window.closeMinOrderPopup = closeMinOrderPopup;

/* ================= MAGNEETOZ CHATBOT ================= */

function initMagneetozChatbot(){
  const widget = document.getElementById("magneetozChatbot");
  const toggle = document.getElementById("chatbotToggle");
  const panel = document.getElementById("chatbotPanel");
  const close = document.getElementById("chatbotClose");
  const messages = document.getElementById("chatbotMessages");
  const actions = document.getElementById("chatbotQuickActions");
  if(!widget || !toggle || !panel || !messages || !actions) return;

  const replies = {
    order:"Order simple hai: menu se food add karo, cart open karo, location aur name complete karo, phir COD ya UPI choose karo.",
    location:"Delivery ke liye current GPS, search address ya manual address use kar sakte ho. Location add hone ke baad delivery charge auto calculate hota hai.",
    offers:"Offers cart me auto-check hote hain. Coupon available ho to cart me coupon box me apply karo. BOGO/combos ke liye eligible item aur size cart me clearly dikhega.",
    tracking:"Order place hone ke baad Profile/Tracking section me live status dikhega. Previous delivered order se Order Again bhi kar sakte ho.",
    otp:"OTP 30-60 seconds le sakta hai. Number sahi ho, SMS inbox check karo, aur latest OTP hi enter karo. OTP field popup me open rahega.",
    support:"Aap WhatsApp support par connect ho sakte ho. Order issue ho to cart/order details ka screenshot bhej dena."
  };

  const labels = {
    order:"Order kaise karein?",
    location:"Delivery location",
    offers:"Offers/Coupons",
    tracking:"Track order",
    otp:"Login/OTP help",
    support:"WhatsApp support"
  };

  const addMessage = (text, type = "bot") => {
    const bubble = document.createElement("div");
    bubble.className = `chatbot-message ${type}`;
    bubble.textContent = text;
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
  };

  const setOpen = (open) => {
    panel.hidden = !open;
    widget.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const openWhatsappSupport = () => {
    const phone = String(deliveryPricingSettings.whatsappNumber || "918303614331").replace(/\D/g, "");
    const text = "Hi MAGNEETOZ, mujhe website/order me help chahiye.";
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, "_blank");
  };

  toggle.addEventListener("click", () => setOpen(panel.hidden));
  close?.addEventListener("click", () => setOpen(false));
  actions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-chatbot-action]");
    if(!button) return;
    const action = button.dataset.chatbotAction;
    addMessage(labels[action] || button.textContent.trim(), "user");
    addMessage(replies[action] || "Main help ke liye ready hoon.", "bot");
    if(action === "order"){
      document.getElementById("menuSection")?.scrollIntoView({ behavior:"smooth", block:"start" });
    }
    if(action === "location"){
      setTimeout(() => window.openLocationSelector?.(), 450);
    }
    if(action === "tracking"){
      setTimeout(() => document.getElementById("profileBtn")?.click(), 450);
    }
    if(action === "support"){
      setTimeout(openWhatsappSupport, 450);
    }
  });
}

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", initMagneetozChatbot, { once:true });
}else{
  initMagneetozChatbot();
}

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
