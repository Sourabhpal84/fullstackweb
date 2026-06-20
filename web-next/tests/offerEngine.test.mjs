import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(root);
const outDir = join(appRoot, ".tmp-offer-tests");

function compileSource(sourcePath, outputPath) {
  const source = readFileSync(sourcePath, "utf8")
    .replaceAll("@/lib/offerTypes", "./offerTypes")
    .replaceAll("@/lib/offerUtils", "./offerUtils");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  });
  writeFileSync(outputPath, compiled.outputText);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "offerTypes.js"), "module.exports = {};\n");
compileSource(join(appRoot, "src", "lib", "offerUtils.ts"), join(outDir, "offerUtils.js"));
compileSource(join(appRoot, "src", "lib", "offerEngine.ts"), join(outDir, "offerEngine.js"));

const { calculateOffer } = await import(pathToFileURL(join(outDir, "offerEngine.js")).href);

function pizza(name, price, productType = "pizza") {
  return {
    id: name.toLowerCase().replaceAll(" ", "-"),
    dishId: name.toLowerCase().replaceAll(" ", "-"),
    name,
    image: "",
    price,
    qty: 1,
    productType
  };
}

test.after(() => {
  rmSync(outDir, { recursive: true, force: true });
});

test("BOGO: 50 + 60 = 60", () => {
  const result = calculateOffer([pizza("Onion Pizza", 50), pizza("Tomato Pizza", 60)], { type: "buy_1_get_1", active: true });
  assert.equal(result.finalTotal, 60);
  assert.equal(result.discount, 50);
  assert.deepEqual(result.freeItems.map((item) => item.name), ["Onion Pizza"]);
});

test("BOGO: 50 + 60 + 70 + 80 = 140", () => {
  const result = calculateOffer([pizza("A", 50), pizza("B", 60), pizza("C", 70), pizza("D", 80)], { type: "buy_1_get_1", active: true });
  assert.equal(result.finalTotal, 140);
  assert.equal(result.discount, 120);
});

test("Buy 2 Get 1: 100 + 90 + 80 = 190", () => {
  const result = calculateOffer([pizza("A", 100), pizza("B", 90), pizza("C", 80)], { type: "buy_2_get_1", active: true });
  assert.equal(result.finalTotal, 190);
  assert.equal(result.discount, 80);
});

test("Buy 2 Get 1: 200 + 180 + 150 + 120 + 100 + 90 = 600", () => {
  const result = calculateOffer([pizza("A", 200), pizza("B", 180), pizza("C", 150), pizza("D", 120), pizza("E", 100), pizza("F", 90)], { type: "buy_2_get_1", active: true });
  assert.equal(result.finalTotal, 600);
  assert.equal(result.discount, 240);
});

test("Mixed categories work when productType is pizza", () => {
  const result = calculateOffer([
    pizza("Premium Pizza", 220),
    pizza("Regular Pizza", 140),
    pizza("Double Topping Pizza", 180),
    pizza("Burger", 120, "burger")
  ], { type: "buy_2_get_1", active: true });
  assert.equal(result.finalTotal, 520);
  assert.equal(result.discount, 140);
  assert.deepEqual(result.freeItems.map((item) => item.name), ["Regular Pizza"]);
});

test("No active offer keeps totals unchanged", () => {
  const result = calculateOffer([pizza("A", 100), pizza("B", 90)], null);
  assert.equal(result.finalTotal, 190);
  assert.equal(result.discount, 0);
  assert.equal(result.offerApplied, false);
});
