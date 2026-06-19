import test from "node:test";
import assert from "node:assert/strict";
import { calculateUnitCost, calculateRecipe, marginStatus } from "../../cost-engine-core.mjs";

test("kg purchase converts to per gram", () => {
  assert.deepEqual(calculateUnitCost({ purchaseQty: 1, purchaseUnit: "kg", purchasePrice: 380 }), {
    baseUnit: "gram", unitCost: 0.38
  });
});

test("recipe totals and suggested price are accurate", () => {
  const result = calculateRecipe({
    sellingPrice: 100,
    targetMarginPercent: 60,
    ingredients: [{ ingredientName: "Cheese", qtyUsed: 50, unit: "gram", unitCost: 0.38, baseUnit: "gram", wastagePercent: 10 }],
    packagingCost: 8, cookingCost: 4, labourCost: 5, otherCost: 2
  });
  assert.equal(result.totalIngredientCost, 19);
  assert.equal(result.totalWastageCost, 1.9);
  assert.equal(result.totalCost, 39.9);
  assert.equal(result.profit, 60.1);
  assert.equal(result.profitMarginPercent, 60.1);
  assert.equal(result.suggestedPrice, 99.75);
});

test("invalid cross-dimension unit is rejected", () => {
  assert.throws(() => calculateRecipe({ ingredients: [{ ingredientName: "Oil", qtyUsed: 1, unit: "gram", unitCost: 1, baseUnit: "ml" }] }), /incompatible/);
});

test("margin badges follow thresholds", () => {
  assert.equal(marginStatus(56), "green");
  assert.equal(marginStatus(55), "yellow");
  assert.equal(marginStatus(34.99), "red");
});
