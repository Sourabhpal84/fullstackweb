"use client";

import { Search, Sparkles } from "lucide-react";

export function SmartMenuTools({
  query,
  onQueryChange,
  intent,
  onIntentChange
}: {
  query: string;
  onQueryChange: (value: string) => void;
  intent: string;
  onIntentChange: (value: string) => void;
}) {
  const intents = [
    ["popular", "Popular"],
    ["budget", "Budget"],
    ["cheesy", "Cheesy"],
    ["quick", "Quick"]
  ];
  return (
    <section className="mt-4 rounded-3xl border border-white/10 bg-white/[.06] p-3 shadow-glow backdrop-blur-xl">
      <div className="flex items-center gap-2 rounded-2xl bg-black/25 px-3">
        <Search size={18} className="text-white/50" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search pizza, burger, fries..."
          className="h-12 min-w-0 flex-1 bg-transparent text-sm font-bold outline-none"
        />
      </div>
      <div className="scrollbar-none mt-3 flex gap-2 overflow-x-auto">
        {intents.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onIntentChange(id)}
            className={`flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-xs font-black transition-transform duration-200 hover:scale-[1.03] ${intent === id ? "bg-brand text-white" : "bg-white/10 text-white/75"}`}
          >
            <Sparkles size={14} />
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
