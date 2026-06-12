"use client";

import { callFunction } from "@/lib/functions";
import type { CartItem } from "@/types/domain";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (event: string, cb: (response: unknown) => void) => void };
  }
}

export async function loadRazorpayScript() {
  if (window.Razorpay) return true;
  return new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export async function createPaymentSession(items: CartItem[], orderDraft: Record<string, unknown>, amount: number) {
  return callFunction<{
    ok: boolean;
    paymentSessionId: string;
    razorpayOrderId: string;
    amount: number;
    keyId: string;
    paymentLinkUrl?: string;
  }>("createPaymentSession", {
    amount,
    idempotencyKey: String(orderDraft.checkoutSignature || `${Date.now()}-${items.length}`),
    cart: items,
    orderDraft
  });
}

export async function verifyPayment(payload: Record<string, unknown>) {
  return callFunction<{ ok: boolean; orderId: string; orderNumber?: string }>("verifyPaymentAndCreateOrder", payload, 45000);
}
