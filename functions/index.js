require("dotenv").config();
const cors = require("cors")({ origin: true });
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const {
  normalizeStatus: normalizeOrderMachineStatus,
  statusRank: machineStatusRank,
  assertForwardTransition,
  timelineEntry
} = require("./services/orderStateMachine");
const {
  assertPaymentOnlyPayload,
  buildPaymentUpdate
} = require("./services/paymentService");
const growth = require("./services/growthService");
const {
  normalizeDeliverySettings,
  calculateDeliveryPricing
} = require("./services/deliveryPricing");

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();
const FieldValue = admin.firestore.FieldValue;
const openAiApiKeySecret = defineSecret("OPENAI_API_KEY");

function env(name) {
  return process.env[name] || process.env[`FUNCTIONS_${name}`] || "";
}

function extractResponseText(data = {}) {
  if (typeof data.output_text === "string") return data.output_text;
  const parts = [];
  (data.output || []).forEach(item => {
    (item.content || []).forEach(content => {
      if (content.text) parts.push(content.text);
    });
  });
  return parts.join("\n").trim();
}

async function callOpenAIJson({ instructions, input, fallback }) {
  const apiKey = env("OPENAI_API_KEY") || env("AI_API_KEY");
  if (!apiKey) return fallback;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: env("OPENAI_MODEL") || "gpt-4o-mini",
      instructions,
      input,
      max_output_tokens: 700
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    logger.warn("OpenAI request failed", { status: response.status, error: data.error?.message });
    return fallback;
  }
  const text = extractResponseText(data);
  try {
    return JSON.parse(String(text || "").replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
  } catch (error) {
    return { ...fallback, raw: text };
  }
}

function getRazorpay() {
  const key_id = env("RAZORPAY_KEY_ID");
  const key_secret = env("RAZORPAY_KEY_SECRET");
  if (!key_id || !key_secret) throw new Error("Razorpay credentials are not configured");
  return new Razorpay({ key_id, key_secret });
}

async function requireAuth(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) throw Object.assign(new Error("Login required"), { status: 401 });
  return admin.auth().verifyIdToken(match[1]);
}

function normalizeIndianPhone(value = "") {
  const digits = String(value || "").replace(/\D/g, "");
  const phone = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(phone) ? phone : "";
}

async function resolveVerifiedCustomerPhone(authUser, profile = {}) {
  const tokenPhone = normalizeIndianPhone(authUser?.phone_number);
  if (tokenPhone) return tokenPhone;
  const authRecord = await admin.auth().getUser(authUser.uid).catch(() => null);
  const authPhone = normalizeIndianPhone(
    authRecord?.phoneNumber
    || authRecord?.providerData?.find(provider => provider.phoneNumber)?.phoneNumber
  );
  if (authPhone) return authPhone;
  return normalizeIndianPhone(profile.phone || profile.customerPhone || profile.phoneDigits);
}

async function requireAdmin(req) {
  const user = await requireAuth(req);
  const email = String(user.email || "").toLowerCase();
  const admins = ["magneeto73@gmail.com", "sourabhpal982@gmail.com"];
  if (!admins.includes(email)) throw Object.assign(new Error("Admin access required"), { status: 403 });
  return user;
}

function sendJson(res, status, body) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.status(status).json(body);
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error("Invalid amount"), { status: 400 });
  return Math.round(amount * 100) / 100;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function amountDueForOrder(order = {}) {
  const total = Number(order.totalAmount || order.amount || order.grandTotal || order.finalAmount || 0);
  const paid = Number(order.amountPaid || 0);
  const due = hasOwn(order, "amountDue") ? Number(order.amountDue) : hasOwn(order, "amountToCollect") ? Number(order.amountToCollect) : total - paid;
  return Math.max(0, Number.isFinite(due) ? due : 0);
}

function paymentRequiredForOrder(order = {}) {
  if (hasOwn(order, "paymentRequired")) return order.paymentRequired !== false;
  const method = String(order.paymentMethod || order.paymentMode || "").toLowerCase();
  const source = String(order.checkoutSource || order.orderSource || "").toLowerCase();
  return method === "online" || method === "upi" || source.includes("razorpay") || source.includes("payment") || amountDueForOrder(order) > 0;
}

function isPaymentComplete(order = {}) {
  const status = String(order.paymentStatus || "").toLowerCase();
  return status === "paid" || status === "success" || status === "collected" || order.paymentCompleted === true || order.paymentCaptured === true || !!order.razorpayPaymentId || !!order.transactionId;
}

function canonicalPaymentFields(order = {}) {
  const status = String(order.paymentStatus || "pending").toLowerCase();
  const complete = isPaymentComplete({ ...order, paymentStatus: status });
  const amountDue = complete ? 0 : amountDueForOrder(order);
  const total = Number(order.totalAmount || order.amount || order.grandTotal || order.finalAmount || amountDue || 0);
  return {
    paymentStatus: complete ? (status === "collected" ? "collected" : "paid") : status,
    paymentRequired: paymentRequiredForOrder({ ...order, amountDue }),
    paymentCompleted: complete,
    amountDue,
    amountPaid: complete ? Number(order.amountPaid || total || 0) : Number(order.amountPaid || 0)
  };
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function netWalletState({ totalEarnings = 0, companySettlementDue = 0, totalCashCollected = 0, totalCompanySettlements = 0, totalWithdrawn = 0, totalEarningsAppliedToSettlement = 0 } = {}) {
  const earnings = Math.max(0, roundMoney(totalEarnings));
  const due = Math.max(0, roundMoney(companySettlementDue));
  const cash = Math.max(0, roundMoney(totalCashCollected));
  const settlements = Math.max(0, roundMoney(totalCompanySettlements));
  const withdrawn = Math.max(0, roundMoney(totalWithdrawn));
  const earningsApplied = Math.max(0, roundMoney(totalEarningsAppliedToSettlement));
  const netBalance = roundMoney(earnings - earningsApplied - due);
  return {
    totalEarnings: earnings,
    totalCashCollected: cash,
    totalCompanySettlements: settlements,
    totalWithdrawn: withdrawn,
    totalEarningsAppliedToSettlement: earningsApplied,
    companySettlementDue: due,
    walletBalance: Math.max(0, roundMoney(earnings - earningsApplied - due - withdrawn)),
    withdrawableBalance: Math.max(0, roundMoney(earnings - earningsApplied - due - withdrawn)),
    netBalance,
    outstandingDue: Math.max(0, -netBalance)
  };
}

function mergeWalletState(current = {}, deltas = {}) {
  return netWalletState({
    totalEarnings: Number(current.totalEarnings || 0) + Number(deltas.totalEarnings || 0),
    companySettlementDue: Number(current.companySettlementDue || 0) + Number(deltas.companySettlementDue || 0),
    totalCashCollected: Number(current.totalCashCollected || 0) + Number(deltas.totalCashCollected || 0),
    totalCompanySettlements: Number(current.totalCompanySettlements || 0) + Number(deltas.totalCompanySettlements || 0),
    totalWithdrawn: Number(current.totalWithdrawn || 0) + Number(deltas.totalWithdrawn || 0),
    totalEarningsAppliedToSettlement: Number(current.totalEarningsAppliedToSettlement || 0) + Number(deltas.totalEarningsAppliedToSettlement || 0)
  });
}

function writeWalletAudit(transaction, { riderId, orderId = "", type, before, after, deltas = {}, metadata = {} }) {
  const walletRef = db.collection("riderWallet").doc(riderId);
  const canonicalWalletRef = db.collection("riderWallets").doc(riderId);
  const walletPayload = {
    riderId,
    ...after,
    cashCollected: Number(after.totalCashCollected || 0),
    companyDue: Number(after.companySettlementDue || 0),
    companySettlements: Number(after.totalCompanySettlements || 0),
    pendingWithdrawalAmount: Number(after.pendingWithdrawal || 0),
    lastCalculatedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
  transaction.set(walletRef, {
    ...walletPayload,
    lastSettlementAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  transaction.set(canonicalWalletRef, walletPayload, { merge: true });
  transaction.set(db.collection("riderSettlementAuditLogs").doc(), {
    riderId,
    orderId,
    type,
    before,
    after,
    deltas,
    metadata,
    createdAt: FieldValue.serverTimestamp()
  });
}

const PAYMENT_ONLY_FORBIDDEN_FIELDS = new Set([
  "status",
  "orderStatus",
  "lifecycleStatus",
  "deliveryStatus",
  "riderStatus",
  "assignedRider",
  "assignedRiderId",
  "riderId",
  "deliveryTimeline",
  "deliveryOtpStatus",
  "activeDeliveryCodeId"
]);

const ORDER_STATUS_RANK = new Map([
  ["", 0],
  ["payment_pending", 0],
  ["Payment Pending", 0],
  ["Pending", 1],
  ["Accepted", 2],
  ["Assigned", 3],
  ["Searching For Rider", 3],
  ["Rider Accepted", 3],
  ["rider_assigned", 3],
  ["Picked Up", 4],
  ["picked_up", 4],
  ["Out For Delivery", 5],
  ["out_for_delivery", 5],
  ["Reached Nearby", 6],
  ["Collect Payment", 6],
  ["Nearby", 6],
  ["Delivery Code Pending", 7],
  ["Payment Completed", 7],
  ["OTP_VERIFIED", 7],
  ["Delivered", 8],
  ["delivered", 8],
  ["Cancelled", 99],
  ["Rejected", 99],
  ["Failed", 99],
  ["failed", 99]
]);

function orderStatusRank(status = "") {
  return machineStatusRank(status);
}

function assertNoBackwardOrderStatus({ orderId, current = {}, update = {}, actor = "system", source = "" }) {
  const currentStatus = current.status || current.orderStatus || "";
  const nextStatus = Object.prototype.hasOwnProperty.call(update, "status") ? update.status : current.status;
  const nextOrderStatus = Object.prototype.hasOwnProperty.call(update, "orderStatus") ? update.orderStatus : current.orderStatus;
  const next = nextStatus || nextOrderStatus || "";
  if (!next) return;
  try {
    assertForwardTransition({ orderId, currentStatus, nextStatus: next, actor, source });
  } catch (error) {
    logger.error("Blocked backward order status update", {
      orderId,
      actor,
      source,
      currentStatus,
      nextStatus: next,
      currentRank: orderStatusRank(currentStatus),
      nextRank: orderStatusRank(next),
      changedFields: Object.keys(update)
    });
    throw error;
  }
}

function guardedOrderUpdate(transaction, orderRef, currentOrder, update, { actor = "system", source = "" } = {}) {
  assertNoBackwardOrderStatus({
    orderId: orderRef.id,
    current: currentOrder || {},
    update,
    actor,
    source
  });
  const nextStatus = Object.prototype.hasOwnProperty.call(update, "status") ? update.status : (currentOrder?.status || "");
  const changedFields = Object.keys(update);
  const finalUpdate = { ...update };
  if (Object.prototype.hasOwnProperty.call(update, "status") || Object.prototype.hasOwnProperty.call(update, "orderStatus")) {
    finalUpdate.timeline = FieldValue.arrayUnion(timelineEntry({ status: nextStatus, actor, source }));
  }
  transaction.set(db.collection("orderWriteAuditLogs").doc(), {
    orderId: orderRef.id,
    actor,
    source,
    previousStatus: currentOrder?.status || currentOrder?.orderStatus || "",
    newStatus: nextStatus,
    previousOrderStatus: currentOrder?.orderStatus || "",
    newOrderStatus: Object.prototype.hasOwnProperty.call(update, "orderStatus") ? update.orderStatus : (currentOrder?.orderStatus || ""),
    changedFields,
    createdAt: FieldValue.serverTimestamp()
  });
  transaction.update(orderRef, finalUpdate);
}

function assertPaymentOnlyUpdate(update = {}) {
  const forbidden = Object.keys(update).filter(key => PAYMENT_ONLY_FORBIDDEN_FIELDS.has(key));
  if (forbidden.length) {
    logger.error("Blocked payment update containing delivery fields", { forbidden });
    throw Object.assign(new Error(`Payment update cannot modify delivery fields: ${forbidden.join(", ")}`), { status: 500 });
  }
}

function paymentOnlyUpdate({ paymentSessionId, razorpayOrderId, paymentId, amount, source }) {
  const update = buildPaymentUpdate({
    paymentSessionId,
    razorpayOrderId,
    paymentId,
    transactionId: paymentId,
    amount,
    paidAt: FieldValue.serverTimestamp()
  });
  assertPaymentOnlyPayload(update);
  assertPaymentOnlyUpdate(update);
  return update;
}

function updatePaymentStatus(transaction, orderRef, paymentData = {}) {
  const update = paymentOnlyUpdate(paymentData);
  transaction.update(orderRef, update);
  transaction.set(db.collection("orderWriteAuditLogs").doc(), {
    orderId: orderRef.id,
    actor: paymentData.actor || "customer",
    source: paymentData.source || "payment_only_update",
    previousStatus: paymentData.statusBefore?.status || "",
    newStatus: paymentData.statusBefore?.status || "",
    previousOrderStatus: paymentData.statusBefore?.orderStatus || "",
    newOrderStatus: paymentData.statusBefore?.orderStatus || "",
    paymentStatusBefore: paymentData.paymentStatusBefore || "",
    paymentStatusAfter: "paid",
    changedFields: Object.keys(update),
    createdAt: FieldValue.serverTimestamp()
  });
  return update;
}

function isUsablePoint(point = {}) {
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function roundedPoint(point = {}) {
  return { latitude: Number(point.lat), longitude: Number(point.lng) };
}

async function calculateGoogleRouteDistance({ origin, destination }) {
  if (!isUsablePoint(origin) || !isUsablePoint(destination)) {
    throw Object.assign(new Error("Valid origin and destination are required"), { status: 400 });
  }
  const apiKey = env("GOOGLE_MAPS_API_KEY") || env("GOOGLE_ROUTES_API_KEY");
  if (!apiKey) throw Object.assign(new Error("Google Routes API key is not configured"), { status: 500 });
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.routeLabels"
    },
    body: JSON.stringify({
      origin: { location: { latLng: roundedPoint(origin) } },
      destination: { location: { latLng: roundedPoint(destination) } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: false,
      units: "METRIC"
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error?.message || "Google route distance failed"), { status: 502 });
  }
  const route = data.routes?.[0];
  if (!route?.distanceMeters) throw Object.assign(new Error("No drivable route found"), { status: 422 });
  const distanceKm = Math.round((Number(route.distanceMeters) / 1000) * 100) / 100;
  const durationSeconds = Number(String(route.duration || "0s").replace("s", "")) || 0;
  return {
    distanceKm,
    distanceMeters: Number(route.distanceMeters),
    durationSeconds,
    durationText: durationSeconds ? `${Math.max(1, Math.round(durationSeconds / 60))} mins` : "",
    source: "google_routes_backend"
  };
}

async function callGoogleGeocode(params = {}) {
  const apiKey = env("GOOGLE_MAPS_API_KEY") || env("GOOGLE_ROUTES_API_KEY");
  if (!apiKey) throw Object.assign(new Error("Google Maps API key is not configured"), { status: 500 });
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("key", apiKey);
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status !== "OK") {
    throw Object.assign(new Error(data.error_message || data.status || "Geocoding failed"), { status: 502 });
  }
  const result = data.results?.[0];
  const location = result?.geometry?.location;
  if (!result?.formatted_address || !isUsablePoint(location)) {
    throw Object.assign(new Error("No matching address found"), { status: 422 });
  }
  return {
    formattedAddress: result.formatted_address,
    lat: Number(location.lat),
    lng: Number(location.lng),
    placeId: result.place_id || "",
    source: "google_geocoding_backend"
  };
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, stripUndefined(item)])
  );
}

function compactText(value, max = 500) {
  return String(value || "").slice(0, max);
}

function compactImageUrl(value) {
  const url = compactText(value, 700);
  if (!url || /^data:/i.test(url)) return "";
  return url;
}

function compactCartItem(item = {}) {
  const rawExtras = Array.isArray(item.extras) ? item.extras : (Array.isArray(item.addOns) ? item.addOns : []);
  const extras = rawExtras.slice(0, 20).map(extra => stripUndefined({
    id: compactText(extra.id || extra.key || extra.name, 80),
    name: compactText(extra.name, 120),
    price: Number(extra.price || 0)
  })).filter(extra => extra.name && extra.price >= 0);
  return stripUndefined({
    id: compactText(item.id, 120),
    name: compactText(item.name, 160),
    size: compactText(item.size, 80),
    variant: compactText(item.variant, 80),
    category: compactText(item.category, 120),
    crust: item.crust && typeof item.crust === "object" ? {
      id: compactText(item.crust.id || item.selectedCrust || "pan", 40),
      label: compactText(item.crust.label || item.crustType || "Pan Crust", 80),
      description: compactText(item.crust.description || "", 120)
    } : {
      id: compactText(item.selectedCrust || "pan", 40),
      label: compactText(item.crustType || "Pan Crust", 80),
      description: compactText(item.crustDescription || "", 120)
    },
    crustType: compactText(item.crustType || item.crust?.label || "Pan Crust", 80),
    selectedCrust: compactText(item.selectedCrust || item.crust?.id || "pan", 40),
    baseUnitPrice: Number(item.baseUnitPrice || item.unitPrice || 0),
    unitPrice: Number(item.unitPrice || item.baseUnitPrice || 0),
    extras,
    addOns: extras,
    extrasTotal: Number(item.extrasTotal || extras.reduce((sum, extra) => sum + Number(extra.price || 0), 0)),
    price: Number(item.price || 0),
    qty: Number(item.qty || item.quantity || 1),
    quantity: Number(item.quantity || item.qty || 1),
    image: compactImageUrl(item.image || item.imageUrl || item.thumbnail || "")
  });
}

function compactCart(items) {
  return Array.isArray(items) ? items.slice(0, 80).map(compactCartItem) : [];
}

function cartSubtotalFromSnapshot(items = []) {
  return roundMoney((Array.isArray(items) ? items : []).reduce((sum, item) => sum + Number(item.price || 0), 0));
}

function cartBaseSubtotalFromSnapshot(items = []) {
  return roundMoney((Array.isArray(items) ? items : []).reduce((sum, item) => {
    const qty = Number(item.qty || item.quantity || 1);
    const extras = Array.isArray(item.extras) ? item.extras : (Array.isArray(item.addOns) ? item.addOns : []);
    const extrasTotal = extras.reduce((extraSum, extra) => extraSum + Number(extra.price || 0), 0) * qty;
    const baseUnit = Number(item.baseUnitPrice || item.unitPrice || 0);
    const baseLine = baseUnit > 0 ? baseUnit * qty : Math.max(0, Number(item.price || 0) - extrasTotal);
    return sum + baseLine;
  }, 0));
}

async function secureDeliveryDraft(draft, cartSnapshot) {
  const subtotal = cartSubtotalFromSnapshot(cartSnapshot);
  const baseSubtotal = cartBaseSubtotalFromSnapshot(cartSnapshot);
  if (Math.abs(subtotal - Number(draft.subtotalAmount || draft.subtotal || 0)) > 0.01) {
    throw Object.assign(new Error("Cart subtotal changed. Please refresh checkout."), { status: 409 });
  }
  if (!draft.restaurantLocation || !draft.location) {
    throw Object.assign(new Error("Exact delivery location is required."), { status: 400 });
  }
  const [settingsSnap, pricingSnap, route] = await Promise.all([
    db.collection("settings").doc("delivery").get(),
    db.collection("settings").doc("pricing").get(),
    calculateGoogleRouteDistance({ origin: draft.restaurantLocation, destination: draft.location })
  ]);
  const settings = normalizeDeliverySettings(settingsSnap.exists ? settingsSnap.data() : {});
  const delivery = calculateDeliveryPricing({ distanceKm: route.distanceKm, subtotal, eligibleSubtotal: baseSubtotal, settings });
  if (!delivery.minimumOrderMet) {
    throw Object.assign(new Error("Minimum order value is ₹99 before extra toppings."), { status: 409 });
  }
  if (!delivery.deliveryServiceable) {
    throw Object.assign(new Error("Sorry, we are not available at your location yet."), { status: 409 });
  }
  const pricing = pricingSnap.exists ? pricingSnap.data() : {};
  const gstPercent = Math.max(0, Number(pricing.gstPercent || 0));
  const handlingCharge = Math.max(0, roundMoney(pricing.handlingCharge || 0));
  const couponDiscount = Math.max(0, Math.min(subtotal, Number(draft.couponDiscount || 0)));
  const taxableAmount = Math.max(0, subtotal - couponDiscount);
  const gstAmount = Math.round(taxableAmount * gstPercent / 100);
  const total = Math.max(0, roundMoney(taxableAmount + gstAmount + handlingCharge + delivery.deliveryFee));
  return {
    ...draft, subtotalAmount: subtotal, subtotal, baseSubtotalAmount: baseSubtotal, baseSubtotal,
    deliveryDistance: route.distanceKm, actualRoadDistance: route.distanceKm,
    distanceSource: route.source || "google_routes_backend",
    distanceKm: route.distanceKm,
    deliveryFee: delivery.deliveryFee,
    deliveryCharge: delivery.deliveryFee,
    originalDeliveryCharge: settings.flatDeliveryFee,
    freeDeliveryDiscount: delivery.freeDeliveryApplied ? settings.flatDeliveryFee : 0,
    freeDelivery: delivery.freeDeliveryApplied,
    freeDeliveryApplied: delivery.freeDeliveryApplied,
    freeDeliveryThreshold: delivery.freeDeliveryThreshold,
    amountNeededForFreeDelivery: delivery.amountNeededForFreeDelivery,
    deliveryServiceable: delivery.deliveryServiceable,
    minimumOrderValue: delivery.minimumOrderValue,
    deliveryRuleVersion: delivery.deliveryRuleVersion,
    gstPercent, gstAmount, handlingCharge,
    totalAmount: total, grandTotal: total, finalAmount: total,
    maxDeliveryDistance: settings.maxDistanceKm
  };
}

function compactOrderDraft(draft = {}, cartSnapshot = []) {
  const items = compactCart(draft.items || cartSnapshot);
  return stripUndefined({
    checkoutId: compactText(draft.checkoutId, 160),
    checkoutSignature: compactText(draft.checkoutSignature, 220),
    customerName: compactText(draft.customerName, 120),
    phone: compactText(draft.phone, 20),
    email: compactText(draft.email, 160),
    address: compactText(draft.address, 700),
    landmark: compactText(draft.landmark, 220),
    addressLat: draft.addressLat ?? null,
    addressLng: draft.addressLng ?? null,
    location: draft.location || null,
    items,
    subtotalAmount: Number(draft.subtotalAmount || draft.subtotal || 0),
    baseSubtotalAmount: Number(draft.baseSubtotalAmount || draft.baseSubtotal || 0),
    totalAmount: Number(draft.totalAmount || draft.grandTotal || draft.finalAmount || 0),
    deliveryDistance: Number(draft.deliveryDistance || 0),
    actualRoadDistance: Number(draft.actualRoadDistance || 0),
    deliveryDistanceText: compactText(draft.deliveryDistanceText, 80),
    estimatedTravelTime: compactText(draft.estimatedTravelTime, 80),
    distanceSource: compactText(draft.distanceSource, 80),
    deliveryCharge: Number(draft.deliveryCharge || 0),
    deliveryFee: Number(draft.deliveryFee ?? draft.deliveryCharge ?? 0),
    originalDeliveryCharge: Number(draft.originalDeliveryCharge || 0),
    couponId: compactText(draft.couponId, 120),
    couponCode: compactText(draft.couponCode, 80),
    couponPgName: compactText(draft.couponPgName, 160),
    couponPgCode: compactText(draft.couponPgCode, 80),
    couponDiscount: Number(draft.couponDiscount || 0),
    walletPointsRequested: Math.max(0, Math.floor(Number(draft.walletPointsRequested || 0))),
    freeDeliveryDiscount: Number(draft.freeDeliveryDiscount || 0),
    freeDelivery: Boolean(draft.freeDelivery),
    freeDeliveryApplied: Boolean(draft.freeDeliveryApplied ?? draft.freeDelivery),
    freeDeliveryThreshold: Number(draft.freeDeliveryThreshold || 0),
    amountNeededForFreeDelivery: Number(draft.amountNeededForFreeDelivery || 0),
    deliveryServiceable: draft.deliveryServiceable !== false,
    minimumOrderValue: Number(draft.minimumOrderValue || 99),
    deliveryRuleVersion: compactText(draft.deliveryRuleVersion, 80),
    distanceKm: Number(draft.distanceKm || draft.deliveryDistance || 0),
    gstPercent: Number(draft.gstPercent || 0),
    gstAmount: Number(draft.gstAmount || 0),
    handlingCharge: Number(draft.handlingCharge || 0),
    subtotal: Number(draft.subtotal || draft.subtotalAmount || 0),
    baseSubtotal: Number(draft.baseSubtotal || draft.baseSubtotalAmount || 0),
    grandTotal: Number(draft.grandTotal || draft.totalAmount || 0),
    finalAmount: Number(draft.finalAmount || draft.grandTotal || draft.totalAmount || 0),
    orderSource: compactText(draft.orderSource || "online", 80),
    restaurantId: compactText(draft.restaurantId || "primary", 120),
    restaurantName: compactText(draft.restaurantName || "MAGNEETOZ", 160),
    restaurantLocation: draft.restaurantLocation || null,
    restaurantDistance: Number(draft.restaurantDistance || 0),
    maxDeliveryDistance: Number(draft.maxDeliveryDistance || 0),
    restaurantRoutingMode: compactText(draft.restaurantRoutingMode, 80),
    userId: compactText(draft.userId, 160)
  });
}

function verifyCheckoutSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const secret = env("RAZORPAY_KEY_SECRET");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");
  const received = Buffer.from(String(razorpaySignature || ""), "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return received.length === expectedBuffer.length && crypto.timingSafeEqual(received, expectedBuffer);
}

function allowedWebOrigins() {
  return [
    "https://magneetoz.com",
    "https://www.magneetoz.com",
    "https://magneetozonline.netlify.app",
    "https://magneetoz.web.app",
    "https://magneetoz.firebaseapp.com",
    "http://localhost:8011",
    "http://localhost:8010",
    "http://127.0.0.1:8011",
    "http://127.0.0.1:8010"
  ];
}

function publicWebsiteUrl(req) {
  const configured = env("WEBSITE_URL") || env("PUBLIC_WEBSITE_URL") || "";
  const origin = req.get("origin") || "";
  const candidate = configured || (allowedWebOrigins().includes(origin) ? origin : "") || "https://magneetoz.com";
  return String(candidate).replace(/\/+$/, "");
}

