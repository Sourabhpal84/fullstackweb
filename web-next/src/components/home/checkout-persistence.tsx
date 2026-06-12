"use client";

import { useEffect } from "react";
import { useCartStore } from "@/lib/cart-store";

const KEY = "magneetoz-next-checkout";

export function CheckoutPersistence() {
  const items = useCartStore((state) => state.items);
  const checkoutContext = useCartStore((state) => state.checkoutContext);
  const setCheckoutContext = useCartStore((state) => state.setCheckoutContext);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
      if (saved.checkoutContext) {
        setCheckoutContext({
          customerName: saved.checkoutContext.customerName || "",
          customerPhone: saved.checkoutContext.customerPhone || "",
          customerAddress: saved.checkoutContext.customerAddress || "",
          customerLandmark: saved.checkoutContext.customerLandmark || ""
        });
      }
    } catch {
      // Ignore corrupted local state.
    }
  }, [setCheckoutContext]);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        savedAt: Date.now(),
        items,
        checkoutContext: {
          customerName: checkoutContext.customerName,
          customerPhone: checkoutContext.customerPhone,
          customerAddress: checkoutContext.customerAddress,
          customerLandmark: checkoutContext.customerLandmark
        }
      }));
    } catch {
      // Local storage may be unavailable in private mode.
    }
  }, [checkoutContext.customerAddress, checkoutContext.customerLandmark, checkoutContext.customerName, checkoutContext.customerPhone, items]);

  return null;
}
