const assert = require("assert");
const { normalizeDeliverySettings, calculateDeliveryPricing } = require("../services/deliveryPricing");

const settings = normalizeDeliverySettings({});
const test = (subtotal, distanceKm, expectedFee, expectedFree) => {
  const result = calculateDeliveryPricing({ subtotal, distanceKm, settings });
  assert.strictEqual(result.deliveryFee, expectedFee);
  assert.strictEqual(result.freeDeliveryApplied, expectedFree);
};

test(99, .8, 0, false);
test(149, .8, 0, true);
test(180, 1.5, 30, false);
test(199, 2, 0, true);
test(220, 3, 30, false);
test(249, 3, 0, true);
test(280, 4, 30, false);
test(299, 4, 0, true);
test(320, 5, 30, false);
test(349, 5, 0, true);
test(380, 6, 40, false);
test(399, 6, 0, true);

assert.strictEqual(calculateDeliveryPricing({ subtotal:109, eligibleSubtotal:49, distanceKm:1, settings }).deliveryFee, 0);
assert.strictEqual(calculateDeliveryPricing({ subtotal:148, distanceKm:1, settings }).minimumOrderMet, false);
assert.strictEqual(calculateDeliveryPricing({ subtotal:149, distanceKm:1, settings }).minimumOrderMet, true);
assert.strictEqual(calculateDeliveryPricing({ subtotal:299, distanceKm:6.01, settings }).deliveryServiceable, false);
console.log("delivery pricing tests passed");
