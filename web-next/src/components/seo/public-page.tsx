import Link from "next/link";
import { business } from "@/lib/seo";

export function PublicPage({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[var(--page-bg)]"><header className="border-b border-white/10 bg-black/50"><nav className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4" aria-label="Main navigation"><Link href="/" className="text-xl font-black">MAGNEETOZ</Link><div className="flex flex-wrap gap-4 text-sm font-bold"><Link href="/menu">Menu</Link><Link href="/delivery/greater-noida">Delivery areas</Link><Link href="/reviews">Reviews</Link><Link href="/faq">FAQs</Link><Link href="/about">About</Link></div></nav></header><main className="mx-auto max-w-6xl px-4 py-10">{children}</main><footer className="border-t border-white/10 px-4 py-8 text-center text-sm text-white/65"><p>{business.name} · Vegetarian pizza delivery in Greater Noida · <a href={`tel:${business.phone}`}>{business.phone}</a></p></footer></div>;
}
export function FaqList({ faqs }: { faqs: { question: string; answer: string }[] }) {
  return <div className="grid gap-3">{faqs.map((faq) => <details key={faq.question} className="rounded-2xl border border-white/10 bg-white/[.06] p-5"><summary className="cursor-pointer font-black">{faq.question}</summary><p className="mt-3 leading-7 text-white/70">{faq.answer}</p></details>)}</div>;
}
