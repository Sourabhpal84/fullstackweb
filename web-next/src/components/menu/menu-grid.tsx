"use client";

import { useMemo } from "react";
import type { Dish } from "@/types/domain";
import { DishCard } from "@/components/menu/dish-card";

export function MenuGrid({ dishes }: { dishes: Dish[] }) {
  const availableFirst = useMemo(() => {
    return [...dishes].sort((a, b) => Number(b.available !== false) - Number(a.available !== false));
  }, [dishes]);

  if (!availableFirst.length) {
    return (
      <section className="grid min-h-[320px] place-items-center py-10">
        <div className="text-center">
          <div className="mx-auto mb-4 h-20 w-20 rounded-full skeleton" />
          <h2 className="text-xl font-black">Menu loading</h2>
          <p className="mt-2 text-sm text-white/60">Fresh items will appear here.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="grid grid-cols-2 gap-3 py-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {availableFirst.map((dish) => (
        <DishCard key={dish.id} dish={dish} />
      ))}
    </section>
  );
}
