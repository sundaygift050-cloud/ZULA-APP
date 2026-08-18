// ─────────────────────────────────────────────────────────────────
// ZÚLA — dynamic social preview middleware (Vercel Edge Middleware)
// ─────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// zula-app-silk.vercel.app is a single static HTML file (a client-side
// SPA). When someone shares a link like:
//   https://zula-app-silk.vercel.app/?seller=abc123
//   https://zula-app-silk.vercel.app/?product=xyz789
// Facebook, WhatsApp, Twitter/X, Telegram, iMessage, Slack, Discord,
// etc. do NOT run your JavaScript. They fetch the raw HTML once and
// read whatever <meta property="og:..."> tags are already sitting in
// <head>. Since every URL currently returns the exact same static
// index.html, every shared link shows the same generic/blank preview
// — that's the "0 Listings, ZÚLA seller, No bio yet" card you saw.
//
// This middleware runs at Vercel's edge, BEFORE the static file is
// served. It only does anything when both of these are true:
//   1. The request has ?seller=... or ?product=... in the URL
//   2. The request is coming from a known social-preview crawler
//      (detected by User-Agent)
// For those requests, it fetches the real seller/product data straight
// from Firestore's REST API and returns a version of index.html with
// the <meta og:...> tags swapped to that seller's/product's real name,
// photo, and description — so the preview card is accurate on every
// platform. Every other request (real visitors, i.e. actual humans in
// a browser) is left completely untouched and gets your normal app.
//
// HOW TO INSTALL
// 1. Put this file at the ROOT of your Vercel project as `middleware.js`
//    (same level as index.html / package.json — NOT inside /api).
// 2. Make sure your Firestore rules allow public read access to the
//    `users` and `products` collections (your app already reads these
//    client-side for guests, so this should already be the case).
// 3. Add a real default social image at /public/og-default.png
//    (1200×630px recommended) — used as a fallback when a seller has
//    no photo or a product has no image.
// 4. Deploy. No other config needed — Vercel auto-detects middleware.js.
// ─────────────────────────────────────────────────────────────────

const FIREBASE_PROJECT_ID = 'zula-app-51ab8';
const SITE_URL = 'https://zula-app-silk.vercel.app';
const DEFAULT_IMAGE = SITE_URL + '/og-default.png';

// Crawlers that fetch a page once (no JS) purely to build a share card.
// Only these get the rewritten HTML — real visitors always get the
// untouched SPA, so nothing about the actual app experience changes.
const CRAWLER_UA_PATTERNS = [
  'facebookexternalhit', 'Facebot',
  'Twitterbot',
  'WhatsApp',
  'TelegramBot',
  'Slackbot', 'Slack-ImgProxy',
  'LinkedInBot',
  'Discordbot',
  'SkypeUriPreview',
  'Pinterest',
  'redditbot',
  'Applebot', // iMessage / Apple link previews
  'Googlebot',
  'bingbot',
];

function isCrawler(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return CRAWLER_UA_PATTERNS.some(p => ua.includes(p.toLowerCase()));
}

// Minimal Firestore REST reader — Edge Middleware can't use the
// firebase-admin/client SDK, but Firestore's public REST endpoint works
// fine over plain fetch() and respects your existing security rules.
async function getFirestoreDoc(collection, id) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${id}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return flattenFirestoreFields(json.fields || {});
}

// Firestore's REST API wraps every value like { stringValue: "x" } or
// { integerValue: "3" } — this unwraps it into a plain JS object.
function flattenFirestoreFields(fields) {
  const out = {};
  for (const key in fields) {
    const v = fields[key];
    if (v.stringValue !== undefined) out[key] = v.stringValue;
    else if (v.integerValue !== undefined) out[key] = Number(v.integerValue);
    else if (v.doubleValue !== undefined) out[key] = v.doubleValue;
    else if (v.booleanValue !== undefined) out[key] = v.booleanValue;
    else if (v.nullValue !== undefined) out[key] = null;
    else out[key] = undefined; // arrays/maps/timestamps not needed here
  }
  return out;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Swaps the <meta property="og:..."> / <meta name="twitter:..."> tags
// (and <title>) in the raw HTML for the values we looked up.
function injectMeta(html, { title, description, image, url }) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const safeImage = escapeHtml(image);
  const safeUrl = escapeHtml(url);

  html = html.replace(/<title>.*?<\/title>/, `<title>${safeTitle}</title>`);
  html = html.replace(/<meta property="og:title" content=".*?" \/>/, `<meta property="og:title" content="${safeTitle}" />`);
  html = html.replace(/<meta property="og:description" content=".*?" \/>/, `<meta property="og:description" content="${safeDesc}" />`);
  html = html.replace(/<meta property="og:image" content=".*?" \/>/, `<meta property="og:image" content="${safeImage}" />`);
  html = html.replace(/<meta property="og:url" content=".*?" \/>/, `<meta property="og:url" content="${safeUrl}" />`);
  html = html.replace(/<meta name="twitter:title" content=".*?" \/>/, `<meta name="twitter:title" content="${safeTitle}" />`);
  html = html.replace(/<meta name="twitter:description" content=".*?" \/>/, `<meta name="twitter:description" content="${safeDesc}" />`);
  html = html.replace(/<meta name="twitter:image" content=".*?" \/>/, `<meta name="twitter:image" content="${safeImage}" />`);
  return html;
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const userAgent = request.headers.get('user-agent') || '';

  const sellerId = url.searchParams.get('seller');
  const productId = url.searchParams.get('product');

  // Only intervene for crawler requests that are actually asking about
  // a specific seller or product — everything else passes straight
  // through untouched.
  if (!isCrawler(userAgent) || (!sellerId && !productId)) {
    return; // no return value = Vercel serves the request normally
  }

  try {
    // Fetch the real index.html first (so we edit the actual current
    // file rather than hardcoding a copy of it in this middleware).
    const originResponse = await fetch(new URL('/', request.url));
    let html = await originResponse.text();

    let meta;
    if (productId) {
      const p = await getFirestoreDoc('products', productId);
      if (p) {
        const price = p.price ? `${p.currency || 'NGN'} ${p.price}` : '';
        meta = {
          title: `${p.name || 'Product'} — ZÚLA`,
          description: [price, p.description].filter(Boolean).join(' · ').slice(0, 200) || 'Check out this listing on ZÚLA.',
          image: p.imageUrl || p.image || DEFAULT_IMAGE,
          url: url.toString(),
        };
      }
    } else if (sellerId) {
      const u = await getFirestoreDoc('users', sellerId);
      if (u) {
        const name = u.fullName || u.firstName || 'ZÚLA seller';
        meta = {
          title: `${name} on ZÚLA`,
          description: u.bio || `Check out ${name}'s store on ZÚLA.`,
          image: u.photoUrl || DEFAULT_IMAGE,
          url: url.toString(),
        };
      }
    }

    if (meta) {
      html = injectMeta(html, meta);
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
  } catch (err) {
    // If anything goes wrong (bad id, Firestore hiccup, etc.), just
    // fall back to the normal static page rather than breaking the link.
    console.error('OG middleware error:', err);
  }

  return; // fall through to the default static response
}

export const config = {
  matcher: '/',
};
