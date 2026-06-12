import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const site = "https://magneetoz.com";
const today = new Date().toISOString().slice(0, 10);

const publicPages = [
  ["/", "daily", "1.0", "MAGNEETOZ Pizza Greater Noida | Fresh Fast Food Delivery"],
  ["/about-us.html", "monthly", "0.8", "About MAGNEETOZ | Pizza & Fast Food Greater Noida"],
  ["/contact-us.html", "monthly", "0.8", "Contact MAGNEETOZ Greater Noida | Pizza Delivery Support"],
  ["/givefeedback.html", "monthly", "0.5", "MAGNEETOZ Feedback | Share Your Food Delivery Experience"],
  ["/privacy-policy.html", "yearly", "0.4", "MAGNEETOZ Privacy Policy | Customer Data & Payments"],
  ["/terms-and-conditions.html", "yearly", "0.4", "MAGNEETOZ Terms & Conditions | Delivery, Payment & COD"]
];

const privatePages = [
  "/8423order9839status.html",
  "/8423total_sell9839.html",
  "/add8423category9839dishes.html",
  "/admin-login.html",
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
];

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${publicPages.map(([url, changefreq, priority]) => `  <url>
    <loc>${site}${url}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`).join("\n")}
</urlset>
`;

const robots = `User-agent: *
Allow: /
${privatePages.map((url) => `Disallow: ${url}`).join("\n")}

User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

Sitemap: ${site}/sitemap.xml
Host: ${site}
`;

const llms = `# MAGNEETOZ

MAGNEETOZ is a Greater Noida pizza and fast food delivery brand.

## Key URLs
- Homepage and menu: ${site}/
- About: ${site}/about-us.html
- Contact: ${site}/contact-us.html
- Privacy: ${site}/privacy-policy.html
- Terms: ${site}/terms-and-conditions.html

## Business Entity
- Name: MAGNEETOZ
- Alternate name: MAGNEETOZ Pizza
- Slogan: Taste of Attraction
- Cuisine: Pizza, burgers, fast food, combos
- Area served: Greater Noida, Uttar Pradesh, India
- Phone: +91 8303614331
- Email: magneetozgravito@gmail.com

## Site Capabilities
- Online food ordering
- Cash on Delivery
- Secure online payments
- Realtime order tracking
- Rider delivery flow
- Customer support
`;

function read(file) {
  return fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), "utf8") : "";
}

const issues = [];
for (const [url, , , title] of publicPages) {
  const file = url === "/" ? "index.html" : url.slice(1);
  const html = read(file);
  if (!html) {
    issues.push(`${file}: missing public page file.`);
    continue;
  }
  if (!/<link\s+rel=["']canonical["']/i.test(html)) issues.push(`${file}: missing canonical tag.`);
  if (!/<meta\s+name=["']description["']/i.test(html)) issues.push(`${file}: missing meta description.`);
  if (!/<meta\s+property=["']og:title["']/i.test(html)) issues.push(`${file}: missing Open Graph title.`);
  if (!/<meta\s+name=["']twitter:card["']/i.test(html)) issues.push(`${file}: missing Twitter card.`);
  const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
  if (h1Count !== 1) issues.push(`${file}: expected exactly one H1, found ${h1Count}.`);
  if (!html.includes(title.split("|")[0].trim()) && file !== "index.html") issues.push(`${file}: title/content could be more aligned.`);
}

const report = `# MAGNEETOZ SEO Report

Generated: ${today}

## Issues Found

${issues.length ? issues.map((issue) => `- ${issue}`).join("\n") : "- No blocking indexability issues found on public pages."}

## Fixes Implemented

- Regenerated XML sitemap with canonical public URLs.
- Regenerated robots.txt with admin/rider/private pages blocked.
- Added AI crawler guidance through llms.txt.
- Added Next.js scalable metadata foundation.
- Added Next.js robots and sitemap route handlers.
- Added Organization, LocalBusiness, WebSite, WebPage, FAQ, Product, Breadcrumb and aggregate rating JSON-LD in the Next app.
- Added Firebase Hosting SEO headers for private pages through firebase.json.
- Added clean URL redirects for public compliance pages.
- Preserved indexable public pages and excluded admin/control-room pages.

## Core Web Vitals Work

- Next app uses next/image with AVIF/WebP support.
- Fixed media aspect ratios reduce CLS.
- Transform/opacity-only interactions reduce INP risk.
- Static metadata and schema are rendered server-side.
- Admin/private pages are excluded from crawl budget.

## Search Console And Analytics

- Add Google Search Console verification by setting the verification token in the site head or DNS.
- Add GA4 measurement id in the deployment environment when available.
- Event hook recommendations: add_to_cart, begin_checkout, purchase, login, track_order_open, coupon_apply.

## Public Sitemap URLs

${publicPages.map(([url]) => `- ${site}${url}`).join("\n")}
`;

fs.writeFileSync(path.join(root, "sitemap.xml"), sitemap);
fs.writeFileSync(path.join(root, "robots.txt"), robots);
fs.writeFileSync(path.join(root, "llms.txt"), llms);
fs.writeFileSync(path.join(root, "SEO_REPORT.md"), report);

console.log(`Generated sitemap.xml, robots.txt, llms.txt and SEO_REPORT.md with ${issues.length} audit notes.`);
