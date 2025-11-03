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

function normalizeStatus(s) {
  const v = String(s || "").toLowerCase();
  if (v === "in progress" || v === "processing") return "in_progress";
  if (["pending", "in_progress", "resolved", "closed", "all"].includes(v)) return v;
  return "all";
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
    } = req.body || {};

    if (!order_id || !ticket_id) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_fields", fields: ["order_id", "ticket_id"] });
    }

    const st = normalizeStatus(status);
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
    };

    const d2 = await adminGraphQL(
      `mutation Save($ownerId:ID!, $value:String!, $tid:String!, $st:String!){
        metafieldsSet(metafields:[
          { ownerId:$ownerId, namespace:"support", key:"tickets", type:"json", value:$value },
          { ownerId:$ownerId, namespace:"support", key:"ticket_id", type:"single_line_text_field", value:$tid },
          { ownerId:$ownerId, namespace:"support", key:"ticket_status", type:"single_line_text_field", value:$st }
        ]) { userErrors { field message } }
      }`,
      { ownerId: orderGid, value: JSON.stringify(map), tid: ticket_id, st }
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
function sign(s) { return crypto.createHmac("sha256", UI_SESSION_SECRET).update(s).digest("hex"); }
function makeToken(hours = 12) {
  const exp = Date.now() + hours * 3600 * 1000;
  const p = String(exp);
  return `${p}.${sign(p)}`;
}
function verifyToken(t){
  if(!t) return false;
  const [exp,sig]=String(t).split(".");
  return (sig===sign(exp)) && (+exp > Date.now());
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

// Login page (GET) — minimal, premium, no eye/remember/back link
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

  if (user === UI_USER && pass === UI_PASS) {
    const token = makeToken(remember ? 72 : 12); // 72h if remembered, else 12h
    res.cookie("ui_session", token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: isSecure(req),
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

// /admin/panel — full-width, no horizontal scroll, live updates + modal
app.get("/admin/panel", requireUIPage, (req, res) => {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'`
  );

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ZUVIC • Support tickets</title>
<style>
  :root{
    --bg:#ffffff; --fg:#0f172a; --muted:#64748b; --card:#fff;
    --border:#e5e7eb; --primary:#1d4ed8; --pill:#eef2ff; --pillfg:#3730a3;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
  body.modal-open{overflow:hidden}
  a{color:#1d4ed8;text-decoration:none}
  .wrap{padding:20px 20px 32px}
  .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .title{font-size:24px;font-weight:700}
  .logout{color:var(--primary)}
  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px}

  /* Tabs */
  .tabs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}
  .chip{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:999px;border:1px solid var(--border);background:#1D4ED8;cursor:pointer;font-size:13px}
  .chip.active{background:var(--primary);border-color:var(--primary);color:#fff}
  .chip .count{opacity:.9}

  /* Filters (global across pages) */
  .filters{
    display:grid;
    grid-template-columns: minmax(130px,160px) minmax(140px,180px) minmax(90px,120px) 1fr auto auto;
    gap:8px;
    margin-bottom:10px;
    align-items:end;
  }
  .filters > label{font-size:11px;color:var(--muted);display:grid;gap:5px;margin:0}
  select,input,button{height:34px;border:1px solid var(--border);border-radius:8px;background:#fff;color:#fff;font-size:13px}
  select,input{color:var(--fg);padding:0 10px}
  .filters > button{align-self:end}
  button.btn{border-color:var(--primary);background:var(--primary);color:#fff;cursor:pointer}
  button.ghost{background:#fff;color:#111}

  @media (max-width: 900px){
    .filters{grid-template-columns: 1fr 1fr 1fr; grid-auto-rows:minmax(34px,auto)}
    .filters > button{justify-self:start}
  }
  @media (max-width: 600px){
    .filters{grid-template-columns: 1fr; }
    .filters > button{width:100%}
  }

  .table-wrap{border:1px solid var(--border);border-radius:12px;background:#fff;overflow-x:auto}
  table{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed}
  col.order   {width:16%}
  col.ticket  {width:12%}
  col.status  {width:12%}
  col.issue   {width:12%}
  col.customer{width:12%}
  col.when    {width:12%}
  col.when2   {width:12%}
  col.actions {width:12%}
  thead th{position:sticky;top:0;background:#fafafa;z-index:2}
  th,td{padding:10px 12px;vertical-align:middle;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  th+th, td+td{border-left:1px solid var(--border)}
  tbody tr+tr td{border-top:1px solid var(--border)}

  .order small{display:block;color:var(--muted);margin-top:2px}
  .pill{display:inline-block;padding:3px 9px;border-radius:999px;background:var(--pill);color:var(--pillfg);font-size:12px}

  td.actions{overflow:visible}
  .actions-cell{
    display:flex;
    gap:8px;
    align-items:center;
    white-space:nowrap;
    flex-wrap:wrap;
  }
  .actions-cell select{
    min-width:140px;
    flex:1 1 140px;
  }
  .save-btn{
    height:34px;border-radius:8px;background:var(--primary);color:#fff;border:0;padding:0 14px;cursor:pointer;
    flex:0 0 auto;
  }

  @media (max-width: 900px){
    table{table-layout:auto}
    colgroup col{width:auto !important}
  }
  @media (max-width: 600px){
    .actions-cell{flex-direction:column; align-items:stretch}
    .actions-cell select{width:100%}
    .save-btn{width:100%}
  }

  .muted{color:var(--muted)}
  .toast{position:fixed;right:14px;bottom:14px;background:#111827;color:#fff;padding:9px 11px;border-radius:10px;opacity:0;transform:translateY(8px);transition:.2s}
  .toast.show{opacity:1;transform:translateY(0)}

  .overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);display:none;align-items:center;justify-content:center;padding:12px;z-index:9999}
  .overlay.show{display:flex}
  .modal{width:min(920px,96vw);background:#fff;border-radius:16px;border:1px solid var(--border);box-shadow:0 28px 70px rgba(0,0,0,.25)}
  .modal .head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)}
  .modal .head .h{font-weight:700}
  .modal .body{padding:14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .modal label{font-size:11px;color:var(--muted)}
  .modal input, .modal select, .modal textarea{width:100%;height:38px;border:1px solid var(--border);border-radius:10px;padding:0 10px;font-size:13px}
  .modal textarea{height:110px;padding:8px 10px;resize:vertical}
  .modal .foot{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border)}
  .modal .btn{height:40px;border-radius:10px;border:0;padding:0 14px;cursor:pointer}
  .modal .primary{background:var(--primary);color:#fff}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div class="title">Support tickets</div>
    <a class="logout" href="/admin/logout">Logout</a>
  </div>

  <div class="card">
    <div class="tabs" id="tabs">
      <button class="chip active" data-status="all">All <span class="count" id="c_all">0</span></button>
      <button class="chip" data-status="pending">Pending <span class="count" id="c_pending">0</span></button>
      <button class="chip" data-status="in_progress">In progress <span class="count" id="c_in_progress">0</span></button>
      <button class="chip" data-status="resolved">Resolved <span class="count" id="c_resolved">0</span></button>
      <button class="chip" data-status="closed">Closed <span class="count" id="c_closed">0</span></button>
    </div>

    <div class="filters">
      <label>Status
        <select id="st">
          <option value="all">all</option>
          <option value="pending">pending</option>
          <option value="in_progress">in_progress</option>
          <option value="resolved">resolved</option>
          <option value="closed">closed</option>
        </select>
      </label>
      <label>Updated since
        <input id="since" type="date"/>
      </label>
      <label>Limit
        <input id="lim" type="number" min="1" max="1000" value="200"/>
      </label>
      <label>Search (ticket/order/name/email)
        <input id="q" placeholder="Type to filter…"/>
      </label>
      <button id="go" class="btn">Refresh</button>
      <button id="clr" class="btn ghost" type="button">Clear</button>
    </div>

    <div class="table-wrap">
      <table id="tbl">
        <colgroup>
          <col class="order"><col class="ticket"><col class="status"><col class="issue">
          <col class="customer"><col class="when"><col class="when2"><col class="actions">
        </colgroup>
        <thead>
          <tr>
            <th>Order</th><th>Ticket</th><th>Status</th><th>Issue</th>
            <th>Customer</th><th>Created</th><th>Updated</th><th>Actions</th>
          </tr>
        </thead>
        <tbody><tr><td colspan="8" class="muted">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<div id="overlay" class="overlay" role="dialog" aria-modal="true">
  <div class="modal">
    <div class="head">
      <div class="h" id="mh"></div>
      <button id="mx" class="btn ghost" style="height:34px;border:1px solid var(--border);border-radius:8px">✕</button>
    </div>
    <div class="body">
      <label>Ticket ID <input id="m_tid" readonly></label>
      <label>Order <input id="m_order" readonly></label>
      <label>Status
        <select id="m_status">
          <option value="pending">pending</option>
          <option value="in_progress">in_progress</option>
          <option value="resolved">resolved</option>
          <option value="closed">closed</option>
        </select>
      </label>
      <label>Issue   <input id="m_issue"  readonly></label>
      <label>Name    <input id="m_name"   readonly></label>
      <label>Email   <input id="m_email"  readonly></label>
      <label>Phone   <input id="m_phone"  readonly></label>
      <label>Message <textarea id="m_message" readonly></textarea></label>
      <label>Reply customer <textarea id="m_reply" placeholder="Type your reply to customer… (optional)"></textarea></label>
      <label>Created <input id="m_created" readonly></label>
      <label>Updated <input id="m_updated" readonly></label>
    </div>
    <div class="foot">
      <button id="msave" class="btn primary">Save</button>
      <button id="mclose" class="btn">Close</button>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script nonce="${nonce}">
(function(){
  const $  = (s)=>document.querySelector(s);
  const $$ = (s)=>document.querySelectorAll(s);
  const esc = (v)=> String(v ?? "").replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const fmt = (d)=> d ? new Date(d).toLocaleString() : "—";
  const pill = (s)=> '<span class="pill">'+esc(String(s||"").replace(/_/g," "))+'</span>';
  const show = (msg)=>{ const t=$("#toast"); t.textContent=msg; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"), 1100); };

  let currentStatus = "all";
  let cacheTickets  = [];

  function counts(list){
    const c = { all:list.length, pending:0, in_progress:0, resolved:0, closed:0 };
    list.forEach(t => { const s=(t.status||"pending").toLowerCase(); if (c[s]!=null) c[s]++; });
    $("#c_all").textContent=c.all; $("#c_pending").textContent=c.pending; $("#c_in_progress").textContent=c.in_progress; $("#c_resolved").textContent=c.resolved; $("#c_closed").textContent=c.closed;
  }

  function orderCell(t){
    const id = t.order_id ? String(t.order_id) : "—";
    const name = t.order_name ? String(t.order_name) : "—";
    return '<div class="order"><div>'+esc(name)+'</div><small>ID: '+esc(id)+'</small></div>';
  }

  function row(t){
    const order = orderCell(t);
    const ticketLink = '<a href="#" class="ticket-link" data-tid="'+esc(t.ticket_id)+'">'+esc(t.ticket_id)+'</a>';
    return \`<tr data-row="\${esc(t.ticket_id)}">
      <td>\${order}</td>
      <td>\${ticketLink}</td>
      <td>\${pill(t.status)}</td>
      <td>\${esc(t.issue || "—")}</td>
      <td>\${esc(t.name || "—")}</td>
      <td>\${fmt(t.created_at)}</td>
      <td>\${fmt(t.updated_at)}</td>
      <td class="actions">
        <div class="actions-cell">
          <select class="set">
            <option value="pending" \${t.status==="pending"?"selected":""}>pending</option>
            <option value="in_progress" \${t.status==="in_progress"?"selected":""}>in_progress</option>
            <option value="resolved" \${t.status==="resolved"?"selected":""}>resolved</option>
            <option value="closed" \${t.status==="closed"?"selected":""}>closed</option>
          </select>
          <button class="save-btn save" data-oid="\${t.order_id}" data-tid="\${esc(t.ticket_id)}">Save</button>
        </div>
      </td>
    </tr>\`;
  }

  function applyFilter(list){
    const q = ($("#q").value||"").toLowerCase();
    return list.filter(t => {
      const byStatus = currentStatus==="all" ? true : (String(t.status).toLowerCase()===currentStatus);
      if (!byStatus) return false;
      if (!q) return true;
      return [t.ticket_id,t.order_name,t.name,t.email].filter(Boolean).some(x=>String(x).toLowerCase().includes(q));
    });
  }

  function render(list){
    counts(list);
    const rows = applyFilter(list).map(row).join("") || '<tr><td colspan="8" class="muted">No tickets</td></tr>';
    $("#tbl tbody").innerHTML = rows;

    $("#tbl").querySelectorAll(".save").forEach(btn=>{
      btn.onclick = async ()=>{
        const tr = btn.closest("tr");
        const status = tr.querySelector(".set").value;
        const body = { order_id: btn.dataset.oid, ticket_id: btn.dataset.tid, status };
        const r = await fetch("/admin/ui/update", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), credentials:"include" });
        const j = await r.json().catch(()=>({ok:false,error:"bad_json"}));
        if(!j.ok){ alert("Update failed: " + (j.error||"unexpected")); return; }
        const idx = cacheTickets.findIndex(x => String(x.ticket_id)===String(j.ticket.ticket_id));
        if(idx>=0) cacheTickets[idx] = { ...cacheTickets[idx], ...j.ticket };
        else cacheTickets.push(j.ticket);
        show("Updated");
        render(cacheTickets);
      };
    });

    $("#tbl").querySelectorAll(".ticket-link").forEach(a=>{
      a.onclick = (e)=>{
        e.preventDefault();
        const t = cacheTickets.find(x => String(x.ticket_id)===String(a.dataset.tid));
        if(!t) return;
        $("#mh").textContent = "Ticket • " + t.ticket_id;
        $("#m_tid").value = t.ticket_id || "";
        $("#m_order").value = (t.order_name || "") + (t.order_id ? "  (ID: "+t.order_id+")" : "");
        $("#m_status").value = t.status || "pending";
        $("#m_issue").value  = t.issue || "";
        $("#m_name").value   = t.name || "";
        $("#m_email").value  = t.email || "";
        $("#m_phone").value  = t.phone || "";
        $("#m_message").value= t.message || "";
        $("#m_reply").value  = t.admin_reply || "";
        $("#m_created").value= fmt(t.created_at);
        $("#m_updated").value= fmt(t.updated_at);
        $("#overlay").classList.add("show");
        document.body.classList.add("modal-open");
      };
    });
  }

  async function load(){
    const qs = new URLSearchParams({
      status: $("#st").value || "all",
      since:  $("#since").value || "",
      limit:  $("#lim").value  || 200
    });
    const r = await fetch("/admin/ui/tickets?"+qs.toString(), { credentials:"include" });
    const j = await r.json().catch(()=>({ok:false,error:"bad_json"}));
    cacheTickets = Array.isArray(j?.tickets) ? j.tickets : [];
    render(cacheTickets);
  }

  $("#tabs").addEventListener("click",(e)=>{
    const b = e.target.closest(".chip"); if(!b) return;
    currentStatus = b.dataset.status;
    $$("#tabs .chip").forEach(x=>x.classList.toggle("active", x===b));
    $("#st").value = currentStatus;
    render(cacheTickets);
  });
  $("#st").onchange = ()=>{ currentStatus=$("#st").value; $$("#tabs .chip").forEach(x=>x.classList.toggle("active", x.dataset.status===currentStatus)); render(cacheTickets); };
  $("#q").oninput = ()=> render(cacheTickets);
  $("#go").onclick  = load;
  $("#clr").onclick = ()=>{ $("#st").value="all"; $("#since").value=""; $("#lim").value=200; $("#q").value=""; currentStatus="all"; $$("#tabs .chip").forEach(x=>x.classList.toggle("active", x.dataset.status==="all")); load(); };

  const closeModal = ()=> { $("#overlay").classList.remove("show"); document.body.classList.remove("modal-open"); };
  $("#mclose").onclick = closeModal;
  $("#mx").onclick = closeModal;
  $("#overlay").addEventListener("click",(e)=>{ if(e.target.id==="overlay") closeModal(); });

  $("#msave").onclick = async ()=>{
    const tid = $("#m_tid").value;
    const t   = cacheTickets.find(x => String(x.ticket_id)===String(tid));
    if(!t) return;
    const body = {
      order_id: t.order_id,
      ticket_id: t.ticket_id,
      status: $("#m_status").value,
      reply:  $("#m_reply").value
    };
    const r = await fetch("/admin/ui/update", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), credentials:"include" });
    const j = await r.json().catch(()=>({ok:false,error:"bad_json"}));
    if(!j.ok){ alert("Update failed: " + (j.error||"unexpected")); return; }
    const idx = cacheTickets.findIndex(x => String(x.ticket_id)===String(j.ticket.ticket_id));
    if(idx>=0) cacheTickets[idx] = { ...cacheTickets[idx], ...j.ticket };
    closeModal();
    show("Updated");
    render(cacheTickets);
  };

  load();
})();
</script>
</body>
</html>`);
});

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
