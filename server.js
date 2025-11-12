// server.js
// ENVs:
// - SHOPIFY_ADMIN_TOKEN, SHOPIFY_SHOP, PROXY_SECRET
// - PROXY_MOUNT (default "/tickets")
// - SHOPIFY_API_VERSION or API_VERSION (fallback "2024-10")
// - ADMIN_UI_KEY           (Bearer for programmatic admin API)
// - UI_USER, UI_PASS       (staff credentials for the HTML login)
// - UI_SESSION_SECRET      (signing key for cookie; defaults to ADMIN_UI_KEY or "change-me")
// Optional: SKIP_PROXY_VERIFY=1

import express from "express";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "url";

// Polyfill fetch if running on a Node build without global fetch
if (!globalThis.fetch) {
  const { default: nodeFetch } = await import("node-fetch");
  globalThis.fetch = nodeFetch;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// ---------- middleware
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  })
);
app.use(rateLimit({ windowMs: 60_000, max: 180 }));
app.use(cookieParser());
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    },
  })
);

// ---------- env
const PORT = process.env.PORT || 3000;
const PROXY_MOUNT = process.env.PROXY_MOUNT || "/tickets";
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || ""; // e.g. zuvic-in.myshopify.com
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION =
  process.env.SHOPIFY_API_VERSION || process.env.API_VERSION || "2024-10";
const SKIP_VERIFY = process.env.SKIP_PROXY_VERIFY === "1";

// ---------- utils
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// STATUS: no "resolved" for admins/UI. Legacy "resolved" → "in_progress".
function normalizeStatus(s) {
  const v = String(s || "").toLowerCase().trim();
  if (v === "in progress" || v === "processing") return "in_progress";
  if (v === "resolved") return "in_progress";               // legacy map
  if (["pending", "in_progress", "closed", "all"].includes(v)) return v;
  return "all";
}

// NEW: hard-lock helpers
function isClosed(s) {
  return normalizeStatus(s) === "closed";
}
function truthy(v) {
  const x = String(v ?? "").trim().toLowerCase();
  return x === "1" || x === "true" || x === "yes";
}

// App Proxy signature helpers
function expectedHmacFromReq(req, secret) {
  const rawQs = req.originalUrl.split("?")[1] || "";
  const usp = new URLSearchParams(rawQs);
  const pairs = [];
  for (const [k, v] of usp) if (k !== "signature") pairs.push([k, v]);
  pairs.sort((a, b) =>
    a[0] === b[0]
      ? String(a[1]).localeCompare(String(b[1]))
      : a[0].localeCompare(b[0])
  );
  const msg = pairs.map(([k, v]) => `${k}=${v}`).join("");
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}
function verifyProxySignature(req) {
  if (SKIP_VERIFY) return true;
  const provided = String(req.query.signature || "").toLowerCase();
  if (!PROXY_SECRET || !provided) return false;
  const expected = expectedHmacFromReq(req, PROXY_SECRET).toLowerCase();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Shopify Admin GraphQL helper
async function adminGraphQL(query, variables = {}) {
  if (!SHOPIFY_SHOP || !ADMIN_TOKEN) {
    throw new Error("Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN");
  }
  const url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.errors) {
    const msg = body?.errors?.[0]?.message || r.statusText;
    throw new Error(`[AdminGraphQL] ${r.status} ${msg}`);
  }
  return body.data;
}

// ======================================================================
// App Proxy endpoints (storefront)
// ======================================================================