function verifyPaymentLinkSignature({ paymentLinkId, paymentLinkReferenceId, paymentLinkStatus, razorpayPaymentId, razorpaySignature }) {
  const secret = env("RAZORPAY_KEY_SECRET");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${paymentLinkId}|${paymentLinkReferenceId}|${paymentLinkStatus}|${razorpayPaymentId}`)
    .digest("hex");
  const received = Buffer.from(String(razorpaySignature || ""), "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return received.length === expectedBuffer.length && crypto.timingSafeEqual(received, expectedBuffer);
}

exports.calculateRouteDistance = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      await requireAuth(req);
      const { origin, destination } = req.body || {};
      const result = await calculateGoogleRouteDistance({ origin, destination });
      await db.collection("routeDistanceLogs").add({
        origin: roundedPoint(origin),
        destination: roundedPoint(destination),
        ...result,
        createdAt: FieldValue.serverTimestamp()
      });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      logger.error("calculateRouteDistance failed", { error: error.message });
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Route distance failed" });
    }
  }
);

exports.validateDeliveryPricing = onRequest(
  { region: "asia-south1", cors: allowedWebOrigins() },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const cart = compactCart(req.body?.cart);
      const draft = compactOrderDraft(req.body?.orderDraft || {}, cart);
      if (draft.userId && draft.userId !== user.uid) {
        throw Object.assign(new Error("Checkout account mismatch"), { status: 403 });
      }
      const secured = await secureDeliveryDraft(draft, cart);
      return sendJson(res, 200, {
        ok: true,
        subtotal: secured.subtotal,
        deliveryDistance: secured.deliveryDistance,
        deliveryCharge: secured.deliveryCharge,
        deliveryFee: secured.deliveryFee,
        originalDeliveryCharge: secured.originalDeliveryCharge,
        freeDeliveryDiscount: secured.freeDeliveryDiscount,
        freeDelivery: secured.freeDelivery,
        freeDeliveryApplied: secured.freeDeliveryApplied,
        freeDeliveryThreshold: secured.freeDeliveryThreshold,
        amountNeededForFreeDelivery: secured.amountNeededForFreeDelivery,
        deliveryServiceable: secured.deliveryServiceable,
        minimumOrderValue: secured.minimumOrderValue,
        deliveryRuleVersion: secured.deliveryRuleVersion,
        maxDeliveryDistance: secured.maxDeliveryDistance
      });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Delivery validation failed" });
    }
  }
);

exports.reverseGeocodeAddress = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      await requireAuth(req);
      const { lat, lng } = req.body || {};
      const point = { lat:Number(lat), lng:Number(lng) };
      if (!isUsablePoint(point)) throw Object.assign(new Error("Valid coordinates are required"), { status: 400 });
      const result = await callGoogleGeocode({ latlng:`${point.lat},${point.lng}` });
      return sendJson(res, 200, { ok:true, ...result });
    } catch (error) {
      logger.error("reverseGeocodeAddress failed", { error: error.message });
      return sendJson(res, error.status || 500, { ok:false, error:error.message || "Reverse geocode failed" });
    }
  }
);

exports.geocodeAddress = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      await requireAuth(req);
      const address = String((req.body || {}).address || "").trim();
      if (address.length < 5) throw Object.assign(new Error("Enter a complete address"), { status: 400 });
      const result = await callGoogleGeocode({ address, components:"country:IN" });
      return sendJson(res, 200, { ok:true, ...result });
    } catch (error) {
      logger.error("geocodeAddress failed", { error: error.message });
      return sendJson(res, error.status || 500, { ok:false, error:error.message || "Address search failed" });
    }
  }
);

exports.analyzeFeedbackAI = onRequest(
  { region: "asia-south1", cors: true, secrets: [openAiApiKeySecret] },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const body = req.body || {};
      const message = String(body.message || "").slice(0, 1500);
      const rating = Number(body.rating || body.overallRating || 0);
      const feedbackId = String(body.feedbackId || "");
      const text = `${message} rating:${rating}`.toLowerCase();
      const negativeWords = ["refund", "late", "bad food", "poor service", "angry", "cold", "wrong", "missing", "cancel"];
      const highPriority = rating <= 2 || negativeWords.some(word => text.includes(word));
      const fallback = {
        sentiment: rating >= 4 ? "positive" : rating <= 2 ? "negative" : "neutral",
        sentimentScore: rating ? Math.max(-1, Math.min(1, (rating - 3) / 2)) : 0,
        emotion: highPriority ? "frustrated" : rating >= 4 ? "satisfied" : "neutral",
        summary: message ? message.slice(0, 140) : "No written message",
        complaintType: negativeWords.find(word => text.includes(word)) || "",
        highPriority,
        recommendedAction: highPriority ? "Contact customer and resolve within 24 hours." : "Thank customer and encourage repeat order."
      };
      const analysis = await callOpenAIJson({
        instructions: "You analyze restaurant customer feedback. Return only valid JSON with: sentiment positive|neutral|negative, sentimentScore number -1 to 1, emotion, summary, complaintType, highPriority boolean, recommendedAction.",
        input: JSON.stringify({ message, rating, foodQuality: body.foodQuality, delivery: body.delivery, service: body.service, valueForMoney: body.valueForMoney }),
        fallback
      });
      const clean = { ...fallback, ...analysis, highPriority: analysis.highPriority === true || fallback.highPriority };
      if (feedbackId) {
        const feedbackRef = db.collection("feedback").doc(feedbackId);
        await feedbackRef.set({
          ai: clean,
          sentiment: clean.sentiment,
          sentimentScore: Number(clean.sentimentScore || 0),
          emotion: clean.emotion || "",
          highPriority: clean.highPriority === true,
          aiAnalyzedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        if (clean.highPriority) {
          await db.collection("complaintTickets").add({
            feedbackId,
            status: "open",
            priority: "high",
            reason: clean.complaintType || "low_rating",
            recommendedAction: clean.recommendedAction || "",
            createdAt: FieldValue.serverTimestamp()
          });
        }
      }
      return sendJson(res, 200, { ok: true, analysis: clean });
    } catch (error) {
      logger.error("analyzeFeedbackAI failed", { error: error.message });
      return sendJson(res, 500, { ok: false, error: error.message || "Feedback AI failed" });
    }
  }
);

exports.generateBusinessInsightsAI = onRequest(
  { region: "asia-south1", cors: true, secrets: [openAiApiKeySecret] },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      await requireAuth(req);
      const summary = req.body?.summary || {};
      const fallback = {
        insights: [
          "Track delivered orders only as revenue to avoid fake growth.",
          "Watch repeat customer rate weekly and create offers for low-repeat periods.",
          "Compare evening orders against afternoon orders to plan staffing."
        ],
        risks: ["Pending COD orders should not be treated as revenue."],
        actions: ["Call high-value repeat customers with loyalty offers.", "Review low-selling items weekly."]
      };
      const result = await callOpenAIJson({
        instructions: "You are a restaurant startup growth analyst. Return only valid JSON with arrays: insights, risks, actions. Keep each item short and practical.",
        input: JSON.stringify(summary).slice(0, 12000),
        fallback
      });
      return sendJson(res, 200, { ok: true, ...fallback, ...result });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Insights failed" });
    }
  }
);

async function createOrderFromPaidSession({ sessionRef, session, payment, source }) {
  const orderRef = db.collection("orders").doc(session.orderId);
  const counterRef = db.collection("counters").doc("orders");
  const recoveryRef = db.collection("paidOrderRecovery").doc(session.id);
  const walletReserveRef = db.collection("walletTransactions").doc(`online_reserve_${session.id}`);
  const userRef = db.collection("users").doc(session.userId);

  const result = await db.runTransaction(async transaction => {
    const [sessionSnap, existingOrderSnap, counterSnap, userSnap, walletReserveSnap] = await Promise.all([
      transaction.get(sessionRef),
      transaction.get(orderRef),
      transaction.get(counterRef),
      transaction.get(userRef),
      transaction.get(walletReserveRef)
    ]);
    const locked = { id: sessionRef.id, ...(sessionSnap.data() || session) };
    const finalizeWalletReservation = paymentId => {
      const reservedPoints = Math.max(0, Number(locked.walletPointsReserved || 0));
      if (!reservedPoints || !walletReserveSnap.exists || walletReserveSnap.data()?.status !== "reserved") return;
      const wallet = userSnap.data() || {};
      transaction.set(userRef, {
        pendingPoints: Math.max(0, Number(wallet.pendingPoints || 0) - reservedPoints),
        lifetimePointsUsed: Number(wallet.lifetimePointsUsed || 0) + reservedPoints,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(walletReserveRef, {
        status: "debited",
        consumedAt: FieldValue.serverTimestamp(),
        razorpayPaymentId: paymentId || ""
      }, { merge: true });
    };
    if (locked.status === "order_created" && locked.createdOrderId) {
      return { orderId: locked.createdOrderId, orderNumber: locked.orderNumber || "", duplicate: true };
    }
    const existingOrder = existingOrderSnap.exists ? existingOrderSnap.data() || {} : {};
    const beforeStatus = {
      status: existingOrder.status || "",
      orderStatus: existingOrder.orderStatus || "",
      lifecycleStatus: existingOrder.lifecycleStatus || "",
      deliveryStatus: existingOrder.deliveryStatus || "",
      riderStatus: existingOrder.riderStatus || ""
    };
    const beforePaymentStatus = existingOrder.paymentStatus || "";
    if (
      existingOrderSnap.exists &&
      (String(existingOrder.paymentStatus || "").toLowerCase() === "paid" || existingOrder.paymentCaptured === true) &&
      existingOrder.orderNumber
    ) {
      transaction.set(sessionRef, {
        status: "order_created",
        walletReservationStatus: Number(locked.walletPointsReserved || 0) ? "consumed" : "none",
        createdOrderId: orderRef.id,
        orderNumber: existingOrder.orderNumber,
        orderCreatedAt: existingOrder.placedAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      finalizeWalletReservation(existingOrder.razorpayPaymentId || payment.id);
      return { orderId: orderRef.id, orderNumber: existingOrder.orderNumber, duplicate: true };
    }

    const existingStatusText = String(existingOrder.status || existingOrder.orderStatus || "").toLowerCase();
    const existingLiveOrder = existingOrderSnap.exists
      && existingStatusText
      && existingStatusText !== "payment_pending";
    if (existingLiveOrder) {
      const amount = Number(locked.amount || 0);
      const paymentId = payment.id;
      const update = updatePaymentStatus(transaction, orderRef, {
        paymentSessionId: locked.id,
        razorpayOrderId: locked.razorpayOrderId,
        paymentId,
        amount,
        source: source || "customer_pay_now",
        actor: "customer",
        statusBefore: beforeStatus,
        paymentStatusBefore: beforePaymentStatus || "pending"
      });
      transaction.set(sessionRef, {
        status: "order_created",
        createdOrderId: orderRef.id,
        orderNumber: existingOrder.orderNumber || locked.orderNumber || "",
        orderCreatedAt: existingOrder.placedAt || existingOrder.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(recoveryRef, {
        status: "payment_verified_existing_order_updated",
        paymentSessionId: locked.id,
        orderId: orderRef.id,
        orderNumber: existingOrder.orderNumber || locked.orderNumber || "",
        razorpayOrderId: locked.razorpayOrderId,
        razorpayPaymentId: paymentId,
        amount,
        userId: locked.userId,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(db.collection("paymentTransactionLogs").doc(), {
        paymentSessionId: locked.id,
        userId: locked.userId,
        orderId: orderRef.id,
        event: "payment_only_existing_order_update",
        source: source || "customer_pay_now",
        statusBefore: beforeStatus,
        statusAfter: beforeStatus,
        paymentStatusBefore: beforePaymentStatus || "pending",
        paymentStatusAfter: "paid",
        razorpayOrderId: locked.razorpayOrderId,
        razorpayPaymentId: paymentId,
        createdAt: FieldValue.serverTimestamp()
      });
      finalizeWalletReservation(paymentId);
      return { orderId: orderRef.id, orderNumber: existingOrder.orderNumber || locked.orderNumber || "", duplicate: false, paymentOnly: true };
    }

    const nextOrderNumber = Number(counterSnap.exists ? counterSnap.data().lastOrderNumber || 0 : 0) + 1;
    const draft = stripUndefined(locked.orderDraft || {});
    const amount = Number(locked.amount || 0);
    const paymentId = payment.id;
    const reservedPoints = Math.max(0, Number(locked.walletPointsReserved || 0));
    const orderData = {
      ...draft,
      orderId: orderRef.id,
      paymentSessionId: locked.id,
      razorpayOrderId: locked.razorpayOrderId,
      orderNumber: nextOrderNumber,
      invoiceNumber: draft.invoiceNumber || `MZ-${Date.now()}-${orderRef.id.slice(-6).toUpperCase()}`,
      invoiceGeneratedAt: FieldValue.serverTimestamp(),
      paymentMethod: "online",
      paymentStatus: "paid",
      paymentRequired: true,
      paymentCompleted: true,
      amountDue: 0,
      amountPaid: amount,
      amountToCollect: 0,
      paymentCaptured: true,
      paymentId,
      razorpayPaymentId: paymentId,
      transactionId: paymentId,
      companyReceivedAmount: amount,
      paymentCollectedAt: FieldValue.serverTimestamp(),
      paymentStage: "Payment Completed",
      checkoutSource: source || "razorpay_verified_backend",
      status: "Pending",
      orderStatus: "Pending",
      lifecycleStatus: "placed",
      paymentVerifiedAt: FieldValue.serverTimestamp(),
      paidAt: FieldValue.serverTimestamp(),
      timeline: [
        ...(Array.isArray(existingOrder.timeline) ? existingOrder.timeline : []),
        { status: "payment_verified", source: source || "razorpay_verified_backend", at: Date.now(), paymentId },
        { status: "placed", source: "backend", at: Date.now() }
      ],
      createdAt: existingOrder.createdAt || FieldValue.serverTimestamp(),
      placedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastStatusUpdatedAt: FieldValue.serverTimestamp()
    };

    transaction.set(counterRef, {
      lastOrderNumber: nextOrderNumber,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(orderRef, orderData, { merge: true });
    transaction.set(sessionRef, {
      status: "order_created",
      walletReservationStatus: reservedPoints ? "consumed" : "none",
      createdOrderId: orderRef.id,
      orderNumber: nextOrderNumber,
      orderCreatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(recoveryRef, {
      status: "order_created",
      paymentSessionId: locked.id,
      orderId: orderRef.id,
      orderNumber: nextOrderNumber,
      razorpayOrderId: locked.razorpayOrderId,
      razorpayPaymentId: paymentId,
      amount,
      userId: locked.userId,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    finalizeWalletReservation(paymentId);
    return { orderId: orderRef.id, orderNumber: nextOrderNumber, duplicate: false };
  });

  if (!result.duplicate) {
    await recordVerifiedOrderCouponUsage(session).catch(error => {
      logger.warn("Verified order coupon usage update skipped", {
        paymentSessionId: session.id,
        error: error.message || String(error)
      });
    });
  }

  return result;
}

async function recordVerifiedOrderCouponUsage(session = {}) {
  const draft = session.orderDraft || {};
  const couponId = String(draft.couponId || "").trim();
  if (!couponId) return;
  const discount = Number(draft.couponDiscount || 0) + Number(draft.freeDeliveryDiscount || 0);
  const userId = String(session.userId || draft.userId || "unknown");
  await db.collection("coupons").doc(couponId).update({
    usedCount: FieldValue.increment(1),
    totalDiscountGiven: FieldValue.increment(Math.max(0, discount)),
    [`usageByUser.${userId}`]: FieldValue.increment(1),
    lastUsedAt: FieldValue.serverTimestamp()
  });
}

exports.createPaymentSession = onRequest(
  {
  region: "asia-south1",
  cors: allowedWebOrigins()
},
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    try {
      const user = await requireAuth(req);
      const body = req.body || {};
      const idempotencyKey = String(body.idempotencyKey || "").slice(0, 160);
      if (!idempotencyKey) throw Object.assign(new Error("Missing idempotency key"), { status: 400 });
      const razorpayKeyId = env("RAZORPAY_KEY_ID");
      if (!razorpayKeyId) throw Object.assign(new Error("Razorpay key is not configured"), { status: 500 });
      const incomingCart = compactCart(body.cart);
      const draft = await secureDeliveryDraft(compactOrderDraft(body.orderDraft || {}, incomingCart), incomingCart);
      const userRef = db.collection("users").doc(user.uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) throw Object.assign(new Error("Pizza Points wallet not found"), { status: 404 });
      const rewardConfig = await growth.settings(db);
      const requestedPoints = Math.max(0, Math.floor(Number(draft.walletPointsRequested || 0)));
      const pointsReserved = growth.calculateWalletRedemption({
        orderValue: Number(draft.grandTotal || 0),
        deliveryFee: Number(draft.deliveryCharge || 0),
        requestedPoints,
        availablePoints: Number(userSnap.data()?.walletPoints || 0),
        config: rewardConfig
      });
      if (requestedPoints && !pointsReserved) throw Object.assign(new Error("Selected Pizza Points are no longer available"), { status: 409 });
      const amount = normalizeAmount(Number(draft.grandTotal || 0) - pointsReserved);
      draft.walletPointsRequested = requestedPoints;
      draft.walletPointsUsed = pointsReserved;
      draft.walletDiscount = pointsReserved;
      draft.totalAmount = amount;
      draft.grandTotal = amount;
      draft.finalAmount = amount;
      if (amount < 10) throw Object.assign(new Error("Online payment is available for orders of ₹10 or more."), { status: 400 });
      if (Math.abs(Number(body.amount || 0) - amount) > 0.01) {
        throw Object.assign(new Error("Delivery pricing changed. Please review the updated total and try again."), { status: 409 });
      }
      const amountPaise = Math.round(amount * 100);
      const customerName = String(draft.customerName || body.customerName || "Magneetoz Customer").slice(0, 120);
      const customerPhone = await resolveVerifiedCustomerPhone(user, userSnap.data() || {});
      if (!customerPhone) throw Object.assign(new Error("Mobile number could not be verified. Please sign in again once."), { status: 400 });
      const customerEmail = String(draft.email || body.email || "").trim();
      if (draft.restaurantLocation && draft.location) {
        const route = await calculateGoogleRouteDistance({
          origin: draft.restaurantLocation,
          destination: draft.location
        });
        const clientDistance = Number(draft.actualRoadDistance || draft.deliveryDistance || 0);
        if (Math.abs(clientDistance - route.distanceKm) > 0.25) {
          throw Object.assign(new Error("Delivery route distance changed. Please refresh location and try again."), { status: 409 });
        }
        const maxDistance = Number(draft.maxDeliveryDistance || 0);
        if (maxDistance > 0 && route.distanceKm > maxDistance) {
          throw Object.assign(new Error("Delivery is not available for this road route distance."), { status: 409 });
        }
      }
      const sessionId = crypto.createHash("sha256").update(`${user.uid}:${idempotencyKey}:${amountPaise}:payment-link-v1`).digest("hex");
      const sessionRef = db.collection("paymentSessions").doc(sessionId);
      const existing = await sessionRef.get();
      if (existing.exists && existing.data().razorpayOrderId) {
        const data = existing.data();
        if (data.status === "order_created" || data.createdOrderId) {
          throw Object.assign(new Error("This payment session is already completed. Please reopen checkout and try again."), { status: 409 });
        }
        const existingAmountPaise = Number(data.amountPaise || Math.round(Number(data.amount || 0) * 100));
        if (existingAmountPaise !== amountPaise) {
          throw Object.assign(new Error("Payment amount changed. Please reopen checkout and try again."), { status: 409 });
        }
        logger.info("ORDER_RESPONSE", {
          paymentSessionId: sessionId,
          razorpayOrderId: data.razorpayOrderId,
          amount: existingAmountPaise,
          currency: data.currency || "INR",
          status: data.status || "created",
          reused: true,
          keyId: razorpayKeyId
        });
        return sendJson(res, 200, {
          ok: true,
          paymentSessionId: sessionId,
          razorpayOrderId: data.razorpayOrderId,
          amount: data.amount,
          amountPaise: existingAmountPaise,
          currency: data.currency || "INR",
          paymentLinkId: "",
          paymentLinkUrl: "",
          keyId: razorpayKeyId
        });
      }

      const orderId = db.collection("orders").doc().id;
      const razorpayOrder = await getRazorpay().orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt: sessionId.slice(0, 40),
        notes: {
          paymentSessionId: sessionId,
          orderId,
          userId: user.uid,
          source: "customer_checkout"
        }
      });
      logger.info("ORDER_RESPONSE", {
        paymentSessionId: sessionId,
        razorpayOrderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        status: razorpayOrder.status,
        receipt: razorpayOrder.receipt,
        keyId: razorpayKeyId
      });

      if (pointsReserved) {
        await db.runTransaction(async transaction => {
          const reserveRef = db.collection("walletTransactions").doc(`online_reserve_${sessionId}`);
          const [lockedUserSnap, reserveSnap] = await Promise.all([
            transaction.get(userRef),
            transaction.get(reserveRef)
          ]);
          if (reserveSnap.exists) return;
          const lockedUser = lockedUserSnap.data() || {};
          if (Number(lockedUser.walletPoints || 0) < pointsReserved) {
            throw Object.assign(new Error("Pizza Points balance changed. Please review checkout again."), { status: 409 });
          }
          const allocations = await consumePizzaPointBatches(transaction, user.uid, pointsReserved, `online_reserve_${sessionId}`);
          transaction.set(userRef, {
            walletPoints: Number(lockedUser.walletPoints || 0) - pointsReserved,
            pendingPoints: Number(lockedUser.pendingPoints || 0) + pointsReserved,
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          transaction.set(reserveRef, {
            userId: user.uid,
            type: "online_order_reserve",
            points: -pointsReserved,
            amountEquivalent: pointsReserved,
            source: "online_checkout",
            paymentSessionId: sessionId,
            orderId,
            allocations,
            status: "reserved",
            description: "Pizza Points reserved for online payment",
            createdAt: FieldValue.serverTimestamp()
          });
        });
      }

      await sessionRef.set({
        id: sessionId,
        idempotencyKey,
        userId: user.uid,
        orderId,
        amount,
        amountPaise,
        currency: "INR",
        cart: incomingCart,
        orderDraft: draft,
        razorpayOrderId: razorpayOrder.id,
        razorpayPaymentLinkId: "",
        razorpayPaymentLinkUrl: "",
        status: "created",
        walletPointsReserved: pointsReserved,
        walletReservationStatus: pointsReserved ? "reserved" : "none",
        lockState: "open",
        attempts: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: false });

      await db.collection("orders").doc(orderId).set({
        orderId,
        userId: user.uid,
        cartSnapshot: incomingCart,
        addressSnapshot: {
          customerName,
          phone: customerPhone,
          address: draft.address || "",
          landmark: draft.landmark || "",
          location: draft.location || null
        },
        amount,
        amountPaise,
        currency: "INR",
        status: "payment_pending",
        orderStatus: "payment_pending",
        lifecycleStatus: "payment_pending",
        paymentStatus: "pending",
        paymentMethod: "online",
        paymentRequired: true,
        paymentCompleted: false,
        amountDue: amount,
        amountPaid: 0,
        amountToCollect: amount,
        walletPointsRequested: requestedPoints,
        walletPointsUsed: pointsReserved,
        walletDiscount: pointsReserved,
        paymentCaptured: false,
        orderSource: "online",
        checkoutSource: "razorpay_payment_pending",
        paymentSessionId: sessionId,
        razorpayOrderId: razorpayOrder.id,
        razorpayPaymentLinkId: "",
        cart: incomingCart,
        orderDraft: draft,
        timeline: [
          { status: "payment_pending", source: "backend", at: Date.now() }
        ],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: false });

      await db.collection("paymentTransactionLogs").add({
        paymentSessionId: sessionId,
        userId: user.uid,
        event: "payment_session_created",
        amount,
        razorpayOrderId: razorpayOrder.id,
        createdAt: FieldValue.serverTimestamp()
      });

      return sendJson(res, 200, {
        ok: true,
        paymentSessionId: sessionId,
        razorpayOrderId: razorpayOrder.id,
        amount,
        amountPaise,
        currency: "INR",
        orderStatus: razorpayOrder.status || "created",
        paymentLinkId: "",
        paymentLinkUrl: "",
        keyId: razorpayKeyId
      });
    } catch (error) {
      logger.error("createPaymentSession failed", { error: error.message });
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Payment session failed" });
    }
  }
);

exports.verifyPaymentAndCreateOrder = onRequest(
  {
  region: "asia-south1",
  cors: allowedWebOrigins()
},
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    let sessionRef;
    try {
      const user = await requireAuth(req);
      const {
        paymentSessionId,
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      } = req.body || {};
      if (!paymentSessionId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        throw Object.assign(new Error("Missing payment verification details"), { status: 400 });
      }
      if (!verifyCheckoutSignature({
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature
      })) {
        throw Object.assign(new Error("Invalid Razorpay signature"), { status: 401 });
      }

      sessionRef = db.collection("paymentSessions").doc(String(paymentSessionId));
      const sessionSnap = await sessionRef.get();
      if (!sessionSnap.exists) throw Object.assign(new Error("Payment session not found"), { status: 404 });
      const session = { id: sessionSnap.id, ...sessionSnap.data() };
      if (session.userId !== user.uid) throw Object.assign(new Error("Payment session belongs to another user"), { status: 403 });
      if (session.razorpayOrderId !== razorpay_order_id) throw Object.assign(new Error("Razorpay order mismatch"), { status: 400 });

      await sessionRef.set({
        status: "verifying",
        lockState: "locked",
        attempts: FieldValue.increment(1),
        razorpayPaymentId: razorpay_payment_id,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
      const expectedPaise = Number(session.amountPaise);
      if (payment.order_id !== razorpay_order_id) throw Object.assign(new Error("Payment order mismatch"), { status: 400 });
      if (Number(payment.amount) !== expectedPaise) throw Object.assign(new Error("Payment amount mismatch"), { status: 400 });
      if (!["captured", "authorized"].includes(payment.status)) throw Object.assign(new Error(`Payment not captured: ${payment.status}`), { status: 402 });
      if (payment.status === "authorized") {
        await getRazorpay().payments.capture(razorpay_payment_id, expectedPaise, "INR");
      }

      await db.collection("paidOrderRecovery").doc(session.id).set({
        status: "payment_verified_order_pending",
        paymentSessionId: session.id,
        userId: user.uid,
        orderId: session.orderId,
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        amount: session.amount,
        orderDraft: session.orderDraft || {},
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      const result = await createOrderFromPaidSession({
        sessionRef,
        session,
        payment: { ...payment, id: razorpay_payment_id },
        source: "razorpay_verified_backend"
      });

      await db.collection("paymentTransactionLogs").add({
        paymentSessionId: session.id,
        userId: user.uid,
        orderId: result.orderId,
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        event: result.duplicate ? "duplicate_verify_returned_existing_order" : "payment_verified_order_created",
        createdAt: FieldValue.serverTimestamp()
      });

      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      logger.error("verifyPaymentAndCreateOrder failed", { error: error.message });
      if (sessionRef) {
        await sessionRef.set({
          status: "verification_failed",
          lastError: error.message || String(error),
          lockState: "open",
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => {});
      }
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Payment verification failed" });
    }
  }
);

exports.resumeOrderPayment = onRequest(
  {
    region: "asia-south1",
    cors: allowedWebOrigins()
  },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    try {
      const user = await requireAuth(req);
      const orderId = compactText(req.body?.orderId, 160);
      if (!orderId) throw Object.assign(new Error("Order id is required"), { status: 400 });
      const razorpayKeyId = env("RAZORPAY_KEY_ID");
      if (!razorpayKeyId) throw Object.assign(new Error("Razorpay key is not configured"), { status: 500 });

      const orderRef = db.collection("orders").doc(orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
      const order = { orderId, ...orderSnap.data() };
      if (order.userId !== user.uid) throw Object.assign(new Error("This order belongs to another user"), { status: 403 });
      if (String(order.paymentStatus || "").toLowerCase() === "paid" || order.paymentCaptured === true) {
        return sendJson(res, 200, {
          ok: true,
          alreadyPaid: true,
          orderId,
          orderNumber: order.orderNumber || "",
          paymentStatus: "paid"
        });
      }
      if (["Delivered", "Cancelled", "Rejected"].includes(order.status)) {
        throw Object.assign(new Error("Payment cannot be changed for this order."), { status: 409 });
      }

      const amount = normalizeAmount(order.totalAmount || order.amount || order.amountToCollect || order.grandTotal || order.finalAmount);
      if (amount < 10) throw Object.assign(new Error("Online payment is available for orders of ₹10 or more."), { status: 400 });
      const amountPaise = Math.round(amount * 100);
      const existingSessionId = compactText(order.paymentSessionId, 160);
      if (existingSessionId) {
        const sessionSnap = await db.collection("paymentSessions").doc(existingSessionId).get();
        const session = sessionSnap.exists ? sessionSnap.data() || {} : {};
        if (
          sessionSnap.exists &&
          session.userId === user.uid &&
          session.orderId === orderId &&
          session.razorpayOrderId &&
          Number(session.amountPaise) === amountPaise &&
          session.status !== "order_created"
        ) {
          return sendJson(res, 200, {
            ok: true,
            paymentSessionId: existingSessionId,
            razorpayOrderId: session.razorpayOrderId,
            amount: session.amount || amount,
            amountPaise,
            currency: session.currency || "INR",
            keyId: razorpayKeyId,
            orderId
          });
        }
      }

      const paymentSessionId = crypto.createHash("sha256").update(`${user.uid}:${orderId}:${amountPaise}:resume-order-payment-v1`).digest("hex");
      const sessionRef = db.collection("paymentSessions").doc(paymentSessionId);
      const existingSession = await sessionRef.get();
      if (existingSession.exists && existingSession.data().razorpayOrderId) {
        const session = existingSession.data();
        return sendJson(res, 200, {
          ok: true,
          paymentSessionId,
          razorpayOrderId: session.razorpayOrderId,
          amount: session.amount || amount,
          amountPaise,
          currency: session.currency || "INR",
          keyId: razorpayKeyId,
          orderId
        });
      }

      const cartSnapshot = compactCart(order.items || order.cart || order.cartSnapshot || []);
      const draft = compactOrderDraft(order.orderDraft || order, cartSnapshot);
      const razorpayOrder = await getRazorpay().orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt: paymentSessionId.slice(0, 40),
        notes: {
          paymentSessionId,
          orderId,
          userId: user.uid,
          source: "customer_pay_now"
        }
      });

      await sessionRef.set({
        id: paymentSessionId,
        idempotencyKey: `pay-now:${orderId}`,
        userId: user.uid,
        orderId,
        amount,
        amountPaise,
        currency: "INR",
        cart: cartSnapshot,
        orderDraft: draft,
        razorpayOrderId: razorpayOrder.id,
        paymentPurpose: "existing_order_payment_update",
        status: "created",
        lockState: "open",
        attempts: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: false });

      await orderRef.set({
        paymentSessionId,
        razorpayOrderId: razorpayOrder.id,
        paymentStatus: "pending",
        paymentRequired: true,
        paymentCompleted: false,
        amountDue: amount,
        amountPaid: Number(order.amountPaid || 0),
        onlinePaymentAvailable: true,
        updatedAt: FieldValue.serverTimestamp(),
        timeline: FieldValue.arrayUnion({ status: "payment_retry_created", source: "customer_pay_now", at: Date.now() })
      }, { merge: true });

      return sendJson(res, 200, {
        ok: true,
        paymentSessionId,
        razorpayOrderId: razorpayOrder.id,
        amount,
        amountPaise,
        currency: "INR",
        keyId: razorpayKeyId,
        orderId
      });
    } catch (error) {
      logger.error("resumeOrderPayment failed", { error: error.message });
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Payment resume failed" });
    }
  }
);

exports.cancelUnpaidPaymentOrder = onRequest(
  {
    region: "asia-south1",
    cors: allowedWebOrigins()
  },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    try {
      const user = await requireAuth(req);
      const orderId = compactText(req.body?.orderId, 160);
      if (!orderId) throw Object.assign(new Error("Order id is required"), { status: 400 });
      const orderRef = db.collection("orders").doc(orderId);
      const result = await db.runTransaction(async transaction => {
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const order = orderSnap.data() || {};
        if (order.userId !== user.uid) throw Object.assign(new Error("This order belongs to another user"), { status: 403 });
        const paymentMethod = String(order.paymentMethod || order.paymentMode || "").toLowerCase();
        const paymentStatus = String(order.paymentStatus || "").toLowerCase();
        const paid = paymentStatus === "paid" || order.paymentCaptured === true || !!order.razorpayPaymentId || !!order.transactionId;
        if (paid) throw Object.assign(new Error("Payment is already received. This order cannot be removed."), { status: 409 });
        if (!["online", "upi"].includes(paymentMethod) && order.paymentRequired !== true) {
          throw Object.assign(new Error("Only unpaid online payment orders can be removed here."), { status: 409 });
        }
        const statusText = String(order.status || order.orderStatus || "").toLowerCase();
        if (["delivered", "cancelled", "rejected", "failed"].includes(statusText)) {
          return { alreadyClosed: true };
        }
        const sessionId = compactText(order.paymentSessionId, 160);
        const reservedPoints = Math.max(0, Number(order.walletPointsUsed || order.walletDiscount || 0));
        const userRef = reservedPoints > 0 && sessionId ? db.collection("users").doc(user.uid) : null;
        const reserveRef = reservedPoints > 0 && sessionId ? db.collection("walletTransactions").doc(`online_reserve_${sessionId}`) : null;
        const [userSnap, reserveSnap] = userRef && reserveRef
          ? await Promise.all([transaction.get(userRef), transaction.get(reserveRef)])
          : [null, null];
        const updates = {
          status: "Cancelled",
          orderStatus: "Cancelled",
          lifecycleStatus: "cancelled",
          paymentStatus: "cancelled",
          paymentRequired: false,
          paymentCompleted: false,
          paymentCaptured: false,
          amountDue: 0,
          amountToCollect: 0,
          cancelledBy: "customer",
          cancelledAt: FieldValue.serverTimestamp(),
          cancellationReason: "Customer cancelled unpaid online payment",
          updatedAt: FieldValue.serverTimestamp(),
          lastStatusUpdatedAt: FieldValue.serverTimestamp(),
          timeline: FieldValue.arrayUnion({ status: "payment_cancelled_by_customer", source: "customer", at: Date.now() })
        };
        transaction.set(orderRef, updates, { merge: true });
        if (sessionId) {
          transaction.set(db.collection("paymentSessions").doc(sessionId), {
            status: "cancelled",
            cancellationReason: "Customer cancelled unpaid online payment",
            walletReservationStatus: reservedPoints ? "released" : FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          if (reservedPoints > 0) {
            if (reserveSnap.exists && String(reserveSnap.data()?.status || "") === "reserved") {
              const wallet = userSnap.data() || {};
              transaction.set(userRef, {
                walletPoints: Number(wallet.walletPoints || 0) + reservedPoints,
                pendingPoints: Math.max(0, Number(wallet.pendingPoints || 0) - reservedPoints),
                updatedAt: FieldValue.serverTimestamp()
              }, { merge: true });
              transaction.set(reserveRef, {
                status: "released",
                releasedPoints: reservedPoints,
                releasedAt: FieldValue.serverTimestamp(),
                releaseReason: "customer_cancelled_unpaid_payment"
              }, { merge: true });
            }
          }
        }
        return { alreadyClosed: false };
      });
      return sendJson(res, 200, { ok: true, orderId, ...result });
    } catch (error) {
      logger.error("cancelUnpaidPaymentOrder failed", { error: error.message });
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Unable to remove pending payment order" });
    }
  }
);

exports.verifyPaymentLinkAndCreateOrder = onRequest(
  {
    region: "asia-south1",
    cors: allowedWebOrigins()
  },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    let sessionRef;
    try {
      const user = await requireAuth(req);
      const {
        paymentSessionId,
        razorpay_payment_id,
        razorpay_payment_link_id,
        razorpay_payment_link_reference_id,
        razorpay_payment_link_status,
        razorpay_signature
      } = req.body || {};
      if (!paymentSessionId || !razorpay_payment_id || !razorpay_payment_link_id || !razorpay_payment_link_reference_id || !razorpay_payment_link_status || !razorpay_signature) {
        throw Object.assign(new Error("Missing payment link verification details"), { status: 400 });
      }
      if (!verifyPaymentLinkSignature({
        paymentLinkId: razorpay_payment_link_id,
        paymentLinkReferenceId: razorpay_payment_link_reference_id,
        paymentLinkStatus: razorpay_payment_link_status,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature
      })) {
        throw Object.assign(new Error("Invalid Razorpay payment link signature"), { status: 401 });
      }

      sessionRef = db.collection("paymentSessions").doc(String(paymentSessionId));
      const sessionSnap = await sessionRef.get();
      if (!sessionSnap.exists) throw Object.assign(new Error("Payment session not found"), { status: 404 });
      const session = { id: sessionSnap.id, ...sessionSnap.data() };
      if (session.userId !== user.uid) throw Object.assign(new Error("Payment session belongs to another user"), { status: 403 });
      if (session.razorpayPaymentLinkId !== razorpay_payment_link_id) throw Object.assign(new Error("Payment link mismatch"), { status: 400 });
      if (String(razorpay_payment_link_status).toLowerCase() !== "paid") throw Object.assign(new Error("Payment link is not paid"), { status: 402 });

      const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
      const expectedPaise = Number(session.amountPaise);
      if (Number(payment.amount) !== expectedPaise) throw Object.assign(new Error("Payment amount mismatch"), { status: 400 });
      if (!["captured", "authorized"].includes(payment.status)) throw Object.assign(new Error(`Payment not captured: ${payment.status}`), { status: 402 });
      if (payment.status === "authorized") {
        await getRazorpay().payments.capture(razorpay_payment_id, expectedPaise, "INR");
      }

      await sessionRef.set({
        status: "verifying",
        lockState: "locked",
        attempts: FieldValue.increment(1),
        razorpayPaymentId: razorpay_payment_id,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      await db.collection("paidOrderRecovery").doc(session.id).set({
        status: "payment_link_verified_order_pending",
        paymentSessionId: session.id,
        userId: session.userId,
        orderId: session.orderId,
        razorpayOrderId: session.razorpayOrderId,
        razorpayPaymentId: razorpay_payment_id,
        amount: session.amount,
        orderDraft: session.orderDraft || {},
        source: "razorpay_payment_link_return",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      const result = await createOrderFromPaidSession({
        sessionRef,
        session,
        payment: { ...payment, id: razorpay_payment_id },
        source: "razorpay_payment_link_return"
      });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      logger.error("verifyPaymentLinkAndCreateOrder failed", { error: error.message });
      if (sessionRef) {
        await sessionRef.set({
          status: "payment_link_verify_failed",
          lastError: error.message,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => {});
      }
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Payment link verification failed" });
    }
  }
);

exports.checkPaymentSessionStatus = onRequest(
  {
    region: "asia-south1",
    cors: allowedWebOrigins()
  },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    try {
      const user = await requireAuth(req);
      const paymentSessionId = String(req.body?.paymentSessionId || "");
      if (!paymentSessionId) throw Object.assign(new Error("Payment session id is required"), { status: 400 });
      const sessionSnap = await db.collection("paymentSessions").doc(paymentSessionId).get();
      if (!sessionSnap.exists) throw Object.assign(new Error("Payment session not found"), { status: 404 });
      const session = { id: sessionSnap.id, ...sessionSnap.data() };
      if (session.userId !== user.uid) throw Object.assign(new Error("Payment session belongs to another user"), { status: 403 });
      const orderSnap = session.orderId ? await db.collection("orders").doc(session.orderId).get() : null;
      let order = orderSnap?.exists ? orderSnap.data() || {} : {};
      const alreadyPaid = String(order.paymentStatus || "").toLowerCase() === "paid" || order.paymentCaptured === true || session.status === "order_created";
      if (!alreadyPaid && session.razorpayOrderId) {
        const paymentsResponse = await getRazorpay().orders.fetchPayments(session.razorpayOrderId).catch(error => {
          logger.warn("Razorpay order payment status fetch failed", { paymentSessionId, error: error.message });
          return null;
        });
        const payments = Array.isArray(paymentsResponse?.items) ? paymentsResponse.items : [];
        const capturedPayment = payments.find(payment =>
          ["captured", "authorized"].includes(payment.status) &&
          Number(payment.amount) === Number(session.amountPaise)
        );
        if (capturedPayment) {
          if (capturedPayment.status === "authorized") {
            await getRazorpay().payments.capture(capturedPayment.id, Number(session.amountPaise), session.currency || "INR");
          }
          await createOrderFromPaidSession({
            sessionRef: db.collection("paymentSessions").doc(paymentSessionId),
            session,
            payment: { ...capturedPayment, id: capturedPayment.id },
            source: "manual_payment_status_recovery"
          });
          const freshOrderSnap = session.orderId ? await db.collection("orders").doc(session.orderId).get() : null;
          order = freshOrderSnap?.exists ? freshOrderSnap.data() || order : order;
        }
      }
      return sendJson(res, 200, {
        ok: true,
        paymentSessionId,
        sessionStatus: session.status || "created",
        orderId: session.createdOrderId || session.orderId || "",
        orderNumber: session.orderNumber || order.orderNumber || "",
        orderStatus: order.status || "",
        paymentStatus: order.paymentStatus || session.paymentStatus || "pending",
        paid: String(order.paymentStatus || "").toLowerCase() === "paid" || order.paymentCaptured === true || session.status === "order_created",
        recoverable: ["created", "verifying", "verification_failed", "payment_link_verify_failed"].includes(session.status || "created"),
        lastError: session.lastError || ""
      });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Payment status check failed" });
    }
  }
);

function verifyRazorpayWebhook(req) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || secret === "your_webhook_secret") {
    logger.error("RAZORPAY_WEBHOOK_SECRET is not configured; rejecting webhook.");
    return false;
  }
  const signature = req.get("x-razorpay-signature") || "";
  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (error) {
    return false;
  }
}

async function markOrderPaidFromPayment({ orderId, paymentId, amount, source }) {
  if (!orderId || !paymentId) {
    logger.warn("Razorpay webhook missing orderId/paymentId", { orderId, paymentId, source });
    return false;
  }
  const orderRef = db.collection("orders").doc(String(orderId));
  await db.runTransaction(async transaction => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) throw new Error(`Order ${orderId} not found`);
    const order = snap.data() || {};
    if (
      order.paymentStatus === "paid" &&
      order.paymentCaptured === true &&
      order.razorpayPaymentId
    ) {
      return;
    }
    updatePaymentStatus(transaction, orderRef, {
      paymentSessionId: order.paymentSessionId || "",
      razorpayOrderId: order.razorpayOrderId || "",
      paymentId,
      amount: Number(amount || order.totalAmount || order.finalAmount || 0),
      source: source || order.checkoutSource || "razorpay_webhook",
      actor: "razorpay_webhook",
      statusBefore: {
        status: order.status || "",
        orderStatus: order.orderStatus || "",
        lifecycleStatus: order.lifecycleStatus || "",
        deliveryStatus: order.deliveryStatus || "",
        riderStatus: order.riderStatus || ""
      },
      paymentStatusBefore: order.paymentStatus || "pending"
    });
  });
  logger.info("Order marked paid from Razorpay", { orderId, paymentId, source });
  return true;
}

exports.razorpayWebhook = onRequest(
  {
    region: "asia-south1",
    cors: false
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }
    if (!verifyRazorpayWebhook(req)) {
      logger.warn("Invalid Razorpay webhook signature");
      res.status(401).send("Invalid signature");
      return;
    }

    const event = req.body || {};
    const payment = event.payload?.payment?.entity || {};
    const notes = payment.notes || {};
    const orderId = notes.orderId || notes.order_id || "";
    const paymentSessionId = notes.paymentSessionId || "";
    const paymentId = payment.id || "";

    try {
      if (event.event === "payment.captured" || payment.status === "captured") {
        if (paymentSessionId) {
          const sessionRef = db.collection("paymentSessions").doc(String(paymentSessionId));
          const sessionSnap = await sessionRef.get();
          if (sessionSnap.exists) {
            const session = { id: sessionSnap.id, ...sessionSnap.data() };
            const paymentMatchesSession = Number(session.amountPaise) === Number(payment.amount)
              && (
                session.razorpayOrderId === payment.order_id
                || session.razorpayPaymentLinkId === payment.invoice_id
                || notes.source === "customer_payment_link"
              );
            if (paymentMatchesSession) {
              await db.collection("paidOrderRecovery").doc(session.id).set({
                status: "payment_verified_order_pending",
                paymentSessionId: session.id,
                userId: session.userId,
                orderId: session.orderId,
                razorpayOrderId: payment.order_id || session.razorpayOrderId,
                razorpayPaymentId: paymentId,
                amount: session.amount,
                orderDraft: session.orderDraft || {},
                source: "razorpay_webhook",
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp()
              }, { merge: true });
              await createOrderFromPaidSession({
                sessionRef,
                session,
                payment: { ...payment, id: paymentId },
                source: "razorpay_webhook"
              });
            }
          }
        } else {
          await markOrderPaidFromPayment({
            orderId,
            paymentId,
            amount: Number(payment.amount || 0) / 100,
            source: notes.source || "razorpay_webhook"
          });
        }
      } else if (event.event === "payment.failed") {
        logger.warn("Razorpay payment failed", {
          orderId,
          paymentId,
          reason: payment.error_reason,
          description: payment.error_description
        });
      }
      res.status(200).send("ok");
    } catch (error) {
      logger.error("Razorpay webhook processing failed", { error: error.message, orderId, paymentId });
      res.status(500).send("webhook processing failed");
    }
  }
);

exports.recoverPaidOrder = onDocumentCreated(
  {
    document: "paidOrderRecovery/{recoveryId}",
    region: "asia-south1"
  },
  async event => {
    const recovery = event.data?.data() || {};
    if (recovery.status !== "payment_verified_order_pending" || !recovery.paymentSessionId) return;
    const sessionRef = db.collection("paymentSessions").doc(String(recovery.paymentSessionId));
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) return;
    const session = { id: sessionSnap.id, ...sessionSnap.data() };
    try {
      await createOrderFromPaidSession({
        sessionRef,
        session,
        payment: { id: recovery.razorpayPaymentId },
        source: recovery.source || "paid_order_recovery"
      });
    } catch (error) {
      logger.error("Paid order recovery failed", { recoveryId: event.params.recoveryId, error: error.message });
      await event.data.ref.set({
        status: "retry_required",
        lastError: error.message || String(error),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  }
);

exports.expirePendingPaymentOrders = onSchedule(
  {
    region: "asia-south1",
    schedule: "every 15 minutes"
  },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);
    const pendingSnap = await db.collection("orders")
      .where("status", "==", "payment_pending")
      .where("createdAt", "<", cutoff)
      .limit(100)
      .get();
    const batch = db.batch();
    pendingSnap.docs.forEach(item => {
      const order = item.data() || {};
      if (String(order.paymentStatus || "").toLowerCase() === "paid" || order.paymentCaptured === true) return;
      batch.set(item.ref, {
        status: "failed",
        orderStatus: "failed",
        lifecycleStatus: "failed",
        paymentStatus: "failed",
        failureReason: "Payment not completed within 15 minutes",
        updatedAt: FieldValue.serverTimestamp(),
        lastStatusUpdatedAt: FieldValue.serverTimestamp(),
        timeline: FieldValue.arrayUnion({ status: "payment_expired", source: "scheduler", at: Date.now() })
      }, { merge: true });
      if (order.paymentSessionId) {
        batch.set(db.collection("paymentSessions").doc(String(order.paymentSessionId)), {
          status: "expired",
          failureReason: "Payment not completed within 15 minutes",
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
    });
    if (!pendingSnap.empty) await batch.commit();
  }
);

exports.releaseExpiredOnlinePointReservations = onSchedule(
  { region: "asia-south1", schedule: "every 15 minutes" },
  async () => {
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 20 * 60 * 1000);
    const reservations = await db.collection("walletTransactions")
      .where("type", "==", "online_order_reserve")
      .where("status", "==", "reserved")
      .where("createdAt", "<", cutoff)
      .limit(100)
      .get();
    for (const reservationSnap of reservations.docs) {
      await db.runTransaction(async transaction => {
        const lockedReservation = await transaction.get(reservationSnap.ref);
        if (!lockedReservation.exists || lockedReservation.data()?.status !== "reserved") return;
        const reservation = lockedReservation.data() || {};
        const sessionRef = db.collection("paymentSessions").doc(String(reservation.paymentSessionId || ""));
        const userRef = db.collection("users").doc(String(reservation.userId || ""));
        const [sessionSnap, userSnap] = await Promise.all([
          transaction.get(sessionRef),
          transaction.get(userRef)
        ]);
        const session = sessionSnap.data() || {};
        if (session.status === "order_created" || session.walletReservationStatus === "consumed") return;
        if (sessionSnap.exists && !["expired", "verification_failed", "failed"].includes(String(session.status || "").toLowerCase())) return;
        const points = Math.abs(Number(reservation.points || 0));
        const allocations = Array.isArray(reservation.allocations) ? reservation.allocations : [];
        const creditRefs = allocations.map(allocation =>
          db.collection("walletTransactions").doc(String(allocation.transactionId || ""))
        );
        const creditSnaps = await Promise.all(creditRefs.map(ref => transaction.get(ref)));
        let releasablePoints = 0;
        let expiredWhileReserved = 0;
        allocations.forEach((allocation, index) => {
          const creditRef = creditRefs[index];
          const creditSnap = creditSnaps[index];
          const allocated = Number(allocation.points || 0);
          if (!creditSnap.exists) {
            expiredWhileReserved += allocated;
            return;
          }
          const credit = creditSnap.data() || {};
          const expiryMs = credit.expiresAt?.toMillis?.() || 0;
          if (credit.status === "expired" || (expiryMs && expiryMs <= Date.now())) {
            expiredWhileReserved += allocated;
            return;
          }
          releasablePoints += allocated;
          transaction.set(creditRef, {
            remainingPoints: Math.max(0, Number(credit.remainingPoints || 0)) + allocated
          }, { merge: true });
        });
        const wallet = userSnap.data() || {};
        transaction.set(userRef, {
          walletPoints: Number(wallet.walletPoints || 0) + releasablePoints,
          pendingPoints: Math.max(0, Number(wallet.pendingPoints || 0) - points),
          lifetimePointsExpired: Number(wallet.lifetimePointsExpired || 0) + expiredWhileReserved,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(reservationSnap.ref, {
          status: expiredWhileReserved ? "released_with_expiry" : "released",
          releasedPoints: releasablePoints,
          expiredPoints: expiredWhileReserved,
          releasedAt: FieldValue.serverTimestamp(),
          releaseReason: "online_payment_session_expired"
        }, { merge: true });
        transaction.set(sessionRef, {
          walletReservationStatus: "released",
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      });
    }
  }
);

exports.expirePizzaPoints = onSchedule(
  { region: "asia-south1", schedule: "every day 02:15" },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const legacyCredits = await db.collection("walletTransactions")
      .where("status", "==", "credited")
      .limit(500)
      .get();
    const legacyBatch = db.batch();
    let legacyUpdates = 0;
    legacyCredits.docs.forEach(item => {
      const credit = item.data() || {};
      if (Number(credit.points || 0) <= 0 || credit.expiresAt) return;
      const createdMs = credit.createdAt?.toMillis?.() || Date.now();
      legacyBatch.set(item.ref, {
        remainingPoints: Math.max(0, Number(
          credit.remainingPoints === undefined ? credit.points : credit.remainingPoints
        )),
        expiresAt: admin.firestore.Timestamp.fromMillis(createdMs + PIZZA_POINT_EXPIRY_MS)
      }, { merge: true });
      legacyUpdates += 1;
    });
    if (legacyUpdates) await legacyBatch.commit();
    const credits = await db.collection("walletTransactions")
      .where("status", "==", "credited")
      .where("expiresAt", "<=", now)
      .limit(200)
      .get();
    for (const creditSnap of credits.docs) {
      await db.runTransaction(async transaction => {
        const lockedCredit = await transaction.get(creditSnap.ref);
        if (!lockedCredit.exists || lockedCredit.data()?.status !== "credited") return;
        const credit = lockedCredit.data() || {};
        const expiring = Math.max(0, Math.floor(Number(
          credit.remainingPoints === undefined ? credit.points : credit.remainingPoints
        )));
        if (!expiring) {
          transaction.set(creditSnap.ref, { status: "consumed" }, { merge: true });
          return;
        }
        const userRef = db.collection("users").doc(String(credit.userId || ""));
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists) return;
        const user = userSnap.data() || {};
        transaction.set(userRef, {
          walletPoints: Math.max(0, Number(user.walletPoints || 0) - expiring),
          lifetimePointsExpired: Number(user.lifetimePointsExpired || 0) + expiring,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(creditSnap.ref, {
          remainingPoints: 0,
          status: "expired",
          expiredPoints: expiring,
          expiredAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(db.collection("walletTransactions").doc(`expiry_${creditSnap.id}`), {
          userId: credit.userId,
          type: "points_expiry",
          points: -expiring,
          amountEquivalent: expiring,
          source: "60_day_expiry",
          sourceTransactionId: creditSnap.id,
          status: "expired",
          description: `${expiring} Pizza Points expired after 60 days`,
          createdAt: FieldValue.serverTimestamp()
        });
      });
    }
  }
);

exports.nightlyRiderNetSettlement = onSchedule(
  {
    region: "asia-south1",
    schedule: "every day 02:30",
    timeZone: "Asia/Kolkata"
  },
  async () => {
    const ridersSnap = await db.collection("riders").get();
    let processed = 0;
    for (const riderDoc of ridersSnap.docs) {
      const riderId = riderDoc.id;
      const rider = riderDoc.data() || {};
      const walletRef = db.collection("riderWallet").doc(riderId);
      await db.runTransaction(async transaction => {
        const walletSnap = await transaction.get(walletRef);
        const before = netWalletState(walletSnap.exists ? walletSnap.data() : {
          totalEarnings: rider.totalEarnings || 0,
          companySettlementDue: rider.companyDue || rider.pendingCashSubmission || 0
        });
        const after = netWalletState(before);
        transaction.set(walletRef, {
          riderId,
          ...after,
          lastSettlementAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(db.collection("riderSettlements").doc(), {
          riderId,
          type: "nightly_net_settlement",
          status: after.netBalance === 0 ? "complete" : after.netBalance > 0 ? "rider_receivable" : "company_due",
          totalEarnings: after.totalEarnings,
          companySettlementDue: after.companySettlementDue,
          walletBalance: after.walletBalance,
          netBalance: after.netBalance,
          outstandingDue: after.outstandingDue,
          createdAt: FieldValue.serverTimestamp()
        });
        transaction.set(db.collection("riderSettlementAuditLogs").doc(), {
          riderId,
          type: "nightly_net_settlement",
          before,
          after,
          createdAt: FieldValue.serverTimestamp()
        });
      });
      processed += 1;
    }
    logger.info("Nightly rider net settlement complete", { processed });
  }
);

function cleanPhone(value = "") {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 10) return "";
  if (digits.length <= 10) return `91${digits.slice(-10)}`;
  return digits;
}

function customerIdFromPhone(value = "") {
  return cleanPhone(value) || "unknown";
}

function tagsForCustomer({ totalOrders, totalSpent, lastOrderDate, items = [] }) {
  const tags = [];
  if (totalSpent >= 3000) tags.push("VIP", "High Spender");
  if (totalOrders >= 5) tags.push("Frequent Buyer");
  if (totalOrders === 1) tags.push("First-time Customer");
  if (items.some(item => String(item.name || "").toLowerCase().includes("pizza"))) tags.push("Pizza Lover");
  const lastMillis = lastOrderDate?.toMillis ? lastOrderDate.toMillis() : Date.now();
  if (Date.now() - lastMillis > 1000 * 60 * 60 * 24 * 30) tags.push("Inactive");
  return [...new Set(tags)];
}

function formatAmount(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function isCashMethod(method = "") {
  return ["cash", "cod"].includes(String(method || "").toLowerCase());
}

function isOnlineMethod(method = "") {
  return ["online", "upi"].includes(String(method || "").toLowerCase());
}

function riderBaseEarning(order = {}) {
  const distance = Math.max(1, Math.ceil(Number(order.actualRoadDistance || order.deliveryDistance || order.distance || 1)));
  return roundMoney(20 + Math.max(0, distance - 3) * 5);
}

function canonicalRiderEarning(order = {}) {
  return Math.max(20, riderBaseEarning(order));
}

async function riderProfileForUser(uid) {
  const snap = await db.collection("riders").doc(uid).get();
  if (!snap.exists) throw Object.assign(new Error("Rider profile not found"), { status: 403 });
  const rider = { riderId: uid, id: uid, ...snap.data() };
  if (rider.active === false || rider.approved !== true) throw Object.assign(new Error("Rider is not approved"), { status: 403 });
  return rider;
}

function assertAssignedRider(order = {}, riderId) {
  if (order.assignedRiderId !== riderId && order.riderId !== riderId) {
    throw Object.assign(new Error("This order is not assigned to this rider"), { status: 403 });
  }
}

async function addOrderAudit(transaction, orderId, event, data = {}) {
  const ref = db.collection("orderAuditLogs").doc();
  transaction.set(ref, {
    orderId,
    event,
    ...data,
    createdAt: FieldValue.serverTimestamp()
  });
}

function pointFrom(value = {}) {
  if (!value || typeof value !== "object") return null;
  const lat = Number(value.lat ?? value.latitude);
  const lng = Number(value.lng ?? value.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function distanceKmBetween(a, b) {
  const p1 = pointFrom(a);
  const p2 = pointFrom(b);
  if (!p1 || !p2) return Number.MAX_SAFE_INTEGER;
  const toRad = deg => deg * Math.PI / 180;
  const earthKm = 6371;
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const lat1 = toRad(p1.lat);
  const lat2 = toRad(p2.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round((2 * earthKm * Math.asin(Math.sqrt(h))) * 100) / 100;
}

async function restaurantPointForOrder(order = {}) {
  const direct = pointFrom(order.restaurantLocation || order.pickupLocation);
  if (direct) return direct;
  const snap = await db.collection("settings").doc("restaurant").get();
  const settingPoint = pointFrom(snap.data()?.location);
  return settingPoint || { lat: 28.465283, lng: 77.502608 };
}

function customerPointForOrder(order = {}) {
  return pointFrom(order.customerLocation || order.location || order.dropLocation);
}

function tsMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value.seconds) return Number(value.seconds) * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function riderPresence(rider = {}) {
  const onlineFlag = rider.online === true
    || rider.isOnline === true
    || rider.status === "online"
    || rider.availabilityStatus === "online";
  const lastSeen = Math.max(
    tsMillis(rider.lastSeenAt),
    tsMillis(rider.lastLocationUpdateAt),
    tsMillis(rider.location?.updatedAt),
    tsMillis(rider.currentLocation?.updatedAt)
  );
  const stale = onlineFlag && lastSeen && Date.now() - lastSeen > 5 * 60 * 1000;
  const activeOrderId = rider.currentActiveOrderId || rider.activeOrderId || "";
  const busy = !!activeOrderId;
  return {
    online: onlineFlag && !stale,
    onlineFlag,
    stale,
    busy,
    available: onlineFlag && !stale && !busy
  };
}

const RIDER_ACTIVE_ORDER_STATUSES = [
  "Rider Accepted",
  "Picked Up",
  "Out For Delivery",
  "Reached Nearby",
  "Collect Payment",
  "Cash Collected",
  "Payment Settled",
  "Delivery Code Pending",
  "Payment Completed"
];

const CLOSED_ORDER_STATUSES = ["Delivered", "Cancelled", "Rejected", "Failed", "failed", "cancelled", "delivered"];

function isOpenRiderOrder(order = {}) {
  const status = String(order.status || order.orderStatus || "");
  return !CLOSED_ORDER_STATUSES.includes(status)
    && !CLOSED_ORDER_STATUSES.includes(status.toLowerCase())
    && !!(order.assignedRiderId || order.riderId);
}

async function findAuthoritativeActiveOrderForRider(riderId) {
  const [assignedSnap, legacySnap] = await Promise.all([
    db.collection("orders").where("assignedRiderId", "==", riderId).get(),
    db.collection("orders").where("riderId", "==", riderId).get()
  ]);
  const byId = new Map();
  assignedSnap.docs.forEach(docSnap => byId.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
  legacySnap.docs.forEach(docSnap => byId.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
  return Array.from(byId.values())
    .filter(isOpenRiderOrder)
    .sort((a, b) => tsMillis(b.assignedAt || b.createdAt || b.placedAt) - tsMillis(a.assignedAt || a.createdAt || a.placedAt))[0] || null;
}

async function reconcileRiderState(riderId, { desiredOnline = null, actor = "system" } = {}) {
  const riderRef = db.collection("riders").doc(riderId);
  const [riderSnap, activeOrder] = await Promise.all([
    riderRef.get(),
    findAuthoritativeActiveOrderForRider(riderId)
  ]);
  if (!riderSnap.exists) throw Object.assign(new Error("Rider not found"), { status: 404 });
  const rider = riderSnap.data() || {};
  let keepOnline = desiredOnline === null
    ? (rider.online === true || rider.isOnline === true || rider.status === "online" || rider.availabilityStatus === "online")
    : desiredOnline === true;
  if (activeOrder && desiredOnline === false) keepOnline = true;
  const update = {
    online: keepOnline,
    isOnline: keepOnline,
    status: keepOnline ? "online" : "offline",
    availabilityStatus: keepOnline ? "online" : "offline",
    isAvailable: keepOnline && !activeOrder,
    lastReconciledAt: FieldValue.serverTimestamp(),
    lastReconciledBy: actor
  };
  if (activeOrder) {
    update.currentActiveOrderId = activeOrder.id;
    update.activeOrderId = activeOrder.id;
  } else {
    update.currentActiveOrderId = FieldValue.delete();
    update.activeOrderId = FieldValue.delete();
  }
  await riderRef.set(update, { merge: true });
  return {
    riderId,
    activeOrderId: activeOrder?.id || "",
    online: keepOnline,
    available: keepOnline && !activeOrder,
    repairedStaleLock: !activeOrder && !!(rider.currentActiveOrderId || rider.activeOrderId)
  };
}

function isDeliveryPaymentEligible(order = {}) {
  const method = String(order.paymentMethod || order.paymentMode || "").toLowerCase();
  const status = String(order.paymentStatus || "").toLowerCase();
  if (method === "cod" || method === "cash") return true;
  return (method === "online" || method === "upi") && (
    status === "paid" ||
    status === "success" ||
    order.paymentCaptured === true ||
    !!order.razorpayPaymentId ||
    !!order.transactionId ||
    Number(order.amountToCollect || 0) === 0
  );
}

function deliveryStatusFor(status = "") {
  const map = {
    Pending: "placed",
    Accepted: "restaurant_accepted",
    Preparing: "preparing",
    Ready: "ready_for_pickup",
    ready_for_pickup: "ready_for_pickup",
    "Searching For Rider": "rider_searching",
    "Rider Accepted": "rider_assigned",
    "Picked Up": "picked_up",
    "Out For Delivery": "out_for_delivery",
    "Reached Nearby": "arrived_customer",
    "Cash Collected": "cash_collected",
    "Payment Settled": "payment_settled",
    Delivered: "delivered",
    Rejected: "cancelled",
    Cancelled: "cancelled"
  };
  return map[status] || String(status || "placed").toLowerCase().replace(/\s+/g, "_");
}

function addDeliveryEvent(transaction, orderId, type, data = {}) {
  transaction.set(db.collection("deliveryEvents").doc(), {
    orderId,
    type,
    ...data,
    createdAt: FieldValue.serverTimestamp()
  });
}

async function findNearestAvailableRider(order = {}, excludeIds = []) {
  const restaurantLocation = await restaurantPointForOrder(order);
  const ridersSnap = await db.collection("riders").get();
  const excluded = new Set(excludeIds.filter(Boolean));
  const candidates = ridersSnap.docs
    .map(item => ({ id: item.id, ...item.data() }))
    .filter(rider => rider.approved === true && rider.active !== false && rider.blocked !== true)
    .filter(rider => riderPresence(rider).available)
    .filter(rider => !excluded.has(rider.id))
    .map(rider => {
      const location = rider.currentLocation || rider.location;
      const distanceKm = distanceKmBetween(restaurantLocation, location);
      return {
        ...rider,
        normalizedLocation: pointFrom(location),
        distanceKm,
        distanceAvailable: Number.isFinite(distanceKm) && distanceKm < Number.MAX_SAFE_INTEGER
      };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const withDistance = candidates.filter(rider => rider.distanceAvailable);
  const radius = [2, 5, 10].find(limit => withDistance.some(rider => rider.distanceKm <= limit)) || null;
  const rider = radius
    ? withDistance.find(item => item.distanceKm <= radius)
    : (withDistance.length ? null : (candidates[0] || null));
  return { rider, radius, candidates, restaurantLocation };
}

function hashDeliveryCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function createCustomerDeliveryCode({ transaction, orderRef, order, orderId, rider, purpose }) {
  const code = String(crypto.randomInt(1000, 10000));
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000);
  const codeRef = db.collection("deliveryAuthorizationCodes").doc(`${orderId}_${purpose}_${Date.now()}`);
  const customerCodeRef = db.collection("customerDeliveryCodes").doc(orderId);
  transaction.set(codeRef, {
    orderId,
    riderId: rider.riderId,
    purpose,
    codeHash: hashDeliveryCode(code),
    expiresAt,
    used: false,
    createdAt: FieldValue.serverTimestamp()
  });
  transaction.set(customerCodeRef, {
    orderId,
    userId: order.userId || "",
    purpose,
    code,
    expiresAt,
    used: false,
    createdAt: FieldValue.serverTimestamp()
  });
  guardedOrderUpdate(transaction, orderRef, order, {
    deliveryAuthorizationCodeExpiresAt: expiresAt,
    activeDeliveryCodeId: codeRef.id,
    deliveryOtpPurpose: purpose,
    deliveryOtpStatus: "active",
    ...(purpose === "cod_exception" ? {
      status: "Delivery Code Pending",
      orderStatus: "Delivery Code Pending",
      settlementState: "DELIVERY_CODE_PENDING"
    } : {
      deliveryOtpRequestedAt: FieldValue.serverTimestamp()
    }),
    lastStatusUpdatedAt: FieldValue.serverTimestamp()
  }, { actor: rider.riderId, source: "createCustomerDeliveryCode" });
  addOrderAudit(transaction, orderId, purpose === "cod_exception" ? "DELIVERY_CODE_GENERATED" : "PREPAID_DELIVERY_OTP_GENERATED", {
    riderId: rider.riderId,
    codeId: codeRef.id
  });
  return { expiresAt };
}

exports.ensurePrepaidDeliveryOtp = onDocumentUpdated(
  {
    document: "orders/{orderId}",
    region: "asia-south1"
  },
  async event => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    const orderId = event.params.orderId;
    if (!["Out For Delivery", "Reached Nearby"].includes(after.status)) return;
    if (after.deliveryOtpStatus === "active" || after.deliveryOtpStatus === "verified" || after.activeDeliveryCodeId) return;
    const method = after.paymentMethod || after.paymentMode;
    const paidOnline = isOnlineMethod(method) &&
      (String(after.paymentStatus || "").toLowerCase() === "paid"
        || String(after.paymentStage || "").toLowerCase() === "payment completed"
        || after.paymentCaptured === true
        || after.razorpayPaymentId
        || after.transactionId);
    if (!paidOnline) return;
    const riderId = after.assignedRiderId || after.riderId || "";
    if (!riderId) return;
    const rider = {
      riderId,
      name: after.riderName || after.assignedRider?.name || "Magneetoz Rider",
      phone: after.riderPhone || after.assignedRider?.phone || ""
    };
    const orderRef = db.collection("orders").doc(orderId);
    await db.runTransaction(async transaction => {
      const snap = await transaction.get(orderRef);
      if (!snap.exists) return;
      const locked = snap.data() || {};
      if (locked.deliveryOtpStatus === "active" || locked.deliveryOtpStatus === "verified" || locked.activeDeliveryCodeId) return;
      createCustomerDeliveryCode({
        transaction,
        orderRef,
        order: locked,
        orderId,
        rider,
        purpose: "prepaid_delivery"
      });
    });
    logger.info("Auto-created prepaid delivery OTP", {
      orderId,
      riderId,
      previousStatus: before.status || "",
      status: after.status
    });
  }
);

async function completeDeliveryTransaction({ orderId, rider, mode, codeRef, codeHash }) {
  const orderRef = db.collection("orders").doc(String(orderId));
  const riderRef = db.collection("riders").doc(rider.riderId);
  const pricingSnap = await db.collection("settings").doc("pricing").get();
  const pricing = pricingSnap.exists ? pricingSnap.data() : {};

  return db.runTransaction(async transaction => {
    const reads = [transaction.get(orderRef), transaction.get(riderRef)];
    if (codeRef) reads.push(transaction.get(codeRef));
    const [orderSnap, riderSnap, codeSnap] = await Promise.all(reads);
    if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
    const order = orderSnap.data();
    if (codeRef) {
      if (!codeSnap?.exists) throw Object.assign(new Error("Delivery code not found"), { status: 404 });
      const codeData = codeSnap.data();
      if (codeData.orderId !== orderId || codeData.riderId !== rider.riderId) throw Object.assign(new Error("Delivery code does not match this order"), { status: 403 });
      if (codeData.used) throw Object.assign(new Error("Delivery code was already used"), { status: 409 });
      if (codeData.expiresAt?.toMillis && Date.now() > codeData.expiresAt.toMillis()) throw Object.assign(new Error("Delivery code has expired"), { status: 410 });
      if (codeHash && codeData.codeHash !== codeHash) throw Object.assign(new Error("Incorrect delivery code"), { status: 401 });
    }
    assertAssignedRider(order, rider.riderId);
    if (order.status === "Delivered") throw Object.assign(new Error("Order is already delivered"), { status: 409 });

    const cashOrder = isCashMethod(order.paymentMethod || order.paymentMode);
    const paymentMethodText = String(order.paymentMethod || order.paymentMode || "").toLowerCase();
    const paymentStatusText = String(order.paymentStatus || "").toLowerCase();
    const paymentStageText = String(order.paymentStage || "").toLowerCase();
    const orderStatusText = String(order.status || order.orderStatus || "").toLowerCase();
    const amountToCollect = Number(order.amountToCollect || 0);
    const hasOnlinePaymentProof = paymentStatusText === "paid"
      || paymentStatusText === "success"
      || paymentStatusText === "collected"
      || paymentStageText === "payment completed"
      || orderStatusText === "payment completed"
      || order.paymentCaptured === true
      || !!order.razorpayPaymentId
      || !!order.transactionId
      || amountToCollect === 0;
    const onlinePaid = isOnlineMethod(paymentMethodText) && hasOnlinePaymentProof;
    const settlementDone = !!order.codSettlementStatus && order.cashSettlementPending === false;
    const exceptionDelivery = mode === "exception_code";
    const prepaidOtpDelivery = mode === "prepaid_customer_otp";
    const doorstepOnlineDelivery = mode === "doorstep_online_paid";
    const doorstepOnlinePaymentProof = doorstepOnlineDelivery && (
      amountToCollect === 0
      || paymentStageText === "payment completed"
      || orderStatusText === "payment completed"
      || paymentStatusText === "paid"
      || paymentStatusText === "success"
      || order.paymentCaptured === true
      || !!order.razorpayPaymentId
      || !!order.transactionId
    );
    const doorstepOnlinePaid = onlinePaid && (
      order.paymentCollectedBy === rider.riderId
      || paymentStageText === "payment completed"
      || orderStatusText === "payment completed"
      || amountToCollect === 0
    );
    if (doorstepOnlineDelivery && !doorstepOnlinePaymentProof) {
      throw Object.assign(new Error("Doorstep online payment is not verified"), { status: 409 });
    }
    const cashDeliveredWithoutSettlement = cashOrder && !settlementDone && !doorstepOnlineDelivery;
    if (!cashOrder && !onlinePaid && !doorstepOnlineDelivery) throw Object.assign(new Error("Online payment is not verified"), { status: 409 });

    const baseEarning = canonicalRiderEarning(order);
    const riderEarning = Math.max(0, baseEarning);
    const total = Number(order.totalAmount || order.finalAmount || 0);
    const treatedAsCashSettlement = cashOrder && !doorstepOnlineDelivery;
    const grossCompanyDue = treatedAsCashSettlement && cashDeliveredWithoutSettlement ? Math.max(0, total - riderEarning) : 0;
    const walletRef = db.collection("riderWallet").doc(rider.riderId);
    const walletSnap = await transaction.get(walletRef);
    const walletBefore = netWalletState(walletSnap.exists ? walletSnap.data() : {
      totalEarnings: riderSnap.exists ? riderSnap.data().totalEarnings : 0,
      companySettlementDue: riderSnap.exists ? (riderSnap.data().companyDue || riderSnap.data().pendingCashSubmission || 0) : 0
    });
    const earningsAdjustedToCompany = Math.min(grossCompanyDue, Math.max(0, roundMoney(walletBefore.walletBalance + riderEarning)));
    const companyDue = Math.max(0, roundMoney(grossCompanyDue - earningsAdjustedToCompany));
    const walletAfter = mergeWalletState(walletBefore, {
      totalEarnings: riderEarning,
      companySettlementDue: companyDue,
      totalCashCollected: treatedAsCashSettlement ? total : 0,
      totalCompanySettlements: earningsAdjustedToCompany,
      totalEarningsAppliedToSettlement: earningsAdjustedToCompany
    });
    const update = {
      status: "Delivered",
      orderStatus: "Delivered",
      deliveredAt: FieldValue.serverTimestamp(),
      deliveredBy: rider.riderId,
      deliveryCompletionMode: mode,
      earning: riderEarning,
      normalEarning: baseEarning,
      exceptionSettlementPenalty: 0,
      companyDue,
      companySettlementGrossDue: grossCompanyDue,
      companySettlementPayoutAdjusted: earningsAdjustedToCompany,
      cashSettlementPending: treatedAsCashSettlement ? cashDeliveredWithoutSettlement : false,
      settlementState: treatedAsCashSettlement ? (cashDeliveredWithoutSettlement ? "SETTLEMENT_PENDING" : "SETTLEMENT_COMPLETED") : "PAID_ONLINE",
      deliveryOtpStatus: codeRef ? "verified" : (order.deliveryOtpStatus || FieldValue.delete()),
      lastStatusUpdatedAt: FieldValue.serverTimestamp()
    };
    if (cashDeliveredWithoutSettlement) {
      update.exceptionReason = exceptionDelivery
        ? "Rider delivered with customer authorization code before company settlement"
        : "Rider delivered directly before company settlement";
      update.settlementPendingRiderId = rider.riderId;
    }
    if (exceptionDelivery) {
      update.deliveryCodeVerifiedAt = FieldValue.serverTimestamp();
      update.deliveryCodeVerifiedBy = rider.riderId;
    }
    guardedOrderUpdate(transaction, orderRef, order, update, { actor: rider.riderId, source: "completeDeliveryTransaction" });
    transaction.update(riderRef, {
      totalOrders: FieldValue.increment(1),
      totalEarnings: FieldValue.increment(riderEarning),
      todayEarnings: FieldValue.increment(riderEarning),
      weeklyEarnings: FieldValue.increment(riderEarning),
      monthlyEarnings: FieldValue.increment(riderEarning),
      pendingSettlement: FieldValue.increment(treatedAsCashSettlement ? 0 : riderEarning),
      totalCashCollected: FieldValue.increment(treatedAsCashSettlement ? total : 0),
      pendingCashSubmission: FieldValue.increment(companyDue),
      companyDue: FieldValue.increment(companyDue),
      exceptionSettlementDeliveries: FieldValue.increment(exceptionDelivery ? 1 : 0),
      currentActiveOrderId: FieldValue.delete(),
      activeOrderId: FieldValue.delete(),
      isAvailable: true,
      lastDeliveryAt: FieldValue.serverTimestamp()
    });
    transaction.set(db.collection("riderWalletTransactions").doc(), {
      riderId: rider.riderId,
      orderId,
      type: exceptionDelivery ? "delivery_earning_exception_settlement" : "delivery_earning",
      amount: riderEarning,
      normalAmount: baseEarning,
      penalty: 0,
      companyDue,
      grossCompanyDue,
      payoutAdjusted: earningsAdjustedToCompany,
      createdAt: FieldValue.serverTimestamp()
    });
    const historyData = {
      riderId: rider.riderId,
      orderId,
      orderNumber: order.orderNumber || order.orderId || orderId,
      customerName: order.customerName || order.name || "Customer",
      distance: Number(order.actualRoadDistance || order.deliveryDistance || order.distance || 0),
      orderAmount: total,
      paymentMethod: cashOrder ? "COD" : "ONLINE",
      riderEarning,
      cashCollected: treatedAsCashSettlement ? total : 0,
      onlineAmount: treatedAsCashSettlement ? 0 : total,
      deliveryTime: FieldValue.serverTimestamp(),
      status: "Delivered",
      companyShare: treatedAsCashSettlement ? Math.max(0, total - riderEarning) : 0,
      settlementStatus: companyDue > 0 ? "Pending" : "Settled",
      createdAt: FieldValue.serverTimestamp()
    };
    transaction.set(db.collection("riderOrderHistory").doc(orderId), historyData, { merge: true });
    transaction.set(db.collection("riderLedger").doc(`earning_${orderId}`), {
      riderId: rider.riderId, orderId, type: "DELIVERY_EARNING", amount: riderEarning,
      direction: "credit", status: "credited",
      description: `Full delivery earning credited for Order #${historyData.orderNumber}`,
      createdAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (earningsAdjustedToCompany > 0) {
      transaction.set(db.collection("riderLedger").doc(`earning_settlement_${orderId}`), {
        riderId: rider.riderId, orderId, type: "COMPANY_SETTLEMENT_SUCCESS",
        amount: earningsAdjustedToCompany, direction: "debit", status: "auto_adjusted",
        description: `Company due adjusted separately from earnings for Order #${historyData.orderNumber}`,
        createdAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    if (treatedAsCashSettlement) {
      transaction.set(db.collection("riderLedger").doc(`cod_${orderId}`), {
        riderId: rider.riderId, orderId, type: "COD_COLLECTION", amount: total,
        direction: "credit", description: `COD collected for Order #${historyData.orderNumber}`,
        createdAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      transaction.set(db.collection("riderLedger").doc(`online_${orderId}`), {
        riderId: rider.riderId, orderId, type: "ONLINE_ORDER", amount: total,
        direction: "info", description: `Online payment for Order #${historyData.orderNumber}`,
        createdAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    transaction.set(db.collection("riderNotifications").doc(), {
      riderId: rider.riderId, type: "DELIVERY_EARNING",
      message: `You earned ₹${roundMoney(riderEarning)} from Order #${historyData.orderNumber}`,
      read: false, createdAt: FieldValue.serverTimestamp()
    });
    writeWalletAudit(transaction, {
      riderId: rider.riderId,
      orderId,
      type: "delivery_completed_wallet_update",
      before: walletBefore,
      after: walletAfter,
      deltas: {
        totalEarnings: riderEarning,
        companySettlementDue: companyDue,
        totalCashCollected: treatedAsCashSettlement ? total : 0,
        totalCompanySettlements: earningsAdjustedToCompany,
        totalEarningsAppliedToSettlement: earningsAdjustedToCompany
      },
      metadata: { mode, exceptionDelivery, treatedAsCashSettlement, penaltyRemoved: true }
    });
    if (codeRef) {
      transaction.update(codeRef, {
        used: true,
        usedAt: FieldValue.serverTimestamp(),
        usedBy: rider.riderId
      });
      transaction.set(db.collection("customerDeliveryCodes").doc(orderId), {
        used: true,
        usedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      await addOrderAudit(transaction, orderId, "DELIVERY_CODE_VERIFIED", {
        riderId: rider.riderId,
        codeId: codeRef.id,
        mode
      });
    }
    await addOrderAudit(transaction, orderId, "DELIVERY_COMPLETED", {
      riderId: rider.riderId,
      mode,
      companyDue,
      riderEarning,
      penalty: 0
    });
    return { orderId, riderEarning, companyDue, penalty: 0 };
  });
}

function tokensFromProfile(profile = {}) {
  return [
    profile.fcmToken,
    profile.notificationToken,
    ...(Array.isArray(profile.fcmTokens) ? profile.fcmTokens : [])
  ].filter(Boolean).filter((token, index, arr) => arr.indexOf(token) === index);
}

async function findCandidateRiders(order = {}) {
  const ridersSnap = await db.collection("riders").get();
  const restaurantLocation = await restaurantPointForOrder(order);
  const orderLat = Number(restaurantLocation?.lat);
  const orderLng = Number(restaurantLocation?.lng);
  const hasOrderLocation = Number.isFinite(orderLat) && Number.isFinite(orderLng);

  const onlineRiders = ridersSnap.docs
    .map(item => ({ id: item.id, ...item.data() }))
    .filter(rider => rider.approved === true && rider.active !== false)
    .filter(rider => riderPresence(rider).available);

  if (!hasOrderLocation) return onlineRiders.map(rider => ({
    id: rider.id,
    name: rider.name || "Magneetoz Rider",
    phone: rider.phone || rider.phoneDigits || "",
    distance: Number.MAX_SAFE_INTEGER,
    distanceSource: "customer_location_missing"
  })).slice(0, 8);

  const routed = await Promise.all(onlineRiders.map(async rider => {
    if (!isUsablePoint(rider.location)) {
      return {
        id: rider.id,
        name: rider.name || "Magneetoz Rider",
        phone: rider.phone || rider.phoneDigits || "",
        distance: Number.MAX_SAFE_INTEGER,
        distanceSource: "rider_location_missing"
      };
    }
    try {
      const route = await calculateGoogleRouteDistance({
        origin: rider.location,
        destination: restaurantLocation
      });
      return {
        id: rider.id,
        name: rider.name || "Magneetoz Rider",
        phone: rider.phone || rider.phoneDigits || "",
        distance: route.distanceKm,
        distanceSource: route.source
      };
    } catch (error) {
      logger.warn("Rider route distance failed", { riderId: rider.id, orderId: order.orderId || "", error: error.message });
      return {
        id: rider.id,
        name: rider.name || "Magneetoz Rider",
        phone: rider.phone || rider.phoneDigits || "",
        distance: Number.MAX_SAFE_INTEGER,
        distanceSource: "route_unavailable"
      };
    }
  }));
  return routed
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8);
}

exports.assignRiderToOrder = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const adminUser = await requireAdmin(req);
      const orderId = String(req.body?.orderId || "");
      const manualRiderId = String(req.body?.riderId || "");
      const manualOverride = req.body?.overrideOffline === true;
      if (!orderId) throw Object.assign(new Error("Order id is required"), { status: 400 });
      const orderRef = db.collection("orders").doc(orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
      const order = { id: orderId, ...orderSnap.data() };
      if (!isDeliveryPaymentEligible(order)) throw Object.assign(new Error("Payment is not verified for delivery assignment"), { status: 409 });
      if (order.assignedRiderId || order.riderId) {
        return sendJson(res, 200, { ok: true, skipped: true, reason: "already_assigned", riderId: order.assignedRiderId || order.riderId });
      }

      let match = {};
      let riderSnap = null;
      if (manualRiderId) {
        riderSnap = await db.collection("riders").doc(manualRiderId).get();
        if (!riderSnap.exists) throw Object.assign(new Error("Selected rider not found"), { status: 404 });
        const rider = { id: manualRiderId, ...riderSnap.data() };
        const presence = riderPresence(rider);
        if (rider.approved !== true || rider.active === false || rider.blocked === true || presence.busy) {
          throw Object.assign(new Error("Selected rider is not online and available"), { status: 409 });
        }
        if (!presence.onlineFlag && !manualOverride) {
          throw Object.assign(new Error("Selected rider is offline. Confirm override to assign manually."), { status: 409 });
        }
        match = { rider, radius: null, restaurantLocation: await restaurantPointForOrder(order) };
      } else {
        match = await findNearestAvailableRider(order, order.riderRequest?.declinedRiderIds || []);
        if (!match.rider) {
          const hasOnlineCandidates = Array.isArray(match.candidates) && match.candidates.length > 0;
          const hasAnyLocation = hasOnlineCandidates && match.candidates.some(item => item.distanceAvailable);
          const errorMessage = !hasOnlineCandidates
            ? "No rider is online right now."
            : !hasAnyLocation
              ? "Riders are online, but their live location is unavailable."
              : "No rider found within 10 km. You can manually assign any online rider.";
          await orderRef.set({
            status: "Searching For Rider",
            orderStatus: "Searching For Rider",
            deliveryStatus: "rider_searching",
            riderStatus: errorMessage,
            failedAssignmentReason: !hasOnlineCandidates ? "no_online_rider" : !hasAnyLocation ? "rider_location_unavailable" : "no_rider_within_10km",
            riderRequest: {
              ...(order.riderRequest || {}),
              status: "no_rider_available",
              candidateRiderIds: [],
              candidates: [],
              requestedAt: FieldValue.serverTimestamp()
            },
            lastStatusUpdatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          await db.collection("deliveryEvents").add({
            orderId,
            type: "NO_RIDER_AVAILABLE",
            createdBy: adminUser.uid,
            createdAt: FieldValue.serverTimestamp()
          });
          return sendJson(res, 409, { ok: false, error: errorMessage });
        }
        riderSnap = await db.collection("riders").doc(match.rider.id).get();
      }

      const rider = { id: match.rider.id, ...match.rider };
      const requestRef = db.collection("riderRequests").doc(`${orderId}_${rider.id}`);
      const riderRef = db.collection("riders").doc(rider.id);
      const customerLocation = customerPointForOrder(order);
      const pickupAddress = order.restaurantAddress || order.pickupAddress || "MAGNEETOZ Restaurant";
      const dropAddress = order.address || order.dropAddress || "";
      const estimatedDistance = Number(order.actualRoadDistance || order.deliveryDistance || order.distance || 0);
      const earning = canonicalRiderEarning(order);
      await db.runTransaction(async transaction => {
        const [lockedOrderSnap, lockedRiderSnap] = await Promise.all([
          transaction.get(orderRef),
          transaction.get(riderRef)
        ]);
        if (!lockedOrderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const lockedOrder = lockedOrderSnap.data() || {};
        const lockedRider = lockedRiderSnap.data() || {};
        if (lockedOrder.assignedRiderId || lockedOrder.riderId) throw Object.assign(new Error("A rider is already assigned"), { status: 409 });
        const lockedPresence = riderPresence(lockedRider);
        if (lockedPresence.busy || (!manualRiderId && !lockedPresence.available) || (!lockedPresence.onlineFlag && !manualOverride)) {
          throw Object.assign(new Error("Rider became unavailable. Please retry."), { status: 409 });
        }
        if (!manualRiderId) {
          transaction.set(requestRef, {
            orderId,
            riderId: rider.id,
            restaurantLocation: match.restaurantLocation,
            customerLocation,
            pickupAddress,
            dropAddress,
            estimatedDistance,
            estimatedEarning: earning,
            expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 60 * 1000),
            status: "pending",
            createdAt: FieldValue.serverTimestamp()
          }, { merge: true });
          guardedOrderUpdate(transaction, orderRef, lockedOrder, {
            status: "Searching For Rider",
            orderStatus: "Searching For Rider",
            deliveryStatus: "rider_searching",
            sentToRider: true,
            riderStatus: "Rider request sent",
            riderRequest: {
              ...(lockedOrder.riderRequest || {}),
              status: "searching",
              requestId: requestRef.id,
              candidateRiderIds: [rider.id],
              candidates: [{
                id: rider.id,
                name: rider.name || rider.riderName || "Magneetoz Rider",
                phone: rider.phone || rider.phoneDigits || "",
                distance: rider.distanceKm || null,
                distanceAvailable: rider.distanceAvailable === true
              }],
              declinedRiderIds: lockedOrder.riderRequest?.declinedRiderIds || [],
              requestedAt: FieldValue.serverTimestamp(),
              searchRadiusKm: match.radius || null
            },
            restaurantLocation: match.restaurantLocation,
            customerLocation: customerLocation || lockedOrder.customerLocation || lockedOrder.location || null,
            lastStatusUpdatedAt: FieldValue.serverTimestamp()
          }, { actor: adminUser.uid, source: "assignRiderToOrder:auto_request" });
          addDeliveryEvent(transaction, orderId, "RIDER_REQUEST_SENT", { riderId: rider.id, autoAccepted: false });
          addOrderAudit(transaction, orderId, "RIDER_REQUEST_SENT", { riderId: rider.id, autoAccepted: false });
          return;
        }
        transaction.set(requestRef, {
          orderId,
          riderId: rider.id,
          restaurantLocation: match.restaurantLocation,
          customerLocation,
          pickupAddress,
          dropAddress,
          estimatedDistance,
          estimatedEarning: earning,
          expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 1000),
          status: "accepted",
          autoAccepted: true,
          acceptedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp()
        }, { merge: true });
        guardedOrderUpdate(transaction, orderRef, lockedOrder, {
          status: "Rider Accepted",
          orderStatus: "Rider Accepted",
          deliveryStatus: "rider_assigned",
          sentToRider: true,
          riderId: rider.id,
          assignedRiderId: rider.id,
          assignedRiderName: rider.name || rider.riderName || "Magneetoz Rider",
          riderName: rider.name || rider.riderName || "Magneetoz Rider",
          riderPhone: rider.phone || rider.phoneDigits || "",
          assignedRider: {
            id: rider.id,
            name: rider.name || rider.riderName || "Magneetoz Rider",
            phone: rider.phone || rider.phoneDigits || ""
          },
          riderStatus: "Rider assigned",
          riderRequest: {
            status: "assigned",
            requestId: requestRef.id,
            candidateRiderIds: [rider.id],
            candidates: [{
              id: rider.id,
              name: rider.name || rider.riderName || "Magneetoz Rider",
              phone: rider.phone || rider.phoneDigits || "",
              distance: rider.distanceKm || null
            }],
            declinedRiderIds: lockedOrder.riderRequest?.declinedRiderIds || [],
            acceptedRiderId: rider.id,
            acceptedAt: FieldValue.serverTimestamp(),
            requestedAt: FieldValue.serverTimestamp(),
            searchRadiusKm: match.radius || null
          },
          restaurantLocation: match.restaurantLocation,
          customerLocation: customerLocation || lockedOrder.customerLocation || lockedOrder.location || null,
          assignedAt: FieldValue.serverTimestamp(),
          acceptedAt: FieldValue.serverTimestamp(),
          assignedBy: adminUser.uid,
          lastStatusUpdatedAt: FieldValue.serverTimestamp()
        }, { actor: adminUser.uid, source: "assignRiderToOrder:manual_assign" });
        transaction.update(riderRef, {
          currentActiveOrderId: orderId,
          activeOrderId: orderId,
          isAvailable: false,
          activeOrderStartedAt: FieldValue.serverTimestamp()
        });
        addDeliveryEvent(transaction, orderId, "RIDER_ASSIGNED", { riderId: rider.id, autoAccepted: true });
        addOrderAudit(transaction, orderId, "RIDER_ASSIGNED", { riderId: rider.id, autoAccepted: true });
      });
      return sendJson(res, 200, {
        ok: true,
        orderId,
        riderId: rider.id,
        riderName: rider.name || rider.riderName || "Magneetoz Rider",
        requestSent: !manualRiderId,
        assigned: !!manualRiderId,
        message: manualRiderId ? "Rider assigned successfully." : "Rider request sent."
      });
    } catch (error) {
      logger.error("assignRiderToOrder failed", { error: error.message });
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Rider assignment failed" });
    }
  }
);

exports.adminUpdateOrderStatus = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const adminUser = await requireAdmin(req);
      const orderId = String(req.body?.orderId || "");
      const requestedStatus = String(req.body?.status || "");
      if (!orderId || !requestedStatus) throw Object.assign(new Error("Order id and status are required"), { status: 400 });
      const statusMap = {
        payment_pending: "Payment Pending",
        placed: "Pending",
        restaurant_accepted: "Accepted",
        preparing: "Preparing",
        ready_for_pickup: "Ready",
        rider_searching: "Searching For Rider",
        rider_assigned: "Rider Accepted",
        rider_accepted: "Rider Accepted",
        picked_up: "Picked Up",
        out_for_delivery: "Out For Delivery",
        arrived_customer: "Reached Nearby",
        delivered: "Delivered",
        cancelled: "Cancelled",
        failed: "Failed"
      };
      const nextStatus = statusMap[requestedStatus.toLowerCase()] || requestedStatus;
      const allowedAdminStatuses = new Set(["Accepted", "Preparing", "Ready", "Rejected", "Cancelled"]);
      if (!allowedAdminStatuses.has(nextStatus)) {
        throw Object.assign(new Error("This status is controlled by rider or system"), { status: 400 });
      }
      const orderRef = db.collection("orders").doc(orderId);
      let previous = null;
      await db.runTransaction(async transaction => {
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const order = orderSnap.data() || {};
        previous = order;
        if (!isDeliveryPaymentEligible(order)) {
          throw Object.assign(new Error("Online payment is not confirmed yet. Do not update this order."), { status: 409 });
        }
        const currentStatus = statusMap[String(order.status || "").toLowerCase()] || order.status || "Pending";
        const normalizedCurrent = normalizeOrderMachineStatus(currentStatus);
        const normalizedNext = normalizeOrderMachineStatus(nextStatus);
        if (!["Rejected", "Cancelled"].includes(nextStatus) && machineStatusRank(normalizedNext) < machineStatusRank(normalizedCurrent)) {
          throw Object.assign(new Error(`Cannot move order backwards from ${currentStatus} to ${nextStatus}`), { status: 409 });
        }
        const updates = {
          status: nextStatus,
          orderStatus: nextStatus,
          deliveryStatus: deliveryStatusFor(nextStatus),
          lastStatusUpdatedAt: FieldValue.serverTimestamp(),
          lastStatusUpdatedBy: adminUser.uid
        };
        if (nextStatus === "Accepted") updates.acceptedAt = FieldValue.serverTimestamp();
        if (nextStatus === "Preparing") updates.preparingAt = FieldValue.serverTimestamp();
        if (nextStatus === "Ready") updates.readyAt = FieldValue.serverTimestamp();
        if (nextStatus === "Rejected" || nextStatus === "Cancelled") {
          updates.completedAt = FieldValue.serverTimestamp();
          updates.cancelledBy = nextStatus === "Rejected" ? "admin" : "admin";
          updates.pizzaPointsRefundEligible = true;
        }
        transaction.update(orderRef, updates);
        addOrderAudit(transaction, orderId, "ADMIN_STATUS_UPDATE", {
          from: currentStatus,
          to: nextStatus,
          adminUid: adminUser.uid
        });
        addDeliveryEvent(transaction, orderId, deliveryStatusFor(nextStatus).toUpperCase(), {
          adminUid: adminUser.uid
        });
      });
      if (["Rejected", "Cancelled"].includes(nextStatus) && (previous?.assignedRiderId || previous?.riderId)) {
        await reconcileRiderState(previous.assignedRiderId || previous.riderId, { actor: `admin_status:${adminUser.uid}` });
      }
      return sendJson(res, 200, { ok: true, orderId, status: nextStatus });
    } catch (error) {
      logger.error("adminUpdateOrderStatus failed", { error: error.message });
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Order status update failed" });
    }
  }
);

exports.reconcileRiderState = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const requestedRiderId = String(req.body?.riderId || user.uid);
      const isSelf = requestedRiderId === user.uid;
      if (!isSelf) await requireAdmin(req);
      const desiredOnline = typeof req.body?.online === "boolean" ? req.body.online : null;
      const result = await reconcileRiderState(requestedRiderId, {
        desiredOnline,
        actor: isSelf ? "rider_self" : "admin"
      });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      logger.error("reconcileRiderState failed", { error: error.message });
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Rider reconciliation failed" });
    }
  }
);

