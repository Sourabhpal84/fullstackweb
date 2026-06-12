"use client";

import Image from "next/image";
import { Plus } from "lucide-react";
import type { Dish } from "@/types/domain";
import { formatCurrency, normalizeImageUrl } from "@/lib/format";
import { useCartStore } from "@/lib/cart-store";
import { trackEvent } from "@/components/seo/analytics";

export function DishCard({ dish }: { dish: Dish }) {
  const addDish = useCartStore((state) => state.addDish);
  const variant = Array.isArray(dish.variants) && dish.variants.length
    ? [...dish.variants].sort((a, b) => Number(a.price) - Number(b.price))[0]
    : { price: Number(dish.price || 0), oldPrice: Number(dish.oldPrice || 0) };
  const unavailable = dish.available === false;

  return (
    <article className="gpu-card overflow-hidden rounded-3xl border border-white/10 bg-white/[.07] shadow-glow">
      <div className="relative aspect-[4/3] bg-white/5">
        <Image
          src={normalizeImageUrl(dish.image)}
          alt={dish.name || "MAGNEETOZ food item"}
          fill
          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 280px"
          className="object-cover"
          loading="lazy"
        />
        {unavailable ? <span className="absolute left-3 top-3 rounded-full bg-black/70 px-3 py-1 text-[11px] font-black">Unavailable</span> : null}
      </div>
      <div className="space-y-3 p-4">
        <div>
          <h3 className="line-clamp-2 min-h-[44px] text-base font-black text-white">{dish.name}</h3>
          <p className="mt-1 line-clamp-2 min-h-[40px] text-xs font-semibold leading-5 text-white/62">
            {dish.description || "Fresh loaded MAGNEETOZ favourite."}
          </p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <strong className="text-lg font-black text-white">{formatCurrency(variant.price)}</strong>
            {Number(variant.oldPrice) > Number(variant.price) ? (
              <del className="ml-2 text-xs font-bold text-white/45">{formatCurrency(variant.oldPrice)}</del>
            ) : null}
          </div>
          <button
            type="button"
            disabled={unavailable}
            onClick={() => {
              addDish(dish);
              trackEvent("add_to_cart", { item_name: dish.name, value: variant.price, currency: "INR" });
            }}
            className="grid h-11 w-11 place-items-center rounded-full bg-brand text-white transition-transform duration-200 hover:scale-105 disabled:opacity-40"
            aria-label={`Add ${dish.name}`}
          >
            <Plus size={19} />
          </button>
        </div>
      </div>
    </article>
  );
}
