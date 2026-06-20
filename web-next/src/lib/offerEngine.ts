import type { ActiveOffer, OfferCalculation, OfferCartItem } from "@/lib/offerTypes";
import { categoryAllowed, expandCartItems, isPizzaItem, summarizeFreeItems } from "@/lib/offerUtils";

export const PIZZA_POINTS_BOGO_MESSAGE = "Pizza Points cannot be used with Buy One Get One offers.";

export function resolveActiveOffer(value?: string | null): ActiveOffer | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (["buy_1_get_1", "bogo", "bogo_1_1"].includes(normalized)) return { type: "buy_1_get_1", active: true };
  if (["buy_2_get_1", "b2g1", "bogo_2_1"].includes(normalized)) return { type: "buy_2_get_1", active: true };
  return null;
}

export function calculateOffer(cart: OfferCartItem[], activeOffer: ActiveOffer | null): OfferCalculation {
  const originalTotal = cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 1), 0);
  if (!activeOffer || activeOffer.active === false) {
    return emptyOffer(originalTotal);
  }

  const eligibleItems = expandCartItems(cart)
    .filter((item) => categoryAllowed(item, activeOffer.eligibleCategories) && (isPizzaItem(item) || !!activeOffer.eligibleCategories?.length))
    .sort((a, b) => Number(b.price || 0) - Number(a.price || 0));

  const groupSize = activeOffer.type === "buy_1_get_1" ? 2 : 3;
  const minimumItems = groupSize;
  if (eligibleItems.length < minimumItems) {
    return emptyOffer(originalTotal, activeOffer.type, eligibleItems.length, minimumItems, activeOffer.eligibleCategories || []);
  }

  const freeUnits: OfferCartItem[] = [];
  for (let index = 0; index + groupSize <= eligibleItems.length; index += groupSize) {
    freeUnits.push(eligibleItems[index + groupSize - 1]);
  }

  const discount = Math.round(freeUnits.reduce((sum, item) => sum + Number(item.price || 0), 0));
  return {
    originalTotal,
    discount,
    finalTotal: Math.max(0, Math.round(originalTotal - discount)),
    freeItems: summarizeFreeItems(freeUnits),
    offerApplied: discount > 0,
    offerType: activeOffer.type,
    eligibleItemCount: eligibleItems.length,
    requiredItemCount: minimumItems,
    eligibleCategories: activeOffer.eligibleCategories || []
  };
}

function emptyOffer(originalTotal: number, offerType?: ActiveOffer["type"], eligibleItemCount = 0, requiredItemCount = 0, eligibleCategories: string[] = []): OfferCalculation {
  return {
    originalTotal,
    discount: 0,
    finalTotal: originalTotal,
    freeItems: [],
    offerApplied: false,
    offerType,
    eligibleItemCount,
    requiredItemCount,
    eligibleCategories
  };
}
