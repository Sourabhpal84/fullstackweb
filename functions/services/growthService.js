"use strict";

const crypto = require("crypto");

const DEFAULT_SETTINGS = Object.freeze({
  referralEnabled: true,
  walletRedemptionEnabled: true,
  referrerRewardPoints: 10,
  referredUserBonusPoints: 20,
  walletMaxRedemptionPercent: 20,
  walletMinimumOrderValue: 0,
  walletAppliesToDeliveryFee: false,
  birthdayRewardPoints: 0,
  ambassadorMinimumWithdrawal: 100
});

function cleanCode(value = "") {
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
}

function cleanPhone(value = "") {
  return String(value).replace(/\D/g, "").slice(-10);
}

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function status(value = "") {
  return String(value).trim().toLowerCase();
}

function delivered(order = {}) {
  return status(order.status || order.orderStatus) === "delivered";
}

function terminalFailure(order = {}) {
  return ["cancelled", "canceled", "failed", "rejected", "refunded"].includes(status(order.status || order.orderStatus));
}

function referralCodeSeed(profile = {}, uid = "") {
  const name = String(profile.fullName || profile.customerName || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
  const fallback = crypto.createHash("sha256").update(uid).digest("hex").slice(0, 7).toUpperCase();
  return cleanCode(`${name || "MAG"}${fallback.slice(0, name ? 3 : 5)}`);
}

async function uniqueReferralCode(db, profile, uid) {
  const base = referralCodeSeed(profile, uid);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = attempt ? String(10 + attempt) : "";
    const code = cleanCode(`${base}${suffix}`);
    const snap = await db.collection("users").where("referralCode", "==", code).limit(1).get();
    if (snap.empty || snap.docs[0].id === uid) return code;
  }
  return cleanCode(`MAG${crypto.randomBytes(5).toString("hex").toUpperCase()}`);
}

async function settings(db) {
  const snap = await db.collection("settings").doc("growthRewards").get();
  return { ...DEFAULT_SETTINGS, ...(snap.exists ? snap.data() : {}) };
}

function walletPatch(pointsDelta, usedDelta = 0) {
  return {
    walletPoints: pointsDelta,
    lifetimePointsEarned: Math.max(0, pointsDelta),
    lifetimePointsUsed: Math.max(0, usedDelta)
  };
}

async function initializeUser({ db, FieldValue, uid, authPhone = "", profile = {} }) {
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  const current = snap.exists ? snap.data() : {};
  const referralCode = current.referralCode || await uniqueReferralCode(db, { ...profile, ...current }, uid);
  const phone = cleanPhone(authPhone || current.phone || current.customerPhone);
  const patch = {
    uid,
    phone: phone ? `+91${phone}` : (current.phone || ""),
    referralCode,
    walletPoints: Number(current.walletPoints || 0),
    pendingPoints: Number(current.pendingPoints || 0),
    lifetimePointsEarned: Number(current.lifetimePointsEarned || 0),
    lifetimePointsUsed: Number(current.lifetimePointsUsed || 0),
    totalOrders: Number(current.totalOrders || 0),
    successfulReferralCount: Number(current.successfulReferralCount || 0),
    ambassadorStatus: current.ambassadorStatus || "none",
    updatedAt: FieldValue.serverTimestamp()
  };
  if (!snap.exists) patch.createdAt = FieldValue.serverTimestamp();
  await ref.set(patch, { merge: true });
  return { ...current, ...patch };
}

