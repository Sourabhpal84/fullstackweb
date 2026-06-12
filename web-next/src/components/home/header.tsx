"use client";

import Image from "next/image";
import { Menu, ShoppingBag, Truck } from "lucide-react";
import { useCartStore } from "@/lib/cart-store";

export function Header({ onTrack, onLogin }: { onTrack: () => void; onLogin: () => void }) {
  const count = useCartStore((state) => state.items.reduce((sum, item) => sum + item.qty, 0));
  const setOpen = useCartStore((state) => state.setOpen);

  return (
    <header className="sticky top-0 z-50 border-b border-white/15 bg-black/60 px-3 py-2 backdrop-blur-xl md:px-6">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3">
        <a href="#" className="flex min-w-0 items-center gap-3">
          <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-full bg-white">
            <Image src="/logo_tran.jpeg" alt="MAGNEETOZ logo" fill sizes="44px" className="object-cover" priority />
          </span>
          <span className="truncate text-lg font-black tracking-wide">MAGNEETOZ</span>
        </a>
        <nav className="flex items-center gap-2">
          <button
            type="button"
            onClick={onTrack}
            className="grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-white/10 transition-transform duration-200 hover:scale-105"
            aria-label="Track order"
          >
            <Truck size={19} />
          </button>
          <button
            type="button"
            onClick={onLogin}
            className="hidden h-11 rounded-full border border-white/15 bg-white/10 px-4 text-xs font-black transition-transform duration-200 hover:scale-105 md:block"
          >
            Login
          </button>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="relative grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-white/10 transition-transform duration-200 hover:scale-105"
            aria-label="Open cart"
          >
            <ShoppingBag size={19} />
            {count > 0 ? (
              <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-brand px-1 text-[10px] font-black text-white">
                {count}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className="grid h-11 w-11 place-items-center rounded-full border border-white/15 bg-white/10 md:hidden"
            aria-label="Open menu"
          >
            <Menu size={19} />
          </button>
        </nav>
      </div>
    </header>
  );
}
