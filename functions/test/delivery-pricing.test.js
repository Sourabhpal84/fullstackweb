const assert = require("assert");
const { normalizeDeliverySettings, calculateDeliveryPricing } = require("../services/deliveryPricing");

const settings = normalizeDeliverySettings({});
const test = (subtotal, distanceKm, expectedFee, expectedFree) => {
  const result = calculateDeliveryPricing({ subtotal, distanceKm, settings });
  assert.strictEqual(result.deliveryFee, expectedFee);
  assert.strictEqual(result.freeDeliveryApplied, expectedFree);
};

test(99, .8, 0, true);
test(120, 1.5, 24, false);
test(149, 2, 0, true);
test(180, 3, 24, false);
test(249, 4, 0, true);
test(280, 5, 24, false);
test(299, 6, 0, true);

assert.strictEqual(calculateDeliveryPricing({ subtotal:98, distanceKm:1, settings }).minimumOrderMet, false);
assert.strictEqual(calculateDeliveryPricing({ subtotal:299, distanceKm:6.01, settings }).deliveryServiceable, false);
console.log("delivery pricing tests passed");
