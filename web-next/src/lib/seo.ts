import type { Metadata } from "next";

export const siteUrl = "https://magneetoz.com";

export const business = {
  name: "MAGNEETOZ",
  alternateName: "MAGNEETOZ Pizza",
  slogan: "Taste of Attraction",
  phone: "+91-8303614331",
  email: "magneetozgravito@gmail.com",
  logo: `${siteUrl}/logo_tran.jpeg`,
  address: {
    streetAddress: "Greater Noida",
    addressLocality: "Greater Noida",
    addressRegion: "Uttar Pradesh",
    postalCode: "201310",
    addressCountry: "IN"
  },
  geo: {
    latitude: 28.465283,
    longitude: 77.502608
  },
  sameAs: [
    "https://magneetoz.com/",
    "https://www.instagram.com/magneetoz",
    "https://www.facebook.com/magneetoz"
  ],
  cuisines: ["Pizza", "Fast Food", "Burgers", "Combos"],
  openingHours: ["Mo-Su 10:00-23:00"]
};

export const publicRoutes = [
  {
    path: "/",
    title: "MAGNEETOZ Pizza Greater Noida | Fresh Fast Food Delivery",
    description: "Order MAGNEETOZ pizza, burgers, combos and fast food in Greater Noida with secure checkout, COD and realtime order tracking.",
    priority: 1,
    changeFrequency: "daily" as const
  },
  {
    path: "/about-us.html",
    title: "About MAGNEETOZ | Pizza & Fast Food Greater Noida",
    description: "Learn about MAGNEETOZ, Taste of Attraction, a pizza and fast food delivery brand serving Greater Noida.",
    priority: .8,
    changeFrequency: "monthly" as const
  },
  {
    path: "/contact-us.html",
    title: "Contact MAGNEETOZ Greater Noida | Pizza Delivery Support",
    description: "Contact MAGNEETOZ for pizza orders, delivery support, WhatsApp support, payments, refunds and business assistance.",
    priority: .8,
    changeFrequency: "monthly" as const
  },
  {
    path: "/givefeedback.html",
    title: "MAGNEETOZ Feedback | Share Your Food Delivery Experience",
    description: "Share feedback for MAGNEETOZ pizza and fast food delivery so our team can improve food quality and service.",
    priority: .5,
    changeFrequency: "monthly" as const
  },
  {
    path: "/privacy-policy.html",
    title: "MAGNEETOZ Privacy Policy | Customer Data & Payments",
    description: "Read how MAGNEETOZ handles customer data, payments, OTP login, WhatsApp notifications and support requests.",
    priority: .4,
    changeFrequency: "yearly" as const
  },
  {
    path: "/terms-and-conditions.html",
    title: "MAGNEETOZ Terms & Conditions | Delivery, Payment & COD",
    description: "Review MAGNEETOZ delivery, payment, cancellation, COD, coupon, rider and customer support terms.",
    priority: .4,
    changeFrequency: "yearly" as const
  }
];

export function pageMetadata(route = publicRoutes[0]): Metadata {
  const canonical = new URL(route.path, siteUrl).toString();
  return {
    metadataBase: new URL(siteUrl),
    title: route.title,
    description: route.description,
    alternates: { canonical },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1
      }
    },
    openGraph: {
      type: "website",
      url: canonical,
      siteName: business.name,
      locale: "en_IN",
      title: route.title,
      description: route.description,
      images: [{ url: business.logo, width: 1200, height: 630, alt: "MAGNEETOZ pizza and fast food logo" }]
    },
    twitter: {
      card: "summary_large_image",
      title: route.title,
      description: route.description,
      images: [business.logo]
    },
    icons: {
      icon: "/logo_tran.jpeg",
      apple: "/logo_tran.jpeg"
    },
    manifest: "/manifest.json"
  };
}

export function structuredDataGraph(route = publicRoutes[0]) {
  const pageUrl = new URL(route.path, siteUrl).toString();
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${siteUrl}/#organization`,
        name: business.name,
        alternateName: business.alternateName,
        url: siteUrl,
        logo: business.logo,
        sameAs: business.sameAs,
        contactPoint: {
          "@type": "ContactPoint",
          telephone: business.phone,
          contactType: "customer support",
          areaServed: "IN",
          availableLanguage: ["English", "Hindi"]
        }
      },
      {
        "@type": ["Restaurant", "LocalBusiness"],
        "@id": `${siteUrl}/#restaurant`,
        name: business.name,
        alternateName: business.alternateName,
        slogan: business.slogan,
        url: siteUrl,
        image: business.logo,
        logo: business.logo,
        telephone: business.phone,
        email: business.email,
        priceRange: "₹₹",
        servesCuisine: business.cuisines,
        menu: siteUrl,
        address: { "@type": "PostalAddress", ...business.address },
        geo: { "@type": "GeoCoordinates", ...business.geo },
        openingHours: business.openingHours,
        areaServed: { "@type": "City", name: "Greater Noida" },
        sameAs: business.sameAs,
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: "4.8",
          reviewCount: "120"
        }
      },
      {
        "@type": "WebSite",
        "@id": `${siteUrl}/#website`,
        name: business.name,
        url: siteUrl,
        publisher: { "@id": `${siteUrl}/#organization` },
        potentialAction: {
          "@type": "SearchAction",
          target: `${siteUrl}/?q={search_term_string}`,
          "query-input": "required name=search_term_string"
        }
      },
      {
        "@type": "WebPage",
        "@id": `${pageUrl}#webpage`,
        url: pageUrl,
        name: route.title,
        description: route.description,
        isPartOf: { "@id": `${siteUrl}/#website` },
        about: { "@id": `${siteUrl}/#restaurant` },
        primaryImageOfPage: { "@type": "ImageObject", url: business.logo },
        breadcrumb: { "@id": `${pageUrl}#breadcrumb` }
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${pageUrl}#breadcrumb`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: siteUrl },
          ...(route.path === "/" ? [] : [{ "@type": "ListItem", position: 2, name: route.title.split("|")[0].trim(), item: pageUrl }])
        ]
      },
      {
        "@type": "FAQPage",
        "@id": `${pageUrl}#faq`,
        mainEntity: [
          {
            "@type": "Question",
            name: "Does MAGNEETOZ deliver pizza in Greater Noida?",
            acceptedAnswer: { "@type": "Answer", text: "Yes. MAGNEETOZ delivers pizza, burgers, fries, cold drinks and combo offers in supported Greater Noida delivery areas." }
          },
          {
            "@type": "Question",
            name: "Can I track my MAGNEETOZ order live?",
            acceptedAnswer: { "@type": "Answer", text: "Yes. Customers can track order status and rider progress from the live order tracking experience." }
          },
          {
            "@type": "Question",
            name: "Does MAGNEETOZ support COD and online payments?",
            acceptedAnswer: { "@type": "Answer", text: "Yes. MAGNEETOZ supports Cash on Delivery and secure online payments where available." }
          }
        ]
      },
      {
        "@type": "Product",
        "@id": `${siteUrl}/#pizza-delivery`,
        name: "MAGNEETOZ Pizza Delivery",
        image: business.logo,
        description: "Fresh pizza and fast food delivery service in Greater Noida.",
        brand: { "@type": "Brand", name: business.name },
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: "4.8",
          reviewCount: "120"
        },
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: "INR",
          lowPrice: "49",
          highPrice: "999",
          availability: "https://schema.org/InStock"
        }
      }
    ]
  };
}
