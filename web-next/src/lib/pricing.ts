"use client";

import type { CartItem, Coupon } from "@/types/domain";
import { deliveryChargeFor } from "@/lib/delivery";

export type Pricing = {
  subtotal: number;
  couponDiscount: number;
  freeDeliveryDiscount: number;
  deliveryCharge: number;
  gstPercent: number;
  gstAmount: number;
  handlingCharge: number;
  grandTotal: number;
};

const PIZZA_MANIA_CATEGORY = "pizza mania";
const ONION_PIZZA_NAME = "onion pizza";
const ONION_PIZZA_FIRST_PRICE = 49;
const ONION_PIZZA_ADDITIONAL_PRICE = 59;

function normalizePricingText(value?: string) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function isPizzaManiaOnionPizza(item: Pick<CartItem, "name" | "category">) {
  if (normalizePricingText(item.name) !== ONION_PIZZA_NAME) return false;
  const category = normalizePricingText(item.category);
  return !category || category === PIZZA_MANIA_CATEGORY || category.includes("pizza") || category.includes("piza");
}

export function cartItemLineTotal(item: CartItem) {
  const qty = Math.max(0, Number(item.qty || 0));
  if (!qty) return 0;
  if (isPizzaManiaOnionPizza(item)) {
    return ONION_PIZZA_FIRST_PRICE + Math.max(0, qty - 1) * ONION_PIZZA_ADDITIONAL_PRICE;
  }
  return Number(item.price || 0) * qty;
}

export function checkoutCartItems(items: CartItem[]) {
  return items.map((item) => ({
    ...item,
    price: cartItemLineTotal(item)
  }));
}

export function cartSubtotal(items: CartItem[]) {
  return items.reduce((sum, item) => sum + cartItemLineTotal(item), 0);
}

export function couponExpired(coupon?: Coupon) {
  const expiry = coupon?.expiryDate;
  if (!expiry) return false;
  const date = typeof expiry.toDate === "function" ? expiry.toDate() : expiry.seconds ? new Date(expiry.seconds * 1000) : null;
  return !!date && date.getTime() < Date.now();
}

export function validateCoupon(coupon: Coupon | null, subtotal: number, categories: string[], uid?: string) {
  if (!coupon) return { ok: false, message: "Coupon not found" };
  if (coupon.active !== true) return { ok: false, message: "Coupon is not active" };
  if (coupon.deleted) return { ok: false, message: "Coupon is not active" };
  if (couponExpired(coupon)) return { ok: false, message: "Coupon expired" };
  if (coupon.usageLimit && Number(coupon.usedCount || 0) >= coupon.usageLimit) return { ok: false, message: "Coupon usage limit reached" };
  if (subtotal < Number(coupon.minOrderAmount || 0)) return { ok: false, message: `Add ₹${Number(coupon.minOrderAmount || 0) - subtotal} more` };
  if (coupon.allowedUsers?.length && !coupon.allowedUsers.includes(uid || "")) return { ok: false, message: "Coupon is not available for this account" };
  if ((coupon.visibility === "vip-only" || coupon.vipOnly) && !coupon.allowedUsers?.includes(uid || "")) return { ok: false, message: "VIP coupon only" };
  if (coupon.applicableCategories?.length && !coupon.applicableCategories.some((category) => categories.includes(category))) {
    return { ok: false, message: "Coupon is not valid for these items" };
  }
  if (coupon.firstOrderOnly && !uid) return { ok: false, message: "Sign in to use this coupon" };
  return { ok: true, message: "Coupon applied" };
}

export function calculatePricing(items: CartItem[], distanceKm: number, coupon: Coupon | null, categories: string[], uid?: string): Pricing {
  const subtotal = cartSubtotal(items);
  const baseDeliveryCharge = deliveryChargeFor(distanceKm, subtotal);
  let couponDiscount = 0;
  let freeDeliveryDiscount = 0;
  let deliveryCharge = baseDeliveryCharge;
  const validation = coupon ? validateCoupon(coupon, subtotal, categories, uid) : { ok: false };
  if (coupon && validation.ok) {
    if (coupon.type === "percentage") {
      couponDiscount = subtotal * (Number(coupon.discountValue || 0) / 100);
      if (coupon.maxDiscount) couponDiscount = Math.min(couponDiscount, Number(coupon.maxDiscount));
    } else if (coupon.type === "flat") {
      couponDiscount = Number(coupon.discountValue || 0);
    }
    couponDiscount = Math.round(Math.min(Math.max(0, couponDiscount), subtotal));
    if (coupon.freeDelivery) {
      freeDeliveryDiscount = deliveryCharge;
      deliveryCharge = 0;
    }
  }
  const taxableAmount = Math.max(0, subtotal - couponDiscount);
  const gstPercent = 0;
  const gstAmount = 0;
  const handlingCharge = subtotal > 0 ? 0 : 0;
  const grandTotal = Math.max(0, Math.round(taxableAmount + gstAmount + handlingCharge + deliveryCharge));
  return { subtotal, couponDiscount, freeDeliveryDiscount, deliveryCharge, gstPercent, gstAmount, handlingCharge, grandTotal };
}
