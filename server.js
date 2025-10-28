// server.js
// ENVs:
// - SHOPIFY_ADMIN_TOKEN, SHOPIFY_SHOP, PROXY_SECRET
// - PROXY_MOUNT (default "/tickets")
// - SHOPIFY_API_VERSION or API_VERSION (fallback "2024-10")
// - ADMIN_UI_KEY           (Bearer for programmatic admin API)
// - UI_USER, UI_PASS       (Basic auth for HTML admin panel)
// - UI_SESSION_SECRET      (signing key for admin UI cookie; defaults to ADMIN_UI_KEY or "change-me")
// Optional: SKIP_PROXY_VERIFY=1  (skip App Proxy signature verification for local dev)

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
// We disable global CSP and set a route-specific CSP with a nonce on /admin/panel
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
  if (["pending", "in_progress", "resolved", "closed", "all"].includes(v))
    return v;
  return "all";
}

// App Proxy signature helpers (HMAC over sorted query without "signature")
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
    throw new Error(
      "Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN environment variables"
    );
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
// App Proxy endpoints (used from your storefront app proxy)
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
      `
      query GetOrder($id: ID!) {
        order(id: $id) { id name tickets: metafield(namespace:"support", key:"tickets"){ id value } }
      }`,
      { id: orderGid }
    );

    let map = {};
    const mf = d1?.order?.tickets;
    if (mf?.value) {
      try {
        map = JSON.parse(mf.value);
      } catch {
        map = {};
      }
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
      `
      mutation Save($ownerId:ID!, $value:String!, $tid:String!, $st:String!){
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
      `
      query GetOrderForTicket($id: ID!) {
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

    let ticket = null;
    let status = null;

    const json = order.tickets?.value;
    if (json)
      try {
        const map = JSON.parse(json);
        if (map && map[ticket_id]) {
          ticket = map[ticket_id];
          status = ticket.status || null;
        }
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
// Admin (Bearer) API — programmatic
// ======================================================================
const ADMIN_UI_KEY = process.env.ADMIN_UI_KEY || "";
function requireAdmin(req, res, next) {
  const bearer = String(req.headers.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const xkey = String(req.headers["x-admin-ui-key"] || "").trim();
  if (ADMIN_UI_KEY && (bearer === ADMIN_UI_KEY || xkey === ADMIN_UI_KEY))
    return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Admin-UI-Key"
  );
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
      `
      query Orders($first:Int!,$after:String,$query:String){
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
      if (raw) {
        try {
          map = JSON.parse(raw);
        } catch {}
      }

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
        if (!status || status === "all" || rec.status === normalizeStatus(status))
          out.push(rec);
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
      return res
        .status(400)
        .json({ ok: false, error: "missing order_id/ticket_id" });

    const orderGid = `gid://shopify/Order/${order_id}`;
    const d1 = await adminGraphQL(
      `
      query GetOrder($id:ID!){
        order(id:$id){ name metafield(namespace:"support", key:"tickets"){ value } }
      }`,
      { id: orderGid }
    );

    let map = {};
    const raw = d1?.order?.metafield?.value;
    if (raw) {
      try {
        map = JSON.parse(raw);
      } catch {}
    }

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
    console.error("POST /admin/tickets/update", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ======================================================================
// Login + Session (professional HTML form, no browser popup)
// ======================================================================
const UI_USER = process.env.UI_USER || "admin";
const UI_PASS = process.env.UI_PASS || "change-me";
const UI_SESSION_SECRET =
  process.env.UI_SESSION_SECRET || ADMIN_UI_KEY || "change-me";

function sign(s) {
  return crypto.createHmac("sha256", UI_SESSION_SECRET).update(s).digest("hex");
}
function makeToken(hours = 12) {
  const exp = Date.now() + hours * 3600 * 1000;
  const p = String(exp);
  return `${p}.${sign(p)}`;
}
function verifyToken(t) {
  if (!t) return false;
  const [exp, sig] = String(t).split(".");
  return sig === sign(exp) && +exp > Date.now();
}
function isSecure(req) {
  return (req.headers["x-forwarded-proto"] || req.protocol) === "https";
}

function requireUIAuth(req, res, next) {
  const tok = req.cookies?.ui_session;
  if (tok && verifyToken(tok)) return next();
  const target =
    typeof req.originalUrl === "string" && req.originalUrl.startsWith("/")
      ? req.originalUrl
      : "/admin/panel";
  return res.redirect(`/admin/login?next=${encodeURIComponent(target)}`);
}

// GET /admin/login — pretty HTML login page
app.get("/admin/login", (req, res) => {
  const nonce = crypto.randomBytes(16).toString("base64");
  const next =
    typeof req.query.next === "string" && req.query.next.startsWith("/")
      ? req.query.next
      : "/admin/panel";

  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'`
  );

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ZUVIC • Admin Login</title>
<style>
  :root{
    --bg:#0b1220; --card:#0f172a; --fg:#e5e7eb; --muted:#94a3b8;
    --primary:#1d4ed8; --border:#1f2937; --input:#0b1220; --error:#ef4444;
  }
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(135deg,#0b1220,#111827); color:var(--fg); font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; min-height:100vh; display:grid; place-items:center}
  .wrap{width:100%; max-width:420px; padding:24px}
  .card{background:var(--card); border:1px solid var(--border); border-radius:18px; padding:28px; box-shadow:0 20px 60px rgba(0,0,0,.35)}
  .brand{display:flex; align-items:center; gap:10px; margin-bottom:18px}
  .logo{width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg,#1d4ed8,#60a5fa)}
  .title{font-size:22px; font-weight:700}
  .muted{color:var(--muted)}
  label{display:block; font-size:12px; color:var(--muted); margin:14px 0 6px}
  input{width:100%; height:42px; border-radius:10px; border:1px solid var(--border); background:var(--input); color:var(--fg); padding:0 12px; outline:none}
  input:focus{border-color:#334155; box-shadow:0 0 0 4px rgba(59,130,246,.15)}
  .row{display:flex; justify-content:space-between; align-items:center; margin-top:16px}
  button{appearance:none; border:0; height:42px; border-radius:10px; background:var(--primary); color:#fff; padding:0 16px; font-weight:600; cursor:pointer}
  .foot{margin-top:14px; text-align:center; font-size:12px; color:var(--muted)}
  .err{display:none; margin-top:8px; color:#fff; background:rgba(239,68,68,.12); border:1px solid rgba(239,68,68,.5); padding:8px 10px; border-radius:8px}
</style>
</head>
<body>
  <div class="wrap">
    <form class="card" method="post" action="/admin/login">
      <div class="brand">
        <div class="logo"></div>
        <div>
          <div class="title">ZUVIC Admin</div>
          <div class="muted">Sign in to manage support tickets</div>
        </div>
      </div>

      <input type="hidden" name="next" value="${next}"/>

      <label for="u">Username</label>
      <input id="u" name="username" autocomplete="username" required/>

      <label for="p">Password</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required/>

      <div class="row">
        <div class="muted">Protected area</div>
        <button type="submit">Sign in</button>
      </div>

      <div id="err" class="err">Invalid username or password</div>

      <div class="foot">© ${new Date().getFullYear()} ZUVIC</div>
    </form>
  </div>

<script nonce="${nonce}">
  // Enhance: if server responds 401 (AJAX), show inline error without leaving page.
  const form = document.querySelector('form.card');
  form.addEventListener('submit', async (e) => {
    // If JS fails, normal POST works.
    e.preventDefault();
    const data = new FormData(form);
    const r = await fetch('/admin/login', { method:'POST', body:data, credentials:'include' });
    if (r.redirected) { window.location = r.url; return; }
    if (r.status === 401) { document.getElementById('err').style.display='block'; return; }
    try { const j = await r.json(); if (j.ok && j.next) location.href=j.next; else document.getElementById('err').style.display='block'; }
    catch { document.getElementById('err').style.display='block'; }
  });
</script>
</body>
</html>`);
});

// POST /admin/login — verify, set cookie, redirect
app.post("/admin/login", async (req, res) => {
  try {
    const user = String(req.body?.username || "");
    const pass = String(req.body?.password || "");
    const next =
      typeof req.body?.next === "string" && req.body.next.startsWith("/")
        ? req.body.next
        : "/admin/panel";

    if (user === UI_USER && pass === UI_PASS) {
      const token = makeToken(12);
      res.cookie("ui_session", token, {
        httpOnly: true,
        sameSite: "Strict",
        secure: isSecure(req),
        path: "/admin",
      });
      // Prefer redirect (works with plain form submit); JS will follow too.
      return res.redirect(next);
    }
    // Invalid
    return res.status(401).json({ ok: false, error: "invalid_credentials" });
  } catch {
    return res.status(500).json({ ok: false, error: "login_failed" });
  }
});

// GET /admin/logout — clear cookie and send to login
app.get("/admin/logout", (req, res) => {
  res.clearCookie("ui_session", { path: "/admin" });
  res.redirect("/admin/login");
});

// ----------------------------------------------------------------------
// Admin Panel page (now uses requireUIAuth instead of Basic)
app.get("/admin/panel", requireUIAuth, (req, res) => {
  const panelPath = path.join(__dirname, "public", "admin-panel.html");
  if (fs.existsSync(panelPath)) return res.sendFile(panelPath);

  // Per-request nonce for inline script
  const nonce = crypto.randomBytes(16).toString("base64");
  // Route-specific CSP header that allows our inline script+inline styles
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'`
  );

  // (The rest of your inline admin panel HTML stays the same as your current corrected version,
  // including the fixed esc() function and the table UI.)
  // ---- Paste your existing inline panel HTML here (unchanged) ----
  /* … your existing inline admin panel markup … */
});

// ----------------------------------------------------------------------
app.listen(PORT, () =>
  console.log(
    `[server] listening on :${PORT} mount=${PROXY_MOUNT} api=${API_VERSION}`
  )
);