exports.systemIntegrityCheck = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const adminUser = await requireAdmin(req);
      const repair = req.body?.repair === true;
      const [ridersSnap, ordersSnap] = await Promise.all([
        db.collection("riders").get(),
        db.collection("orders").get()
      ]);
      const riders = new Map(ridersSnap.docs.map(docSnap => [docSnap.id, { id: docSnap.id, ...docSnap.data() }]));
      const orders = ordersSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
      const issues = {
        staleRiderLocks: [],
        assignedToMissingRider: [],
        missingPaymentStatus: [],
        missingPaymentMethod: [],
        invalidPaymentStates: [],
        hiddenPendingPayNow: [],
        invalidOrderStatus: []
      };
      const validStatuses = new Set([
        "Pending", "Payment Pending", "payment_pending", "Accepted", "Preparing", "Ready", "ready_for_pickup",
        "Searching For Rider", "Rider Accepted", "Picked Up", "Out For Delivery", "Reached Nearby",
        "Collect Payment", "Cash Collected", "Payment Settled", "Delivery Code Pending", "Payment Completed",
        "Delivered", "Cancelled", "Rejected", "Failed", "failed", "cancelled", "delivered"
      ]);
      const openOrdersByRider = new Map();
      orders.forEach(order => {
        const riderId = order.assignedRiderId || order.riderId || "";
        if (riderId && !riders.has(riderId)) issues.assignedToMissingRider.push({ orderId: order.id, riderId });
        if (!String(order.paymentStatus || "")) issues.missingPaymentStatus.push({ orderId: order.id, paymentMethod: order.paymentMethod || "" });
        if (!String(order.paymentMethod || order.paymentMode || "")) issues.missingPaymentMethod.push({ orderId: order.id, paymentStatus: order.paymentStatus || "" });
        const paymentFields = canonicalPaymentFields(order);
        const methodText = String(order.paymentMethod || order.paymentMode || "").toLowerCase();
        const statusText = String(order.status || order.orderStatus || "");
        const blockedStatus = ["Delivered", "Cancelled", "Rejected", "Failed", "failed", "cancelled", "delivered"].includes(statusText);
        const refunded = String(order.paymentStatus || "").toLowerCase() === "refunded" || order.refunded === true || order.refundStatus === "refunded";
        const canShowPayNow = paymentFields.paymentRequired
          && !paymentFields.paymentCompleted
          && !blockedStatus
          && !refunded
          && ["cod", "cash", "online", "upi", ""].includes(methodText)
          && (paymentFields.amountDue >= 1 || Number(order.totalAmount || order.amount || order.grandTotal || order.finalAmount || 0) >= 1);
        const rawAmountDue = amountDueForOrder(order);
        if (String(order.paymentStatus || "").toLowerCase() === "paid" && rawAmountDue > 0) {
          issues.invalidPaymentStates.push({ orderId: order.id, reason: "paid_with_amount_due", amountDue: rawAmountDue });
        }
        if (paymentFields.paymentRequired && !paymentFields.paymentCompleted && !blockedStatus && !refunded && !canShowPayNow) {
          issues.hiddenPendingPayNow.push({
            orderId: order.id,
            paymentStatus: order.paymentStatus || "",
            paymentMethod: order.paymentMethod || order.paymentMode || "",
            amountDue: paymentFields.amountDue,
            orderStatus: statusText
          });
        }
        const status = String(order.status || order.orderStatus || "");
        if (status && !validStatuses.has(status)) issues.invalidOrderStatus.push({ orderId: order.id, status });
        if (riderId && isOpenRiderOrder(order)) {
          if (!openOrdersByRider.has(riderId)) openOrdersByRider.set(riderId, []);
          openOrdersByRider.get(riderId).push(order.id);
        }
      });
      riders.forEach(rider => {
        const lockedOrderId = rider.currentActiveOrderId || rider.activeOrderId || "";
        const actualOpenOrders = openOrdersByRider.get(rider.id) || [];
        if (lockedOrderId && !actualOpenOrders.includes(lockedOrderId)) {
          issues.staleRiderLocks.push({ riderId: rider.id, lockedOrderId, actualOpenOrders });
        }
      });
      const repairs = [];
      if (repair) {
        for (const issue of issues.staleRiderLocks) {
          const result = await reconcileRiderState(issue.riderId, { actor: `integrity:${adminUser.uid}` });
          repairs.push({ type: "stale_rider_lock", ...result });
        }
        for (const issue of issues.missingPaymentStatus) {
          const orderRef = db.collection("orders").doc(issue.orderId);
          await orderRef.set({
            paymentStatus: issue.paymentMethod === "online" || issue.paymentMethod === "upi" ? "pending" : "pending",
            paymentStatusRepairedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          repairs.push({ type: "missing_payment_status", orderId: issue.orderId });
        }
        for (const order of orders) {
          const fields = canonicalPaymentFields(order);
          const patch = {
            ...fields,
            paymentMethod: order.paymentMethod || order.paymentMode || "cod",
            paymentIntegrityRepairedAt: FieldValue.serverTimestamp()
          };
          const needsPatch = !hasOwn(order, "paymentRequired")
            || !hasOwn(order, "paymentCompleted")
            || !hasOwn(order, "amountDue")
            || !hasOwn(order, "amountPaid")
            || !String(order.paymentStatus || "")
            || !String(order.paymentMethod || order.paymentMode || "");
          if (needsPatch) {
            await db.collection("orders").doc(order.id).set(patch, { merge: true });
            repairs.push({ type: "canonical_payment_fields", orderId: order.id });
          }
        }
      }
      return sendJson(res, 200, { ok: true, repair, issues, repairs });
    } catch (error) {
      logger.error("systemIntegrityCheck failed", { error: error.message });
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Integrity check failed" });
    }
  }
);

