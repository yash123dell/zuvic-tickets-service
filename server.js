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

// Polyfill fetch if needed
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
// Password-protected HTML Admin Panel (white UI, no horizontal scroll)
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

// Basic helper used on first page load
function requireUIPassword(req, res, next) {
  res.set("Cache-Control", "no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  const hdr = req.headers.authorization || "";
  if (!hdr.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Tickets Admin"');
    return res.status(401).send("Auth required");
  }
  const [user, pass] = Buffer.from(hdr.split(" ")[1], "base64")
    .toString("utf8")
    .split(":");
  if (user === UI_USER && pass === UI_PASS) {
    const token = makeToken(12);
    res.cookie("ui_session", token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: isSecure(req),
      path: "/admin",
    });
    return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Tickets Admin"');
  return res.status(401).send("Auth required");
}

// Accept cookie OR Basic for XHR; if Basic is present, also set cookie.
function requireUIAuth(req, res, next) {
  const tok = req.cookies?.ui_session;
  if (tok && verifyToken(tok)) return next();

  const hdr = req.headers.authorization || "";
  if (hdr.startsWith("Basic ")) {
    const [user, pass] = Buffer.from(hdr.split(" ")[1], "base64")
      .toString("utf8")
      .split(":");
    if (user === UI_USER && pass === UI_PASS) {
      const token = makeToken(12);
      res.cookie("ui_session", token, {
        httpOnly: true,
        sameSite: "Strict",
        secure: isSecure(req),
        path: "/admin",
      });
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Tickets Admin"');
  return res.status(401).send("Auth required");
}

app.get("/admin/logout", (req, res) => {
  res.clearCookie("ui_session", { path: "/admin" });
  res.set("WWW-Authenticate", 'Basic realm="Tickets Admin"');
  res.status(401).send("Logged out");
});

// /admin/panel (white, no horizontal scroll, better actions, modal on ticket click)
app.get("/admin/panel", requireUIPassword, (req, res) => {
  const panelPath = path.join(__dirname, "public", "admin-panel.html");
  if (fs.existsSync(panelPath)) return res.sendFile(panelPath);

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
    --bg:#ffffff; --fg:#0f172a; --muted:#64748b; --card:#ffffff; --border:#e5e7eb; --primary:#1d4ed8;
    --tab:#eef2ff; --tabfg:#3730a3; --row:#ffffff; --divider:#f1f5f9; --pill:#eef2ff; --pillfg:#1e3a8a;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
  a{color:var(--primary);text-decoration:none}

  .wrap{padding:24px;max-width:1400px;margin:0 auto}
  .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
  .title{font-size:28px;font-weight:700}
  .logout{color:var(--primary)}

  .card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px}

  /* Tabs single-row */
  .tabs{display:flex;gap:8px;flex-wrap:nowrap;overflow:auto;white-space:nowrap;margin-bottom:12px}
  .tab{padding:8px 12px;border:1px solid var(--border);border-radius:999px;background:#fff;color:#111;cursor:pointer}
  .tab.active{background:var(--primary);border-color:var(--primary);color:#fff}
  .count{opacity:.85;margin-left:6px}

  /* Filters */
  .filters{display:grid;grid-template-columns:180px 180px 120px 1fr auto auto;gap:10px;margin-bottom:10px;align-items:end}
  label{font-size:12px;color:var(--muted);display:block}
  select,input,button{width:100%;height:36px;border:1px solid var(--border);border-radius:8px;padding:0 10px;background:#fff;color:var(--fg)}
  button{border-color:var(--primary);background:var(--primary);color:#fff;cursor:pointer}
  .ghost{background:#fff;color:#111;border-color:var(--border)}

  /* Table (no horizontal scroll) */
  .table-wrap{border-radius:12px;border:1px solid var(--border);background:#fff}
  table{width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0}
  thead th{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--border);font-weight:600;color:#334155;padding:12px}
  tbody td{padding:12px;border-bottom:1px solid var(--divider);vertical-align:middle}
  tbody tr:last-child td{border-bottom:0}
  td,th{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .muted{color:var(--muted)}
  .ord{font-weight:600}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--pill);color:var(--pillfg);font-size:12px}
  .link{appearance:none;background:none;border:0;padding:0;color:var(--primary);cursor:pointer;font-weight:600}

  /* Actions cell */
  .actions{display:flex;gap:8px;justify-content:flex-end;align-items:center}
  .actions select{min-width:130px}
  .actions button{min-width:76px}

  /* Modal */
  .overlay{position:fixed;inset:0;background:rgba(15,23,42,.35);display:none;align-items:center;justify-content:center;padding:16px}
  .overlay.show{display:flex}
  .modal{width:min(720px,96vw);background:#fff;border-radius:16px;border:1px solid var(--border);box-shadow:0 20px 60px rgba(0,0,0,.15);overflow:hidden}
  .m-head{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
  .m-title{font-size:18px;font-weight:700}
  .m-body{padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .m-row{display:flex;flex-direction:column}
  .m-row label{font-size:12px;color:var(--muted);margin-bottom:6px}
  .m-row input,.m-row textarea,.m-row select{height:38px;border:1px solid var(--border);border-radius:8px;padding:0 10px}
  .m-row textarea{height:88px;padding:10px;resize:vertical}
  .m-foot{padding:14px 16px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px}
  .close{appearance:none;background:none;border:0;font-size:22px;line-height:22px;cursor:pointer;color:#334155}
  .toast{position:fixed;right:16px;bottom:16px;background:#111827;color:#fff;padding:10px 12px;border-radius:10px;opacity:0;transform:translateY(8px);transition:.2s}
  .toast.show{opacity:1;transform:translateY(0)}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div class="title">Support tickets</div>
    <a class="logout" href="/admin/logout" title="Log out">Logout</a>
  </div>

  <div class="card">
    <div class="tabs" id="tabs">
      <button class="tab active" data-status="all">All <span class="count" id="c_all">0</span></button>
      <button class="tab" data-status="pending">Pending <span class="count" id="c_pending">0</span></button>
      <button class="tab" data-status="in_progress">In progress <span class="count" id="c_in_progress">0</span></button>
      <button class="tab" data-status="resolved">Resolved <span class="count" id="c_resolved">0</span></button>
      <button class="tab" data-status="closed">Closed <span class="count" id="c_closed">0</span></button>
    </div>

    <div class="filters">
      <label>Status
        <select id="st">
          <option value="all">All</option>
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
        <input id="lim" type="number" value="200" min="1" max="1000"/>
      </label>
      <label>Search (ticket/order/name/email)
        <input id="q" placeholder="Type to filter…"/>
      </label>
      <button id="go">Refresh</button>
      <button id="clr" class="ghost" type="button">Clear</button>
    </div>

    <div id="err" class="muted" style="display:none"></div>

    <div class="table-wrap">
      <table id="tbl" aria-label="Tickets table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Ticket</th>
            <th>Status</th>
            <th>Issue</th>
            <th>Customer</th>
            <th>Created</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody><tr><td colspan="8" class="muted" style="padding:16px">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- Modal -->
<div id="dlg" class="overlay" role="dialog" aria-modal="true" aria-labelledby="dlg_title">
  <div class="modal">
    <div class="m-head">
      <div id="dlg_title" class="m-title">Ticket</div>
      <button class="close" aria-label="Close dialog">&times;</button>
    </div>
    <div class="m-body">
      <div class="m-row"><label>Ticket ID</label><input id="d_tid" readonly/></div>
      <div class="m-row"><label>Order</label><input id="d_order" readonly/></div>
      <div class="m-row"><label>Status</label>
        <select id="d_status">
          <option value="pending">pending</option>
          <option value="in_progress">in_progress</option>
          <option value="resolved">resolved</option>
          <option value="closed">closed</option>
        </select>
      </div>
      <div class="m-row"><label>Issue</label><input id="d_issue" readonly/></div>
      <div class="m-row"><label>Name</label><input id="d_name" readonly/></div>
      <div class="m-row"><label>Email</label><input id="d_email" readonly/></div>
      <div class="m-row"><label>Phone</label><input id="d_phone" readonly/></div>
      <div class="m-row"><label>Message</label><textarea id="d_message" readonly></textarea></div>
      <div class="m-row"><label>Created</label><input id="d_created" readonly/></div>
      <div class="m-row"><label>Updated</label><input id="d_updated" readonly/></div>
    </div>
    <div class="m-foot">
      <button id="d_save">Save</button>
      <button class="ghost" id="d_close">Close</button>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script nonce="${nonce}">
const $  = (s)=>document.querySelector(s);
const $$ = (s)=>document.querySelectorAll(s);
const esc = (v)=> String(v ?? "").replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const fmt = (d)=> d ? new Date(d).toLocaleString() : "—";
const show = (msg)=>{ const t=$("#toast"); t.textContent=msg; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"), 1200); };
const pill = (s)=> '<span class="pill">'+esc(String(s||"").replace("_"," "))+'</span>';
const cell = (v)=> v ? esc(v) : "—";

let currentStatus = "all";
let cacheTickets  = [];

function setActiveTab(status){
  currentStatus = status;
  $$("#tabs .tab").forEach(btn => btn.classList.toggle("active", btn.dataset.status===status));
  $("#st").value = status;
  render(cacheTickets);
}
function counts(list){
  const c = { all:list.length, pending:0, in_progress:0, resolved:0, closed:0 };
  list.forEach(t => { const s=(t.status||"pending").toLowerCase(); if (c[s]!==undefined) c[s]++; });
  $("#c_all").textContent = c.all;
  $("#c_pending").textContent = c.pending;
  $("#c_in_progress").textContent = c.in_progress;
  $("#c_resolved").textContent = c.resolved;
  $("#c_closed").textContent = c.closed;
}

function orderCell(t){
  const ord = esc(t.order_name || "");
  const id  = esc(t.order_id || "");
  return '<div class="ord">'+ord+'</div><div class="muted">ID: '+id+'</div>';
}

function row(t){
  // ticket link opens modal
  const tlink = '<button class="link ticket" data-oid="'+esc(t.order_id)+'" data-tid="'+esc(t.ticket_id)+'"> '+esc(t.ticket_id)+' </button>';
  return '<tr>'+
    '<td>'+orderCell(t)+'</td>'+
    '<td>'+tlink+'</td>'+
    '<td>'+pill(t.status)+'</td>'+
    '<td title="'+esc(t.issue||"")+'">'+cell(t.issue)+'</td>'+
    '<td title="'+esc(t.name||"")+'">'+cell(t.name)+'</td>'+
    '<td>'+fmt(t.created_at)+'</td>'+
    '<td>'+fmt(t.updated_at)+'</td>'+
    '<td><div class="actions">'+
      '<select class="set">'+
        '<option value="pending" '+(t.status==="pending"?"selected":"")+'>pending</option>'+
        '<option value="in_progress" '+(t.status==="in_progress"?"selected":"")+'>in_progress</option>'+
        '<option value="resolved" '+(t.status==="resolved"?"selected":"")+'>resolved</option>'+
        '<option value="closed" '+(t.status==="closed"?"selected":"")+'>closed</option>'+
      '</select>'+
      '<button class="save" data-oid="'+esc(t.order_id)+'" data-tid="'+esc(t.ticket_id)+'">Save</button>'+
    '</div></td>'+
  '</tr>';
}

function render(list){
  counts(list);
  const q = ($("#q").value||"").toLowerCase();
  const rows = list.filter(t => {
    const byStatus = currentStatus==="all" ? true : (String(t.status).toLowerCase()===currentStatus);
    if (!byStatus) return false;
    if (!q) return true;
    return [t.ticket_id,t.order_name,t.name,t.email].filter(Boolean).some(x=>String(x).toLowerCase().includes(q));
  }).map(row).join("") || '<tr><td colspan="8" class="muted" style="padding:16px">No tickets</td></tr>';
  $("#tbl tbody").innerHTML = rows;

  // bind actions
  $("#tbl").querySelectorAll(".save").forEach(btn=>{
    btn.onclick = async ()=>{
      const tr = btn.closest("tr");
      const status = tr.querySelector(".set").value;
      const body = { order_id: btn.dataset.oid, ticket_id: btn.dataset.tid, status };
      const r2 = await fetch("/admin/ui/update", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), credentials:"include" });
      const j2 = await r2.json().catch(()=>({ok:false,error:"bad_json"}));
      if(!j2.ok) alert("Update failed: " + j2.error);
      else { show("Updated"); load(); }
    };
  });

  $("#tbl").querySelectorAll(".ticket").forEach(a=>{
    a.onclick = ()=> openModal(a.dataset.oid, a.dataset.tid);
  });
}

async function load(){
  $("#err").style.display="none";
  const qs = new URLSearchParams({
    status: $("#st").value || "all",
    since:  $("#since").value || "",
    limit:  $("#lim").value  || 200
  });
  const r = await fetch("/admin/ui/tickets?"+qs.toString(), { credentials:"include" });
  if (r.status === 401) { $("#err").textContent="Auth required. Reload the page."; $("#err").style.display="block"; return; }
  const j = await r.json().catch(()=>({ok:false,error:"bad_json"}));
  if(!j.ok && !Array.isArray(j.tickets)){ $("#err").textContent = "Failed: " + (j.error||"unexpected"); $("#err").style.display="block"; $("#tbl tbody").innerHTML=""; return; }
  const list = Array.isArray(j.tickets) ? j.tickets : j; // accept either {tickets:[]} or [] shape
  cacheTickets = list || [];
  render(cacheTickets);
}

// ----- Modal helpers
function fillModal(t){
  $("#dlg_title").textContent = "Ticket • "+(t.ticket_id||"");
  $("#d_tid").value = t.ticket_id||"";
  $("#d_order").value = (t.order_name||"") + "   (ID: "+(t.order_id||"")+")";
  $("#d_status").value = t.status||"pending";
  $("#d_issue").value = t.issue||"";
  $("#d_name").value = t.name||"";
  $("#d_email").value = t.email||"";
  $("#d_phone").value = t.phone||"";
  $("#d_message").value = t.message||"";
  $("#d_created").value = fmt(t.created_at);
  $("#d_updated").value = fmt(t.updated_at);
  $("#d_save").dataset.oid = t.order_id;
  $("#d_save").dataset.tid = t.ticket_id;
}
function openModal(order_id, ticket_id){
  const t = cacheTickets.find(x=> String(x.order_id)==String(order_id) && String(x.ticket_id)==String(ticket_id));
  if(!t) return;
  fillModal(t);
  $("#dlg").classList.add("show");
}
function closeModal(){ $("#dlg").classList.remove("show"); }

$("#d_close").onclick = closeModal;
$(".close").onclick = closeModal;
$("#dlg").addEventListener("click", (e)=>{ if(e.target.id==="dlg") closeModal(); });

$("#d_save").onclick = async (e)=>{
  const body = { order_id: e.target.dataset.oid, ticket_id: e.target.dataset.tid, status: $("#d_status").value };
  const r = await fetch("/admin/ui/update", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), credentials:"include" });
  const j = await r.json().catch(()=>({ok:false,error:"bad_json"}));
  if(!j.ok) alert("Update failed: " + j.error);
  else { closeModal(); show("Updated"); load(); }
};

// bindings
$("#tabs").addEventListener("click",(e)=>{ const b=e.target.closest(".tab"); if(b) setActiveTab(b.dataset.status); });
$("#st").onchange = ()=> setActiveTab($("#st").value);
$("#go").onclick  = load;
$("#clr").onclick = ()=>{ $("#st").value="all"; $("#since").value=""; $("#lim").value=200; $("#q").value=""; setActiveTab("all"); load(); };
$("#q").oninput   = ()=> render(cacheTickets);

load();
</script>
</body>
</html>`);
});

// Admin UI JSON used by the panel (cookie OR Basic)
app.get("/admin/ui/tickets", requireUIAuth, async (req, res) => {
  try {
    const { since, status = "all", limit = 200 } = req.query || {};
    const tickets = await collectTickets({
      since,
      status: normalizeStatus(status),
      limit,
    });
    res.json({ ok: true, count: tickets.length, tickets });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/admin/ui/update", requireUIAuth, async (req, res) => {
  try {
    const { order_id, ticket_id } = req.body || {};
    const status = normalizeStatus(req.body?.status || "pending");
    if (!order_id || !ticket_id)
      return res
        .status(400)
        .json({ ok: false, error: "missing order_id/ticket_id" });

    const orderGid = `gid://shopify/Order/${order_id}`;
    const d1 = await adminGraphQL(
      `query GetOrder($id:ID!){ order(id:$id){ name metafield(namespace:"support", key:"tickets"){ value } } }`,
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
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------
app.listen(PORT, () =>
  console.log(
    `[server] listening on :${PORT} mount=${PROXY_MOUNT} api=${API_VERSION}`
  )
);
