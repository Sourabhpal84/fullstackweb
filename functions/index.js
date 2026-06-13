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
  return stripUndefined({
    id: compactText(item.id, 120),
    name: compactText(item.name, 160),
    size: compactText(item.size, 80),
    variant: compactText(item.variant, 80),
    category: compactText(item.category, 120),
    price: Number(item.price || 0),
    qty: Number(item.qty || item.quantity || 1),
    quantity: Number(item.quantity || item.qty || 1),
    image: compactImageUrl(item.image || item.imageUrl || item.thumbnail || "")
  });
}

function compactCart(items) {
  return Array.isArray(items) ? items.slice(0, 80).map(compactCartItem) : [];
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
    totalAmount: Number(draft.totalAmount || draft.grandTotal || draft.finalAmount || 0),
    deliveryDistance: Number(draft.deliveryDistance || 0),
    actualRoadDistance: Number(draft.actualRoadDistance || 0),
    deliveryDistanceText: compactText(draft.deliveryDistanceText, 80),
    estimatedTravelTime: compactText(draft.estimatedTravelTime, 80),
    distanceSource: compactText(draft.distanceSource, 80),
    deliveryCharge: Number(draft.deliveryCharge || 0),
    originalDeliveryCharge: Number(draft.originalDeliveryCharge || 0),
    couponId: compactText(draft.couponId, 120),
    couponCode: compactText(draft.couponCode, 80),
    couponPgName: compactText(draft.couponPgName, 160),
    couponPgCode: compactText(draft.couponPgCode, 80),
    couponDiscount: Number(draft.couponDiscount || 0),
    freeDeliveryDiscount: Number(draft.freeDeliveryDiscount || 0),
    freeDelivery: Boolean(draft.freeDelivery),
    gstPercent: Number(draft.gstPercent || 0),
    gstAmount: Number(draft.gstAmount || 0),
    handlingCharge: Number(draft.handlingCharge || 0),
    subtotal: Number(draft.subtotal || draft.subtotalAmount || 0),
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

  const result = await db.runTransaction(async transaction => {
    const [sessionSnap, existingOrderSnap, counterSnap] = await Promise.all([
      transaction.get(sessionRef),
      transaction.get(orderRef),
      transaction.get(counterRef)
    ]);
    const locked = { id: sessionRef.id, ...(sessionSnap.data() || session) };
    if (locked.status === "order_created" && locked.createdOrderId) {
      return { orderId: locked.createdOrderId, orderNumber: locked.orderNumber || "", duplicate: true };
    }
    const existingOrder = existingOrderSnap.exists ? existingOrderSnap.data() || {} : {};
    if (
      existingOrderSnap.exists &&
      (String(existingOrder.paymentStatus || "").toLowerCase() === "paid" || existingOrder.paymentCaptured === true) &&
      existingOrder.orderNumber
    ) {
      transaction.set(sessionRef, {
        status: "order_created",
        createdOrderId: orderRef.id,
        orderNumber: existingOrder.orderNumber,
        orderCreatedAt: existingOrder.placedAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { orderId: orderRef.id, orderNumber: existingOrder.orderNumber, duplicate: true };
    }

    const nextOrderNumber = Number(counterSnap.exists ? counterSnap.data().lastOrderNumber || 0 : 0) + 1;
    const draft = stripUndefined(locked.orderDraft || {});
    const amount = Number(locked.amount || 0);
    const paymentId = payment.id;
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
      const amount = normalizeAmount(body.amount);
      if (amount < 10) throw Object.assign(new Error("Online payment is available for orders of ₹10 or more."), { status: 400 });
      const amountPaise = Math.round(amount * 100);
      const idempotencyKey = String(body.idempotencyKey || "").slice(0, 160);
      if (!idempotencyKey) throw Object.assign(new Error("Missing idempotency key"), { status: 400 });
      const razorpayKeyId = env("RAZORPAY_KEY_ID");
      if (!razorpayKeyId) throw Object.assign(new Error("Razorpay key is not configured"), { status: 500 });
      const incomingCart = compactCart(body.cart);
      const draft = compactOrderDraft(body.orderDraft || {}, incomingCart);
      const customerName = String(draft.customerName || body.customerName || "Magneetoz Customer").slice(0, 120);
      const customerPhone = String(draft.phone || body.phone || "").replace(/\D/g, "").slice(-10);
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
        amountToCollect: amount,
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
      const order = orderSnap?.exists ? orderSnap.data() || {} : {};
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
    transaction.update(orderRef, {
      status: order.status === "Payment Pending" ? "Pending" : (order.status || "Pending"),
      orderStatus: order.orderStatus === "Payment Pending" ? "Pending" : (order.orderStatus || "Pending"),
      paymentStatus: "paid",
      paymentMethod: "online",
      amountToCollect: 0,
      paymentCaptured: true,
      paymentId,
      razorpayPaymentId: paymentId,
      transactionId: paymentId,
      companyReceivedAmount: Number(amount || order.totalAmount || order.finalAmount || 0),
      paymentCollectedAt: admin.firestore.FieldValue.serverTimestamp(),
      checkoutSource: source || order.checkoutSource || "razorpay_webhook",
      paymentStage: "Payment Completed",
      lastStatusUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
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

function riderBaseEarning(order = {}, settings = {}) {
  const distance = Math.max(1, Math.ceil(Number(order.actualRoadDistance || order.deliveryDistance || order.distance || 1)));
  const base = Number(settings.BASE_FARE || settings.baseFare || 25);
  const paidPerKm = Number(settings.PAID_PER_KM || settings.paidPerKm || 5);
  return Math.max(0, base + Math.max(0, distance - 3) * paidPerKm);
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
    "Searching For Rider": "rider_searching",
    "Rider Accepted": "rider_assigned",
    "Picked Up": "picked_up",
    "Out For Delivery": "out_for_delivery",
    "Reached Nearby": "arrived_customer",
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
    .filter(rider => rider.online || rider.isOnline)
    .filter(rider => !rider.currentActiveOrderId && rider.isAvailable !== false)
    .filter(rider => !excluded.has(rider.id))
    .map(rider => ({
      ...rider,
      distanceKm: distanceKmBetween(restaurantLocation, rider.location || rider.currentLocation)
    }))
    .filter(rider => Number.isFinite(rider.distanceKm) && rider.distanceKm < Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const radius = [2, 5, 10].find(limit => candidates.some(rider => rider.distanceKm <= limit)) || null;
  const rider = radius ? candidates.find(item => item.distanceKm <= radius) : null;
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
  transaction.update(orderRef, {
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
  });
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
  const penalty = Math.max(0, Number(pricing.exceptionSettlementPenalty || 3));

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
    if (cashOrder && !settlementDone && !exceptionDelivery && !doorstepOnlineDelivery) {
      throw Object.assign(new Error("Cash order requires company settlement or customer delivery code"), { status: 409 });
    }
    if (!cashOrder && !onlinePaid && !doorstepOnlineDelivery) throw Object.assign(new Error("Online payment is not verified"), { status: 409 });
    if (!cashOrder && onlinePaid && !prepaidOtpDelivery && !doorstepOnlineDelivery && !doorstepOnlinePaid) {
      throw Object.assign(new Error("Customer delivery OTP is required for prepaid order"), { status: 409 });
    }

    const baseEarning = riderBaseEarning(order, pricing);
    const riderEarning = Math.max(0, exceptionDelivery ? baseEarning - penalty : baseEarning);
    const total = Number(order.totalAmount || order.finalAmount || 0);
    const treatedAsCashSettlement = cashOrder && !doorstepOnlineDelivery;
    const companyDue = treatedAsCashSettlement && exceptionDelivery ? Math.max(0, total - riderEarning) : 0;
    const update = {
      status: "Delivered",
      orderStatus: "Delivered",
      deliveredAt: FieldValue.serverTimestamp(),
      deliveredBy: rider.riderId,
      deliveryCompletionMode: mode,
      earning: riderEarning,
      normalEarning: baseEarning,
      exceptionSettlementPenalty: exceptionDelivery ? penalty : 0,
      companyDue,
      cashSettlementPending: treatedAsCashSettlement ? exceptionDelivery : false,
      settlementState: treatedAsCashSettlement ? (exceptionDelivery ? "SETTLEMENT_PENDING" : "SETTLEMENT_COMPLETED") : "PAID_ONLINE",
      deliveryOtpStatus: codeRef ? "verified" : (order.deliveryOtpStatus || FieldValue.delete()),
      lastStatusUpdatedAt: FieldValue.serverTimestamp()
    };
    if (exceptionDelivery) {
      update.exceptionReason = "Rider delivered with customer authorization code before company settlement";
      update.settlementPendingRiderId = rider.riderId;
      update.deliveryCodeVerifiedAt = FieldValue.serverTimestamp();
      update.deliveryCodeVerifiedBy = rider.riderId;
    }
    transaction.update(orderRef, update);
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
      payoutPenalties: FieldValue.increment(exceptionDelivery ? penalty : 0),
      currentActiveOrderId: FieldValue.delete(),
      lastDeliveryAt: FieldValue.serverTimestamp()
    });
    transaction.set(db.collection("riderWalletTransactions").doc(), {
      riderId: rider.riderId,
      orderId,
      type: exceptionDelivery ? "delivery_earning_exception_settlement" : "delivery_earning",
      amount: riderEarning,
      normalAmount: baseEarning,
      penalty: exceptionDelivery ? penalty : 0,
      companyDue,
      createdAt: FieldValue.serverTimestamp()
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
      penalty: exceptionDelivery ? penalty : 0
    });
    return { orderId, riderEarning, companyDue, penalty: exceptionDelivery ? penalty : 0 };
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
    .filter(rider => rider.online || rider.isOnline)
    .filter(rider => !rider.currentActiveOrderId);

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
    .filter(rider => Number.isFinite(rider.distance) && rider.distance < Number.MAX_SAFE_INTEGER)
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
        if (rider.approved !== true || rider.active === false || rider.blocked === true || !(rider.online || rider.isOnline) || rider.currentActiveOrderId || rider.isAvailable === false) {
          throw Object.assign(new Error("Selected rider is not online and available"), { status: 409 });
        }
        match = { rider, radius: null, restaurantLocation: await restaurantPointForOrder(order) };
      } else {
        match = await findNearestAvailableRider(order, order.riderRequest?.declinedRiderIds || []);
        if (!match.rider) {
          await orderRef.set({
            status: "Searching For Rider",
            orderStatus: "Searching For Rider",
            deliveryStatus: "rider_searching",
            riderStatus: "No rider available within 10 km. Try reassign.",
            failedAssignmentReason: "no_available_rider_within_10km",
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
          return sendJson(res, 409, { ok: false, error: "No online available rider found within 10 km" });
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
      const earning = riderBaseEarning(order, (await db.collection("settings").doc("pricing").get()).data() || {});
      await db.runTransaction(async transaction => {
        const [lockedOrderSnap, lockedRiderSnap] = await Promise.all([
          transaction.get(orderRef),
          transaction.get(riderRef)
        ]);
        if (!lockedOrderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const lockedOrder = lockedOrderSnap.data() || {};
        const lockedRider = lockedRiderSnap.data() || {};
        if (lockedOrder.assignedRiderId || lockedOrder.riderId) throw Object.assign(new Error("A rider is already assigned"), { status: 409 });
        if (lockedRider.currentActiveOrderId || lockedRider.isAvailable === false || !(lockedRider.online || lockedRider.isOnline)) {
          throw Object.assign(new Error("Rider became unavailable. Please retry."), { status: 409 });
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
        transaction.update(orderRef, {
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
        });
        transaction.update(riderRef, {
          currentActiveOrderId: orderId,
          activeOrderId: orderId,
          isAvailable: false,
          activeOrderStartedAt: FieldValue.serverTimestamp()
        });
        addDeliveryEvent(transaction, orderId, "RIDER_ASSIGNED", { riderId: rider.id, autoAccepted: true });
        addOrderAudit(transaction, orderId, "RIDER_ASSIGNED", { riderId: rider.id, autoAccepted: true });
      });
      return sendJson(res, 200, { ok: true, orderId, riderId: rider.id, riderName: rider.name || rider.riderName || "Magneetoz Rider" });
    } catch (error) {
      logger.error("assignRiderToOrder failed", { error: error.message });
      return sendJson(res, error.status || 500, { ok: false, error: error.message || "Rider assignment failed" });
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
      await db.runTransaction(async transaction => {
        const [orderSnap, riderSnap] = await Promise.all([transaction.get(orderRef), transaction.get(riderRef)]);
        if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const order = orderSnap.data() || {};
        const riderData = riderSnap.data() || {};
        if (order.assignedRiderId && order.assignedRiderId !== rider.riderId) throw Object.assign(new Error("Another rider already accepted this order"), { status: 409 });
        if (riderData.currentActiveOrderId && riderData.currentActiveOrderId !== orderId) throw Object.assign(new Error("Complete current delivery first"), { status: 409 });
        const request = order.riderRequest || {};
        if (!(request.candidateRiderIds || []).includes(rider.riderId) && order.assignedRiderId !== rider.riderId) {
          throw Object.assign(new Error("This delivery request is no longer available"), { status: 403 });
        }
        transaction.update(orderRef, {
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
        });
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
        transaction.update(orderRef, {
          status: nextStatus,
          orderStatus: nextStatus,
          deliveryStatus: deliveryStatusFor(nextStatus),
          riderStatus: nextStatus === "Out For Delivery" ? "Rider is moving toward you" : nextStatus === "Reached Nearby" ? "Rider is nearby" : "Delivery updated",
          ...timestampFields,
          lastStatusUpdatedAt: FieldValue.serverTimestamp()
        });
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
        transaction.update(orderRef, {
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
        });
        addOrderAudit(transaction, orderId, "CASH_COLLECTED", { riderId: rider.riderId, amount: Number(order.totalAmount || order.finalAmount || 0) });
      });
      return sendJson(res, 200, { ok: true });
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
      const pricingSnap = await db.collection("settings").doc("pricing").get();
      const pricing = pricingSnap.exists ? pricingSnap.data() : {};
      const total = Number(order.totalAmount || order.finalAmount || 0);
      const earning = riderBaseEarning(order, pricing);
      const grossCompanyDue = Math.max(0, total - earning);
      const availablePayout = Math.max(0, Number(rider.pendingSettlement || 0));
      const payoutAdjusted = type === "cod_company_settlement" ? Math.min(grossCompanyDue, availablePayout) : 0;
      const amount = type === "cod_company_settlement" ? Math.max(0, grossCompanyDue - payoutAdjusted) : total;
      if (type === "cod_company_settlement" && amount <= 0) {
        await db.runTransaction(async transaction => {
          const lockedOrderSnap = await transaction.get(db.collection("orders").doc(orderId));
          const riderRef = db.collection("riders").doc(rider.riderId);
          if (!lockedOrderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
          const lockedOrder = lockedOrderSnap.data();
          assertAssignedRider(lockedOrder, rider.riderId);
          transaction.update(db.collection("orders").doc(orderId), {
            status: "Payment Settled",
            orderStatus: "Payment Settled",
            codSettlementStatus: "paid_to_company_by_payout_adjustment",
            settlementState: "SETTLEMENT_COMPLETED",
            cashSettlementPending: false,
            companyRazorpaySettlementAmount: 0,
            companySettlementGrossDue: grossCompanyDue,
            companySettlementPayoutAdjusted: payoutAdjusted,
            companySettlementNetPaid: 0,
            companyRazorpayPaidBy: rider.riderId,
            companyRazorpayPaidAt: FieldValue.serverTimestamp(),
            lastStatusUpdatedAt: FieldValue.serverTimestamp()
          });
          transaction.update(riderRef, {
            pendingSettlement: FieldValue.increment(-payoutAdjusted),
            settlementAdjustedPayout: FieldValue.increment(payoutAdjusted),
            lastCodSettlementAt: FieldValue.serverTimestamp()
          });
          transaction.set(db.collection("riderWalletTransactions").doc(), {
            riderId: rider.riderId,
            orderId,
            type: "cod_company_settlement_payout_adjustment",
            amount: -payoutAdjusted,
            grossCompanyDue,
            payoutAdjusted,
            netCompanyPaid: 0,
            createdAt: FieldValue.serverTimestamp()
          });
          addOrderAudit(transaction, orderId, "COMPANY_SETTLEMENT_ADJUSTED_FROM_PAYOUT", {
            riderId: rider.riderId,
            grossCompanyDue,
            payoutAdjusted,
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
      await sessionRef.set({
        orderId,
        riderId: rider.riderId,
        type,
        amount,
        riderEarning: earning,
        grossCompanyDue,
        payoutAdjusted,
        netCompanyPaid: amount,
        amountPaise: Math.round(amount * 100),
        razorpayOrderId: razorpayOrder.id,
        status: "created",
        createdAt: FieldValue.serverTimestamp()
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
        const orderSnap = await transaction.get(orderRef);
        if (!orderSnap.exists) throw Object.assign(new Error("Order not found"), { status: 404 });
        const autoDeliverCustomerOnline = session.type !== "cod_company_settlement";
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
          companyRazorpayPaymentId: razorpay_payment_id,
          companyRazorpayPaidAt: FieldValue.serverTimestamp(),
          companyRazorpayPaidBy: rider.riderId
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
        transaction.update(orderRef, { ...update, lastStatusUpdatedAt: FieldValue.serverTimestamp() });
        transaction.update(sessionRef, { status: "verified", razorpayPaymentId: razorpay_payment_id, verifiedAt: FieldValue.serverTimestamp() });
        if (session.type === "cod_company_settlement" && Number(session.payoutAdjusted || 0) > 0) {
          transaction.update(riderRef, {
            pendingSettlement: FieldValue.increment(-Number(session.payoutAdjusted || 0)),
            settlementAdjustedPayout: FieldValue.increment(Number(session.payoutAdjusted || 0)),
            lastCodSettlementAt: FieldValue.serverTimestamp()
          });
        }
        if (autoDeliverCustomerOnline) {
          const riderEarning = Number(session.riderEarning || 0);
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
          estimatedEarning: riderBaseEarning(order, (await db.collection("settings").doc("pricing").get()).data() || {}),
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