exports.acceptRiderRequest = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const orderId = String(req.body?.orderId || "");
      const orderRef = db.collection("orders").doc(orderId);
      const riderRef = db.collection("riders").doc(rider.riderId);
      const walletRef = db.collection("riderWallet").doc(rider.riderId);
      await reconcileRiderState(rider.riderId, { actor: "before_accept" });
      await db.runTransaction(async transaction => {
        const [orderSnap, riderSnap, walletSnap] = await Promise.all([
          transaction.get(orderRef), transaction.get(riderRef), transaction.get(walletRef)
        ]);
        if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const order = orderSnap.data() || {};
        const riderData = riderSnap.data() || {};
        if (order.assignedRiderId && order.assignedRiderId !== rider.riderId) throw Object.assign(new Error("Another rider already accepted this order"), { status: 409 });
        const activeOrderId = riderData.currentActiveOrderId || riderData.activeOrderId || "";
        if (activeOrderId && activeOrderId !== orderId) throw Object.assign(new Error("Complete current delivery first"), { status: 409 });
        const request = order.riderRequest || {};
        if (!(request.candidateRiderIds || []).includes(rider.riderId) && order.assignedRiderId !== rider.riderId) {
          throw Object.assign(new Error("This delivery request is no longer available"), { status: 403 });
        }
        guardedOrderUpdate(transaction, orderRef, order, {
          status: "Rider Accepted",
          orderStatus: "Rider Accepted",
          deliveryStatus: "rider_accepted",
          sentToRider: true,
          riderId: rider.riderId,
          assignedRiderId: rider.riderId,
          riderName: rider.name || rider.riderName || "Magneetoz Rider",
          riderPhone: rider.phone || rider.phoneDigits || "",
          assignedRider: { id: rider.riderId, name: rider.name || rider.riderName || "Magneetoz Rider", phone: rider.phone || rider.phoneDigits || "" },
          riderStatus: "Accepted by rider",
          riderRequest: { ...request, status: "assigned", acceptedRiderId: rider.riderId, acceptedAt: FieldValue.serverTimestamp() },
          assignedAt: order.assignedAt || FieldValue.serverTimestamp(),
          lastStatusUpdatedAt: FieldValue.serverTimestamp()
        }, { actor: rider.riderId, source: "acceptRiderRequest" });
        transaction.update(riderRef, {
          currentActiveOrderId: orderId,
          activeOrderId: orderId,
          isAvailable: false,
          activeOrderStartedAt: FieldValue.serverTimestamp()
        });
        transaction.set(db.collection("riderRequests").doc(`${orderId}_${rider.riderId}`), {
          orderId,
          riderId: rider.riderId,
          status: "accepted",
          acceptedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        addDeliveryEvent(transaction, orderId, "RIDER_ACCEPTED", { riderId: rider.riderId });
      });
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Accept failed" });
    }
  }
);

