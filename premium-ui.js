const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  deferredInstall: null,
  recentSearches: JSON.parse(localStorage.getItem("magneetozRecentSearches") || "[]"),
  rafPending: false,
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce), (max-width: 720px)").matches,
  scrollProgress: null,
  floatingFood: []
};

function fallbackImage(value){
  const image = String(value || "").trim();
  if(!image) return "logo_tran.png";
  if(image.startsWith("http://") || image.startsWith("https://") || image.startsWith("data:") || image.startsWith("blob:")){
    return image;
  }
  return image.replace(/^\.?\//, "") || "logo_tran.png";
}

function setAppHeight(){
  document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
}

function ensureScrollProgress(){
  if($(".scroll-progress")) return;
  const bar = document.createElement("div");
  bar.className = "scroll-progress";
  document.body.appendChild(bar);
  state.scrollProgress = bar;
}

function updateScrollEffects(){
  state.rafPending = false;
  if(state.reducedMotion) return;
  const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  const progress = scrollY / max;
  state.scrollProgress?.style.setProperty("transform", `scaleX(${progress})`);
  state.floatingFood.forEach((el, index) => {
    const speed = (index + 1) * .035;
    el.style.transform = `translate3d(0, ${scrollY * speed}px, 0)`;
  });
}

function requestScrollEffects(){
  if(state.reducedMotion) return;
  if(state.rafPending) return;
  state.rafPending = true;
  requestAnimationFrame(updateScrollEffects);
}

function cacheScrollEffectTargets(){
  state.scrollProgress = $(".scroll-progress");
  state.floatingFood = state.reducedMotion ? [] : $$(".floating-food");
}

function toast(message){
  const host = $("#premiumToastHost");
  if(!host) return;
  const node = document.createElement("div");
  node.className = "premium-toast";
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

function hideSplash(){
  setTimeout(() => $("#premiumSplash")?.classList.add("hide"), 650);
}

function revealOnScroll(){
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(entry.isIntersecting){
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold:.12 });
  $$(".reveal-on-scroll").forEach(el => observer.observe(el));
}

function openSearch(){
  const overlay = $("#smartSearchOverlay");
  overlay?.classList.add("active");
  overlay?.setAttribute("aria-hidden","false");
  setTimeout(() => $("#smartSearchInput")?.focus(), 80);
  renderSearch("");
}

function closeSearch(){
  const overlay = $("#smartSearchOverlay");
  overlay?.classList.remove("active");
  overlay?.setAttribute("aria-hidden","true");
}

function cards(){
  return $$(".new-card").map(card => ({
    card,
    name: card.dataset.dishName || card.querySelector("h3")?.textContent || "Magneetoz dish",
    desc: card.dataset.dishDesc || card.querySelector("p")?.textContent || "Fresh MAGNEETOZ favourite",
    image: fallbackImage(card.dataset.dishImage || card.querySelector("img")?.getAttribute("src")),
    category: card.dataset.dishCategory || "Recommended",
    price: card.querySelector(".offer")?.textContent?.trim() || ""
  }));
}

function saveRecent(term){
  const clean = term.trim();
  if(!clean) return;
  state.recentSearches = [clean, ...state.recentSearches.filter(item => item !== clean)].slice(0, 5);
  localStorage.setItem("magneetozRecentSearches", JSON.stringify(state.recentSearches));
  renderRecentSearches();
}

function renderRecentSearches(){
  const host = $("#recentSearches");
  const section = $("#recentSearchSection");
  if(!host || !section) return;
  section.style.display = state.recentSearches.length ? "block" : "none";
  host.innerHTML = state.recentSearches
    .map(term => `<button type="button" data-search-term="${term}">${term}</button>`)
    .join("");
}

function renderSearch(term){
  const host = $("#smartSearchResults");
  if(!host) return;
  const clean = term.trim().toLowerCase();
  const results = cards()
    .filter(item => !clean || `${item.name} ${item.desc} ${item.category}`.toLowerCase().includes(clean))
    .slice(0, 9);

  if(!results.length){
    host.innerHTML = `<div class="search-result"><strong>No exact match</strong><span>Try pizza, combo, cheese, or garlic.</span></div>`;
    return;
  }

  host.innerHTML = results.map((item, index) => `
    <button type="button" class="search-result" data-card-index="${index}">
      <span>
        <strong>${item.name}</strong>
        <span>${item.category} ${item.price ? "• " + item.price : ""}</span>
      </span>
      <b>View</b>
    </button>
  `).join("");

  $$(".search-result", host).forEach((button, index) => {
    button.addEventListener("click", () => {
      const item = results[index];
      saveRecent(item.name);
      closeSearch();
      item.card.scrollIntoView({ behavior:"smooth", block:"center" });
      item.card.classList.add("cart-pulse");
      setTimeout(() => item.card.classList.remove("cart-pulse"), 500);
    });
  });
}

function wireSearch(){
  $("#openSearchBtn")?.addEventListener("click", openSearch);
  $("#smartSearchTrigger")?.addEventListener("click", openSearch);
  $("#bottomSearchBtn")?.addEventListener("click", openSearch);
  $("#closeSmartSearch")?.addEventListener("click", closeSearch);
  $("#smartSearchOverlay")?.addEventListener("click", event => {
    if(event.target.id === "smartSearchOverlay") closeSearch();
  });
  $("#smartSearchInput")?.addEventListener("input", event => renderSearch(event.target.value));
  $("#smartSearchInput")?.addEventListener("keydown", event => {
    if(event.key === "Enter"){
      saveRecent(event.target.value);
      renderSearch(event.target.value);
    }
  });
  $("#trendingSearches")?.addEventListener("click", event => {
    const button = event.target.closest("button");
    if(!button) return;
    const input = $("#smartSearchInput");
    input.value = button.textContent.trim();
    saveRecent(input.value);
    renderSearch(input.value);
  });
  $("#recentSearches")?.addEventListener("click", event => {
    const term = event.target.closest("button")?.dataset.searchTerm;
    if(!term) return;
    $("#smartSearchInput").value = term;
    renderSearch(term);
  });
  $("#voiceSearchBtn")?.addEventListener("click", () => toast("Voice search UI is ready for browser speech support."));
  renderRecentSearches();
}

function buildRecommendations(){
  const host = $("#recommendedRail");
  if(!host) return;
  const items = cards().slice(0, 8);
  if(!items.length){
    host.innerHTML = `
      <div class="recommendation-card">
        <span>Most Loved</span>
        <strong>Fresh picks will appear as soon as menu loads.</strong>
      </div>`;
    return;
  }
  host.innerHTML = items.map((item, index) => `
    <div class="recommendation-card">
      <img src="${item.image}" alt="${item.name}" loading="lazy" decoding="async">
      <span>${index % 2 ? "Popular Near You" : "Recommended"}</span>
      <strong>${item.name}</strong>
      <small>${item.price || item.category}</small>
      <button type="button" data-reco-index="${index}">View</button>
    </div>
  `).join("");
  $$("img", host).forEach(img => {
    img.addEventListener("error", () => {
      img.src = "logo_tran.png";
    }, { once:true });
  });
  $$("[data-reco-index]", host).forEach(button => {
    button.addEventListener("click", () => {
      const item = items[Number(button.dataset.recoIndex)];
      item.card.scrollIntoView({ behavior:"smooth", block:"center" });
      item.card.classList.add("cart-pulse");
      setTimeout(() => item.card.classList.remove("cart-pulse"), 500);
    });
  });
}

function openPreview(card){
  $("#previewImage").src = fallbackImage(card.dataset.dishImage || card.querySelector("img")?.getAttribute("src"));
  $("#previewTitle").textContent = card.dataset.dishName || card.querySelector("h3")?.textContent || "MAGNEETOZ special";
  $("#previewDesc").textContent = card.dataset.dishDesc || "Fresh, hot, and made for cravings.";
  $("#previewTag").textContent = card.dataset.dishCategory || "Most loved";
  $("#quickPreview")?.classList.add("active");
  $("#quickPreview")?.setAttribute("aria-hidden","false");
}

function wirePreview(){
  document.addEventListener("click", event => {
    const previewButton = event.target.closest("[data-preview]");
    if(previewButton){
      openPreview(previewButton.closest(".new-card"));
    }
  });
  $("#closeQuickPreview")?.addEventListener("click", closePreview);
  $("#quickPreview")?.addEventListener("click", event => {
    if(event.target.id === "quickPreview") closePreview();
  });
}

function closePreview(){
  $("#quickPreview")?.classList.remove("active");
  $("#quickPreview")?.setAttribute("aria-hidden","true");
}

function wireNavigation(){
  document.addEventListener("click", event => {
    const target = event.target.closest("[data-scroll-target]")?.dataset.scrollTarget;
    if(!target) return;
    $(target)?.scrollIntoView({ behavior:"smooth", block:"start" });
  });
  $("#profileBtn")?.addEventListener("click", () => $("#profileDrawer")?.classList.add("active"));
  $("#closeProfile")?.addEventListener("click", () => $("#profileDrawer")?.classList.remove("active"));
  $("#profileDrawer")?.addEventListener("click", event => {
    if(event.target.id === "profileDrawer") $("#profileDrawer")?.classList.remove("active");
  });
}

function wireMobileGestures(){
  const cartPanel = $("#cartPanel");
  if(!cartPanel) return;
  let startY = 0;
  let startX = 0;
  cartPanel.addEventListener("touchstart", event => {
    startY = event.touches[0].clientY;
    startX = event.touches[0].clientX;
  }, { passive:true });
  cartPanel.addEventListener("touchend", event => {
    const touch = event.changedTouches[0];
    const deltaY = touch.clientY - startY;
    const deltaX = touch.clientX - startX;
    if(Math.abs(deltaY) > Math.abs(deltaX) && deltaY > 90 && cartPanel.classList.contains("active")){
      window.toggleCart?.(false);
    }
  }, { passive:true });
}

function wireMagneticButtons(){
  if(matchMedia("(hover:none)").matches) return;
  document.addEventListener("mousemove", event => {
    $$(".magnetic-btn").forEach(button => {
      const rect = button.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width / 2;
      const y = event.clientY - rect.top - rect.height / 2;
      const distance = Math.hypot(x, y);
      if(distance < 110){
        button.style.transform = `translate(${x * .08}px, ${y * .08}px)`;
      }else{
        button.style.transform = "";
      }
    });
  });
}

function wireCartPolish(){
  window.addEventListener("magneetoz:item-added", event => {
    $(".cart-circle")?.classList.add("cart-pulse");
    setTimeout(() => $(".cart-circle")?.classList.remove("cart-pulse"), 420);
    toast(`${event.detail.name} added to cart`);
  });
  window.addEventListener("magneetoz:cart-updated", event => {
    const total = $("#total");
    if(total) total.animate?.([{ transform:"scale(1)" }, { transform:"scale(1.12)" }, { transform:"scale(1)" }], { duration:360 });
    document.body.classList.toggle("has-cart-items", event.detail.count > 0);
  });
}

function confetti(){
  const colors = ["#ff7b00","#22c55e","#38bdf8","#ff4f8b","#fde047"];
  for(let i = 0; i < 42; i++){
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.left = Math.random() * 100 + "vw";
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = Math.random() * .35 + "s";
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 2200);
  }
}

