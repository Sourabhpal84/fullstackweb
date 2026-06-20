import type { FreeOfferItem, OfferCartItem } from "@/lib/offerTypes";

export function isPizzaItem(item: OfferCartItem) {
  return String(item.productType || "").toLowerCase() === "pizza";
}

export function expandCartItems(items: OfferCartItem[]) {
  return items.flatMap((item) => {
    const qty = Math.max(0, Math.floor(Number(item.qty || 0)));
    return Array.from({ length: qty }, (_, index) => ({
      ...item,
      unitKey: `${item.id}:${index}`,
      qty: 1,
      price: Number(item.price || 0)
    }));
  });
}

export function summarizeFreeItems(items: OfferCartItem[]): FreeOfferItem[] {
  const grouped = new Map<string, FreeOfferItem>();
  items.forEach((item) => {
    const key = `${item.id}:${item.price}`;
    const existing = grouped.get(key);
    if (existing) {
      grouped.set(key, { ...existing, qty: existing.qty + 1 });
      return;
    }
    grouped.set(key, {
      id: item.id,
      dishId: item.dishId,
      name: item.name,
      price: Number(item.price || 0),
      qty: 1
    });
  });
  return [...grouped.values()];
}
