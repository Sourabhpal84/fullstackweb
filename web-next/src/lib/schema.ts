import { business, siteUrl } from "@/lib/seo";
import type { PizzaContent } from "@/lib/content";
export const faqSchema = (faqs: { question: string; answer: string }[]) => ({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faqs.map((faq) => ({ "@type": "Question", name: faq.question, acceptedAnswer: { "@type": "Answer", text: faq.answer } })) });
export function pizzaSchema(pizza: PizzaContent) {
  const url = `${siteUrl}/pizza/${pizza.slug}`;
  return { "@context": "https://schema.org", "@graph": [
    { "@type": "Product", "@id": `${url}#product`, name: pizza.name, description: pizza.description, image: business.logo, category: pizza.category, brand: { "@type": "Brand", name: business.name }, offers: pizza.prices.map((item) => ({ "@type": "Offer", name: item.name, price: item.price, priceCurrency: "INR", availability: "https://schema.org/InStock", url })) },
    { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: siteUrl }, { "@type": "ListItem", position: 2, name: "Pizza", item: `${siteUrl}/menu` }, { "@type": "ListItem", position: 3, name: pizza.name, item: url }] }
  ]};
}