exports.rejectRiderRequest = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const orderId = String(req.body?.orderId || "");
      const orderRef = db.collection("orders").doc(orderId);
      await db.runTransaction(async transaction => {
        const snap = await transaction.get(orderRef);
        if (!snap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const order = snap.data() || {};
        if (order.assignedRiderId && order.assignedRiderId !== rider.riderId) return;
        transaction.update(orderRef, {
          "riderRequest.declinedRiderIds": FieldValue.arrayUnion(rider.riderId),
          "riderRequest.lastRejectedAt": FieldValue.serverTimestamp(),
          riderStatus: "Rider rejected. Reassign from admin.",
          lastStatusUpdatedAt: FieldValue.serverTimestamp()
        });
        transaction.set(db.collection("riderRequests").doc(`${orderId}_${rider.riderId}`), {
          orderId,
          riderId: rider.riderId,
          status: "rejected",
          rejectedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        addDeliveryEvent(transaction, orderId, "RIDER_REJECTED", { riderId: rider.riderId });
      });
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Reject failed" });
    }
  }
);

exports.updateRiderDeliveryStatus = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const orderId = String(req.body?.orderId || "");
      const nextStatus = String(req.body?.status || "");
      const allowed = {
        "Rider Accepted": ["Picked Up"],
        "Picked Up": ["Out For Delivery"],
        "Out For Delivery": ["Reached Nearby"],
        "Reached Nearby": ["Collect Payment", "Payment Completed"]
      };
      if (!["Picked Up", "Out For Delivery", "Reached Nearby", "Collect Payment", "Payment Completed"].includes(nextStatus)) {
        throw Object.assign(new Error("Invalid delivery status"), { status: 400 });
      }
      const orderRef = db.collection("orders").doc(orderId);
      await db.runTransaction(async transaction => {
        const snap = await transaction.get(orderRef);
        if (!snap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const order = snap.data() || {};
        assertAssignedRider(order, rider.riderId);
        if (order.status === "Delivered") throw Object.assign(new Error("Order already delivered"), { status: 409 });
        const current = order.status || "Rider Accepted";
        if (!(allowed[current] || []).includes(nextStatus) && current !== nextStatus) {
          throw Object.assign(new Error(`Cannot move delivery from ${current} to ${nextStatus}`), { status: 409 });
        }
        const timestampFields = {};
        if (nextStatus === "Picked Up") timestampFields.pickedUpAt = FieldValue.serverTimestamp();
        if (nextStatus === "Out For Delivery") timestampFields.outForDeliveryAt = FieldValue.serverTimestamp();
        if (nextStatus === "Reached Nearby") timestampFields.reachedNearbyAt = FieldValue.serverTimestamp();
        guardedOrderUpdate(transaction, orderRef, order, {
          status: nextStatus,
          orderStatus: nextStatus,
          deliveryStatus: deliveryStatusFor(nextStatus),
          riderStatus: nextStatus === "Out For Delivery" ? "Rider is moving toward you" : nextStatus === "Reached Nearby" ? "Rider is nearby" : "Delivery updated",
          ...timestampFields,
          lastStatusUpdatedAt: FieldValue.serverTimestamp()
        }, { actor: rider.riderId, source: "updateRiderDeliveryStatus" });
        addDeliveryEvent(transaction, orderId, deliveryStatusFor(nextStatus).toUpperCase(), { riderId: rider.riderId });
      });
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Status update failed" });
    }
  }
);

