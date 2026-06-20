"use client";
import { useCartStore } from "@/lib/cart-store";
import type { PizzaContent } from "@/lib/content";
export function SeoAddButton({ pizza }: { pizza: PizzaContent }) {
  const addDish = useCartStore((state) => state.addDish);
  return <button className="rounded-full bg-brand px-6 py-3 font-black" onClick={() => addDish({ id: pizza.slug, name: pizza.name, description: pizza.description, category: pizza.category, productType: "pizza", price: pizza.prices[0].price, image: "/logo_tran.jpeg", available: true })}>Add to cart</button>;
}
