"use strict";

const DELIVERY_RULE_VERSION = "flat-30-base-minimum-v2";

function normalizeDeliverySettings(data = {}) {
  const configuredFlatFee = Math.max(0, Number(data.flatDeliveryFee ?? 30));
  return {
    minimumOrderValue: Math.max(0, Number(data.minimumOrderValue ?? 99)),
    flatDeliveryFee: configuredFlatFee === 24 ? 30 : configuredFlatFee,
    maxDistanceKm: Math.max(0.1, Number(data.maxDeliveryDistanceKm || data.maxDistance || 6)),
    freeDeliveryEnabled: data.freeDeliveryEnabled !== false,
    whatsappNumber: String(data.whatsappNumber || "918303614331").replace(/\D/g, ""),
    zones: [
      { maxKm: 1, threshold: Math.max(0, Number(data.zone1Threshold ?? 99)) },
      { maxKm: 2, threshold: Math.max(0, Number(data.zone2Threshold ?? 149)) },
      { maxKm: 3, threshold: Math.max(0, Number(data.zone3Threshold ?? 199)) },
      { maxKm: 4, threshold: Math.max(0, Number(data.zone4Threshold ?? 249)) },
      { maxKm: 6, threshold: Math.max(0, Number(data.zone5Threshold ?? 299)) }
    ]
  };
}

function calculateDeliveryPricing({ distanceKm, subtotal, eligibleSubtotal, settings }) {
  const distance = Number(distanceKm);
  const orderValue = Math.max(0, Number(subtotal) || 0);
  const eligibleOrderValue = Math.max(0, Number(eligibleSubtotal ?? subtotal) || 0);
  const locationAvailable = Number.isFinite(distance) && distance > 0;
  const serviceable = locationAvailable && distance <= settings.maxDistanceKm;
  const zone = locationAvailable ? settings.zones.find(item => distance <= item.maxKm) : null;
  const threshold = Number(zone?.threshold || 0);
  const minimumMet = eligibleOrderValue >= settings.minimumOrderValue;
  const freeDeliveryApplied = serviceable && minimumMet && settings.freeDeliveryEnabled && eligibleOrderValue >= threshold;
  const deliveryFee = serviceable && minimumMet && !freeDeliveryApplied ? settings.flatDeliveryFee : 0;

  return {
    distanceKm: locationAvailable ? distance : 0,
    deliveryFee,
    deliveryCharge: deliveryFee,
    freeDeliveryApplied,
    freeDeliveryThreshold: threshold,
    eligibleSubtotal: eligibleOrderValue,
    amountNeededForFreeDelivery: threshold ? Math.max(0, threshold - eligibleOrderValue) : 0,
    deliveryServiceable: serviceable,
    minimumOrderValue: settings.minimumOrderValue,
    minimumOrderMet: minimumMet,
    amountNeededForMinimumOrder: Math.max(0, settings.minimumOrderValue - eligibleOrderValue),
    deliveryRuleVersion: DELIVERY_RULE_VERSION
  };
}

module.exports = {
  DELIVERY_RULE_VERSION,
  normalizeDeliverySettings,
  calculateDeliveryPricing
};