exports.updateRiderLocation = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const orderId = String(req.body?.orderId || rider.currentActiveOrderId || "");
      const location = pointFrom(req.body?.location || {});
      if (!location) throw Object.assign(new Error("Valid rider location is required"), { status: 400 });
      const payload = {
        ...location,
        accuracy: Number(req.body?.location?.accuracy || 0),
        updatedAt: new Date().toISOString()
      };
      await db.runTransaction(async transaction => {
        const riderRef = db.collection("riders").doc(rider.riderId);
        const orderRef = orderId ? db.collection("orders").doc(orderId) : null;
        const orderSnap = orderRef ? await transaction.get(orderRef) : null;
        transaction.update(riderRef, {
          location: payload,
          currentLocation: payload,
          lastLocationUpdateAt: FieldValue.serverTimestamp(),
          lastSeenAt: FieldValue.serverTimestamp()
        });
        transaction.set(db.collection("riderLocations").doc(rider.riderId), {
          riderId: rider.riderId,
          location: payload,
          activeOrderId: orderId || null,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        if (orderSnap?.exists) {
          const order = orderSnap.data() || {};
          if (order.assignedRiderId === rider.riderId || order.riderId === rider.riderId) {
            transaction.update(orderRef, {
              riderLocation: payload,
              riderLocationUpdatedAt: FieldValue.serverTimestamp(),
              riderStatus: deliveryStatusFor(order.status) === "arrived_customer" ? "Rider is nearby" : "Rider location updated"
            });
          }
        }
      });
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Location update failed" });
    }
  }
);

exports.riderMarkCashReceived = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const orderId = String(req.body?.orderId || "");
      const orderRef = db.collection("orders").doc(orderId);
      await db.runTransaction(async transaction => {
        const snap = await transaction.get(orderRef);
        if (!snap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const order = snap.data();
        assertAssignedRider(order, rider.riderId);
        if (!isCashMethod(order.paymentMethod || order.paymentMode)) throw Object.assign(new Error("Order is not COD"), { status: 400 });
        guardedOrderUpdate(transaction, orderRef, order, {
          status: "Cash Collected",
          orderStatus: "Cash Collected",
          paymentStatus: "collected",
          paymentMethod: "cod",
          amountToCollect: 0,
          paymentCaptured: false,
          cashCollectedBy: rider.riderId,
          cashCollectedAt: FieldValue.serverTimestamp(),
          paymentCollectedBy: rider.riderId,
          paymentCollectedAt: FieldValue.serverTimestamp(),
          cashSettlementPending: true,
          settlementState: "CASH_COLLECTED",
          paymentStage: "Cash Collected",
          lastStatusUpdatedAt: FieldValue.serverTimestamp()
        }, { actor: rider.riderId, source: "riderMarkCashReceived" });
        addOrderAudit(transaction, orderId, "CASH_COLLECTED", { riderId: rider.riderId, amount: Number(order.totalAmount || order.finalAmount || 0) });
      });
      return sendJson(res, 200, { ok: true, codeGenerated: false });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Cash collection failed" });
    }
  }
);

exports.createRiderPaymentSession = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const orderId = String(req.body?.orderId || "");
      const type = String(req.body?.type || "customer_online");
      const orderSnap = await db.collection("orders").doc(orderId).get();
      if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
      const order = orderSnap.data();
      assertAssignedRider(order, rider.riderId);
      if (type === "cod_company_settlement" && order.activeRiderPaymentSessionId) {
        const existingSessionSnap = await db.collection("riderPaymentSessions").doc(String(order.activeRiderPaymentSessionId)).get();
        const existingSession = existingSessionSnap.exists ? existingSessionSnap.data() || {} : {};
        if (
          existingSessionSnap.exists &&
          existingSession.riderId === rider.riderId &&
          existingSession.orderId === orderId &&
          existingSession.type === "cod_company_settlement" &&
          existingSession.status === "created" &&
          existingSession.razorpayOrderId
        ) {
          return sendJson(res, 200, {
            ok: true,
            paymentSessionId: existingSessionSnap.id,
            razorpayOrderId: existingSession.razorpayOrderId,
            amount: Number(existingSession.amount || existingSession.outstandingDue || 0),
            grossCompanyDue: Number(existingSession.grossCompanyDue || 0),
            riderEarning: Number(existingSession.riderEarning || 0),
            payoutAdjusted: Number(existingSession.payoutAdjusted || 0),
            keyId: env("RAZORPAY_KEY_ID"),
            recovery: true
          });
        }
      }
      const pricingSnap = await db.collection("settings").doc("pricing").get();
      const pricing = pricingSnap.exists ? pricingSnap.data() : {};
      const total = Number(order.totalAmount || order.finalAmount || 0);
      const earning = canonicalRiderEarning(order);
      const grossCompanyDue = Math.max(0, total - earning);
      const walletSnap = await db.collection("riderWallet").doc(rider.riderId).get();
      const currentWallet = netWalletState(walletSnap.exists ? walletSnap.data() : {
        totalEarnings: rider.totalEarnings || 0,
        companySettlementDue: rider.companyDue || rider.pendingCashSubmission || 0
      });
      const payoutAdjusted = type === "cod_company_settlement" ? Math.min(grossCompanyDue, currentWallet.walletBalance) : 0;
      const amount = type === "cod_company_settlement" ? Math.max(0, roundMoney(grossCompanyDue - payoutAdjusted)) : total;
      if (type === "cod_company_settlement" && amount <= 0) {
        await db.runTransaction(async transaction => {
          const lockedOrderRef = db.collection("orders").doc(orderId);
          const lockedOrderSnap = await transaction.get(lockedOrderRef);
          const riderRef = db.collection("riders").doc(rider.riderId);
          const walletRef = db.collection("riderWallet").doc(rider.riderId);
          const lockedWalletSnap = await transaction.get(walletRef);
          if (!lockedOrderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
          const lockedOrder = lockedOrderSnap.data();
          assertAssignedRider(lockedOrder, rider.riderId);
          if (lockedOrder.codSettlementStatus) throw Object.assign(new Error("Company settlement is already recorded"), { status: 409 });
          const walletBefore = netWalletState(lockedWalletSnap.exists ? lockedWalletSnap.data() : {
            totalEarnings: rider.totalEarnings || 0,
            companySettlementDue: rider.companyDue || rider.pendingCashSubmission || 0
          });
          const adjusted = Math.min(grossCompanyDue, walletBefore.walletBalance);
          const remainingDue = Math.max(0, roundMoney(grossCompanyDue - adjusted));
          const walletAfter = mergeWalletState(walletBefore, {
            companySettlementDue: remainingDue,
            totalCompanySettlements: adjusted,
            totalEarningsAppliedToSettlement: adjusted
          });
          guardedOrderUpdate(transaction, lockedOrderRef, lockedOrder, {
            status: "Payment Settled",
            orderStatus: "Payment Settled",
            codSettlementStatus: "paid_to_company_by_payout_adjustment",
            settlementState: "SETTLEMENT_COMPLETED",
            cashSettlementPending: false,
            companyRazorpaySettlementAmount: 0,
            companySettlementGrossDue: grossCompanyDue,
            companySettlementPayoutAdjusted: adjusted,
            companySettlementNetPaid: 0,
            companyRazorpayPaidBy: rider.riderId,
            companyRazorpayPaidAt: FieldValue.serverTimestamp(),
            lastStatusUpdatedAt: FieldValue.serverTimestamp()
          }, { actor: rider.riderId, source: "createRiderPaymentSession:payout_adjustment" });
          transaction.update(riderRef, {
            pendingSettlement: FieldValue.increment(-adjusted),
            settlementAdjustedPayout: FieldValue.increment(adjusted),
            lastCodSettlementAt: FieldValue.serverTimestamp()
          });
          transaction.set(db.collection("riderWalletTransactions").doc(), {
            riderId: rider.riderId,
            orderId,
            type: "cod_company_settlement_payout_adjustment",
            amount: -adjusted,
            grossCompanyDue,
            payoutAdjusted: adjusted,
            netCompanyPaid: 0,
            createdAt: FieldValue.serverTimestamp()
          });
          transaction.set(db.collection("riderSettlements").doc(), {
            riderId: rider.riderId,
            orderId,
            type: "company_settlement",
            status: "complete",
            grossCompanyDue,
            payoutAdjusted: adjusted,
            upiPaid: 0,
            walletBefore,
            walletAfter,
            createdAt: FieldValue.serverTimestamp()
          });
          writeWalletAudit(transaction, {
            riderId: rider.riderId,
            orderId,
            type: "company_settlement_auto_adjusted",
            before: walletBefore,
            after: walletAfter,
            deltas: { companySettlementDue: remainingDue, totalCompanySettlements: adjusted, totalEarningsAppliedToSettlement: adjusted },
            metadata: { grossCompanyDue, payoutAdjusted: adjusted, outstandingDue: 0 }
          });
          addOrderAudit(transaction, orderId, "COMPANY_SETTLEMENT_ADJUSTED_FROM_PAYOUT", {
            riderId: rider.riderId,
            grossCompanyDue,
            payoutAdjusted: adjusted,
            netCompanyPaid: 0
          });
        });
        return sendJson(res, 200, {
          ok: true,
          noPaymentRequired: true,
          amount: 0,
          grossCompanyDue,
          riderEarning: earning,
          payoutAdjusted
        });
      }
      if (amount <= 0) throw Object.assign(new Error("No payable amount found"), { status: 400 });
      const sessionRef = db.collection("riderPaymentSessions").doc();
      const razorpayOrder = await getRazorpay().orders.create({
        amount: Math.round(amount * 100),
        currency: "INR",
        receipt: sessionRef.id.slice(0, 40),
        notes: { orderId, riderId: rider.riderId, type, source: "rider_dashboard" }
      });
      await db.runTransaction(async transaction => {
        const orderRef = db.collection("orders").doc(orderId);
        const walletRef = db.collection("riderWallet").doc(rider.riderId);
        const [lockedOrderSnap, lockedWalletSnap] = await Promise.all([
          transaction.get(orderRef),
          transaction.get(walletRef)
        ]);
        if (!lockedOrderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const lockedOrder = lockedOrderSnap.data() || {};
        assertAssignedRider(lockedOrder, rider.riderId);
        if (type === "cod_company_settlement" && lockedOrder.codSettlementStatus) throw Object.assign(new Error("Company settlement is already recorded"), { status: 409 });
        const walletBefore = netWalletState(lockedWalletSnap.exists ? lockedWalletSnap.data() : {
          totalEarnings: rider.totalEarnings || 0,
          companySettlementDue: rider.companyDue || rider.pendingCashSubmission || 0
        });
        const adjusted = type === "cod_company_settlement" ? Math.min(grossCompanyDue, walletBefore.walletBalance) : 0;
        const remainingDue = type === "cod_company_settlement" ? Math.max(0, roundMoney(grossCompanyDue - adjusted)) : 0;
        const walletAfter = type === "cod_company_settlement"
          ? mergeWalletState(walletBefore, {
              companySettlementDue: remainingDue,
              totalCompanySettlements: adjusted,
              totalEarningsAppliedToSettlement: adjusted
            })
          : walletBefore;
        transaction.set(sessionRef, {
          orderId,
          riderId: rider.riderId,
          type,
          amount,
          riderEarning: earning,
          grossCompanyDue,
          payoutAdjusted: adjusted,
          walletBefore,
          walletAfterDueAdded: walletAfter,
          outstandingDue: amount,
          netCompanyPaid: amount,
          amountPaise: Math.round(amount * 100),
          razorpayOrderId: razorpayOrder.id,
          status: "created",
          recoveryState: type === "cod_company_settlement" ? "payment_required" : "open",
          createdAt: FieldValue.serverTimestamp()
        });
        if (type === "cod_company_settlement") {
          transaction.update(orderRef, {
            settlementState: "SETTLEMENT_PAYMENT_PENDING",
            cashSettlementPending: true,
            companySettlementGrossDue: grossCompanyDue,
            companySettlementPayoutAdjusted: adjusted,
            companySettlementOutstandingDue: amount,
            activeRiderPaymentSessionId: sessionRef.id,
            lastStatusUpdatedAt: FieldValue.serverTimestamp()
          });
          writeWalletAudit(transaction, {
            riderId: rider.riderId,
            orderId,
            type: "company_settlement_due_recorded",
            before: walletBefore,
            after: walletAfter,
            deltas: { companySettlementDue: remainingDue, totalCompanySettlements: adjusted, totalEarningsAppliedToSettlement: adjusted },
            metadata: { grossCompanyDue, payoutAdjusted: adjusted, outstandingDue: amount, paymentSessionId: sessionRef.id }
          });
          transaction.set(db.collection("riderSettlements").doc(sessionRef.id), {
            riderId: rider.riderId,
            orderId,
            type: "company_settlement",
            status: "payment_pending",
            grossCompanyDue,
            payoutAdjusted: adjusted,
            outstandingDue: amount,
            upiPaid: 0,
            razorpayOrderId: razorpayOrder.id,
            walletBefore,
            walletAfter,
            createdAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
      });
      return sendJson(res, 200, { ok: true, paymentSessionId: sessionRef.id, razorpayOrderId: razorpayOrder.id, amount, grossCompanyDue, riderEarning: earning, payoutAdjusted, keyId: env("RAZORPAY_KEY_ID") });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Payment session failed" });
    }
  }
);

exports.verifyRiderPayment = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const { paymentSessionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      if (!verifyCheckoutSignature({ razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id, razorpaySignature: razorpay_signature })) {
        throw Object.assign(new Error("Invalid Razorpay signature"), { status: 401 });
      }
      const sessionRef = db.collection("riderPaymentSessions").doc(String(paymentSessionId || ""));
      const sessionSnap = await sessionRef.get();
      if (!sessionSnap.exists) throw Object.assign(new Error("Payment session not found"), { status: 404 });
      const session = sessionSnap.data();
      if (session.riderId !== rider.riderId || session.razorpayOrderId !== razorpay_order_id) throw Object.assign(new Error("Payment session mismatch"), { status: 403 });
      const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
      if (payment.order_id !== razorpay_order_id || Number(payment.amount) !== Number(session.amountPaise)) throw Object.assign(new Error("Payment amount mismatch"), { status: 400 });
      if (!["captured", "authorized"].includes(payment.status)) throw Object.assign(new Error(`Payment not captured: ${payment.status}`), { status: 402 });
      if (payment.status === "authorized") await getRazorpay().payments.capture(razorpay_payment_id, Number(session.amountPaise), "INR");
      const orderRef = db.collection("orders").doc(String(session.orderId));
      const riderRef = db.collection("riders").doc(rider.riderId);
      await db.runTransaction(async transaction => {
        const walletRef = db.collection("riderWallet").doc(rider.riderId);
        const [orderSnap, walletSnap] = await Promise.all([
          transaction.get(orderRef),
          transaction.get(walletRef)
        ]);
        if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const lockedOrder = orderSnap.data() || {};
        if (session.type === "cod_company_settlement" && lockedOrder.codSettlementStatus) {
          transaction.update(sessionRef, { status: "verified_duplicate", razorpayPaymentId: razorpay_payment_id, verifiedAt: FieldValue.serverTimestamp() });
          return;
        }
        const autoDeliverCustomerOnline = session.type !== "cod_company_settlement";
        const walletBefore = netWalletState(walletSnap.exists ? walletSnap.data() : session.walletAfterDueAdded || {});
        const walletAfterPayment = session.type === "cod_company_settlement"
          ? mergeWalletState(walletBefore, {
              companySettlementDue: -Number(session.amount || 0),
              totalCompanySettlements: Number(session.amount || 0)
            })
          : walletBefore;
        const update = session.type === "cod_company_settlement" ? {
          status: "Payment Settled",
          orderStatus: "Payment Settled",
          codSettlementStatus: "paid_to_company",
          settlementState: "SETTLEMENT_COMPLETED",
          cashSettlementPending: false,
          companyRazorpaySettlementAmount: session.amount,
          companySettlementGrossDue: Number(session.grossCompanyDue || session.amount || 0),
          companySettlementPayoutAdjusted: Number(session.payoutAdjusted || 0),
          companySettlementNetPaid: Number(session.amount || 0),
          companySettlementOutstandingDue: 0,
          companyRazorpayPaymentId: razorpay_payment_id,
          companyRazorpayPaidAt: FieldValue.serverTimestamp(),
          companyRazorpayPaidBy: rider.riderId,
          activeRiderPaymentSessionId: FieldValue.delete()
        } : {
          status: "Delivered",
          orderStatus: "Delivered",
          deliveredAt: FieldValue.serverTimestamp(),
          deliveredBy: rider.riderId,
          deliveryCompletionMode: "rider_online_payment_auto_delivered",
          paymentStatus: "paid",
          paymentMethod: "online",
          amountToCollect: 0,
          paymentCaptured: true,
          paymentCollectedBy: rider.riderId,
          paymentCollectedAt: FieldValue.serverTimestamp(),
          razorpayPaymentId: razorpay_payment_id,
          transactionId: razorpay_payment_id,
          companyReceivedAmount: session.amount,
          paymentStage: "Payment Completed"
        };
        guardedOrderUpdate(transaction, orderRef, lockedOrder, { ...update, lastStatusUpdatedAt: FieldValue.serverTimestamp() }, {
          actor: rider.riderId,
          source: session.type === "cod_company_settlement" ? "verifyRiderPayment:company_settlement" : "verifyRiderPayment:customer_online"
        });
        transaction.update(sessionRef, { status: "verified", recoveryState: "settlement_complete", razorpayPaymentId: razorpay_payment_id, verifiedAt: FieldValue.serverTimestamp() });
        if (session.type === "cod_company_settlement" && Number(session.payoutAdjusted || 0) > 0) {
          transaction.update(riderRef, {
            pendingSettlement: FieldValue.increment(-Number(session.payoutAdjusted || 0)),
            settlementAdjustedPayout: FieldValue.increment(Number(session.payoutAdjusted || 0)),
            lastCodSettlementAt: FieldValue.serverTimestamp()
          });
        }
        if (autoDeliverCustomerOnline) {
          const riderEarning = canonicalRiderEarning(lockedOrder);
          transaction.update(riderRef, {
            totalOrders: FieldValue.increment(1),
            totalEarnings: FieldValue.increment(riderEarning),
            todayEarnings: FieldValue.increment(riderEarning),
            weeklyEarnings: FieldValue.increment(riderEarning),
            monthlyEarnings: FieldValue.increment(riderEarning),
            pendingSettlement: FieldValue.increment(riderEarning),
            currentActiveOrderId: FieldValue.delete(),
            lastDeliveryAt: FieldValue.serverTimestamp()
          });
          transaction.set(db.collection("riderWalletTransactions").doc(), {
            riderId: rider.riderId,
            orderId: session.orderId,
            type: "delivery_earning_customer_online_auto_delivered",
            amount: riderEarning,
            razorpayPaymentId: razorpay_payment_id,
            createdAt: FieldValue.serverTimestamp()
          });
        }
        if (session.type === "cod_company_settlement") {
          transaction.set(db.collection("riderLedger").doc(`settlement_success_${paymentSessionId}`), {
            ledgerId: `settlement_success_${paymentSessionId}`,
            riderId: rider.riderId,
            orderId: session.orderId,
            settlementId: paymentSessionId,
            type: "COMPANY_SETTLEMENT_SUCCESS",
            amount: Number(session.amount || 0),
            direction: "debit",
            description: `Company settlement paid through Razorpay`,
            status: "success",
            metadata: { razorpayPaymentId: razorpay_payment_id, razorpayOrderId: razorpay_order_id },
            createdAt: FieldValue.serverTimestamp()
          }, { merge: true });
          transaction.set(db.collection("riderNotifications").doc(), {
            riderId: rider.riderId,
            type: "COMPANY_SETTLEMENT_SUCCESS",
            message: `Company settlement of ₹${roundMoney(session.amount)} completed successfully.`,
            read: false,
            createdAt: FieldValue.serverTimestamp()
          });
          writeWalletAudit(transaction, {
            riderId: rider.riderId,
            orderId: session.orderId,
            type: "company_settlement_upi_paid",
            before: walletBefore,
            after: walletAfterPayment,
            deltas: { companySettlementDue: -Number(session.amount || 0), totalCompanySettlements: Number(session.amount || 0) },
            metadata: { razorpayPaymentId: razorpay_payment_id, paymentSessionId, upiPaid: Number(session.amount || 0) }
          });
          transaction.set(db.collection("riderWalletTransactions").doc(), {
            riderId: rider.riderId,
            orderId: session.orderId,
            type: "cod_company_settlement",
            amount: -Number(session.amount || 0),
            grossCompanyDue: Number(session.grossCompanyDue || session.amount || 0),
            payoutAdjusted: Number(session.payoutAdjusted || 0),
            netCompanyPaid: Number(session.amount || 0),
            razorpayPaymentId: razorpay_payment_id,
            createdAt: FieldValue.serverTimestamp()
          });
          transaction.set(db.collection("riderSettlementPayments").doc(razorpay_payment_id), {
            riderId: rider.riderId,
            orderId: session.orderId,
            paymentSessionId,
            amount: Number(session.amount || 0),
            razorpayOrderId: razorpay_order_id,
            razorpayPaymentId: razorpay_payment_id,
            status: "paid",
            createdAt: FieldValue.serverTimestamp()
          }, { merge: true });
          transaction.set(db.collection("riderSettlements").doc(String(paymentSessionId)), {
            riderId: rider.riderId,
            orderId: session.orderId,
            type: "company_settlement",
            status: "complete",
            grossCompanyDue: Number(session.grossCompanyDue || session.amount || 0),
            payoutAdjusted: Number(session.payoutAdjusted || 0),
            outstandingDue: 0,
            upiPaid: Number(session.amount || 0),
            razorpayPaymentId: razorpay_payment_id,
            walletBefore: session.walletBefore || {},
            walletAfter: walletAfterPayment,
            completedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
        addOrderAudit(transaction, session.orderId, session.type === "cod_company_settlement" ? "COMPANY_SETTLEMENT_VERIFIED" : "CUSTOMER_ONLINE_PAYMENT_VERIFIED", {
          riderId: rider.riderId,
          amount: session.amount,
          grossCompanyDue: Number(session.grossCompanyDue || session.amount || 0),
          payoutAdjusted: Number(session.payoutAdjusted || 0),
          razorpayPaymentId: razorpay_payment_id,
          autoDelivered: autoDeliverCustomerOnline
        });
      });
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Payment verification failed" });
    }
  }
);

exports.requestDeliveryExceptionCode = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const orderId = String(req.body?.orderId || "");
      const orderRef = db.collection("orders").doc(orderId);
      let result = {};
      await db.runTransaction(async transaction => {
        const snap = await transaction.get(orderRef);
        if (!snap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const order = snap.data();
        assertAssignedRider(order, rider.riderId);
        if (!isCashMethod(order.paymentMethod || order.paymentMode) || String(order.paymentStatus || "").toLowerCase() !== "collected") {
          throw Object.assign(new Error("Cash must be collected before requesting delivery code"), { status: 409 });
        }
        result = createCustomerDeliveryCode({ transaction, orderRef, order, orderId, rider, purpose: "cod_exception" });
      });
      const expiresAt = await result.expiresAt;
      return sendJson(res, 200, { ok: true, expiresAt: expiresAt.toMillis() });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Code generation failed" });
    }
  }
);

exports.requestPrepaidDeliveryCode = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const orderId = String(req.body?.orderId || "");
      const orderRef = db.collection("orders").doc(orderId);
      let result = {};
      await db.runTransaction(async transaction => {
        const snap = await transaction.get(orderRef);
        if (!snap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const order = snap.data();
        assertAssignedRider(order, rider.riderId);
        const method = order.paymentMethod || order.paymentMode;
        const paidOnline = isOnlineMethod(method) &&
          (String(order.paymentStatus || "").toLowerCase() === "paid" || order.paymentCaptured === true || order.razorpayPaymentId);
        if (!paidOnline) throw Object.assign(new Error("Prepaid delivery OTP is available only after verified online payment"), { status: 409 });
        if (order.status === "Delivered") throw Object.assign(new Error("Order is already delivered"), { status: 409 });
        result = createCustomerDeliveryCode({ transaction, orderRef, order, orderId, rider, purpose: "prepaid_delivery" });
      });
      const expiresAt = await result.expiresAt;
      return sendJson(res, 200, { ok: true, expiresAt: expiresAt.toMillis() });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Delivery OTP generation failed" });
    }
  }
);

exports.completeDeliveryWithCode = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const orderId = String(req.body?.orderId || "");
      const code = String(req.body?.code || "").trim();
      if (!/^\d{4}$/.test(code)) throw Object.assign(new Error("Enter the 4 digit customer code"), { status: 400 });
      const orderSnap = await db.collection("orders").doc(orderId).get();
      if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
      const order = orderSnap.data();
      assertAssignedRider(order, rider.riderId);
      const codeRef = db.collection("deliveryAuthorizationCodes").doc(String(order.activeDeliveryCodeId || ""));
      const codeSnap = await codeRef.get();
      if (!codeSnap.exists) throw Object.assign(new Error("Delivery code not found"), { status: 404 });
      const codeData = codeSnap.data();
      if (codeData.used) throw Object.assign(new Error("Delivery code was already used"), { status: 409 });
      if (codeData.expiresAt?.toMillis && Date.now() > codeData.expiresAt.toMillis()) throw Object.assign(new Error("Delivery code has expired"), { status: 410 });
      const codeHash = hashDeliveryCode(code);
      if (codeData.codeHash !== codeHash) throw Object.assign(new Error("Incorrect delivery code"), { status: 401 });
      const orderMethod = order.paymentMethod || order.paymentMode;
      const mode = isOnlineMethod(orderMethod) ? "prepaid_customer_otp" : "exception_code";
      const result = await completeDeliveryTransaction({ orderId, rider, mode, codeRef, codeHash });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Delivery completion failed" });
    }
  }
);

exports.completeRiderDelivery = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const orderId = String(req.body?.orderId || "");
      const requestedMode = String(req.body?.mode || "verified_payment");
      let mode = requestedMode === "doorstep_online_paid" ? "doorstep_online_paid" : "verified_payment";
      if (mode === "verified_payment") {
        const orderSnap = await db.collection("orders").doc(orderId).get();
        if (orderSnap.exists) {
          const order = orderSnap.data() || {};
          const methodText = String(order.paymentMethod || order.paymentMode || "").toLowerCase();
          const statusText = String(order.status || order.orderStatus || "").toLowerCase();
          const stageText = String(order.paymentStage || "").toLowerCase();
          const paymentStatusText = String(order.paymentStatus || "").toLowerCase();
          const amountToCollect = Number(order.amountToCollect || 0);
          const paidDoorstepOnline = amountToCollect === 0
            && (
              isOnlineMethod(methodText)
              || statusText === "payment completed"
              || stageText === "payment completed"
              || paymentStatusText === "paid"
              || paymentStatusText === "success"
              || order.paymentCaptured === true
              || !!order.razorpayPaymentId
              || !!order.transactionId
            );
          if (paidDoorstepOnline) mode = "doorstep_online_paid";
        }
      }
      const result = await completeDeliveryTransaction({ orderId, rider, mode });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Delivery completion failed" });
    }
  }
);

