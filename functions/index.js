require("dotenv").config();
const cors = require("cors")({ origin: true });
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
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

function verifyCheckoutSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const secret = env("RAZORPAY_KEY_SECRET");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(String(razorpaySignature || "")), Buffer.from(expected));
}

function verifyPaymentLinkSignature({ paymentLinkId, paymentLinkReferenceId, paymentLinkStatus, razorpayPaymentId, razorpaySignature }) {
  const secret = env("RAZORPAY_KEY_SECRET");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${paymentLinkId}|${paymentLinkReferenceId}|${paymentLinkStatus}|${razorpayPaymentId}`)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(String(razorpaySignature || "")), Buffer.from(expected));
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

  return db.runTransaction(async transaction => {
    const [sessionSnap, existingOrderSnap, counterSnap] = await Promise.all([
      transaction.get(sessionRef),
      transaction.get(orderRef),
      transaction.get(counterRef)
    ]);
    const locked = { id: sessionRef.id, ...(sessionSnap.data() || session) };
    if (existingOrderSnap.exists) {
      transaction.set(sessionRef, {
        status: "order_created",
        orderCreatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { orderId: orderRef.id, orderNumber: existingOrderSnap.data().orderNumber, duplicate: true };
    }
    if (locked.status === "order_created" && locked.createdOrderId) {
      return { orderId: locked.createdOrderId, orderNumber: locked.orderNumber || "", duplicate: true };
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
      paymentStatus: "Paid",
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
      createdAt: FieldValue.serverTimestamp(),
      placedAt: FieldValue.serverTimestamp(),
      lastStatusUpdatedAt: FieldValue.serverTimestamp()
    };

    transaction.set(counterRef, {
      lastOrderNumber: nextOrderNumber,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(orderRef, orderData);
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
}

exports.createPaymentSession = onRequest(
  {
  region: "asia-south1",
  cors: [
    "https://magneetozonline.netlify.app",
    "https://magneetoz.com"
  ]
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
      const draft = body.orderDraft || {};
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
          paymentLinkId: data.razorpayPaymentLinkId || "",
          paymentLinkUrl: data.razorpayPaymentLinkUrl || "",
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
      const verifiedRazorpayOrder = await getRazorpay().orders.fetch(razorpayOrder.id);
      const paymentLink = await getRazorpay().paymentLink.create({
        amount: amountPaise,
        currency: "INR",
        accept_partial: false,
        reference_id: sessionId.slice(0, 40),
        description: `Magneetoz order payment`,
        customer: {
          name: customerName,
          contact: customerPhone || undefined,
          email: customerEmail || undefined
        },
        notify: {
          sms: false,
          email: false
        },
        reminder_enable: false,
        callback_url: `https://magneetoz.com/?paymentSessionId=${encodeURIComponent(sessionId)}`,
        callback_method: "get",
        notes: {
          paymentSessionId: sessionId,
          orderId,
          userId: user.uid,
          source: "customer_payment_link"
        }
      });
      logger.info("ORDER_RESPONSE", {
        paymentSessionId: sessionId,
        razorpayOrderId: razorpayOrder.id,
        amount: verifiedRazorpayOrder.amount,
        currency: verifiedRazorpayOrder.currency,
        status: verifiedRazorpayOrder.status,
        receipt: verifiedRazorpayOrder.receipt,
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
        cart: Array.isArray(body.cart) ? body.cart : [],
        orderDraft: draft,
        razorpayOrderId: razorpayOrder.id,
        razorpayPaymentLinkId: paymentLink.id,
        razorpayPaymentLinkUrl: paymentLink.short_url,
        status: "created",
        lockState: "open",
        attempts: 0,
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
        orderStatus: verifiedRazorpayOrder.status,
        paymentLinkId: paymentLink.id,
        paymentLinkUrl: paymentLink.short_url,
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
  cors: [
    "https://magneetozonline.netlify.app",
    "https://magneetoz.com"
  ]
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

exports.verifyPaymentLinkAndCreateOrder = onRequest(
  {
    region: "asia-south1",
    cors: [
      "https://magneetozonline.netlify.app",
      "https://magneetoz.com"
    ]
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

function verifyRazorpayWebhook(req) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn("RAZORPAY_WEBHOOK_SECRET is not configured; accepting webhook without signature verification.");
    return true;
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
    const doorstepOnlinePaid = onlinePaid && (
      order.paymentCollectedBy === rider.riderId
      || paymentStageText === "payment completed"
      || orderStatusText === "payment completed"
      || amountToCollect === 0
    );
    if (cashOrder && !settlementDone && !exceptionDelivery && !doorstepOnlineDelivery) {
      throw Object.assign(new Error("Cash order requires company settlement or customer delivery code"), { status: 409 });
    }
    if (!cashOrder && !onlinePaid) throw Object.assign(new Error("Online payment is not verified"), { status: 409 });
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
  const orderLat = Number(order.location?.lat);
  const orderLng = Number(order.location?.lng);
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
        destination: { lat: orderLat, lng: orderLng }
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
      riderIds = candidates.map(rider => rider.id);

      await queueRef.set({
        candidateRiderIds: riderIds,
        candidates,
        selectedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      if (orderSnap.exists) {
        await orderRef.set({
          riderRequest: {
            ...(order.riderRequest || {}),
            status: riderIds.length ? "searching" : "waiting_for_online_rider",
            candidateRiderIds: riderIds,
            candidates,
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
