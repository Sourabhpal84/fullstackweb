import type { MetadataRoute } from "next";
import { publicRoutes, siteUrl } from "@/lib/seo";
import { deliveryAreas, pizzas } from "@/lib/content";

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    ...publicRoutes,
    { path: "/menu", priority: .9, changeFrequency: "daily" as const },
    { path: "/faq", priority: .7, changeFrequency: "monthly" as const },
    { path: "/reviews", priority: .6, changeFrequency: "weekly" as const },
    { path: "/about", priority: .7, changeFrequency: "monthly" as const },
    ...pizzas.map((pizza) => ({ path: `/pizza/${pizza.slug}`, priority: .9, changeFrequency: "daily" as const })),
    ...deliveryAreas.map((area) => ({ path: `/delivery/${area.slug}`, priority: .8, changeFrequency: "weekly" as const }))
  ];
  return routes.map((route) => ({
    url: new URL(route.path, siteUrl).toString(),
    lastModified: new Date(),
    changeFrequency: route.changeFrequency,
    priority: route.priority
  }));
}
