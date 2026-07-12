"use strict";

const DELIVERY_RULE_VERSION = "zone-fee-base-threshold-v3";
const ABSOLUTE_MINIMUM_ORDER_VALUE = 149;

function settingNumber(value, fallback, legacyValue) {
  const parsed = Math.max(0, Number(value ?? fallback));
  return parsed === legacyValue ? fallback : parsed;
}

function normalizeDeliverySettings(data = {}) {
  const configuredFlatFee = settingNumber(data.flatDeliveryFee, 30, 24);
  const configuredMinimum = Math.max(0, Number(data.minimumOrderValue ?? ABSOLUTE_MINIMUM_ORDER_VALUE));
  return {
    minimumOrderValue: Math.max(ABSOLUTE_MINIMUM_ORDER_VALUE, configuredMinimum),
    flatDeliveryFee: configuredFlatFee,
    maxDistanceKm: Math.max(0.1, Number(data.maxDeliveryDistanceKm || data.maxDistance || 6)),
    freeDeliveryEnabled: data.freeDeliveryEnabled !== false,
    whatsappNumber: String(data.whatsappNumber || "918303614331").replace(/\D/g, ""),
    zones: [
      { maxKm: 1, threshold: settingNumber(data.zone1Threshold, 149, 99), fee: settingNumber(data.zone1Fee, 30, 24) },
      { maxKm: 2, threshold: settingNumber(data.zone2Threshold, 199, 149), fee: settingNumber(data.zone2Fee, 30, 24) },
      { maxKm: 3, threshold: settingNumber(data.zone3Threshold, 249, 199), fee: settingNumber(data.zone3Fee, 30, 24) },
      { maxKm: 4, threshold: settingNumber(data.zone4Threshold, 299, 249), fee: settingNumber(data.zone4Fee, 30, 40) },
      { maxKm: 5, threshold: settingNumber(data.zone5Threshold, 349, 299), fee: settingNumber(data.zone5Fee, 30, 50) },
      { maxKm: 6, threshold: settingNumber(data.zone6Threshold, 399, 299), fee: settingNumber(data.zone6Fee, 40, 50) }
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
  const zoneFee = Math.max(0, Number(zone?.fee ?? settings.flatDeliveryFee) || 0);
  const deliveryFee = serviceable && minimumMet && !freeDeliveryApplied ? zoneFee : 0;

  return {
    distanceKm: locationAvailable ? distance : 0,
    deliveryFee,
    deliveryCharge: deliveryFee,
    baseCharge: zoneFee,
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
  ABSOLUTE_MINIMUM_ORDER_VALUE,
  normalizeDeliverySettings,
  calculateDeliveryPricing
};
