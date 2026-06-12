"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import type { ThemeSettings } from "@/types/domain";
import { normalizeImageUrl } from "@/lib/format";

export function Hero({ theme }: { theme: ThemeSettings }) {
  const hero = theme.hero || {};
  const images = (hero.images || []).filter(Boolean).slice(0, 3);
  const primaryImage = normalizeImageUrl(images[0] || "/logo_tran.jpeg");
  const blur = Math.max(0, Math.min(24, Number(hero.backgroundBlur || 0)));
  const black = Math.max(0, Math.min(85, Number(hero.backgroundBlackIntensity ?? 24))) / 100;

  return (
    <section className="relative isolate min-h-[calc(100svh-64px)] overflow-hidden px-4 py-8 md:px-6 md:py-14">
      <div className="absolute inset-0 -z-20">
        <Image
          src={primaryImage}
          alt=""
          fill
          priority
          sizes="100vw"
          className="scale-105 object-cover"
          style={{ filter: `blur(${blur}px) brightness(.82)` }}
        />
      </div>
      <div className="absolute inset-0 -z-10" style={{ background: `rgba(0,0,0,${black})` }} />
      <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(6,10,16,.82),rgba(6,10,16,.35),rgba(6,10,16,.78))]" />

      <div className="mx-auto grid min-h-[72svh] max-w-7xl items-center gap-8 md:grid-cols-[1.08fr_.72fr]">
        <motion.div
          initial={{ opacity: 0, transform: "translate3d(0,16px,0)" }}
          animate={{ opacity: 1, transform: "translate3d(0,0,0)" }}
          transition={{ duration: .45, ease: "easeOut" }}
          className="max-w-3xl"
        >
          <p className="mb-4 text-xs font-black uppercase tracking-[.16em] text-cyan-200">
            {hero.kicker || "MAGNEETOZ Greater Noida • Pizza • Burgers • Combos"}
          </p>
          <h1 className="text-balance text-4xl font-black leading-tight text-white md:text-6xl">
            {hero.title || "MAGNEETOZ Pizza Delivery in Greater Noida"}
          </h1>
          <p className="mt-5 max-w-2xl text-base font-semibold leading-7 text-white/82 md:text-lg">
            {hero.subtitle || "Order pizza, burgers, fries, cold drinks, and combo offers online with secure checkout, COD, and realtime order tracking."}
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a href="#menu" className="rounded-full bg-brand px-6 py-3 text-sm font-black text-white shadow-glow transition-transform duration-200 hover:scale-[1.03]">
              {hero.primaryButton || "Explore Menu"}
            </a>
            <button type="button" className="rounded-full border border-white/20 bg-white/10 px-6 py-3 text-sm font-black text-white backdrop-blur-xl transition-transform duration-200 hover:scale-[1.03]">
              {hero.secondaryButton || "Smart Search"}
            </button>
          </div>
        </motion.div>

        <aside className="gpu-card rounded-[28px] border border-white/20 bg-white/10 p-4 shadow-glow backdrop-blur-xl">
          <div className="relative aspect-square overflow-hidden rounded-[24px] bg-black/30">
            <Image
              src={primaryImage}
              alt="MAGNEETOZ featured food"
              fill
              sizes="(max-width: 768px) 88vw, 390px"
              className="object-cover"
              placeholder="blur"
              blurDataURL="/logo_tran.jpeg"
            />
          </div>
          <div className="mt-4 flex items-center justify-between rounded-2xl bg-black/35 p-4">
            <div>
              <span className="text-xs font-bold text-white/60">Kitchen status</span>
              <strong className="block text-sm text-white">Fresh batch preparing</strong>
            </div>
            <b className="text-sm text-cyan-200">18-30 min</b>
          </div>
        </aside>
      </div>
    </section>
  );
}
