"use client";

import { create } from "zustand";
import type { CartItem, Coupon, Dish, GeoPointLike } from "@/types/domain";
import { normalizeImageUrl } from "@/lib/format";

type CartState = {
  items: CartItem[];
  open: boolean;
  checkoutContext: {
    coupons: Coupon[];
    activeCoupon: Coupon | null;
    customerLocation: GeoPointLike | null;
    restaurantLocation: GeoPointLike | null;
    distanceKm: number;
    maxDeliveryDistance: number;
    restaurantUnavailable: boolean;
    restaurantUnavailableMessage: string;
    customerName: string;
    customerPhone: string;
    customerAddress: string;
    customerLandmark: string;
  };
  addDish: (dish: Dish) => void;
  changeQty: (id: string, delta: number) => void;
  remove: (id: string) => void;
  clear: () => void;
  setOpen: (open: boolean) => void;
  setCheckoutContext: (context: Partial<CartState["checkoutContext"]>) => void;
};

function lowestPrice(dish: Dish) {
  const variants = Array.isArray(dish.variants) ? dish.variants.filter((item) => Number(item.price) > 0) : [];
  if (variants.length) return variants.sort((a, b) => Number(a.price) - Number(b.price))[0];
  return { price: Number(dish.price || 0), oldPrice: Number(dish.oldPrice || 0), label: "" };
}

export const useCartStore = create<CartState>((set) => ({
  items: [],
  open: false,
  checkoutContext: {
    coupons: [],
    activeCoupon: null,
    customerLocation: null,
    restaurantLocation: null,
    distanceKm: 0,
    maxDeliveryDistance: 6,
    restaurantUnavailable: false,
    restaurantUnavailableMessage: "",
    customerName: "",
    customerPhone: "",
    customerAddress: "",
    customerLandmark: ""
  },
  addDish: (dish) => {
    const variant = lowestPrice(dish);
    const id = `${dish.id}:${variant.label || variant.name || "default"}`;
    set((state) => {
      const existing = state.items.find((item) => item.id === id);
      if (existing) {
        return { items: state.items.map((item) => item.id === id ? { ...item, qty: item.qty + 1 } : item), open: true };
      }
      return {
        open: true,
        items: [
          ...state.items,
          {
            id,
            dishId: dish.id,
            name: dish.name || "MAGNEETOZ Item",
            image: normalizeImageUrl(dish.image),
            price: Number(variant.price || 0),
            qty: 1,
            variantLabel: variant.label || variant.name
          }
        ]
      };
    });
  },
  changeQty: (id, delta) => set((state) => ({
    items: state.items
      .map((item) => item.id === id ? { ...item, qty: Math.max(0, item.qty + delta) } : item)
      .filter((item) => item.qty > 0)
  })),
  remove: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
  clear: () => set({ items: [] }),
  setOpen: (open) => set({ open }),
  setCheckoutContext: (context) => set((state) => ({ checkoutContext: { ...state.checkoutContext, ...context } }))
}));
