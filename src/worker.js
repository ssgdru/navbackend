// Cloudflare Workers edition of the FastAPI navigation portal.
// Route-for-route and behavior-for-backend parity with nav-backend/main.py:
//   /                    renders templates/index.html (mini-Jinja)
//   /api/nav             categories JSON, ts+MD5 signature, 60s TTL
//   /icon/{host}         third-party favicon proxy with edge cache + 1h negative cache
//   /favicon.ico         serves /static/favicon.png via ASSETS binding
//   /health              liveness JSON
//   /static/* , /disclaimer are served directly by the ASSETS binding (no worker)
//   anything else        404
// Security: same-origin CSP, per-IP rate limit binding (60/min), icon host whitelist.
// The backend binds nothing: Workers are edge-only; there is no origin server.
// Note: the PCL2 download feature is intentionally NOT ported to this edition.

import { render } from "./jinja.js";
import { md5 } from "./md5.js";
import indexTpl from "./templates/index.html";
import NAV_CONFIG from "../config.json";

const TS_TOLERANCE = 60; // seconds, /api/nav signature window
const ICON_MAX_BYTES = 262144;

const ICON_HOSTS = new Set();
for (const cat of NAV_CONFIG.categories || []) {
  for (const item of cat.links || []) {
    if (item.icon === "fav" && typeof item.url === "string" && item.url.startsWith("http")) {
      try {
        const host = new URL(item.url).hostname;
        if (host) {
          item.icon_url = `/icon/${host}`;
          ICON_HOSTS.add(host);
        }
      } catch (e) {
        // malformed URL in config: leave the item untouched, dot fallback applies
      }
    }
  }
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "X-Permitted-Cross-Domain-Policies": "none",
};

function withSecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function makeSign(tsInt) {
  return md5(`${env_secret()}${tsInt}`);
}

// The secret lives in wrangler.toml [vars] so it can be rotated without code edits.
let SECRET_FALLBACK = "redhe1314_nav_secret_2024_x#";
let CACHED_ENV = null;
function env_secret() {
  return (CACHED_ENV && CACHED_ENV.API_SECRET) || SECRET_FALLBACK;
}

function verifySign(ts, sign, ttlSeconds) {
  if (!ts || !sign) return false;
  const tsInt = Number(ts);
  if (!Number.isFinite(tsInt)) return false;
  if (Math.abs(Date.now() - tsInt) > ttlSeconds * 1000) return false;
  return makeSign(tsInt) === sign;
}

async function rateLimitOk(env, request) {
  if (!env || !env.RATE_LIMITER) return true; // binding absent: platform WAF handles limits
  try {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const outcome = await env.RATE_LIMITER.limit({ key: ip });
    return !!outcome.success;
  } catch (e) {
    return true; // fail open: availability over strictness, platform WAF still applies
  }
}

function handleIndex() {
  const html = render(indexTpl, { title: NAV_CONFIG.title, categories: NAV_CONFIG.categories || [] });
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache, must-revalidate" },
  });
}

function handleApiNav(url) {
  const ts = url.searchParams.get("ts");
  const sign = url.searchParams.get("sign");
  if (!verifySign(ts, sign, TS_TOLERANCE)) {
    return json({ detail: "Invalid signature or expired timestamp" }, 403);
  }
  return json({ code: 0, data: NAV_CONFIG.categories });
}

function sniffImageType(bytes) {
  const v = new Uint8Array(bytes.slice(0, 8));
  if (v[0] === 0xff && v[1] === 0xd8) return "image/jpeg";
  if (v[0] === 0x89 && v[1] === 0x50 && v[2] === 0x4e && v[3] === 0x47) return "image/png";
  if (v[0] === 0x47 && v[1] === 0x49 && v[2] === 0x46) return "image/gif";
  return "image/x-icon";
}

async function fetchRemoteBytes(url, limit) {
  const resp = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; nav-backend/1.0; favicon proxy)" },
    signal: AbortSignal.timeout(4000),
  });
  if (!resp.ok) return null;
  const buf = await resp.arrayBuffer();
  if (!buf.byteLength) return null;
  return buf.byteLength > limit ? buf.slice(0, limit) : buf;
}

async function fetchRemoteIcon(host) {
  for (const scheme of ["https", "http"]) {
    try {
      const data = await fetchRemoteBytes(`${scheme}://${host}/favicon.ico`, ICON_MAX_BYTES);
      if (data) return data;
    } catch (e) {
      // try next scheme
    }
  }
  try {
    const headBuf = await fetchRemoteBytes(`https://${host}/`, 65536);
    if (headBuf) {
      const head = new TextDecoder("utf-8").decode(headBuf);
      const linkTag = head.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i);
      if (linkTag) {
        const href = linkTag[0].match(/href=["']([^"']+)["']/i);
        if (href) {
          const iconUrl = new URL(href[1], `https://${host}/`).href;
          if (iconUrl.startsWith("http")) {
            const data = await fetchRemoteBytes(iconUrl, ICON_MAX_BYTES);
            if (data) return data;
          }
        }
      }
    }
  } catch (e) {
    // fall through to miss
  }
  return null;
}

async function handleIcon(ctx, request, path) {
  const host = decodeURIComponent(path.slice("/icon/".length));
  if (!ICON_HOSTS.has(host)) return json({ detail: "Not Found" }, 404);

  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const data = await fetchRemoteIcon(host);
  if (!data) {
    // negative cache for 1h: mirrors the .miss marker of the FastAPI version
    const miss = new Response(null, {
      status: 404,
      headers: { "cache-control": "public, max-age=3600" },
    });
    ctx.waitUntil(cache.put(request, miss.clone()));
    return miss;
  }

  const ok = new Response(data, {
    status: 200,
    headers: {
      "content-type": sniffImageType(data),
      "cache-control": "public, max-age=604800",
    },
  });
  ctx.waitUntil(cache.put(request, ok.clone()));
  return ok;
}

async function handleFavicon(env, request) {
  if (!env || !env.ASSETS) return new Response(null, { status: 204 });
  const assetUrl = new URL("/static/favicon.png", request.url);
  const res = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
  if (!res.ok) return new Response(null, { status: 204 });
  return res;
}

export default {
  async fetch(request, env, ctx) {
    CACHED_ENV = env;
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path !== "/health") {
        const ok = await rateLimitOk(env, request);
        if (!ok) return withSecurityHeaders(json({ detail: "Too Many Requests" }, 429));
      }

      let res;
      if (path === "/") {
        res = handleIndex(env);
      } else if (path === "/api/nav") {
        res = handleApiNav(url);
      } else if (path.startsWith("/icon/")) {
        res = await handleIcon(ctx, request, path);
      } else if (path === "/favicon.ico") {
        res = await handleFavicon(env, request);
      } else if (path === "/health") {
        res = json({ status: "ok", ts: Date.now() });
      } else {
        res = new Response("Not Found", { status: 404 });
      }
      return withSecurityHeaders(res);
    } catch (e) {
      return withSecurityHeaders(
        new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } })
      );
    }
  },
};