// --- UPDATE PROFILE (NEW) ----------------------------------------------
// Theme should POST JSON to /apps/tickets/update-profile (matches PROXY_MOUNT)
// Required body: { customer_id, first_name?, last_name?, phone? }
app.post(`${PROXY_MOUNT}/update-profile`, async (req, res) => {
  try {
    if (!verifyProxySignature(req))
      return res.status(401).json({ ok: false, error: "invalid_signature" });

    const { customer_id, first_name, last_name, phone } = req.body || {};
    if (!customer_id)
      return res.status(400).json({ ok: false, error: "missing_customer_id" });

    // Extra safety: ensure the logged in customer (from proxy) matches payload.
    // Shopify includes logged_in_customer_id in App Proxy querystring when available.
    const loggedId = String(req.query.logged_in_customer_id || "").trim();
    if (loggedId && String(customer_id) !== loggedId) {
      return res.status(403).json({ ok: false, error: "customer_mismatch" });
    }

    const gid = `gid://shopify/Customer/${customer_id}`;

    const gql = `
      mutation UpdateCustomer($id: ID!, $first: String, $last: String, $phone: String) {
        customerUpdate(input:{ id:$id, firstName:$first, lastName:$last, phone:$phone }) {
          userErrors { field message }
          customer { id }
        }
      }
    `;

    const data = await adminGraphQL(gql, {
      id: gid,
      first: first_name || null,
      last: last_name || null,
      phone: (phone || "").trim() || null,
    });

    const errs = data?.customerUpdate?.userErrors;
    if (errs && errs.length) {
      return res.status(400).json({ ok: false, error: errs[0].message || "update_failed" });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[update-profile]", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
// ----------------------------------------------------------------------

// Existing ticket endpoints
app.post(`${PROXY_MOUNT}/attach-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req))
      return res.status(401).json({ ok: false, error: "invalid_signature" });

    const {
      order_id,
      ticket_id,
      status = "pending",
      issue = "",
      message = "",
      phone = "",
      email = "",
      name = "",
      order_name = "",
      created_at,
      // NEW: explicit reopen flag allowed from storefront
      reopen
    } = req.body || {};

    if (!order_id || !ticket_id) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_fields", fields: ["order_id", "ticket_id"] });
    }

    const orderGid = `gid://shopify/Order/${String(order_id)}`;

    const d1 = await adminGraphQL(
      `query GetOrder($id: ID!) { order(id: $id) { id name tickets: metafield(namespace:"support", key:"tickets"){ id value } } }`,
      { id: orderGid }
    );

    let map = {};
    const mf = d1?.order?.tickets;
    if (mf?.value) {
      try { map = JSON.parse(mf.value); } catch { map = {}; }
    }

    const now = new Date().toISOString();
    const prev = map[ticket_id] || {};
    let st = normalizeStatus(status);

    // Reopen rule — only customer via proxy can reopen closed
    const wantsReopen =
      truthy(reopen) || String(status || "").toLowerCase() === "reopen";

    if (isClosed(prev.status)) {
      if (!wantsReopen) {
        return res.status(423).json({ ok: false, error: "ticket_closed_use_reopen" });
      }
      st = "pending"; // reopen → back to pending
    }

    map[ticket_id] = {
      ticket_id,
      status: st,
      issue: issue || prev.issue || "",
      message: message || prev.message || "",
      phone: phone || prev.phone || "",
      email: email || prev.email || "",
      name: name || prev.name || "",
      order_id,
      order_name: order_name || d1?.order?.name || prev.order_name || "",
      created_at: prev.created_at || created_at || now,
      updated_at: now,
      reopened_at: (isClosed(prev.status) && wantsReopen) ? now : (prev.reopened_at || undefined),
      reopened_by: (isClosed(prev.status) && wantsReopen) ? "customer" : (prev.reopened_by || undefined),
    };

    const d2 = await adminGraphQL(
      `mutation Save($ownerId:ID!, $value:String!, $tid:String!, $st:String!){
        metafieldsSet(metafields:[
          { ownerId:$ownerId, namespace:"support", key:"tickets", type:"json", value:$value },
          { ownerId:$ownerId, namespace:"support", key:"ticket_id", type:"single_line_text_field", value:$tid },
          { ownerId:$ownerId, namespace:"support", key:"ticket_status", type:"single_line_text_field", value:$st }
        ]) { userErrors { field message } }
      }`,
      { ownerId: orderGid, value: JSON.stringify(map), tid: ticket_id, st: st }
    );

    const err = d2?.metafieldsSet?.userErrors?.[0];
    if (err) throw new Error(err.message);

    res.json({ ok: true, ticket: map[ticket_id] });
  } catch (e) {
    console.error("[attach-ticket]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get(`${PROXY_MOUNT}/find-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req))
      return res.status(401).json({ ok: false, error: "invalid_signature" });

    const ticket_id = String(req.query.ticket_id || "").trim();
    const order_id = String(req.query.order_id || "").trim();
    if (!ticket_id) return res.status(400).json({ ok: false, error: "missing ticket_id" });
    if (!order_id) return res.status(400).json({ ok: false, error: "missing order_id" });

    const orderGid = `gid://shopify/Order/${order_id}`;
    const d = await adminGraphQL(
      `query GetOrderForTicket($id: ID!) {
        order(id: $id) {
          id name createdAt
          tickets: metafield(namespace:"support", key:"tickets"){ value }
          tId:     metafield(namespace:"support", key:"ticket_id"){ value }
          tStatus: metafield(namespace:"support", key:"ticket_status"){ value }
        }
      }`,
      { id: orderGid }
    );

    const order = d?.order;
    if (!order) return res.json({ ok: false, error: "order_not_found" });

    let ticket = null, status = null;

    const json = order.tickets?.value;
    if (json) try {
      const map = JSON.parse(json);
      if (map && map[ticket_id]) { ticket = map[ticket_id]; status = ticket.status || null; }
    } catch {}

    if (!ticket && order.tId?.value === ticket_id) {
      ticket = { ticket_id, status: order.tStatus?.value || "pending" };
      status = ticket.status;
    }

    if (!ticket) return res.json({ ok: false, error: "ticket_not_found" });

    res.json({
      ok: true,
      ticket,
      status: status || "pending",
      order_id,
      order_name: order.name,
      order_created_at: order.createdAt,
    });
  } catch (e) {
    console.error("[find-ticket]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ======================================================================
// Admin (programmatic) API
// ======================================================================
const ADMIN_UI_KEY = process.env.ADMIN_UI_KEY || "";
function requireAdmin(req, res, next) {
  const bearer = String(req.headers.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const xkey = String(req.headers["x-admin-ui-key"] || "").trim();
  if (ADMIN_UI_KEY && (bearer === ADMIN_UI_KEY || xkey === ADMIN_UI_KEY)) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-UI-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function collectTickets({ since, status, limit = 200 }) {
  const out = [];
  let after = null;
  const max = Math.min(Number(limit || 200), 1000);
  const shopQuery = since ? `updated_at:>=${since}` : null;

  while (out.length < max) {
    const data = await adminGraphQL(
      `query Orders($first:Int!,$after:String,$query:String){
        orders(first:$first, after:$after, query:$query, sortKey:UPDATED_AT, reverse:true){
          edges{
            cursor
            node{
              id name createdAt updatedAt
              mfJSON: metafield(namespace:"support", key:"tickets"){ value }
              mfId:   metafield(namespace:"support", key:"ticket_id"){ value }
              mfSt:   metafield(namespace:"support", key:"ticket_status"){ value }
            }
          }
          pageInfo{ hasNextPage }
        }
      }`,
      { first: 50, after, query: shopQuery }
    );

    const edges = data?.orders?.edges || [];
    if (!edges.length) break;

    for (const { cursor, node } of edges) {
      const orderId = Number(String(node.id).split("/").pop());
      const base = {
        order_id: orderId,
        order_name: node.name,
        order_created_at: node.createdAt,
        order_updated_at: node.updatedAt,
      };

      let map = {};
      const raw = node.mfJSON?.value;
      if (raw) { try { map = JSON.parse(raw); } catch {} }

      if (Object.keys(map).length) {
        for (const [key, t] of Object.entries(map)) {
          const rec = {
            ...base,
            ticket_id: t.ticket_id || key,
            status: normalizeStatus(t.status) || "pending",
            issue: t.issue || "",
            message: t.message || "",
            phone: t.phone || "",
            email: t.email || "",
            name: t.name || "",
            created_at: t.created_at || base.order_created_at,
            updated_at: t.updated_at || base.order_updated_at,
          };
          if (!status || status === "all" || rec.status === normalizeStatus(status)) {
            out.push(rec);
            if (out.length >= max) break;
          }
        }
      } else if (node.mfId?.value) {
        const rec = {
          ...base,
          ticket_id: node.mfId.value,
          status: normalizeStatus(node.mfSt?.value || "pending"),
          issue: "",
          message: "",
          phone: "",
          email: "",
          name: "",
          created_at: base.order_created_at,
          updated_at: base.order_updated_at,
        };
        if (!status || status === "all" || rec.status === normalizeStatus(status)) out.push(rec);
      }
      if (out.length >= max) break;
      after = cursor;
    }
    if (!data?.orders?.pageInfo?.hasNextPage) break;
  }

  return out.slice(0, max);
}

app.get("/admin/tickets", requireAdmin, async (req, res) => {
  try {
    const { since, status, limit } = req.query || {};
    const tickets = await collectTickets({
      since,
      status: normalizeStatus(status),
      limit,
    });
    res.json({ ok: true, count: tickets.length, tickets });
  } catch (e) {
    console.error("GET /admin/tickets", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/admin/tickets/update", requireAdmin, async (req, res) => {
  try {
    const { order_id, ticket_id } = req.body || {};
    const status = normalizeStatus(req.body?.status || "pending");
    if (!order_id || !ticket_id)
      return res.status(400).json({ ok: false, error: "missing order_id/ticket_id" });

    const orderGid = `gid://shopify/Order/${order_id}`;
    const d1 = await adminGraphQL(
      `query GetOrder($id:ID!){ order(id:$id){ name metafield(namespace:"support", key:"tickets"){ value } } }`,
      { id: orderGid }
    );

    let map = {};
    const raw = d1?.order?.metafield?.value;
    if (raw) { try { map = JSON.parse(raw); } catch {} }

    const now = new Date().toISOString();
    const prev = map[ticket_id] || {};

    // HARD LOCK for admins: cannot update once closed
    if (isClosed(prev.status)) {
      return res.status(423).json({ ok:false, error:"ticket_closed_admin_locked" });
    }

    map[ticket_id] = {
      ...(prev || {}),
      ticket_id,
      status,
      order_id,
      order_name: prev.order_name || d1?.order?.name || "",
      created_at: prev.created_at || now,
      updated_at: now,
    };

    const d2 = await adminGraphQL(
      `mutation Save($ownerId:ID!, $value:String!, $tid:String!, $st:String!){
        metafieldsSet(metafields:[
          { ownerId:$ownerId, namespace:"support", key:"tickets", type:"json", value:$value },
          { ownerId:$ownerId, namespace:"support", key:"ticket_id", type:"single_line_text_field", value:$tid },
          { ownerId:$ownerId, namespace:"support", key:"ticket_status", type:"single_line_text_field", value:$st }
        ]) { userErrors { field message } }
      }`,
      { ownerId: orderGid, value: JSON.stringify(map), tid: ticket_id, st: status }
    );

    const err = d2?.metafieldsSet?.userErrors?.[0];
    if (err) throw new Error(err.message);

    res.json({ ok: true, ticket: map[ticket_id] });
  } catch (e) {
    console.error("POST /admin/tickets/update", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ======================================================================
// Admin UI (Branded login + cookie session + panel)
// ======================================================================
const UI_USER = process.env.UI_USER || "admin";
const UI_PASS = process.env.UI_PASS || "change-me";
const UI_SESSION_SECRET =
  process.env.UI_SESSION_SECRET || ADMIN_UI_KEY || "change-me";
function sign(s) { return crypto.createHmac("sha256", UI_SESSION_SECRET).update(s).digest(s ? "hex" : "hex"); }
function makeToken(hours = 12) {
  const exp = Date.now() + hours * 3600 * 1000;
  const p = String(exp);
  return `${p}.${crypto.createHmac("sha256", UI_SESSION_SECRET).update(p).digest("hex")}`;
}
function verifyToken(t){
  if(!t) return false;
  const [exp,sig]=String(t).split(".");
  return (sig===crypto.createHmac("sha256", UI_SESSION_SECRET).update(exp).digest("hex")) && (+exp > Date.now());
}
function isSecure(req){
  return (req.headers["x-forwarded-proto"] || req.protocol) === "https";
}

// Cookie helpers for UI
function uiCookieValid(req) {
  const tok = req.cookies?.ui_session;
  return tok && verifyToken(tok);
}

// For page routes: redirect to /admin/login if not signed in
function requireUIPage(req, res, next) {
  if (uiCookieValid(req)) return next();
  const nextUrl = encodeURIComponent(req.originalUrl || "/admin/panel");
  return res.redirect(`/admin/login?next=${nextUrl}`);
}

// For JSON/XHR routes: return JSON 401 if not signed in (no browser popup)
function requireUIAuth(req, res, next) {
  if (uiCookieValid(req)) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// Rate limit login attempts
const loginLimiter = rateLimit({ windowMs: 5 * 60_000, max: 30 });

// Login page (GET)
app.get("/admin/login", (req, res) => {
  if (uiCookieValid(req)) return res.redirect("/admin/panel");

  const nonce = crypto.randomBytes(16).toString("base64");
  const err = String(req.query.err || "") === "1";
  const nextPath = String(req.query.next || "/admin/panel");

  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'`
  );

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ZUVIC • Staff sign in</title>
<style>
  :root{
    --bg:#0b1222; --bg2:#0e1a33; --card:#ffffff; --ink:#0f172a;
    --muted:#6b7280; --brand:#2455f4; --brand2:#3b7bff; --line:#e5e7eb;
  }
  *{box-sizing:border-box}
  body{
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
    background:radial-gradient(1200px 600px at 50% 20%, #0f1b36 0%, var(--bg) 50%, var(--bg2) 100%);
    font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; color:#fff;
  }
  .card{
    width:min(440px,94vw);
    background:var(--card); color:var(--ink);
    border-radius:22px; border:1px solid rgba(255,255,255,.08);
    box-shadow:0 40px 90px rgba(0,0,0,.45), 0 2px 0 rgba(0,0,0,.06) inset;
    overflow:hidden;
  }
  .head{padding:28px 28px 6px}
  .brand{display:flex;gap:12px;align-items:center}
  .logo{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;
        background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; font-weight:800}
  .title{font-size:20px;font-weight:800}
  .sub{font-size:12px;color:var(--muted)}
  .body{padding:10px 28px 24px}
  label{font-size:12px;color:var(--muted);display:block;margin:14px 0 6px}
  input[type="text"], input[type="password"]{
    width:100%; height:44px; border:1px solid var(--line); border-radius:12px; padding:0 12px; font-size:14px; outline:none;
  }
  .btn{
    width:100%; height:46px; margin-top:16px; border:0; border-radius:12px;
    background:linear-gradient(180deg,var(--brand),var(--brand2)); color:#fff; font-weight:800; cursor:pointer;
  }
  .btn:active{transform:translateY(1px)}
  .err{margin-top:10px;color:#991b1b;background:#fee2e2;border:1px solid #fecaca;padding:10px;border-radius:10px;font-size:13px}
  .foot{padding:14px 28px 26px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between}
</style>
</head>
<body>
  <form class="card" method="post" action="/admin/login">
    <div class="head">
      <div class="brand">
        <div class="logo">Z</div>
        <div>
          <div class="title">Staff sign in</div>
          <div class="sub">ZUVIC Support Admin</div>
        </div>
      </div>
    </div>
    <div class="body">
      ${err ? `<div class="err">Invalid username or password.</div>` : ``}
      <input type="hidden" name="next" value="${nextPath}">
      <label>Username</label>
      <input name="username" type="text" autocomplete="username" spellcheck="false" required>
      <label>Password</label>
      <input name="password" type="password" autocomplete="current-password" required>
      <button class="btn" type="submit">Sign in</button>
    </div>
    <div class="foot">
      <span>© ${new Date().getFullYear()} ZUVIC</span>
      <span>Secure area</span>
    </div>
  </form>
</body>
</html>`);
});

// Login POST: set signed cookie and redirect
app.post("/admin/login", loginLimiter, express.urlencoded({ extended: false }), (req, res) => {
  const nextPath = String(req.body.next || "/admin/panel");
  const user = String(req.body.username || "");
  const pass = String(req.body.password || "");
  const remember = false; // always 12h session

  if (user === (process.env.UI_USER || "admin") && pass === (process.env.UI_PASS || "change-me")) {
    const exp = Date.now() + 12 * 3600 * 1000;
    const tok = `${exp}.${crypto.createHmac("sha256", (process.env.UI_SESSION_SECRET || process.env.ADMIN_UI_KEY || "change-me")).update(String(exp)).digest("hex")}`;
    res.cookie("ui_session", tok, {
      httpOnly: true,
      sameSite: "Strict",
      secure: (req.headers["x-forwarded-proto"] || req.protocol) === "https",
      path: "/admin",
    });
    return res.redirect(nextPath);
  }
  return res.redirect(`/admin/login?err=1&next=${encodeURIComponent(nextPath)}`);
});

// Logout → back to login
app.get("/admin/logout", (req, res) => {
  res.clearCookie("ui_session", { path: "/admin" });
  return res.redirect("/admin/login");
});

// /admin/panel — (unchanged UI code trimmed for brevity in this comment)
//  ... [the rest of your Admin UI routes and JS remain exactly as in your file] ...

// Admin UI JSON for panel (cookie-guarded)
app.get("/admin/ui/tickets", requireUIAuth, async (req, res) => {
  try {
    const { since, status = "all", limit = 200 } = req.query || {};
    const tickets = await collectTickets({ since, status: normalizeStatus(status), limit });
    res.json({ ok: true, count: tickets.length, tickets });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
app.post("/admin/ui/update", requireUIAuth, async (req, res) => {
  try {
    const { order_id, ticket_id } = req.body || {};
    const status = normalizeStatus(req.body?.status || "pending");
    const reply  = typeof req.body?.reply === "string" ? req.body.reply.slice(0, 4000) : undefined;
    if (!order_id || !ticket_id)
      return res.status(400).json({ ok: false, error: "missing order_id/ticket_id" });

    const orderGid = `gid://shopify/Order/${order_id}`;
    const d1 = await adminGraphQL(
      `query GetOrder($id:ID!){ order(id:$id){ name metafield(namespace:"support", key:"tickets"){ value } } }`,
      { id: orderGid }
    );

    let map = {};
    const raw = d1?.order?.metafield?.value;
    if (raw) { try { map = JSON.parse(raw); } catch {} }

    const now = new Date().toISOString();
    const prev = map[ticket_id] || {};

    // HARD LOCK for UI/Admin: cannot update once closed
    if (isClosed(prev.status)) {
      return res.status(423).json({ ok:false, error:"ticket_closed_admin_locked" });
    }

    map[ticket_id] = {
      ...(prev || {}),
      ticket_id,
      status,
      order_id,
      order_name: prev.order_name || d1?.order?.name || "",
      created_at: prev.created_at || now,
      updated_at: now,
      ...(reply !== undefined ? { admin_reply: reply } : {})
    };

    const d2 = await adminGraphQL(
      `
      mutation Save($ownerId:ID!, $value:String!, $tid:String!, $st:String!){
        metafieldsSet(metafields:[
          { ownerId:$ownerId, namespace:"support", key:"tickets", type:"json", value:$value },
          { ownerId:$ownerId, namespace:"support", key:"ticket_id", type:"single_line_text_field", value:$tid },
          { ownerId:$ownerId, namespace:"support", key:"ticket_status", type:"single_line_text_field", value:$st }
        ]) { userErrors { field message } }
      }`,
      { ownerId: orderGid, value: JSON.stringify(map), tid: ticket_id, st: status }
    );

    const err = d2?.metafieldsSet?.userErrors?.[0];
    if (err) throw new Error(err.message);

    res.json({ ok: true, ticket: map[ticket_id] });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------
app.listen(PORT, () =>
  console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT} api=${API_VERSION}`)
);