exports.createNearbyRiderRequest = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const orderId = String(req.body?.orderId || "");
      if (!orderId) throw Object.assign(new Error("Order id is required"), { status: 400 });
      const orderRef = db.collection("orders").doc(orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
      const order = orderSnap.data() || {};
      if (order.userId !== user.uid) throw Object.assign(new Error("You can request rider only for your own order"), { status: 403 });
      if (order.assignedRiderId || order.riderId || order.riderRequest?.status === "assigned") {
        return sendJson(res, 200, { ok: true, skipped: true, reason: "already_assigned" });
      }
      await orderRef.set({
        sentToRider: true,
        riderRequest: {
          ...(order.riderRequest || {}),
          status: "searching",
          candidateRiderIds: [],
          candidates: [],
          declinedRiderIds: order.riderRequest?.declinedRiderIds || [],
          requestedAt: order.riderRequest?.requestedAt || FieldValue.serverTimestamp()
        },
        riderStatus: "Searching for nearby rider"
      }, { merge: true });
      await db.collection("riderNotificationQueue").add({
        orderId,
        orderNumber: order.orderNumber || "",
        customerName: order.customerName || "Customer",
        amount: order.totalAmount || order.finalAmount || 0,
        distance: order.actualRoadDistance || order.deliveryDistance || 0,
        candidateRiderIds: [],
        needsCandidateSelection: true,
        status: "queued",
        createdBy: user.uid,
        createdAt: FieldValue.serverTimestamp()
      });
      await db.collection("orderAuditLogs").add({
        orderId,
        event: "RIDER_REQUEST_CREATED",
        userId: user.uid,
        createdAt: FieldValue.serverTimestamp()
      });
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Rider request failed" });
    }
  }
);

