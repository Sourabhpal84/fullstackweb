"use client";

import Image from "next/image";
import { Minus, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { auth } from "@/lib/firebase";
import { useCartStore } from "@/lib/cart-store";
import { formatCurrency } from "@/lib/format";
import { createPaymentSession, loadRazorpayScript, verifyPayment } from "@/lib/checkout";
import { calculatePricing, validateCoupon } from "@/lib/pricing";
import { createCodOrder, type CodOrderDraft } from "@/lib/orders";
import { trackEvent } from "@/components/seo/analytics";

export function CartDrawer({ activeCouponCode, onCouponCodeChange }: { activeCouponCode: string; onCouponCodeChange: (code: string) => void }) {
  const { items, open, setOpen, changeQty, remove, clear, checkoutContext } = useCartStore();
  const setCheckoutContext = useCartStore((state) => state.setCheckoutContext);
  const [busy, setBusy] = useState(false);
  const categories = useMemo(() => [...new Set(items.map((item) => item.variantLabel || ""))], [items]);
  const pricing = useMemo(
    () => calculatePricing(items, checkoutContext.distanceKm, checkoutContext.activeCoupon, categories, auth.currentUser?.uid),
    [categories, checkoutContext.activeCoupon, checkoutContext.distanceKm, items]
  );
  const visibleCoupons = checkoutContext.coupons.filter((coupon) => {
    const visibility = String(coupon.visibility || "public").toLowerCase();
    return coupon.active !== false && !coupon.deleted && visibility !== "hidden" && visibility !== "vip-only";
  }).slice(0, 5);

  function orderDraft(paymentMethod = "online"): CodOrderDraft {
    const user = auth.currentUser;
    const checkoutSignature = `${user?.uid || "guest"}:${items.map((item) => `${item.name}:${item.qty}:${item.price}`).join("|")}:${pricing.grandTotal}:${activeCouponCode}:${paymentMethod}`;
    return {
      checkoutId: `co_${user?.uid || "guest"}_${Date.now()}`,
      checkoutSignature,
      customerName: checkoutContext.customerName || user?.displayName || "Magneetoz Customer",
      phone: checkoutContext.customerPhone || user?.phoneNumber?.replace("+91", "") || "",
      address: checkoutContext.customerAddress,
      landmark: checkoutContext.customerLandmark,
      addressLat: checkoutContext.customerLocation?.lat || null,
      addressLng: checkoutContext.customerLocation?.lng || null,
      items: items.map((item) => ({
        id: item.dishId,
        name: item.name,
        price: item.price,
        qty: item.qty,
        quantity: item.qty,
        image: item.image,
        category: item.variantLabel || ""
      })),
      subtotalAmount: pricing.subtotal,
      totalAmount: pricing.grandTotal,
      deliveryDistance: checkoutContext.distanceKm,
      actualRoadDistance: checkoutContext.distanceKm,
      distanceSource: checkoutContext.distanceKm ? "next_checkout" : "pending",
      deliveryCharge: pricing.deliveryCharge,
      originalDeliveryCharge: pricing.deliveryCharge + pricing.freeDeliveryDiscount,
      couponCode: checkoutContext.activeCoupon?.code || "",
      couponDiscount: pricing.couponDiscount,
      freeDelivery: !!checkoutContext.activeCoupon?.freeDelivery,
      gstPercent: pricing.gstPercent,
      gstAmount: pricing.gstAmount,
      handlingCharge: pricing.handlingCharge,
      subtotal: pricing.subtotal,
      grandTotal: pricing.grandTotal,
      finalAmount: pricing.grandTotal,
      orderSource: "next_web",
      location: checkoutContext.customerLocation,
      restaurantId: "primary",
      restaurantName: "MAGNEETOZ",
      restaurantLocation: checkoutContext.restaurantLocation,
      restaurantDistance: checkoutContext.distanceKm,
      maxDeliveryDistance: checkoutContext.maxDeliveryDistance,
      restaurantRoutingMode: "single_restaurant",
      userId: user?.uid || ""
    };
  }

  async function payOnline() {
    if (!items.length || busy) return;
    if (!auth.currentUser) return alert("Please login before checkout.");
    if (checkoutContext.restaurantUnavailable) return alert(checkoutContext.restaurantUnavailableMessage || "Restaurant is currently unavailable.");
    if (!checkoutContext.customerLocation) return alert("Please use location before checkout.");
    if (!checkoutContext.customerName || !checkoutContext.customerPhone || !checkoutContext.customerAddress) return alert("Please fill name, phone and address.");
    if (checkoutContext.maxDeliveryDistance > 0 && checkoutContext.distanceKm > checkoutContext.maxDeliveryDistance) {
      return alert(`Delivery is available within ${checkoutContext.maxDeliveryDistance} km.`);
    }
    setBusy(true);
    try {
      const loaded = await loadRazorpayScript();
      if (!loaded || !window.Razorpay) throw new Error("Payment gateway unavailable");
      const draft = orderDraft("online");
      const session = await createPaymentSession(items, draft, pricing.grandTotal);
      const razorpay = new window.Razorpay({
        key: session.keyId || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: Math.round(session.amount * 100),
        currency: "INR",
        name: "MAGNEETOZ",
        description: "MAGNEETOZ order payment",
        order_id: session.razorpayOrderId,
        handler: async (response: Record<string, unknown>) => {
          await verifyPayment({ paymentSessionId: session.paymentSessionId, ...response });
          trackEvent("purchase", { value: pricing.grandTotal, currency: "INR", payment_type: "online" });
          clear();
          setOpen(false);
        }
      });
      razorpay.open();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Unable to start payment");
    } finally {
      setBusy(false);
    }
  }

  async function placeCodOrder() {
    if (!items.length || busy) return;
    if (!auth.currentUser) return alert("Please login before checkout.");
    if (checkoutContext.restaurantUnavailable) return alert(checkoutContext.restaurantUnavailableMessage || "Restaurant is currently unavailable.");
    if (!checkoutContext.customerLocation) return alert("Please use location before checkout.");
    if (!checkoutContext.customerName || !checkoutContext.customerPhone || !checkoutContext.customerAddress) return alert("Please fill name, phone and address.");
    if (checkoutContext.maxDeliveryDistance > 0 && checkoutContext.distanceKm > checkoutContext.maxDeliveryDistance) {
      return alert(`Delivery is available within ${checkoutContext.maxDeliveryDistance} km.`);
    }
    setBusy(true);
    try {
      const result = await createCodOrder(orderDraft("cod"), items);
      trackEvent("purchase", { value: pricing.grandTotal, currency: "INR", payment_type: "cod", order_number: result.orderNumber });
      clear();
      setOpen(false);
      alert(`Order placed. Order #${result.orderNumber}`);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Unable to place COD order");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className={`fixed inset-y-0 right-0 z-[70] w-full max-w-md transform bg-[#07111f] shadow-glow transition-transform duration-300 ${open ? "translate-x-0" : "translate-x-full"}`}>
      <div className="flex h-full flex-col border-l border-white/10">
        <div className="flex items-center justify-between border-b border-white/10 p-4">
          <div>
            <h2 className="text-lg font-black">Your Cart</h2>
            <p className="text-xs font-semibold text-white/55">{items.length} selected items</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="grid h-10 w-10 place-items-center rounded-full bg-white/10" aria-label="Close cart">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {items.length ? items.map((item) => (
            <div key={item.id} className="flex gap-3 rounded-2xl border border-white/10 bg-white/[.06] p-3">
              <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-white/5">
                <Image src={item.image} alt={item.name} fill sizes="80px" className="object-cover" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-black">{item.name}</h3>
                <p className="mt-1 text-xs text-white/55">{formatCurrency(item.price)}</p>
                <div className="mt-3 flex items-center gap-2">
                  <button className="grid h-8 w-8 place-items-center rounded-full bg-white/10" onClick={() => changeQty(item.id, -1)} aria-label="Decrease quantity"><Minus size={14} /></button>
                  <b>{item.qty}</b>
                  <button className="grid h-8 w-8 place-items-center rounded-full bg-white/10" onClick={() => changeQty(item.id, 1)} aria-label="Increase quantity"><Plus size={14} /></button>
                  <button className="ml-auto text-xs font-bold text-white/55" onClick={() => remove(item.id)}>Remove</button>
                </div>
              </div>
            </div>
          )) : <div className="grid h-full place-items-center text-center text-white/60">Your cart is empty.</div>}
        </div>
        <div className="border-t border-white/10 p-4">
          <div className="mb-4 grid gap-2">
            <input
              value={checkoutContext.customerName}
              onChange={(event) => setCheckoutContext({ customerName: event.target.value })}
              placeholder="Your name"
              className="h-11 rounded-2xl border border-white/10 bg-white/[.06] px-4 text-sm font-bold outline-none"
            />
            <input
              value={checkoutContext.customerPhone}
              onChange={(event) => setCheckoutContext({ customerPhone: event.target.value.replace(/\D/g, "").slice(0, 10) })}
              placeholder="Phone number"
              inputMode="numeric"
              className="h-11 rounded-2xl border border-white/10 bg-white/[.06] px-4 text-sm font-bold outline-none"
            />
            <textarea
              value={checkoutContext.customerAddress}
              onChange={(event) => setCheckoutContext({ customerAddress: event.target.value })}
              placeholder="Delivery address"
              rows={2}
              className="resize-none rounded-2xl border border-white/10 bg-white/[.06] px-4 py-3 text-sm font-bold outline-none"
            />
            <input
              value={checkoutContext.customerLandmark}
              onChange={(event) => setCheckoutContext({ customerLandmark: event.target.value })}
              placeholder="Landmark optional"
              className="h-11 rounded-2xl border border-white/10 bg-white/[.06] px-4 text-sm font-bold outline-none"
            />
          </div>
          <div className="mb-4 space-y-3">
            <input
              value={activeCouponCode}
              onChange={(event) => onCouponCodeChange(event.target.value.toUpperCase())}
              placeholder="Coupon code"
              className="h-11 w-full rounded-full border border-white/10 bg-white/[.06] px-4 text-sm font-bold outline-none"
            />
            {visibleCoupons.length ? (
              <div className="scrollbar-none flex gap-2 overflow-x-auto">
                {visibleCoupons.map((coupon) => {
                  const valid = validateCoupon(coupon, pricing.subtotal, categories, auth.currentUser?.uid);
                  return (
                    <button key={coupon.id} onClick={() => onCouponCodeChange(coupon.code)} className="shrink-0 rounded-2xl border border-white/10 bg-white/[.06] px-3 py-2 text-left text-xs">
                      <strong className="block">{coupon.code}</strong>
                      <span className="text-white/55">{valid.ok ? "Tap to apply" : valid.message}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div className="mb-4 space-y-2 rounded-2xl bg-white/[.05] p-3 text-sm">
            <Row label="Subtotal" value={pricing.subtotal} />
            <Row label="Coupon savings" value={-pricing.couponDiscount} />
            <Row label="Delivery" value={pricing.deliveryCharge} />
          </div>
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm font-bold text-white/60">Total</span>
            <strong className="text-2xl font-black">{formatCurrency(pricing.grandTotal)}</strong>
          </div>
          <button disabled={!items.length || busy} onClick={payOnline} className="h-12 w-full rounded-full bg-brand font-black text-white disabled:opacity-45">
            {busy ? "Processing..." : "Pay Online Securely"}
          </button>
          <button disabled={!items.length || busy} onClick={placeCodOrder} className="mt-2 h-12 w-full rounded-full bg-white font-black text-ink disabled:opacity-45">
            Cash on Delivery
          </button>
        </div>
      </div>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/60">{label}</span>
      <b>{value < 0 ? `-${formatCurrency(Math.abs(value))}` : formatCurrency(value)}</b>
    </div>
  );
}
