"use client";

import Image from "next/image";
import type { Category } from "@/types/domain";
import { normalizeImageUrl } from "@/lib/format";

type Props = {
  categories: Category[];
  activeCategory: string;
  onChange: (id: string) => void;
};

export function CategoryRail({ categories, activeCategory, onChange }: Props) {
  return (
    <div className="sticky top-[65px] z-40 -mx-3 border-b border-white/10 bg-[#07111f]/88 px-3 py-2 backdrop-blur-xl md:-mx-6 md:px-6">
      <div className="scrollbar-none flex gap-2 overflow-x-auto">
        <CategoryButton
          label="All"
          image="/logo_tran.jpeg"
          active={activeCategory === "all"}
          onClick={() => onChange("all")}
        />
        {categories.map((category) => (
          <CategoryButton
            key={category.id}
            label={category.name}
            image={category.image || category.imageUrl || category.icon || category.photo || category.thumbnail}
            active={activeCategory === category.name}
            onClick={() => onChange(category.name)}
          />
        ))}
      </div>
    </div>
  );
}

function CategoryButton({ label, image, active, onClick }: { label: string; image?: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`grid min-h-[72px] min-w-[64px] shrink-0 place-items-center gap-1 rounded-2xl px-2 py-2 text-[10px] font-black uppercase transition-transform duration-200 hover:scale-[1.03] ${active ? "bg-white text-ink" : "bg-white/7 text-white/75"}`}
    >
      <span className="relative h-10 w-10 overflow-hidden rounded-full bg-white">
        <Image src={normalizeImageUrl(image)} alt="" fill sizes="40px" className="object-cover" />
      </span>
      <span className="max-w-[58px] truncate">{label}</span>
    </button>
  );
}
