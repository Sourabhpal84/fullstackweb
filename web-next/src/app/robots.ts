import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/admin",
          "/admin-login.html",
          "/8423order9839status.html",
          "/8423total_sell9839.html",
          "/add8423category9839dishes.html",
          "/coupons-admin.html",
          "/delivery-logic-admin.html",
          "/feedback-admin.html",
          "/offers-admin.html",
          "/rider-dashboard.html",
          "/rider-login.html",
          "/rider-settlements-admin.html",
          "/riders-admin.html",
          "/super-admin-dashboard.html",
          "/theme-studio-admin.html",
          "/whatsapp-marketing-admin.html"
        ]
      }
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl
  };
}
