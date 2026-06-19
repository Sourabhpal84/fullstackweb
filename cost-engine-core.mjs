const SCALE = 10000;

export const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;
export const roundNumber = value => Math.round((Number(value) || 0) * SCALE) / SCALE;

export function unitDefinition(unit, packetQty = 0) {
  const definitions = {
    kg: { baseUnit: "gram", multiplier: 1000 },
    gram: { baseUnit: "gram", multiplier: 1 },
    liter: { baseUnit: "ml", multiplier: 1000 },
    ml: { baseUnit: "ml", multiplier: 1 },
    piece: { baseUnit: "piece", multiplier: 1 },
    packet: { baseUnit: "piece", multiplier: Number(packetQty) || 0 }
  };
  return definitions[unit] || null;
}

export function calculateUnitCost({ purchaseQty, purchaseUnit, purchasePrice, packetQty }) {
  const definition = unitDefinition(purchaseUnit, packetQty);
  const quantity = Number(purchaseQty);
  const price = Number(purchasePrice);
  if (!definition || quantity <= 0 || price < 0 || definition.multiplier <= 0) return null;
  return {
    baseUnit: definition.baseUnit,
    unitCost: roundNumber(price / (quantity * definition.multiplier))
  };
}

export function convertUsage(qty, unit, ingredient) {
  const definition = unitDefinition(unit, ingredient.packetQty);
  if (!definition || definition.baseUnit !== ingredient.baseUnit) return null;
  return roundNumber((Number(qty) || 0) * definition.multiplier);
}

export function calculateRecipe(input) {
  const ingredients = (input.ingredients || []).map(row => {
    const baseQty = convertUsage(row.qtyUsed, row.unit, row);
    if (baseQty === null) throw new Error(`${row.ingredientName || "Ingredient"} unit is incompatible.`);
    const baseCost = roundMoney(baseQty * (Number(row.unitCost) || 0));
    const wastagePercent = Math.max(0, Number(row.wastagePercent) || 0);
    const wastageCost = roundMoney(baseCost * wastagePercent / 100);
    return { ...row, baseQty, baseCost, wastagePercent, wastageCost, finalCost: roundMoney(baseCost + wastageCost) };
  });
  const totalIngredientCost = roundMoney(ingredients.reduce((sum, row) => sum + row.baseCost, 0));
  const totalWastageCost = roundMoney(ingredients.reduce((sum, row) => sum + row.wastageCost, 0));
  const extras = ["packagingCost", "cookingCost", "labourCost", "otherCost"]
    .reduce((sum, key) => sum + Math.max(0, Number(input[key]) || 0), 0);
  const totalCost = roundMoney(totalIngredientCost + totalWastageCost + extras);
  const sellingPrice = Math.max(0, Number(input.sellingPrice) || 0);
  const profit = roundMoney(sellingPrice - totalCost);
  const profitMarginPercent = sellingPrice ? roundMoney(profit / sellingPrice * 100) : 0;
  const foodCostPercent = sellingPrice ? roundMoney(totalCost / sellingPrice * 100) : 0;
  const targetMarginPercent = Math.min(99.99, Math.max(0, Number(input.targetMarginPercent) || 0));
  const suggestedPrice = targetMarginPercent < 100
    ? roundMoney(totalCost / (1 - targetMarginPercent / 100))
    : 0;
  return { ingredients, totalIngredientCost, totalWastageCost, totalCost, profit, profitMarginPercent, foodCostPercent, targetMarginPercent, suggestedPrice };
}

export function marginStatus(margin) {
  return Number(margin) > 55 ? "green" : Number(margin) >= 35 ? "yellow" : "red";
}