function wireSuccess(){
  window.addEventListener("magneetoz:order-success", event => {
    confetti();
    toast(`Order #${event.detail.orderNumber} placed successfully`);
  });
}

function wireInstallPrompt(){
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    state.deferredInstall = event;
    if(localStorage.getItem("magneetozInstallDismissed") !== "1"){
      $("#installAppPrompt")?.classList.add("show");
    }
  });
  $("#installAppBtn")?.addEventListener("click", async () => {
    if(!state.deferredInstall){
      toast("Install prompt will appear when your browser allows it.");
      return;
    }
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    $("#installAppPrompt")?.classList.remove("show");
  });
  $("#dismissInstallPrompt")?.addEventListener("click", () => {
    localStorage.setItem("magneetozInstallDismissed","1");
    $("#installAppPrompt")?.classList.remove("show");
  });
  if("serviceWorker" in navigator && location.protocol.startsWith("http")){
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

function liveActivity(){
  const text = $("#liveActivityText");
  if(!text) return;
  const messages = [
    "12 customers are exploring MAGNEETOZ now",
    "3 fresh orders were placed recently",
    "Kitchen is live and accepting orders",
    "Secure UPI and COD checkout enabled"
  ];
  let index = 0;
  setInterval(() => {
    index = (index + 1) % messages.length;
    text.textContent = messages[index];
  }, 4200);
}

window.addEventListener("magneetoz:menu-rendered", () => {
  cacheScrollEffectTargets();
  buildRecommendations();
  renderSearch($("#smartSearchInput")?.value || "");
});

document.addEventListener("DOMContentLoaded", () => {
  setAppHeight();
  if(!state.reducedMotion) ensureScrollProgress();
  cacheScrollEffectTargets();
  hideSplash();
  revealOnScroll();
  wireSearch();
  wirePreview();
  wireNavigation();
  wireMobileGestures();
  wireMagneticButtons();
  wireCartPolish();
  wireSuccess();
  wireInstallPrompt();
  liveActivity();
  buildRecommendations();
  if(!state.reducedMotion) updateScrollEffects();
});

window.addEventListener("resize", setAppHeight, { passive:true });
window.addEventListener("orientationchange", setAppHeight, { passive:true });
if(!state.reducedMotion) window.addEventListener("scroll", requestScrollEffects, { passive:true });
