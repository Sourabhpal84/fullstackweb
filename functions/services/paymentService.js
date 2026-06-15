"use strict";

const PAYMENT_ALLOWED_FIELDS = Object.freeze([
  "paymentStatus",
  "paymentId",
  "transactionId",
  "paidAt"
]);

const PAYMENT_FORBIDDEN_FIELDS = Object.freeze([
  "status",
  "orderStatus",
  "lifecycleStatus",
  "deliveryStatus",
  "riderStatus",
  "assignedRider",
  "assignedRiderId",
  "riderId",
  "activeOrder",
  "timeline",
  "deliveryTimeline",
  "deliveryOtpStatus",
  "activeDeliveryCodeId"
]);

function assertPaymentOnlyPayload(payload = {}) {
  const keys = Object.keys(payload || {});
  const forbidden = keys.filter(key => PAYMENT_FORBIDDEN_FIELDS.includes(key));
  const disallowed = keys.filter(key => !PAYMENT_ALLOWED_FIELDS.includes(key));
  if (forbidden.length || disallowed.length) {
    const error = new Error(`Payment update contains non-payment fields: ${[...new Set([...forbidden, ...disallowed])].join(", ")}`);
    error.status = 500;
    error.code = "PAYMENT_UPDATE_SCOPE_VIOLATION";
    error.details = { forbidden, disallowed, keys };
    throw error;
  }
  return true;
}

function buildPaymentUpdate({ paymentId, transactionId, paidAt } = {}) {
  const update = {
    paymentStatus: "paid",
    paymentId: paymentId || transactionId || "",
    transactionId: transactionId || paymentId || "",
    paidAt: paidAt || new Date()
  };
  assertPaymentOnlyPayload(update);
  return update;
}

module.exports = {
  PAYMENT_ALLOWED_FIELDS,
  PAYMENT_FORBIDDEN_FIELDS,
  assertPaymentOnlyPayload,
  buildPaymentUpdate
};
