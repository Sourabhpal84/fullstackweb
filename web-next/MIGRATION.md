# MAGNEETOZ Next.js Migration

This folder is the production-ready Next.js migration foundation for the existing HTML/CSS/JavaScript site.

## What Was Identified

- The current customer app relies on one very large `script.js` and global DOM string rendering.
- Menu cards and tracking views are rebuilt through `innerHTML`, which causes layout and paint work during scroll.
- Images do not have a single optimized pipeline, so late decode and layout jank can appear.
- CSS contains many global overrides and `transition` rules, which makes performance tuning difficult.
- Firebase and Razorpay logic exists, but the client needs cleaner typed boundaries.

## New Architecture

- Next.js App Router with TypeScript.
- Tailwind CSS design system with fixed image/card dimensions.
- Firebase Web SDK isolated in `src/lib/firebase.ts`.
- Cloud Function calls isolated in `src/lib/functions.ts`.
- Razorpay client bridge isolated in `src/lib/checkout.ts`.
- Cart state isolated with Zustand.
- Components split by feature:
  - `components/home`
  - `components/menu`
  - `components/cart`
  - `components/tracking`
  - `components/auth`

## Performance Decisions

- `next/image` is used for logo, hero, category and dish images.
- Image dimensions are stable through `aspect-ratio` containers to avoid layout shift.
- Animations use transform and opacity only.
- Expensive UI surfaces are componentized instead of global DOM rewrites.
- Skeleton loading is included for empty/loading menu states.
- Category rail is compact and sticky with GPU-friendly transforms.

## Firebase

The app uses the existing Firebase project by default and also supports environment variables:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FUNCTIONS_BASE_URL=
NEXT_PUBLIC_RAZORPAY_KEY_ID=
```

## Razorpay

Payment remains secure:

- Client creates payment intent via `createPaymentSession`.
- Razorpay checkout runs in browser.
- Payment verification is sent to `verifyPaymentAndCreateOrder`.
- Existing Firebase Cloud Functions continue to verify signatures and create orders server-side.

## Deployment

```bash
cd web-next
npm install
npm run typecheck
npm run build
vercel
```

For Firebase Hosting later, point hosting to the Next.js output through an adapter or deploy this folder to Vercel and keep Firebase for Auth, Firestore, Storage and Functions.

## Migration Status

Done in this foundation:

- Next.js + TypeScript + Tailwind setup
- Vercel-ready config
- Firebase client setup
- Phone OTP login modal with invisible reCAPTCHA
- Firestore menu/category/theme listeners
- Optimized hero
- Optimized category rail
- Optimized menu cards
- Cart drawer
- Razorpay client bridge
- Live order tracking panel with rider map support
- Browser location capture and delivery distance calculation
- Restaurant/delivery settings listeners
- Coupon listener, validation, discounts and free-delivery pricing
- Existing Cloud Function compatible `orderDraft` payment payload
- Smart menu search and intent-based recommendations
- Customer checkout details form
- COD order creation using Firestore transaction and order counter
- Basic local checkout detail persistence
- Production build verified

Remaining feature migration phases:

- Saved addresses and reverse geocoded address suggestions
- Admin pages
- Rider dashboard as a Next.js protected route
- Theme Studio as a Next.js admin route
- Full notification/PWA service worker migration
- Lighthouse pass on deployed URL after production data and images are connected
