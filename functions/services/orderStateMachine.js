"use strict";

const ORDER_STATES = Object.freeze({
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  ASSIGNED: "Rider Accepted",
  PICKED_UP: "Picked Up",
  OUT_FOR_DELIVERY: "Out For Delivery",
  REACHED_NEARBY: "Reached Nearby",
  OTP_VERIFIED: "Delivery Code Pending",
  DELIVERED: "Delivered"
});

const STATUS_RANKS = Object.freeze({
  "": 0,
  payment_pending: 0,
  "Payment Pending": 0,
  Pending: 1,
  Accepted: 2,
  Preparing: 3,
  Ready: 4,
  ready_for_pickup: 4,
  Assigned: 3,
  "Searching For Rider": 5,
  "Rider Accepted": 5,
  rider_assigned: 5,
  "Picked Up": 6,
  picked_up: 6,
  "Out For Delivery": 7,
  out_for_delivery: 7,
  "Reached Nearby": 8,
  "Collect Payment": 8,
  Nearby: 8,
  "Cash Collected": 9,
  cash_collected: 9,
  "Payment Settled": 10,
  payment_settled: 10,
  "Delivery Code Pending": 11,
  "Payment Completed": 11,
  OTP_VERIFIED: 11,
  Delivered: 12,
  delivered: 12,
  Cancelled: 99,
  Rejected: 99,
  Failed: 99,
  failed: 99
});

function normalizeStatus(status = "") {
  const text = String(status || "");
  const lower = text.toLowerCase();
  const map = {
    payment_pending: "Payment Pending",
    pending: "Pending",
    accepted: "Accepted",
    preparing: "Preparing",
    ready: "Ready",
    ready_for_pickup: "Ready",
    assigned: "Rider Accepted",
    rider_accepted: "Rider Accepted",
    rider_assigned: "Rider Accepted",
    picked_up: "Picked Up",
    out_for_delivery: "Out For Delivery",
    reached_nearby: "Reached Nearby",
    collect_payment: "Reached Nearby",
    nearby: "Reached Nearby",
    cash_collected: "Cash Collected",
    payment_settled: "Payment Settled",
    otp_verified: "Delivery Code Pending",
    delivery_code_pending: "Delivery Code Pending",
    payment_completed: "Payment Completed",
    delivered: "Delivered",
    cancelled: "Cancelled",
    rejected: "Rejected",
    failed: "Failed"
  };
  return map[lower] || text || "Pending";
}

function statusRank(status = "") {
  const normalized = normalizeStatus(status);
  return STATUS_RANKS[normalized] ?? STATUS_RANKS[String(status || "")] ?? 1;
}

function assertForwardTransition({ orderId = "", currentStatus = "", nextStatus = "", actor = "system", source = "" } = {}) {
  const currentRank = statusRank(currentStatus);
  const nextRank = statusRank(nextStatus);
  if (nextRank < currentRank) {
    const error = new Error(`Backward order status update blocked: ${currentStatus} -> ${nextStatus}`);
    error.status = 409;
    error.code = "ORDER_STATUS_ROLLBACK_BLOCKED";
    error.details = { orderId, actor, source, currentStatus, nextStatus, currentRank, nextRank };
    throw error;
  }
  return { currentRank, nextRank };
}

function timelineEntry({ status, actor = "system", source = "" } = {}) {
  return {
    status: normalizeStatus(status),
    actor,
    source,
    at: Date.now()
  };
}

module.exports = {
  ORDER_STATES,
  STATUS_RANKS,
  normalizeStatus,
  statusRank,
  assertForwardTransition,
  timelineEntry
};