async function attachReferral({ db, FieldValue, uid, code, authPhone = "" }) {
  const normalized = cleanCode(code);
  if (!normalized) throw Object.assign(new Error("Enter a valid referral code"), { status: 400 });
  const userRef = db.collection("users").doc(uid);
  const matches = await db.collection("users").where("referralCode", "==", normalized).limit(1).get();
  const ambassadorMatches = matches.empty
    ? await db.collection("ambassadors").where("ambassadorCode", "==", normalized).where("status", "==", "approved").limit(1).get()
    : null;
  if (matches.empty && (!ambassadorMatches || ambassadorMatches.empty)) {
    throw Object.assign(new Error("Referral or ambassador code not found"), { status: 404 });
  }
  const sourceDoc = !matches.empty ? matches.docs[0] : ambassadorMatches.docs[0];
  const source = sourceDoc.data();
  const path = !matches.empty ? "normal" : "ambassador";
  if (sourceDoc.id === uid || source.userId === uid) throw Object.assign(new Error("You cannot use your own code"), { status: 409 });

  await db.runTransaction(async transaction => {
    const snap = await transaction.get(userRef);
    const current = snap.exists ? snap.data() : {};
    if (current.referredBy || current.ambassadorReferredBy) {
      if ((current.referralCodeApplied || "") === normalized) return;
      throw Object.assign(new Error("A referral is already attached to this account"), { status: 409 });
    }
    const phone = cleanPhone(authPhone || current.phone || current.customerPhone);
    if (phone) {
      const duplicate = await db.collection("users").where("phoneDigits", "==", phone).limit(2).get();
      if (duplicate.docs.some(item => item.id !== uid)) throw Object.assign(new Error("This mobile is already linked to another account"), { status: 409 });
    }
    transaction.set(userRef, {
      referredBy: path === "normal" ? sourceDoc.id : "",
      ambassadorReferredBy: path === "ambassador" ? sourceDoc.id : "",
      referralPath: path,
      referralCodeApplied: normalized,
      phoneDigits: phone,
      referralAttachedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(db.collection("referralEvents").doc(uid), {
      referrerUserId: path === "normal" ? sourceDoc.id : "",
      ambassadorId: path === "ambassador" ? sourceDoc.id : "",
      referredUserId: uid,
      referralCode: normalized,
      path,
      status: "attached",
      rewardCredited: false,
      createdAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  return { ok: true, path, code: normalized };
}

async function creditPoints(transaction, { db, FieldValue, userRef, user, points, type, source, orderId, referralUserId = "", description }) {
  const amount = Math.max(0, Math.floor(Number(points) || 0));
  if (!amount) return;
  transaction.set(userRef, {
    walletPoints: Number(user.walletPoints || 0) + amount,
    lifetimePointsEarned: Number(user.lifetimePointsEarned || 0) + amount,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  transaction.set(db.collection("walletTransactions").doc(`${type}_${orderId}_${userRef.id}`), {
    userId: userRef.id,
    type,
    points: amount,
    amountEquivalent: amount,
    source,
    orderId,
    referralUserId,
    status: "credited",
    description,
    createdAt: FieldValue.serverTimestamp()
  });
}

async function processDeliveredOrder({ db, FieldValue, orderId, before = {}, order = {}, logger = console }) {
  if (!delivered(order) || delivered(before) || terminalFailure(order) || !order.userId) return { skipped: true };
  const eventRef = db.collection("growthOrderEvents").doc(orderId);
  return db.runTransaction(async transaction => {
    const [eventSnap, userSnap, rewardSettings] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(db.collection("users").doc(order.userId)),
      settings(db)
    ]);
    if (eventSnap.exists && eventSnap.data().processed === true) return { duplicate: true };
    if (!userSnap.exists) {
      transaction.set(eventRef, { processed: true, skippedReason: "user_missing", processedAt: FieldValue.serverTimestamp() });
      return { skipped: true };
    }
    const user = userSnap.data();
    const userRef = userSnap.ref;
    const deliveredOrders = await db.collection("orders").where("userId", "==", order.userId).where("status", "==", "Delivered").limit(2).get();
    const firstDelivered = deliveredOrders.size <= 1;
    let rewardPath = "none";
    if (firstDelivered && rewardSettings.referralEnabled !== false && user.referralPath === "normal" && user.referredBy) {
      const referrerRef = db.collection("users").doc(user.referredBy);
      const referrerSnap = await transaction.get(referrerRef);
      if (referrerSnap.exists && referrerRef.id !== userRef.id) {
        await creditPoints(transaction, {
          db, FieldValue, userRef: referrerRef, user: referrerSnap.data(),
          points: rewardSettings.referrerRewardPoints, type: "referral_bonus", source: "first_delivered_order",
          orderId, referralUserId: userRef.id, description: "Friend's first delivered order"
        });
        await creditPoints(transaction, {
          db, FieldValue, userRef, user,
          points: rewardSettings.referredUserBonusPoints, type: "welcome_bonus", source: "first_delivered_order",
          orderId, referralUserId: referrerRef.id, description: "Referral welcome reward"
        });
        transaction.set(referrerRef, {
          successfulReferralCount: Number(referrerSnap.data().successfulReferralCount || 0) + 1
        }, { merge: true });
        transaction.set(db.collection("referralEvents").doc(userRef.id), {
          status: "credited", orderId, rewardCredited: true,
          referrerPoints: Number(rewardSettings.referrerRewardPoints || 0),
          referredPoints: Number(rewardSettings.referredUserBonusPoints || 0),
          deliveredAt: order.deliveredAt || FieldValue.serverTimestamp(),
          creditedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        rewardPath = "normal";
      }
    } else if (user.referralPath === "ambassador" && user.ambassadorReferredBy) {
      const ambassadorRef = db.collection("ambassadors").doc(user.ambassadorReferredBy);
      const ambassadorSnap = await transaction.get(ambassadorRef);
      if (ambassadorSnap.exists && ambassadorSnap.data().status === "approved") {
        const ambassador = ambassadorSnap.data();
        const subtotal = money(order.subtotal || order.cartSubtotal || order.totalAmount || 0);
        const kind = ambassador.rewardType || "cash_flat";
        const value = Number(ambassador.rewardValue || 20);
        const earned = kind === "percentage" ? money(subtotal * value / 100) : money(value);
        transaction.set(ambassadorRef, {
          deliveredOrders: Number(ambassador.deliveredOrders || 0) + 1,
          revenueGenerated: money(Number(ambassador.revenueGenerated || 0) + subtotal),
          rewardsEarned: money(Number(ambassador.rewardsEarned || 0) + earned),
          withdrawableBalance: money(Number(ambassador.withdrawableBalance || 0) + earned),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(db.collection("ambassadorTransactions").doc(`order_${orderId}`), {
          ambassadorId: ambassadorRef.id, userId: ambassador.userId || "",
          referredUserId: userRef.id, orderId, type: kind, amount: earned,
          status: "credited", createdAt: FieldValue.serverTimestamp()
        });
        rewardPath = "ambassador";
      }
    }
    transaction.set(userRef, {
      totalOrders: Number(user.totalOrders || 0) + 1,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(eventRef, {
      orderId, userId: order.userId, processed: true, firstDelivered, rewardPath,
      processedAt: FieldValue.serverTimestamp()
    });
    logger.info("Growth reward order processed", { orderId, userId: order.userId, firstDelivered, rewardPath });
    return { processed: true, firstDelivered, rewardPath };
  });
}

function calculateWalletRedemption({ orderValue, deliveryFee = 0, requestedPoints, availablePoints, config = DEFAULT_SETTINGS }) {
  const subtotal = Math.max(0, money(orderValue));
  if (config.walletRedemptionEnabled === false || subtotal < Number(config.walletMinimumOrderValue || 0)) return 0;
  const eligible = config.walletAppliesToDeliveryFee === true ? subtotal : Math.max(0, subtotal - Number(deliveryFee || 0));
  const cap = Math.floor(eligible * Number(config.walletMaxRedemptionPercent || 20) / 100);
  return Math.max(0, Math.min(Math.floor(Number(requestedPoints) || 0), Math.floor(Number(availablePoints) || 0), cap, Math.floor(subtotal)));
}

module.exports = {
  DEFAULT_SETTINGS,
  attachReferral,
  calculateWalletRedemption,
  cleanCode,
  initializeUser,
  processDeliveredOrder,
  settings
};