exports.sendRiderDeliveryRequest = onDocumentCreated(
  {
    document: "riderNotificationQueue/{queueId}",
    region: "asia-south1"
  },
  async event => {
    const snap = event.data;
    if (!snap) return;

    const queueRef = snap.ref;
    const queue = snap.data() || {};
    let riderIds = Array.isArray(queue.candidateRiderIds)
      ? queue.candidateRiderIds
      : [];

    if (!riderIds.length && queue.needsCandidateSelection && queue.orderId) {
      const orderRef = db.collection("orders").doc(String(queue.orderId));
      const orderSnap = await orderRef.get();
      const order = orderSnap.exists ? orderSnap.data() : {};
      const candidates = await findCandidateRiders(order);
      const selectedCandidates = candidates.slice(0, 1);
      riderIds = selectedCandidates.map(rider => rider.id);
      const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 1000);

      await queueRef.set({
        candidateRiderIds: riderIds,
        candidates: selectedCandidates,
        selectedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      if (riderIds[0]) {
        await db.collection("riderRequests").doc(`${queue.orderId}_${riderIds[0]}`).set({
          orderId: queue.orderId,
          riderId: riderIds[0],
          restaurantLocation: await restaurantPointForOrder(order),
          customerLocation: customerPointForOrder(order),
          pickupAddress: order.restaurantAddress || order.pickupAddress || "MAGNEETOZ Restaurant",
          dropAddress: order.address || order.dropAddress || "",
          estimatedDistance: Number(order.actualRoadDistance || order.deliveryDistance || order.distance || 0),
          estimatedEarning: canonicalRiderEarning(order),
          expiresAt,
          status: "pending",
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      if (orderSnap.exists) {
        await orderRef.set({
          riderRequest: {
            ...(order.riderRequest || {}),
            status: riderIds.length ? "searching" : "waiting_for_online_rider",
            candidateRiderIds: riderIds,
            candidates: selectedCandidates,
            expiresAt,
            requestedAt: order.riderRequest?.requestedAt || admin.firestore.FieldValue.serverTimestamp()
          },
          riderStatus: riderIds.length ? "Searching for nearby rider" : "Waiting for an online rider"
        }, { merge: true });
      }
    }

    if (!riderIds.length) {
      await queueRef.set({
        status: "skipped",
        error: "No candidate riders",
        processedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }

    const riderSnaps = await Promise.all(
      riderIds.map(id => db.collection("riders").doc(id).get())
    );

    const riders = riderSnaps
      .filter(item => item.exists)
      .map(item => ({ id: item.id, ...item.data() }))
      .filter(rider => tokensFromProfile(rider).length && rider.approved === true && rider.active !== false);

    if (!riders.length) {
      await queueRef.set({
        status: "skipped",
        error: "No riders with FCM tokens",
        processedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }

    const orderNumber = queue.orderNumber || queue.orderId || "";
    const customerName = queue.customerName || "Customer";
    const amount = formatAmount(queue.amount || queue.totalAmount || 0);
    const title = "New Delivery Request";
    const body = `Order #${orderNumber}\nCustomer: ${customerName}\nAmount: ${amount}`;

    const responses = await Promise.allSettled(
      riders.flatMap(rider => tokensFromProfile(rider).map(token => ({ rider, token }))).map(({ rider, token }) => messaging.send({
        token,
        notification: { title, body },
        data: {
          type: "delivery_request",
          orderId: String(queue.orderId || ""),
          orderNumber: String(orderNumber),
          customerName: String(customerName),
          amount: String(queue.amount || queue.totalAmount || 0),
          distance: String(queue.distance || ""),
          body
        },
        android: {
          priority: "high",
          notification: {
            channelId: "magneetoz_delivery_requests",
            priority: "max",
            sound: "default",
            defaultVibrateTimings: true,
            notificationCount: 1
          }
        },
        webpush: {
          fcmOptions: {
            link: `/rider-dashboard.html?orderId=${encodeURIComponent(queue.orderId || "")}`
          },
          notification: {
            title,
            body,
            icon: "/logo_tran.png",
            badge: "/logo_tran.png",
            requireInteraction: true,
            renotify: true,
            vibrate: [220, 90, 220, 90, 320],
            actions: [
              { action: "accept", title: "Accept" },
              { action: "reject", title: "Reject" }
            ]
          }
        }
      }))
    );

    const sent = [];
    const failed = [];

    const targets = riders.flatMap(rider => tokensFromProfile(rider).map(token => ({ rider, token })));
    responses.forEach((result, index) => {
      const rider = targets[index].rider;
      if (result.status === "fulfilled") {
        sent.push({ riderId: rider.id, messageId: result.value });
      } else {
        failed.push({
          riderId: rider.id,
          error: result.reason?.message || String(result.reason)
        });
      }
    });

    await queueRef.set({
      status: sent.length ? "sent" : "failed",
      sent,
      failed,
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (failed.length) {
      logger.warn("Some rider notifications failed", { queueId: event.params.queueId, failed });
    }
  }
);

exports.collectCustomerFromOrder = onDocumentCreated(
  {
    document: "orders/{orderId}",
    region: "asia-south1"
  },
  async event => {
    const order = event.data?.data() || {};
    if (order.status === "payment_pending" || String(order.paymentStatus || "").toLowerCase() !== "paid" && String(order.paymentMethod || "").toLowerCase() === "online") return;
    const phone = cleanPhone(order.phone);
    if (!phone) return;

    const customerRef = db.collection("customers").doc(customerIdFromPhone(phone));
    await db.runTransaction(async transaction => {
      const snap = await transaction.get(customerRef);
      const existing = snap.exists ? snap.data() : {};
      const totalOrders = (existing.totalOrders || 0) + 1;
      const totalSpent = (existing.totalSpent || 0) + Number(order.totalAmount || order.finalAmount || 0);
      const lastOrderDate = order.createdAt || order.placedAt || admin.firestore.FieldValue.serverTimestamp();
      const mergedTags = [
        ...(Array.isArray(existing.tags) ? existing.tags : []),
        ...tagsForCustomer({
          totalOrders,
          totalSpent,
          lastOrderDate,
          items: order.items || []
        })
      ];

      transaction.set(customerRef, {
        customerName: order.customerName || existing.customerName || "Customer",
        phoneNumber: phone,
        displayPhone: order.phone || existing.displayPhone || phone,
        totalOrders,
        totalSpent,
        lastOrderDate,
        lastOrderAmount: Number(order.totalAmount || order.finalAmount || 0),
        location: order.location || existing.location || null,
        lastAddress: order.address || existing.lastAddress || "",
        tags: [...new Set(mergedTags)],
        whatsappOptIn: existing.whatsappOptIn !== false,
        createdAt: existing.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
  }
);

exports.notifyCustomerOrderStatus = onDocumentUpdated(
  {
    document: "orders/{orderId}",
    region: "asia-south1"
  },
  async event => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    if (!after.userId || before.status === after.status) return;

    const statusCopy = {
      "Accepted": "Your MAGNEETOZ order has been accepted.",
      "Preparing": "Your food is being prepared.",
      "Rider Accepted": `${after.riderName || "Your rider"} is assigned to your order.`,
      "Picked Up": "Your order has been picked up.",
      "Out For Delivery": "Your order is out for delivery.",
      "Reached Nearby": "Your rider is nearby.",
      "Collect Payment": "Your rider is nearby. Please keep payment ready.",
      "Payment Completed": "Payment received. Delivery is being completed.",
      "Delivered": "Order delivered. Enjoy your MAGNEETOZ meal."
    };
    const body = statusCopy[after.status] || `Order status: ${after.status || "Updated"}`;
    const userSnap = await db.collection("users").doc(after.userId).get();
    if (!userSnap.exists) return;
    const tokens = tokensFromProfile(userSnap.data());
    if (!tokens.length) return;

    const title = `Order #${after.orderNumber || event.params.orderId}`;
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: {
        type: "order_status",
        orderId: event.params.orderId,
        orderNumber: String(after.orderNumber || ""),
        status: String(after.status || ""),
        body
      },
      android: {
        priority: "high",
        notification: {
          channelId: "magneetoz_orders",
          priority: "high",
          sound: "default"
        }
      },
      webpush: {
        fcmOptions: { link: `/index.html?orderId=${encodeURIComponent(event.params.orderId)}#tracking` },
        notification: {
          title,
          body,
          icon: "/logo_tran.png",
          badge: "/logo_tran.png",
          tag: `order-${event.params.orderId}-${after.status}`,
          renotify: false,
          requireInteraction: false,
          vibrate: [160, 80, 160]
        }
      }
    });

    if (response.failureCount) {
      logger.warn("Customer notification failures", {
        orderId: event.params.orderId,
        failureCount: response.failureCount
      });
    }
  }
);

async function sendWhatsAppCloudMessage({ config, customer, campaign }) {
  const token = config.accessToken;
  const phoneNumberId = config.phoneNumberId;
  if (!token || !phoneNumberId) throw new Error("WhatsApp Cloud API is not configured");

  const websiteUrl = config.websiteUrl || "https://magneetoz.com";
  const coupon = campaign.couponCode ? `\n\nUse Coupon:\n${campaign.couponCode}` : "";
  const message = `${campaign.title || "MAGNEETOZ SPECIAL OFFER"}\n\n${campaign.description || ""}${coupon}\n\n${campaign.buttonText || "Order Now"}:\n${websiteUrl}\n\nReply STOP to unsubscribe.`;
  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
  const to = cleanPhone(customer.phoneNumber || customer.displayPhone);

  const sendPayload = config.templateName
    ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: {
          name: config.templateName,
          language: { code: config.templateLanguage || "en_US" },
          components: [
            ...(campaign.image ? [{
              type: "header",
              parameters: [{ type: "image", image: { link: campaign.image } }]
            }] : []),
            {
              type: "body",
              parameters: [
                { type: "text", text: campaign.title || "MAGNEETOZ SPECIAL OFFER" },
                { type: "text", text: campaign.description || "Fresh offer is live." },
                { type: "text", text: campaign.couponCode || "MAGNEETOZ" },
                { type: "text", text: websiteUrl }
              ]
            }
          ]
        }
      }
    : campaign.image
    ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "image",
        image: {
          link: campaign.image,
          caption: message
        }
      }
    : {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: {
          preview_url: true,
          body: message
        }
      };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(sendPayload)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `WhatsApp API failed with ${response.status}`);
  }
  return body;
}

exports.sendWhatsAppCampaign = onDocumentCreated(
  {
    document: "whatsappCampaignQueue/{queueId}",
    region: "asia-south1"
  },
  async event => {
    const queueRef = event.data.ref;
    const queue = event.data.data() || {};
    const campaignSnap = await db.collection("whatsappCampaigns").doc(queue.campaignId).get();
    if (!campaignSnap.exists) {
      await queueRef.set({ status: "failed", error: "Campaign not found" }, { merge: true });
      return;
    }

    const campaign = { id: campaignSnap.id, ...campaignSnap.data() };
    const configSnap = await db.collection("settings").doc("whatsapp").get();
    const config = configSnap.exists ? configSnap.data() : {};
    const maxPerRun = Number(config.maxPerRun || 200);

    let customersQuery = db.collection("customers").where("whatsappOptIn", "==", true);
    if (campaign.targetAudience === "vip") customersQuery = customersQuery.where("tags", "array-contains", "VIP");
    if (campaign.targetAudience === "frequent") customersQuery = customersQuery.where("tags", "array-contains", "Frequent Buyer");
    if (campaign.targetAudience === "firstTime") customersQuery = customersQuery.where("totalOrders", "==", 1);
    if (campaign.targetAudience === "highSpenders") customersQuery = customersQuery.where("tags", "array-contains", "High Spender");

    const customerSnap = await customersQuery.limit(maxPerRun).get();
    const customers = customerSnap.docs.map(item => ({ id: item.id, ...item.data() }));

    await queueRef.set({
      status: "sending",
      totalTargets: customers.length,
      startedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const sent = [];
    const failed = [];

    for (const customer of customers) {
      try {
        const result = await sendWhatsAppCloudMessage({ config, customer, campaign });
        sent.push({
          customerId: customer.id,
          phoneNumber: customer.phoneNumber,
          messageId: result.messages?.[0]?.id || ""
        });
      } catch (error) {
        failed.push({
          customerId: customer.id,
          phoneNumber: customer.phoneNumber,
          error: error.message || String(error)
        });
      }
    }

    await campaignSnap.ref.set({
      sendStatus: sent.length ? "sent" : "failed",
      lastSentAt: admin.firestore.FieldValue.serverTimestamp(),
      messagesSent: admin.firestore.FieldValue.increment(sent.length),
      messagesFailed: admin.firestore.FieldValue.increment(failed.length),
      lastReach: customers.length
    }, { merge: true });

    await queueRef.set({
      status: sent.length ? "completed" : "failed",
      sent,
      failed,
      sentCount: sent.length,
      failedCount: failed.length,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
);

exports.broadcastOfferToCustomers = onDocumentCreated(
  {
    document: "offers/{offerId}",
    region: "asia-south1"
  },
  async event => {
    const snap = event.data;
    if (!snap) return;
    const offer = snap.data() || {};
    if (offer.broadcastRequested !== true && offer.broadcastStatus !== "pending") return;

    const usersSnap = await db.collection("users").get();

    const tokens = [];
    usersSnap.forEach(userSnap => {
      const user = userSnap.data();
      if (user.notificationsEnabled === false || user.offerNotificationsEnabled === false) return;
      tokens.push(...tokensFromProfile(user));
    });

    if (!tokens.length) {
      await snap.ref.set({
        broadcastStatus: "skipped",
        broadcastError: "No customer FCM tokens",
        broadcastAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }

    const title = offer.notificationTitle || offer.title || "MAGNEETOZ Offer";
    const body = offer.notificationBody || offer.description || "A fresh MAGNEETOZ deal is live.";
    const image = offer.image || "/logo_tran.png";

    const response = await messaging.sendEachForMulticast({
      tokens: [...new Set(tokens)],
      notification: { title, body, image },
      data: {
        type: "offer_broadcast",
        offerId: event.params.offerId,
        couponCode: String(offer.couponCode || ""),
        title: String(offer.title || title),
        body: String(body)
      },
      android: {
        priority: "high",
        notification: {
          channelId: "magneetoz_offers",
          priority: "high",
          sound: "default"
        }
      },
      webpush: {
        fcmOptions: { link: "/index.html#offersSection" },
        notification: {
          title,
          body,
          image,
          icon: "/logo_tran.png",
          badge: "/logo_tran.png",
          requireInteraction: false,
          vibrate: [140, 70, 180]
        }
      }
    });

    await snap.ref.set({
      broadcastStatus: "sent",
      broadcastSuccessCount: response.successCount,
      broadcastFailureCount: response.failureCount,
      broadcastAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection("notificationHistory").add({
      type: "offer_broadcast",
      offerId: event.params.offerId,
      title,
      body,
      couponCode: offer.couponCode || "",
      successCount: response.successCount,
      failureCount: response.failureCount,
      readBy: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
);

exports.broadcastUpdatedOfferToCustomers = onDocumentUpdated(
  {
    document: "offers/{offerId}",
    region: "asia-south1"
  },
  async event => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    if (before.broadcastRequested === after.broadcastRequested && before.broadcastStatus === after.broadcastStatus) return;
    if (after.broadcastRequested !== true && after.broadcastStatus !== "pending") return;
    if (after.broadcastStatus === "sent") return;

    const usersSnap = await db.collection("users").get();
    const tokens = [];
    usersSnap.forEach(userSnap => {
      const user = userSnap.data();
      if (user.notificationsEnabled === false || user.offerNotificationsEnabled === false) return;
      tokens.push(...tokensFromProfile(user));
    });

    if (!tokens.length) {
      await event.data.after.ref.set({
        broadcastStatus: "skipped",
        broadcastError: "No customer FCM tokens",
        broadcastAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }

    const title = after.notificationTitle || after.title || "MAGNEETOZ Offer";
    const body = after.notificationBody || after.description || "A fresh MAGNEETOZ deal is live.";
    const image = after.image || "/logo_tran.png";
    const response = await messaging.sendEachForMulticast({
      tokens: [...new Set(tokens)],
      notification: { title, body, image },
      data: {
        type: "offer_broadcast",
        offerId: event.params.offerId,
        couponCode: String(after.couponCode || ""),
        title: String(after.title || title),
        body: String(body)
      },
      webpush: {
        fcmOptions: { link: "/index.html#offersSection" },
        notification: {
          title,
          body,
          image,
          icon: "/logo_tran.png",
          badge: "/logo_tran.png",
          requireInteraction: false,
          vibrate: [140, 70, 180]
        }
      }
    });

    await event.data.after.ref.set({
      broadcastStatus: "sent",
      broadcastSuccessCount: response.successCount,
      broadcastFailureCount: response.failureCount,
      broadcastAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
);

exports.generateLoyaltyRewardCoupon = onDocumentUpdated(
  {
    document: "orders/{orderId}",
    region: "asia-south1"
  },
  async event => {
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};
    if (before.status === "Delivered" || after.status !== "Delivered" || !after.userId) return;

    const rewardSnap = await db.collection("settings").doc("rewards").get();
    const reward = rewardSnap.exists ? rewardSnap.data() : {};
    if (reward.enabled === false) return;

    const requiredOrders = Number(reward.requiredOrders || 10);
    const codePrefix = reward.couponCode || "FREEPIZZA10";
    const userId = after.userId;

    const deliveredSnap = await db.collection("orders")
      .where("userId", "==", userId)
      .where("status", "==", "Delivered")
      .get();

    if (deliveredSnap.size < requiredOrders || deliveredSnap.size % requiredOrders !== 0) return;

    const couponCode = `${codePrefix}-${userId.slice(0, 5).toUpperCase()}-${deliveredSnap.size}`;
    const existing = await db.collection("coupons").where("code", "==", couponCode).limit(1).get();
    if (!existing.empty) return;

    await db.collection("coupons").add({
      code: couponCode,
      type: "flat",
      discountValue: Number(reward.discountValue || 199),
      maxDiscount: Number(reward.maxDiscount || reward.discountValue || 199),
      minOrderAmount: Number(reward.minOrderAmount || 0),
      usageLimit: 1,
      usedCount: 0,
      active: true,
      hiddenCoupon: true,
      firstOrderOnly: false,
      allowedUsers: [userId],
      freeItem: reward.rewardType || "Free Pizza",
      freeDelivery: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      generatedBy: "loyalty_reward",
      rewardOrderCount: deliveredSnap.size
    });

    await db.collection("rewardRedemptions").add({
      userId,
      orderId: event.params.orderId,
      couponCode,
      rewardType: reward.rewardType || "Free Pizza",
      requiredOrders,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
);

exports.initializeGrowthProfile = onDocumentCreated(
  { document: "users/{userId}", region: "asia-south1" },
  async event => {
    const snap = event.data;
    if (!snap) return;
    const userId = event.params.userId;
    let authPhone = "";
    try {
      authPhone = (await admin.auth().getUser(userId)).phoneNumber || "";
    } catch (error) {
      logger.warn("Growth profile auth lookup skipped", { userId, error: error.message });
    }
    await growth.initializeUser({ db, FieldValue, uid: userId, authPhone, profile: snap.data() || {} });
  }
);

exports.processGrowthRewardsOnDelivery = onDocumentUpdated(
  { document: "orders/{orderId}", region: "asia-south1" },
  async event => {
    if (!event.data) return;
    await growth.processDeliveredOrder({
      db,
      FieldValue,
      orderId: event.params.orderId,
      before: event.data.before.data() || {},
      order: event.data.after.data() || {},
      logger
    });
  }
);

exports.reconcilePendingReferralRewards = onSchedule(
  {
    schedule: "every 15 minutes",
    region: "asia-south1",
    timeZone: "Asia/Kolkata"
  },
  async () => {
    const pending = await db.collection("referralEvents")
      .where("status", "==", "attached")
      .limit(50)
      .get();
    if (pending.empty) return;

    for (const eventDoc of pending.docs) {
      const referral = eventDoc.data() || {};
      if (referral.rewardCredited === true || !referral.referredUserId) continue;
      try {
        const orders = await db.collection("orders")
          .where("userId", "==", referral.referredUserId)
          .get();
        const deliveredOrder = orders.docs
          .map(item => ({ id: item.id, data: item.data() || {} }))
          .filter(item => String(item.data.status || item.data.orderStatus || "").toLowerCase() === "delivered")
          .sort((a, b) => {
            const aTime = a.data.deliveredAt?.toMillis?.() || a.data.createdAt?.toMillis?.() || 0;
            const bTime = b.data.deliveredAt?.toMillis?.() || b.data.createdAt?.toMillis?.() || 0;
            return aTime - bTime;
          })[0];
        if (!deliveredOrder) continue;
        await growth.processDeliveredOrder({
          db,
          FieldValue,
          orderId: deliveredOrder.id,
          before: {},
          order: deliveredOrder.data,
          logger
        });
      } catch (error) {
        logger.error("Pending referral reconciliation failed", {
          referralEventId: eventDoc.id,
          referredUserId: referral.referredUserId,
          error: error.message
        });
      }
    }
  }
);

function feedbackRewardPoints(orderAmount) {
  const amount = Number(orderAmount || 0);
  if (amount >= 500) return 20;
  if (amount >= 400) return 15;
  if (amount >= 300) return 10;
  if (amount >= 200) return 5;
  if (amount >= 100) return 3;
  return 0;
}

const PIZZA_POINT_EXPIRY_MS = 60 * 24 * 60 * 60 * 1000;

async function consumePizzaPointBatches(transaction, userId, points, sourceId) {
  let remaining = Math.max(0, Math.floor(Number(points || 0)));
  if (!remaining) return [];
  const creditsQuery = db.collection("walletTransactions")
    .where("userId", "==", userId)
    .where("status", "==", "credited")
    .orderBy("createdAt", "asc")
    .limit(100);
  const credits = await transaction.get(creditsQuery);
  const allocations = [];
  for (const creditSnap of credits.docs) {
    if (!remaining) break;
    const credit = creditSnap.data() || {};
    if (Number(credit.points || 0) <= 0) continue;
    const available = Math.max(0, Math.floor(Number(
      credit.remainingPoints === undefined ? credit.points : credit.remainingPoints
    )));
    if (!available) continue;
    const used = Math.min(available, remaining);
    transaction.set(creditSnap.ref, {
      remainingPoints: available - used,
      lastConsumedAt: FieldValue.serverTimestamp(),
      lastConsumptionSource: sourceId
    }, { merge: true });
    allocations.push({ transactionId: creditSnap.id, points: used });
    remaining -= used;
  }
  if (remaining) throw Object.assign(new Error("Available Pizza Point batches are insufficient"), { status: 409 });
  return allocations;
}

exports.settlePizzaPointsOnOrderCancellation = onDocumentUpdated(
  { document: "orders/{orderId}", region: "asia-south1" },
  async event => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    const beforeStatus = String(before.status || before.orderStatus || "").toLowerCase();
    const afterStatus = String(after.status || after.orderStatus || "").toLowerCase();
    if (beforeStatus === afterStatus || !["cancelled", "rejected"].includes(afterStatus) || !after.userId) return;
    const orderId = event.params.orderId;
    const customerCancelled = String(after.cancelledBy || "").toLowerCase() === "customer";
    const pointsUsed = Math.max(0, Number(after.walletPointsUsed || after.walletDiscount || 0));
    if (!pointsUsed) {
      await event.data.after.ref.set({
        pizzaPointsRefundEligible: !customerCancelled,
        pizzaPointsSettlementStatus: "not_applicable"
      }, { merge: true });
      return;
    }
    if (customerCancelled) {
      await event.data.after.ref.set({
        pizzaPointsRefundEligible: false,
        pizzaPointsForfeited: pointsUsed,
        pizzaPointsSettlementStatus: "forfeited",
        pizzaPointsForfeitureReason: "customer_cancelled_order",
        pizzaPointsSettledAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }
    const userRef = db.collection("users").doc(String(after.userId));
    const codLedgerRef = db.collection("walletTransactions").doc(`order_redeem_${orderId}_${after.userId}`);
    const onlineLedgerRef = after.paymentSessionId
      ? db.collection("walletTransactions").doc(`online_reserve_${after.paymentSessionId}`)
      : null;
    await db.runTransaction(async transaction => {
      const refs = [userRef, codLedgerRef, ...(onlineLedgerRef ? [onlineLedgerRef] : [])];
      const [userSnap, codLedgerSnap, onlineLedgerSnap] = await Promise.all(refs.map(ref => transaction.get(ref)));
      const ledgerSnap = codLedgerSnap.exists ? codLedgerSnap : onlineLedgerSnap;
      if (!ledgerSnap?.exists) return;
      const ledger = ledgerSnap.data() || {};
      if (ledger.refundStatus === "refunded" || !["debited", "reserved"].includes(String(ledger.status || ""))) return;
      const allocations = Array.isArray(ledger.allocations) ? ledger.allocations : [];
      const creditRefs = allocations.map(allocation =>
        db.collection("walletTransactions").doc(String(allocation.transactionId || ""))
      );
      const creditSnaps = await Promise.all(creditRefs.map(ref => transaction.get(ref)));
      let refundable = 0;
      allocations.forEach((allocation, index) => {
        const creditSnap = creditSnaps[index];
        if (!creditSnap.exists) return;
        const credit = creditSnap.data() || {};
        const expiryMs = credit.expiresAt?.toMillis?.() || 0;
        if (credit.status === "expired" || (expiryMs && expiryMs <= Date.now())) return;
        const amount = Math.max(0, Number(allocation.points || 0));
        refundable += amount;
        transaction.set(creditRefs[index], {
          status: "credited",
          remainingPoints: Math.max(0, Number(credit.remainingPoints || 0)) + amount,
          lastRefundedAt: FieldValue.serverTimestamp(),
          lastRefundSource: `order_${orderId}`
        }, { merge: true });
      });
      const user = userSnap.data() || {};
      transaction.set(userRef, {
        walletPoints: Number(user.walletPoints || 0) + refundable,
        pendingPoints: Math.max(0, Number(user.pendingPoints || 0) - (ledger.status === "reserved" ? pointsUsed : 0)),
        lifetimePointsUsed: Math.max(0, Number(user.lifetimePointsUsed || 0) - (ledger.status === "debited" ? refundable : 0)),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(ledgerSnap.ref, {
        status: "refunded",
        refundStatus: "refunded",
        refundedPoints: refundable,
        refundedAt: FieldValue.serverTimestamp(),
        refundReason: "restaurant_or_admin_cancelled_order"
      }, { merge: true });
      transaction.set(event.data.after.ref, {
        pizzaPointsRefundEligible: true,
        pizzaPointsRefunded: refundable,
        pizzaPointsSettlementStatus: "refunded",
        pizzaPointsSettledAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });
  }
);

exports.creditFeedbackPizzaPoints = onDocumentCreated(
  { document: "feedback/{feedbackId}", region: "asia-south1" },
  async event => {
    const feedbackSnap = event.data;
    if (!feedbackSnap) return;
    const feedback = feedbackSnap.data() || {};
    if (feedback.feedbackType !== "order_feedback" || !feedback.orderId || !feedback.userId) return;
    const orderRef = db.collection("orders").doc(String(feedback.orderId));
    const userRef = db.collection("users").doc(String(feedback.userId));
    const ledgerRef = db.collection("walletTransactions").doc(`feedback_reward_${feedback.orderId}_${feedback.userId}`);
    await db.runTransaction(async transaction => {
      const [orderSnap, userSnap, ledgerSnap] = await Promise.all([
        transaction.get(orderRef), transaction.get(userRef), transaction.get(ledgerRef)
      ]);
      if (!orderSnap.exists || !userSnap.exists) return;
      const order = orderSnap.data() || {};
      const user = userSnap.data() || {};
      const delivered = String(order.status || order.orderStatus || "").toLowerCase() === "delivered";
      if (ledgerSnap.exists) {
        transaction.set(feedbackSnap.ref, { rewardStatus: "already_credited", rewardPoints: Math.abs(Number(ledgerSnap.data().points || 0)) }, { merge: true });
        return;
      }
      if (!delivered || order.userId !== feedback.userId) {
        transaction.set(feedbackSnap.ref, { rewardStatus: "ineligible", rewardReason: delivered ? "order_owner_mismatch" : "order_not_delivered" }, { merge: true });
        return;
      }
      const eligibleOrderAmount = Number(order.subtotalAmount || order.subtotal || order.grandTotal || order.totalAmount || 0);
      const points = feedbackRewardPoints(eligibleOrderAmount);
      if (!points) {
        transaction.set(feedbackSnap.ref, {
          rewardStatus: "ineligible", rewardReason: "order_below_100",
          rewardPoints: 0, eligibleOrderAmount
        }, { merge: true });
        return;
      }
      transaction.set(userRef, {
        walletPoints: Number(user.walletPoints || 0) + points,
        lifetimePointsEarned: Number(user.lifetimePointsEarned || 0) + points,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(ledgerRef, {
        userId: feedback.userId, type: "loyalty_bonus", points, amountEquivalent: points,
        source: "delivered_order_feedback", orderId: feedback.orderId,
        orderNumber: order.orderNumber || order.orderId || feedback.orderId,
        orderAmount: eligibleOrderAmount, feedbackId: event.params.feedbackId,
        status: "credited",
        remainingPoints: points,
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + PIZZA_POINT_EXPIRY_MS),
        description: `${points} Pizza Points earned from feedback for Order #${order.orderNumber || order.orderId || feedback.orderId}`,
        createdAt: FieldValue.serverTimestamp()
      });
      transaction.set(feedbackSnap.ref, { rewardStatus: "credited", rewardPoints: points, rewardCreditedAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.set(orderRef, { feedbackRewardCredited: true, feedbackRewardPoints: points, feedbackRewardAt: FieldValue.serverTimestamp() }, { merge: true });
    });
  }
);

exports.attachReferralToUser = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const result = await growth.attachReferral({
        db, FieldValue, uid: user.uid, code: req.body?.code, authPhone: user.phone_number || ""
      });
      sendJson(res, 200, result);
    } catch (error) {
      logger.warn("Attach referral failed", { error: error.message });
      sendJson(res, error.status || 500, { error: error.message });
    }
  }
);

exports.ensureGrowthProfile = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const profile = await growth.initializeUser({
        db,
        FieldValue,
        uid: user.uid,
        authPhone: user.phone_number || "",
        profile: {}
      });
      sendJson(res, 200, {
        ok: true,
        referralCode: profile.referralCode || "",
        walletPoints: Number(profile.walletPoints || 0)
      });
    } catch (error) {
      logger.warn("Ensure growth profile failed", { error: error.message });
      sendJson(res, error.status || 500, { error: error.message });
    }
  }
);

exports.validateReferralCode = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const code = growth.cleanCode(req.body?.code);
      const [users, ambassadors] = await Promise.all([
        db.collection("users").where("referralCode", "==", code).limit(1).get(),
        db.collection("ambassadors").where("ambassadorCode", "==", code).where("status", "==", "approved").limit(1).get()
      ]);
      if (users.empty && ambassadors.empty) return sendJson(res, 404, { valid: false, error: "Code not found" });
      sendJson(res, 200, { valid: true, path: users.empty ? "ambassador" : "normal", code });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message });
    }
  }
);

exports.createAmbassadorApplication = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const body = req.body || {};
      const ref = db.collection("ambassadorApplications").doc(user.uid);
      await ref.set({
        userId: user.uid,
        fullName: String(body.fullName || "").trim().slice(0, 100),
        mobile: user.phone_number || "",
        college: String(body.college || "").trim().slice(0, 160),
        hostelPg: String(body.hostelPg || "").trim().slice(0, 160),
        area: String(body.area || "").trim().slice(0, 160),
        instagram: String(body.instagram || "").trim().slice(0, 180),
        whatsappNumber: String(body.whatsappNumber || user.phone_number || "").trim().slice(0, 20),
        motivation: String(body.motivation || "").trim().slice(0, 1200),
        expectedReach: Math.max(0, Number(body.expectedReach || 0)),
        status: "pending",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      sendJson(res, 200, { ok: true, applicationId: ref.id });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message });
    }
  }
);

exports.requestAmbassadorWithdrawal = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const amount = normalizeAmount(req.body?.amount);
      const upiId = String(req.body?.upiId || "").trim();
      if (!/^[\w.\-]{2,}@[A-Za-z]{2,}$/.test(upiId)) throw Object.assign(new Error("Enter a valid UPI ID"), { status: 400 });
      const ambassadorQuery = await db.collection("ambassadors").where("userId", "==", user.uid).where("status", "==", "approved").limit(1).get();
      if (ambassadorQuery.empty) throw Object.assign(new Error("Approved ambassador account required"), { status: 403 });
      const ambassadorRef = ambassadorQuery.docs[0].ref;
      const withdrawalRef = db.collection("ambassadorWithdrawals").doc();
      await db.runTransaction(async transaction => {
        const snap = await transaction.get(ambassadorRef);
        const ambassador = snap.data() || {};
        const config = await growth.settings(db);
        if (amount < Number(config.ambassadorMinimumWithdrawal || 100)) throw Object.assign(new Error("Amount is below minimum withdrawal"), { status: 400 });
        if (amount > Number(ambassador.withdrawableBalance || 0)) throw Object.assign(new Error("Insufficient withdrawable balance"), { status: 409 });
        transaction.set(ambassadorRef, {
          withdrawableBalance: roundMoney(Number(ambassador.withdrawableBalance || 0) - amount),
          pendingWithdrawal: roundMoney(Number(ambassador.pendingWithdrawal || 0) + amount),
          upiId,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(withdrawalRef, {
          ambassadorId: ambassadorRef.id, userId: user.uid, amount, upiId,
          status: "pending", requestedAt: FieldValue.serverTimestamp()
        });
      });
      sendJson(res, 200, { ok: true, withdrawalId: withdrawalRef.id });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message });
    }
  }
);

exports.adminAdjustPizzaPoints = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const adminUser = await requireAdmin(req);
      const userId = String(req.body?.userId || "").trim();
      const points = Math.trunc(Number(req.body?.points || 0));
      if (!userId || !points || Math.abs(points) > 100000) throw Object.assign(new Error("Valid user and point amount required"), { status: 400 });
      const userRef = db.collection("users").doc(userId);
      const txRef = db.collection("walletTransactions").doc();
      await db.runTransaction(async transaction => {
        const snap = await transaction.get(userRef);
        if (!snap.exists) throw Object.assign(new Error("User not found"), { status: 404 });
        const user = snap.data();
        const next = Number(user.walletPoints || 0) + points;
        if (next < 0) throw Object.assign(new Error("Debit exceeds available points"), { status: 409 });
        transaction.set(userRef, {
          walletPoints: next,
          lifetimePointsEarned: Number(user.lifetimePointsEarned || 0) + Math.max(0, points),
          lifetimePointsUsed: Number(user.lifetimePointsUsed || 0) + Math.max(0, -points),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(txRef, {
          userId, type: points > 0 ? "admin_credit" : "admin_debit",
          points, amountEquivalent: points, source: "admin",
          status: points > 0 ? "credited" : "debited",
          ...(points > 0 ? {
            remainingPoints: points,
            expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + PIZZA_POINT_EXPIRY_MS)
          } : {}),
          description: String(req.body?.description || "Admin adjustment").slice(0, 240),
          adminUid: adminUser.uid, createdAt: FieldValue.serverTimestamp()
        });
      });
      sendJson(res, 200, { ok: true, transactionId: txRef.id });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message });
    }
  }
);

exports.applyWalletToOrder = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const authUser = await requireAuth(req);
      const orderId = String(req.body?.orderId || "");
      const requestedPoints = Math.max(0, Math.floor(Number(req.body?.requestedPoints || 0)));
      if (!orderId || !requestedPoints) throw Object.assign(new Error("Order and points are required"), { status: 400 });
      const orderRef = db.collection("orders").doc(orderId);
      const userRef = db.collection("users").doc(authUser.uid);
      const ledgerRef = db.collection("walletTransactions").doc(`order_redeem_${orderId}_${authUser.uid}`);
      const result = await db.runTransaction(async transaction => {
        const [orderSnap, userSnap, ledgerSnap] = await Promise.all([
          transaction.get(orderRef), transaction.get(userRef), transaction.get(ledgerRef)
        ]);
        if (!orderSnap.exists || orderSnap.data().userId !== authUser.uid) throw Object.assign(new Error("Order not found"), { status: 404 });
        if (!userSnap.exists) throw Object.assign(new Error("Wallet not found"), { status: 404 });
        if (ledgerSnap.exists) return { pointsUsed: Number(ledgerSnap.data().points || 0), walletBalance: Number(userSnap.data().walletPoints || 0) };
        const order = orderSnap.data();
        if (String(order.paymentMethod || "").toLowerCase() !== "cod" || !["pending", "payment pending"].includes(String(order.status || "").toLowerCase())) {
          throw Object.assign(new Error("Pizza Points can only be applied to a new COD order"), { status: 409 });
        }
        const user = userSnap.data();
        const config = await growth.settings(db);
        const pointsUsed = growth.calculateWalletRedemption({
          orderValue: Number(order.grandTotal || order.totalAmount || 0),
          deliveryFee: Number(order.deliveryCharge || 0),
          requestedPoints,
          availablePoints: Number(user.walletPoints || 0),
          config
        });
        if (!pointsUsed) throw Object.assign(new Error("No Pizza Points can be applied to this order"), { status: 409 });
        const finalTotal = Math.max(0, roundMoney(Number(order.grandTotal || order.totalAmount || 0) - pointsUsed));
        const walletBalance = Number(user.walletPoints || 0) - pointsUsed;
        const allocations = await consumePizzaPointBatches(transaction, authUser.uid, pointsUsed, `order_redeem_${orderId}_${authUser.uid}`);
        transaction.set(userRef, {
          walletPoints: walletBalance,
          lifetimePointsUsed: Number(user.lifetimePointsUsed || 0) + pointsUsed,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(orderRef, {
          walletPointsUsed: pointsUsed,
          walletDiscount: pointsUsed,
          totalAmount: finalTotal,
          grandTotal: finalTotal,
          finalAmount: finalTotal,
          amountDue: finalTotal,
          amountToCollect: finalTotal,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(ledgerRef, {
          userId: authUser.uid, type: "order_redeem", points: -pointsUsed,
          amountEquivalent: pointsUsed, source: "checkout", orderId,
          allocations,
          status: "debited", description: "Pizza Points used on order",
          createdAt: FieldValue.serverTimestamp()
        });
        return { pointsUsed, walletBalance, finalTotal };
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      logger.warn("Wallet redemption failed", { error: error.message });
      sendJson(res, error.status || 500, { error: error.message });
    }
  }
);

exports.adminReviewAmbassador = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const adminUser = await requireAdmin(req);
      const applicationId = String(req.body?.applicationId || "");
      const decision = String(req.body?.decision || "");
      if (!["approved", "rejected", "disabled"].includes(decision)) throw Object.assign(new Error("Invalid decision"), { status: 400 });
      const appRef = db.collection("ambassadorApplications").doc(applicationId);
      const appSnap = await appRef.get();
      if (!appSnap.exists) throw Object.assign(new Error("Application not found"), { status: 404 });
      const application = appSnap.data();
      const ambassadorRef = db.collection("ambassadors").doc(application.userId);
      const code = growth.cleanCode(req.body?.ambassadorCode || `MAGAMB${application.userId.slice(0, 6)}`);
      const batch = db.batch();
      batch.set(appRef, { status: decision, reviewedBy: adminUser.uid, reviewedAt: FieldValue.serverTimestamp(), adminNote: String(req.body?.adminNote || "") }, { merge: true });
      if (decision === "approved") {
        batch.set(ambassadorRef, {
          ...application, userId: application.userId, status: "approved", ambassadorCode: code,
          rewardType: String(req.body?.rewardType || "cash_flat"),
          rewardValue: Number(req.body?.rewardValue || 20),
          deliveredOrders: 0, revenueGenerated: 0, rewardsEarned: 0,
          withdrawableBalance: 0, pendingWithdrawal: 0,
          approvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        batch.set(db.collection("users").doc(application.userId), { ambassadorStatus: "approved", ambassadorCode: code, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      await batch.commit();
      sendJson(res, 200, { ok: true, ambassadorCode: decision === "approved" ? code : "" });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message });
    }
  }
);

exports.adminProcessAmbassadorWithdrawal = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const adminUser = await requireAdmin(req);
      const withdrawalRef = db.collection("ambassadorWithdrawals").doc(String(req.body?.withdrawalId || ""));
      const decision = String(req.body?.decision || "");
      if (!["paid", "rejected"].includes(decision)) throw Object.assign(new Error("Invalid decision"), { status: 400 });
      await db.runTransaction(async transaction => {
        const withdrawalSnap = await transaction.get(withdrawalRef);
        if (!withdrawalSnap.exists || withdrawalSnap.data().status !== "pending") throw Object.assign(new Error("Pending withdrawal not found"), { status: 404 });
        const withdrawal = withdrawalSnap.data();
        const ambassadorRef = db.collection("ambassadors").doc(withdrawal.ambassadorId);
        const ambassadorSnap = await transaction.get(ambassadorRef);
        const ambassador = ambassadorSnap.data() || {};
        const amount = Number(withdrawal.amount || 0);
        const patch = { pendingWithdrawal: Math.max(0, roundMoney(Number(ambassador.pendingWithdrawal || 0) - amount)), updatedAt: FieldValue.serverTimestamp() };
        if (decision === "rejected") patch.withdrawableBalance = roundMoney(Number(ambassador.withdrawableBalance || 0) + amount);
        transaction.set(ambassadorRef, patch, { merge: true });
        transaction.set(withdrawalRef, { status: decision, processedBy: adminUser.uid, processedAt: FieldValue.serverTimestamp(), adminNote: String(req.body?.adminNote || "") }, { merge: true });
      });
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message });
    }
  }
);

exports.requestRiderWithdrawal = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const amount = normalizeAmount(req.body?.amount);
      const upiId = String(req.body?.upiId || "").trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,}@[a-z0-9._-]{2,}$/i.test(upiId)) throw Object.assign(new Error("Enter a valid UPI ID"), { status: 400 });
      const withdrawalRef = db.collection("riderWithdrawals").doc();
      await db.runTransaction(async transaction => {
        const riderRef = db.collection("riders").doc(user.uid);
        const walletRef = db.collection("riderWallet").doc(user.uid);
        const settingsRef = db.collection("settings").doc("riderFinance");
        const pendingQuery = db.collection("riderWithdrawals").where("riderId", "==", user.uid).where("status", "==", "pending").limit(1);
        const [riderSnap, walletSnap, settingsSnap, pendingSnap] = await Promise.all([
          transaction.get(riderRef), transaction.get(walletRef), transaction.get(settingsRef), transaction.get(pendingQuery)
        ]);
        if (!riderSnap.exists) throw Object.assign(new Error("Rider profile not found"), { status: 404 });
        if (!pendingSnap.empty) throw Object.assign(new Error("A withdrawal request is already pending"), { status: 409 });
        const wallet = netWalletState(walletSnap.exists ? walletSnap.data() : riderSnap.data());
        const minimumWithdrawalAmount = Number(settingsSnap.data()?.minimumWithdrawalAmount || 1);
        if (amount < minimumWithdrawalAmount) throw Object.assign(new Error(`Minimum withdrawal is ₹${minimumWithdrawalAmount}`), { status: 400 });
        const pending = Number(walletSnap.data()?.pendingWithdrawal || 0);
        const available = Math.max(0, roundMoney(wallet.withdrawableBalance - pending));
        if (amount > available) throw Object.assign(new Error("Amount exceeds withdrawable balance"), { status: 409 });
        transaction.set(riderRef, { upiId, upiVerifiedStatus: "pending", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        const pendingWithdrawalAmount = roundMoney(pending + amount);
        transaction.set(walletRef, { pendingWithdrawal: pendingWithdrawalAmount, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        transaction.set(db.collection("riderWallets").doc(user.uid), { pendingWithdrawalAmount, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        transaction.set(withdrawalRef, {
          withdrawalId: withdrawalRef.id, riderId: user.uid, riderName: riderSnap.data().name || "Rider",
          mobile: riderSnap.data().phone || riderSnap.data().mobileNumber || "", upiId,
          amount, requestedAmount: amount, withdrawableAtRequest: available,
          companyDueAtRequest: Number(wallet.companySettlementDue || 0),
          status: "pending", requestedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp()
        });
        transaction.set(db.collection("riderLedger").doc(`withdrawal_requested_${withdrawalRef.id}`), {
          ledgerId: `withdrawal_requested_${withdrawalRef.id}`, riderId: user.uid,
          withdrawalId: withdrawalRef.id, type: "WITHDRAWAL_REQUESTED", amount,
          direction: "info", status: "pending", description: `Withdrawal requested to ${upiId}`,
          createdAt: FieldValue.serverTimestamp()
        });
      });
      sendJson(res, 200, { ok: true, withdrawalId: withdrawalRef.id });
    } catch (error) { sendJson(res, error.status || 500, { error: error.message }); }
  }
);

exports.createRiderWalletSettlement = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const walletSnap = await db.collection("riderWallet").doc(rider.riderId).get();
      const wallet = netWalletState(walletSnap.exists ? walletSnap.data() : rider);
      const amount = roundMoney(wallet.companySettlementDue);
      if (amount <= 0) throw Object.assign(new Error("No company due remaining"), { status: 409 });
      const sessionRef = db.collection("riderPaymentSessions").doc();
      const razorpayOrder = await getRazorpay().orders.create({
        amount: Math.round(amount * 100), currency: "INR", receipt: sessionRef.id.slice(0, 40),
        notes: { riderId: rider.riderId, type: "wallet_company_settlement" }
      });
      await sessionRef.set({
        riderId: rider.riderId, type: "wallet_company_settlement", amount,
        amountPaise: Math.round(amount * 100), razorpayOrderId: razorpayOrder.id,
        status: "created", createdAt: FieldValue.serverTimestamp()
      });
      await db.collection("riderSettlements").doc(sessionRef.id).set({
        settlementId: sessionRef.id, riderId: rider.riderId, amount,
        razorpayOrderId: razorpayOrder.id, status: "payment_pending",
        type: "wallet_company_settlement", createdAt: FieldValue.serverTimestamp()
      });
      sendJson(res, 200, { ok: true, paymentSessionId: sessionRef.id, razorpayOrderId: razorpayOrder.id, amount, keyId: env("RAZORPAY_KEY_ID") });
    } catch (error) { sendJson(res, error.status || 500, { error: error.message }); }
  }
);

exports.verifyRiderWalletSettlement = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const user = await requireAuth(req);
      const rider = await riderProfileForUser(user.uid);
      const { paymentSessionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      if (!verifyCheckoutSignature({ razorpayOrderId: razorpay_order_id, razorpayPaymentId: razorpay_payment_id, razorpaySignature: razorpay_signature })) {
        throw Object.assign(new Error("Invalid Razorpay signature"), { status: 401 });
      }
      const sessionRef = db.collection("riderPaymentSessions").doc(String(paymentSessionId || ""));
      const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
      if (payment.status === "authorized") await getRazorpay().payments.capture(razorpay_payment_id, Number(payment.amount), "INR");
      await db.runTransaction(async transaction => {
        const sessionSnap = await transaction.get(sessionRef);
        if (!sessionSnap.exists) throw Object.assign(new Error("Settlement session not found"), { status: 404 });
        const session = sessionSnap.data();
        if (session.status === "verified") return;
        if (session.riderId !== rider.riderId || session.type !== "wallet_company_settlement" || session.razorpayOrderId !== razorpay_order_id) throw Object.assign(new Error("Settlement session mismatch"), { status: 403 });
        if (payment.order_id !== razorpay_order_id || Number(payment.amount) !== Number(session.amountPaise) || !["captured","authorized"].includes(payment.status)) throw Object.assign(new Error("Payment is not verified"), { status: 402 });
        const walletRef = db.collection("riderWallet").doc(rider.riderId);
        const walletSnap = await transaction.get(walletRef);
        const before = netWalletState(walletSnap.exists ? walletSnap.data() : {});
        const paid = Math.min(Number(session.amount || 0), before.companySettlementDue);
        const after = mergeWalletState(before, { companySettlementDue: -paid, totalCompanySettlements: paid });
        writeWalletAudit(transaction, { riderId:rider.riderId, type:"wallet_company_settlement_success", before, after, deltas:{companySettlementDue:-paid,totalCompanySettlements:paid}, metadata:{paymentSessionId,razorpayPaymentId:razorpay_payment_id} });
        transaction.set(db.collection("riders").doc(rider.riderId), {
          companyDue: after.companySettlementDue, pendingCashSubmission: after.companySettlementDue,
          lastCodSettlementAt: FieldValue.serverTimestamp()
        }, { merge:true });
        transaction.set(db.collection("riderLedger").doc(`settlement_success_${paymentSessionId}`), {
          ledgerId:`settlement_success_${paymentSessionId}`, riderId:rider.riderId,
          settlementId:paymentSessionId, type:"COMPANY_SETTLEMENT_SUCCESS", amount:paid,
          direction:"debit", status:"success", description:"Company settlement paid through Razorpay",
          metadata:{razorpayPaymentId:razorpay_payment_id,razorpayOrderId:razorpay_order_id}, createdAt:FieldValue.serverTimestamp()
        }, { merge:true });
        transaction.set(db.collection("riderSettlements").doc(String(paymentSessionId)), {
          status:"complete", amount:paid, razorpayPaymentId:razorpay_payment_id,
          paidAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp()
        }, { merge:true });
        transaction.set(sessionRef, { status:"verified", razorpayPaymentId:razorpay_payment_id, verifiedAt:FieldValue.serverTimestamp() }, { merge:true });
      });
      sendJson(res, 200, { ok:true });
    } catch (error) { sendJson(res, error.status || 500, { error:error.message }); }
  }
);

exports.adminProcessRiderWithdrawal = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    try {
      const adminUser = await requireAdmin(req);
      const withdrawalId = String(req.body?.withdrawalId || "");
      const decision = String(req.body?.decision || "").toLowerCase();
      if (!["approved", "rejected"].includes(decision)) throw Object.assign(new Error("Invalid decision"), { status: 400 });
      await db.runTransaction(async transaction => {
        const ref = db.collection("riderWithdrawals").doc(withdrawalId);
        const snap = await transaction.get(ref);
        if (!snap.exists || snap.data().status !== "pending") throw Object.assign(new Error("Pending request not found"), { status: 404 });
        const item = snap.data();
        const walletRef = db.collection("riderWallet").doc(item.riderId);
        const walletSnap = await transaction.get(walletRef);
        const before = netWalletState(walletSnap.exists ? walletSnap.data() : {});
        const pendingWithdrawal = Math.max(0, roundMoney(Number(walletSnap.data()?.pendingWithdrawal || 0) - Number(item.amount || 0)));
        const after = decision === "approved" ? mergeWalletState(before, { totalWithdrawn: item.amount }) : before;
        transaction.set(walletRef, { ...after, pendingWithdrawal, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        transaction.set(db.collection("riderWallets").doc(item.riderId), {
          ...after, pendingWithdrawalAmount: pendingWithdrawal, updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(ref, {
          status: decision === "approved" ? "completed" : "rejected",
          transactionId: String(req.body?.transactionId || "").trim(),
          notes: String(req.body?.notes || "").trim(), rejectionReason: String(req.body?.reason || "").trim(),
          processedBy: adminUser.uid, processedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        if (decision === "approved") {
          transaction.set(db.collection("riderLedger").doc(`withdrawal_approved_${withdrawalId}`), {
            ledgerId: `withdrawal_approved_${withdrawalId}`, riderId: item.riderId, withdrawalId, type: "WITHDRAWAL_APPROVED", amount: Number(item.amount || 0),
            direction: "debit", status: "completed", transactionId: String(req.body?.transactionId || "").trim(),
            description: "Withdrawal approved", createdAt: FieldValue.serverTimestamp()
          });
        } else {
          transaction.set(db.collection("riderLedger").doc(`withdrawal_rejected_${withdrawalId}`), {
            ledgerId: `withdrawal_rejected_${withdrawalId}`, riderId: item.riderId, withdrawalId,
            type: "WITHDRAWAL_REJECTED", amount: Number(item.amount || 0), direction: "info",
            status: "rejected", description: String(req.body?.reason || "Withdrawal rejected"),
            createdAt: FieldValue.serverTimestamp()
          });
        }
        transaction.set(db.collection("riderNotifications").doc(), {
          riderId: item.riderId, type: decision === "approved" ? "WITHDRAWAL_APPROVED" : "WITHDRAWAL_REJECTED",
          message: decision === "approved" ? `₹${roundMoney(item.amount)} withdrawal approved and transferred to your UPI.` : `Withdrawal rejected. ${String(req.body?.reason || "")}`,
          read: false, createdAt: FieldValue.serverTimestamp()
        });
      });
      sendJson(res, 200, { ok: true });
    } catch (error) { sendJson(res, error.status || 500, { error: error.message }); }
  }
);
