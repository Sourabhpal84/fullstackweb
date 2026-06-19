"use strict";

const assert = require("node:assert/strict");
const {
  statusRank,
  assertForwardTransition,
  normalizeStatus
} = require("../services/orderStateMachine");
const {
  buildPaymentUpdate,
  assertPaymentOnlyPayload
} = require("../services/paymentService");

function assertBlocked(from, to) {
  assert.throws(
    () => assertForwardTransition({ orderId: "test-order", currentStatus: from, nextStatus: to, actor: "test", source: "unit" }),
    /Backward order status update blocked/
  );
}

function assertAllowed(from, to) {
  assert.doesNotThrow(() => assertForwardTransition({ orderId: "test-order", currentStatus: from, nextStatus: to, actor: "test", source: "unit" }));
  assert.ok(statusRank(to) >= statusRank(from), `${from} -> ${to} should be forward`);
}

function assertPaymentDoesNotCarryDeliveryFields() {
  const update = buildPaymentUpdate({
    paymentId: "pay_123",
    transactionId: "pay_123",
    paymentSessionId: "session_123",
    razorpayOrderId: "order_123",
    amount: 103,
    paidAt: new Date("2026-06-15T00:00:00Z")
  });
  assert.equal(update.paymentStatus, "paid");
  assert.equal(update.paymentMethod, "online");
  assert.equal(update.amountToCollect, 0);
  assert.equal(update.amountDue, 0);
  assert.equal(update.amountPaid, 103);
  assert.equal(update.paymentCompleted, true);
  assert.equal(update.paymentCaptured, true);
  assertPaymentOnlyPayload(update);
  assert.throws(
    () => assertPaymentOnlyPayload({ ...update, status: "Pending" }),
    /non-payment fields/
  );
  assert.throws(
    () => assertPaymentOnlyPayload({ ...update, orderStatus: "Assigned" }),
    /non-payment fields/
  );
}

assert.equal(normalizeStatus("reached_nearby"), "Reached Nearby");
assertBlocked("Reached Nearby", "Pending");
assertBlocked("Reached Nearby", "Rider Accepted");
assertBlocked("Reached Nearby", "Picked Up");
assertBlocked("Delivered", "Picked Up");
assertBlocked("Delivered", "Rider Accepted");

assertAllowed("Reached Nearby", "Reached Nearby");
assertAllowed("Reached Nearby", "Delivered");
assertAllowed("Out For Delivery", "Reached Nearby");
assertAllowed("Delivery Code Pending", "Delivered");

assertPaymentDoesNotCarryDeliveryFields();

const paymentScenarios = [
  ["Reached Nearby", "payment retry"],
  ["Out For Delivery", "payment success"],
  ["Delivery Code Pending", "webhook delay"],
  ["Reached Nearby", "refresh recovery"],
  ["Out For Delivery", "multiple attempts"]
];

for (const [status, label] of paymentScenarios) {
  const beforeRank = statusRank(status);
  const paymentUpdate = buildPaymentUpdate({ paymentId: `pay_${label.replace(/\W+/g, "_")}` });
  assertPaymentOnlyPayload(paymentUpdate);
  assert.equal(statusRank(status), beforeRank, `${label} must not mutate status rank`);
}

console.log("order state machine tests passed");
