"use client";

import { collection, doc, increment, runTransaction, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import type { CartItem, GeoPointLike } from "@/types/domain";

export type CodOrderDraft = {
  checkoutId: string;
  checkoutSignature: string;
  customerName: string;
  phone: string;
  address: string;
  landmark: string;
  addressLat: number | null;
  addressLng: number | null;
  items: Array<Record<string, unknown>>;
  subtotalAmount: number;
  totalAmount: number;
  deliveryDistance: number;
  actualRoadDistance: number;
  distanceSource: string;
  deliveryCharge: number;
  originalDeliveryCharge: number;
  couponCode: string;
  couponDiscount: number;
  freeDelivery: boolean;
  gstPercent: number;
  gstAmount: number;
  handlingCharge: number;
  subtotal: number;
  grandTotal: number;
  finalAmount: number;
  orderSource: string;
  location: GeoPointLike | null;
  restaurantId: string;
  restaurantName: string;
  restaurantLocation: GeoPointLike | null;
  restaurantDistance: number;
  maxDeliveryDistance: number;
  restaurantRoutingMode: string;
  userId: string;
};

export function buildInvoiceNumber(orderId: string) {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `MZ-${stamp}-${orderId.slice(-6).toUpperCase()}`;
}

export async function createCodOrder(draft: CodOrderDraft, cart: CartItem[]) {
  const user = auth.currentUser;
  if (!user?.uid) throw new Error("Please login before checkout.");
  if (!cart.length) throw new Error("Cart empty.");
  const orderRef = doc(collection(db, "orders"));
  const counterRef = doc(db, "counters", "orders");
  return runTransaction(db, async (transaction) => {
    const counterSnap = await transaction.get(counterRef);
    const nextOrderNumber = Number(counterSnap.exists() ? counterSnap.data().lastOrderNumber || 0 : 0) + 1;
    const orderData = {
      ...draft,
      orderId: orderRef.id,
      orderNumber: nextOrderNumber,
      invoiceNumber: buildInvoiceNumber(orderRef.id),
      invoiceGeneratedAt: serverTimestamp(),
      paymentMethod: "cod",
      paymentStatus: "pending",
      paymentCaptured: false,
      amountToCollect: draft.grandTotal,
      checkoutSource: "next_cod",
      status: "Pending",
      orderStatus: "Pending",
      userId: user.uid,
      createdAt: serverTimestamp(),
      placedAt: serverTimestamp(),
      lastStatusUpdatedAt: serverTimestamp()
    };
    transaction.set(counterRef, {
      lastOrderNumber: increment(1),
      updatedAt: serverTimestamp()
    }, { merge: true });
    transaction.set(orderRef, orderData);
    return { orderId: orderRef.id, orderNumber: nextOrderNumber };
  });
}
