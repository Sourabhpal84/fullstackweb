"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import type { Category, Coupon, CustomerOrder, DeliverySettings, Dish, GeoPointLike, RestaurantSettings, ThemeSettings } from "@/types/domain";
import { Header } from "@/components/home/header";
import { Hero } from "@/components/home/hero";
import { CategoryRail } from "@/components/menu/category-rail";
import { MenuGrid } from "@/components/menu/menu-grid";
import { SmartMenuTools } from "@/components/menu/smart-menu-tools";
import { CartDrawer } from "@/components/cart/cart-drawer";
import { TrackingPanel } from "@/components/tracking/tracking-panel";
import { AuthModal } from "@/components/auth/auth-modal";
import { CheckoutPersistence } from "@/components/home/checkout-persistence";
import { calculateRouteDistance, DEFAULT_MAX_DISTANCE_KM, getBrowserLocation } from "@/lib/delivery";
import { useCartStore } from "@/lib/cart-store";

export function HomeExperience() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [theme, setTheme] = useState<ThemeSettings>({});
  const [activeCategory, setActiveCategory] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [smartIntent, setSmartIntent] = useState("popular");
  const [trackingOpen, setTrackingOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [activeCouponCode, setActiveCouponCode] = useState("");
  const [restaurant, setRestaurant] = useState<RestaurantSettings>({});
  const [deliverySettings, setDeliverySettings] = useState<DeliverySettings>({});
  const [customerLocation, setCustomerLocation] = useState<GeoPointLike | null>(null);
  const [distanceKm, setDistanceKm] = useState(0);
  const setCheckoutContext = useCartStore((state) => state.setCheckoutContext);

  useEffect(() => {
    const unsubTheme = onSnapshot(doc(db, "settings", "theme"), (snap) => {
      setTheme(snap.exists() ? snap.data() as ThemeSettings : {});
    });
    const unsubCategories = onSnapshot(query(collection(db, "categories"), orderBy("order", "asc")), (snap) => {
      setCategories(snap.docs.map((item) => ({ id: item.id, ...item.data() } as Category)));
    });
    const unsubDishes = onSnapshot(collection(db, "dishes"), (snap) => {
      setDishes(snap.docs.map((item) => ({ id: item.id, ...item.data() } as Dish)));
    });
    const unsubCoupons = onSnapshot(collection(db, "coupons"), (snap) => {
      setCoupons(snap.docs.map((item) => ({ id: item.id, ...item.data() } as Coupon)));
    });
    const unsubRestaurant = onSnapshot(doc(db, "settings", "restaurant"), (snap) => {
      setRestaurant(snap.exists() ? snap.data() as RestaurantSettings : {});
    });
    const unsubDelivery = onSnapshot(doc(db, "settings", "delivery"), (snap) => {
      setDeliverySettings(snap.exists() ? snap.data() as DeliverySettings : {});
    });
    return () => {
      unsubTheme();
      unsubCategories();
      unsubDishes();
      unsubCoupons();
      unsubRestaurant();
      unsubDelivery();
    };
  }, []);

  useEffect(() => {
    let unsubOrders: (() => void) | undefined;
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      unsubOrders?.();
      unsubOrders = undefined;
      if (!user?.uid) {
        setOrders([]);
        return;
      }
      unsubOrders = onSnapshot(query(collection(db, "orders"), where("userId", "==", user.uid), orderBy("createdAt", "desc")), (snap) => {
        setOrders(snap.docs.map((item) => ({ id: item.id, ...item.data() } as CustomerOrder)));
      });
    });
    return () => {
      unsubOrders?.();
      unsubAuth();
    };
  }, []);

  const filteredDishes = useMemo(() => {
    const queryText = searchQuery.trim().toLowerCase();
    const intentText = smartIntent.toLowerCase();
    return dishes
      .filter((dish) => activeCategory === "all" || String(dish.category || "").toLowerCase() === activeCategory.toLowerCase())
      .filter((dish) => {
        if (!queryText) return true;
        return `${dish.name || ""} ${dish.description || ""} ${dish.category || ""}`.toLowerCase().includes(queryText);
      })
      .sort((a, b) => scoreDish(b, intentText) - scoreDish(a, intentText));
  }, [activeCategory, dishes, searchQuery, smartIntent]);

  const activeCoupon = useMemo(() => {
    return coupons.find((coupon) => coupon.code?.toUpperCase() === activeCouponCode.toUpperCase()) || null;
  }, [activeCouponCode, coupons]);

  useEffect(() => {
    setCheckoutContext({
      coupons,
      activeCoupon,
      customerLocation,
      restaurantLocation: restaurant.location || null,
      distanceKm,
      maxDeliveryDistance: Number(deliverySettings.maxDeliveryDistanceKm || deliverySettings.maxDistance || DEFAULT_MAX_DISTANCE_KM),
      restaurantUnavailable: restaurant.unavailable === true,
      restaurantUnavailableMessage: restaurant.unavailableMessage || ""
    });
  }, [activeCoupon, coupons, customerLocation, deliverySettings, distanceKm, restaurant, setCheckoutContext]);

  async function refreshLocation() {
    const location = await getBrowserLocation();
    setCustomerLocation(location);
    if (restaurant.location) {
      const route = await calculateRouteDistance(restaurant.location, location);
      setDistanceKm(route.distanceKm);
    }
  }

  return (
    <div className="min-h-screen bg-[var(--page-bg)]">
      <Header onTrack={() => setTrackingOpen(true)} onLogin={() => setAuthOpen(true)} />
      <Hero theme={theme} />
      <main id="menu" className="mx-auto max-w-7xl px-3 pb-28 md:px-6">
        <CategoryRail
          categories={categories}
          activeCategory={activeCategory}
          onChange={setActiveCategory}
        />
        <SmartMenuTools query={searchQuery} onQueryChange={setSearchQuery} intent={smartIntent} onIntentChange={setSmartIntent} />
        <MenuGrid dishes={filteredDishes} />
        <section className="grid gap-3 py-8 md:grid-cols-3" aria-labelledby="faq-title">
          <article className="rounded-3xl border border-white/10 bg-white/[.06] p-5">
            <span className="text-xs font-black uppercase text-cyan-100">FAQ</span>
            <h2 id="faq-title" className="mt-2 text-xl font-black">MAGNEETOZ Pizza Delivery FAQs</h2>
            <p className="mt-3 text-sm font-semibold leading-6 text-white/65">MAGNEETOZ delivers pizza, burgers, fries, cold drinks and combo offers in supported Greater Noida delivery areas.</p>
          </article>
          <article className="rounded-3xl border border-white/10 bg-white/[.06] p-5">
            <span className="text-xs font-black uppercase text-cyan-100">Live Tracking</span>
            <h3 className="mt-2 text-lg font-black">Can I track my order live?</h3>
            <p className="mt-3 text-sm font-semibold leading-6 text-white/65">Yes. Customers can track order status and rider progress from the live order tracking experience.</p>
          </article>
          <article className="rounded-3xl border border-white/10 bg-white/[.06] p-5">
            <span className="text-xs font-black uppercase text-cyan-100">Payments</span>
            <h3 className="mt-2 text-lg font-black">COD and online payments</h3>
            <p className="mt-3 text-sm font-semibold leading-6 text-white/65">MAGNEETOZ supports Cash on Delivery and secure online payments where available.</p>
          </article>
        </section>
      </main>
      <div className="fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-24px)] max-w-3xl -translate-x-1/2 items-center justify-between rounded-2xl border border-white/10 bg-black/70 p-3 text-xs font-bold shadow-glow backdrop-blur-xl">
        <span>{distanceKm ? `Delivery distance ${distanceKm.toFixed(1)} km` : "Enable location for delivery estimate"}</span>
        <button onClick={refreshLocation} className="rounded-full bg-white px-4 py-2 font-black text-ink">Use location</button>
      </div>
      <CartDrawer activeCouponCode={activeCouponCode} onCouponCodeChange={setActiveCouponCode} />
      <TrackingPanel open={trackingOpen} onClose={() => setTrackingOpen(false)} orders={orders} />
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
      <CheckoutPersistence />
    </div>
  );
}

function scoreDish(dish: Dish, intent: string) {
  const text = `${dish.name || ""} ${dish.description || ""} ${dish.category || ""}`.toLowerCase();
  const variantPrice = Array.isArray(dish.variants) && dish.variants[0] ? Number(dish.variants[0].price || 0) : Number(dish.price || 0);
  let score = dish.available === false ? -1000 : 0;
  if (intent === "budget") score += variantPrice && variantPrice <= 149 ? 80 : 10;
  if (intent === "cheesy") score += /cheese|cheesy|loaded|pizza/.test(text) ? 80 : 10;
  if (intent === "quick") score += /fries|burger|drink|combo/.test(text) ? 70 : 20;
  if (intent === "popular") score += /special|popular|best|magneetoz|loaded/.test(text) ? 80 : 30;
  return score;
}
