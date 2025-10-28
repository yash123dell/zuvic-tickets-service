// server.js
// ENVs (required):
// - SHOPIFY_ADMIN_TOKEN, SHOPIFY_SHOP, PROXY_SECRET
// - ADMIN_UI_KEY  (for /admin/tickets API with Bearer token)
// ENVs (optional, for HTML admin panel):
// - UI_USER, UI_PASS
// ENVs (optional tuning):
// - PROXY_MOUNT (default "/support")
// - SHOPIFY_API_VERSION or API_VERSION (default "2024-10")
// - SKIP_PROXY_VERIFY=1  (skip App Proxy signature verification for local dev)

import express from "express";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

const PORT         = process.env.PORT || 3000;
// ⬇️ Your proxy subpath is /support, so make it the default:
const PROXY_MOUNT  = process.env.PROXY_MOUNT || "/support";
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || "";        // e.g. zuvic-in.myshopify.com
const ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION  = process.env.SHOPIFY_API_VERSION || process.env.API_VERSION || "2024-10";
const SKIP_VERIFY  = process.env.SKIP_PROXY_VERIFY === "1";

// Optional UI basic auth (for /admin/panel & /admin/ui/*)
const UI_USER = process.env.UI_USER || "admin";
const UI_PASS = process.env.UI_PASS || "change-me";

// --- health ---
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// ---- App Proxy signature helpers (Shopify computes HMAC over sorted query without "signature")
function expectedHmacFromReq(req, secret) {
  const rawQs = (req.originalUrl.split("?")[1] || "");
  const usp = new URLSearchParams(rawQs);
  const pairs = [];
  for (const [k, v] of usp) if (k !== "signature") pairs.push([k, v]);
  pairs.sort((a, b) =>
    a[0] === b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0])
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

// ---- Admin GraphQL helper
async function adminGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json();
  if (!r.ok || body.errors) {
    const msg = body.errors?.[0]?.message || r.statusText;
    throw new Error(`[AdminGraphQL] ${r.status} ${msg}`);
  }
  return body.data;
}

// -----------------------------------------------
// POST /apps/support/attach-ticket   (via App Proxy)
// Writes JSON map support.tickets + mirror text metafields
// -----------------------------------------------
app.post(`${PROXY_MOUNT}/attach-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    const {
      order_id,               // required numeric ID
      ticket_id,              // required, e.g. "ZUVIC-AB12CD"
      status = "pending",
      issue = "",
      message = "",
      phone = "",
      email = "",
      name = "",
      order_name = "",
      created_at,             // optional client ts
    } = req.body || {};

    if (!order_id || !ticket_id) {
      return res.status(400).json({ ok: false, error: "missing_fields", fields: ["order_id","ticket_id"] });
    }

    const orderGid = `gid://shopify/Order/${String(order_id)}`;

    // 1) Read existing support.tickets
    const q1 = `
      query GetOrder($id: ID!) {
        order(id: $id) {
          id
          name
          tickets: metafield(namespace:"support", key:"tickets") { id value }
        }
      }`;
    const d1 = await adminGraphQL(q1, { id: orderGid });

    let map = {};
    const mf = d1?.order?.tickets;
    if (mf?.value) { try { map = JSON.parse(mf.value); } catch { map = {}; } }

    // 2) Upsert this ticket
    const now = new Date().toISOString();
    const prev = map[ticket_id] || {};
    map[ticket_id] = {
      ticket_id,
      status,
      issue:   issue   || prev.issue   || "",
      message: message || prev.message || "",
      phone:   phone   || prev.phone   || "",
      email:   email   || prev.email   || "",
      name:    name    || prev.name    || "",
      order_id,
      order_name: order_name || d1?.order?.name || prev.order_name || "",
      created_at: prev.created_at || created_at || now,
      updated_at: now,
    };

    // 3) Save JSON metafield + mirrors
    const q2 = `
      mutation SaveTickets($ownerId: ID!, $value: String!, $ticketId: String!, $status: String!) {
        metafieldsSet(metafields: [
          { ownerId:$ownerId, namespace:"support", key:"tickets",       type:"json",                   value:$value },
          { ownerId:$ownerId, namespace:"support", key:"ticket_id",     type:"single_line_text_field", value:$ticketId },
          { ownerId:$ownerId, namespace:"support", key:"ticket_status", type:"single_line_text_field", value:$status }
        ]) { userErrors { field message } }
      }`;
    const d2 = await adminGraphQL(q2, { ownerId: orderGid, value: JSON.stringify(map), ticketId: ticket_id, status });

    const err = d2?.metafieldsSet?.userErrors?.[0];
    if (err) throw new Error(err.message);

    return res.json({ ok: true, ticket: map[ticket_id] });
  } catch (e) {
    console.error("[attach-ticket]", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// -----------------------------------------------
// GET /apps/support/find-ticket  (via App Proxy)
// Looks up a ticket by ticket_id on a specific order_id
// -----------------------------------------------
app.get(`${PROXY_MOUNT}/find-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    const ticket_id = String(req.query.ticket_id || "").trim();
    const order_id  = String(req.query.order_id  || "").trim();

    if (!ticket_id) return res.status(400).json({ ok:false, error:"missing ticket_id" });
    if (!order_id)  return res.status(400).json({ ok:false, error:"missing order_id" });

    const orderGid = `gid://shopify/Order/${order_id}`;
    const q = `
      query GetOrderForTicket($id: ID!) {
        order(id: $id) {
          id
          name
          createdAt
          tickets: metafield(namespace:"support", key:"tickets")       { value }
          tId:     metafield(namespace:"support", key:"ticket_id")     { value }
          tStatus: metafield(namespace:"support", key:"ticket_status") { value }
        }
      }`;
    const d = await adminGraphQL(q, { id: orderGid });
    const order = d?.order;
    if (!order) return res.json({ ok:false, error:"order_not_found" });

    let ticket = null;
    let status = null;

    // Preferred: JSON map
    const json = order.tickets?.value;
    if (json) {
      try {
        const map = JSON.parse(json);
        if (map && map[ticket_id]) {
          ticket = map[ticket_id];
          status = ticket.status || null;
        }
      } catch {}
    }

    // Fallback: mirror text metafields
    if (!ticket && order.tId?.value === ticket_id) {
      ticket = { ticket_id, status: order.tStatus?.value || "pending" };
      status = ticket.status;
    }

    if (!ticket) return res.json({ ok:false, error:"ticket_not_found" });

    return res.json({
      ok: true,
      ticket,
      status: status || "pending",
      order_id,
      order_name: order.name,
      order_created_at: order.createdAt
    });
  } catch (e) {
    console.error("[find-ticket]", e);
    return res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

// ==== Admin UI key auth (token) for JSON API ====
const ADMIN_UI_KEY = process.env.ADMIN_UI_KEY || "";
function requireAdmin(req, res, next) {
  const bearer = String(req.headers.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const xkey = String(req.headers["x-admin-ui-key"] || "").trim(); // optional alt header
  if (ADMIN_UI_KEY && (bearer === ADMIN_UI_KEY || xkey === ADMIN_UI_KEY)) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// (Optional) basic CORS so you can call from a browser tool
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten later if you host a UI
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-UI-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Helper to pull orders and flatten tickets (NO PII) ----------
async function collectTickets({ since, status, limit = 200 }) {
  const out = [];
  let after = null;
  const max = Math.min(Number(limit || 200), 1000);
  const shopQuery = since ? `updated_at:>=${since}` : null;

  while (out.length < max) {
    const q = `
      query Orders($first:Int!,$after:String,$query:String){
        orders(first:$first, after:$after, query:$query, sortKey:UPDATED_AT, reverse:true){
          edges{
            cursor
            node{
              id
              name
              createdAt
              updatedAt
              mfJSON: metafield(namespace:"support", key:"tickets"){ value }
              mfId:   metafield(namespace:"support", key:"ticket_id"){ value }
              mfSt:   metafield(namespace:"support", key:"ticket_status"){ value }
            }
          }
          pageInfo{ hasNextPage }
        }
      }`;
    const data = await adminGraphQL(q, { first: 50, after, query: shopQuery });

    const edges = data?.orders?.edges || [];
    if (!edges.length) break;

    for (const { node } of edges) {
      const orderId = Number(String(node.id).split("/").pop());
      const base = {
        order_id: orderId,
        order_name: node.name,
        order_created_at: node.createdAt,
        order_updated_at: node.updatedAt
      };

      // Prefer JSON map
      let map = {};
      const raw = node.mfJSON?.value;
      if (raw) { try { map = JSON.parse(raw); } catch (_) {} }

      if (Object.keys(map).length) {
        for (const [key, t] of Object.entries(map)) {
          const rec = {
            ...base,
            ticket_id: t.ticket_id || key,
            status: (t.status || "pending"),
            issue: t.issue || "",
            message: t.message || "",
            phone: t.phone || "",
            email: t.email || "",
            name:  t.name  || "",
            created_at: t.created_at || base.order_created_at,
            updated_at: t.updated_at || base.order_updated_at
          };
          if (!status || status === "all" || rec.status.toLowerCase() === String(status).toLowerCase()) {
            out.push(rec);
            if (out.length >= max) break;
          }
        }
      } else if (node.mfId?.value) {
        // Fallback to single fields
        const rec = {
          ...base,
          ticket_id: node.mfId.value,
          status: node.mfSt?.value || "pending",
          issue: "",
          message: "",
          phone: "",
          email: "",
          name:  "",
          created_at: base.order_created_at,
          updated_at: base.order_updated_at
        };
        if (!status || status === "all" || rec.status.toLowerCase() === String(status).toLowerCase()) {
          out.push(rec);
        }
      }
      if (out.length >= max) break;
    }

    const hasNext = data?.orders?.pageInfo?.hasNextPage;
    if (!hasNext) break;
    const lastCursor = data.orders.edges[data.orders.edges.length - 1]?.cursor;
    if (!lastCursor) break;
    after = lastCursor;
  }

  return out.slice(0, max);
}

// ===== JSON Admin API (Bearer ADMIN_UI_KEY) =====

// GET /admin/tickets?since=YYYY-MM-DD&status=pending|resolved|closed|in_progress|all&limit=200
app.get("/admin/tickets", requireAdmin, async (req, res) => {
  try {
    const { since, status = "all", limit = 200 } = req.query || {};
    const tickets = await collectTickets({ since, status, limit });
    res.json({ ok: true, count: tickets.length, tickets });
  } catch (e) {
    console.error("GET /admin/tickets", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// POST /admin/tickets/update { order_id, ticket_id, status }
app.post("/admin/tickets/update", requireAdmin, async (req, res) => {
  try {
    const { order_id, ticket_id, status = "pending" } = req.body || {};
    if (!order_id || !ticket_id) {
      return res.status(400).json({ ok:false, error:"missing order_id/ticket_id" });
    }
    const orderGid = `gid://shopify/Order/${order_id}`;

    // Read current JSON
    const q1 = `
      query GetOrder($id:ID!){
        order(id:$id){
          name
          metafield(namespace:"support", key:"tickets"){ value }
        }
      }`;
    const d1 = await adminGraphQL(q1, { id: orderGid });
    let map = {};
    const raw = d1?.order?.metafield?.value;
    if (raw) { try { map = JSON.parse(raw); } catch (_) {} }

    const now = new Date().toISOString();
    const prev = map[ticket_id] || {};
    map[ticket_id] = {
      ...(prev||{}),
      ticket_id,
      status,
      order_id,
      order_name: prev.order_name || d1?.order?.name || "",
      created_at: prev.created_at || now,
      updated_at: now
    };

    const q2 = `
      mutation Save($ownerId:ID!, $value:String!, $tid:String!, $st:String!){
        metafieldsSet(metafields:[{
          ownerId:$ownerId, namespace:"support", key:"tickets", type:"json", value:$value
        },{
          ownerId:$ownerId, namespace:"support", key:"ticket_id", type:"single_line_text_field", value:$tid
        },{
          ownerId:$ownerId, namespace:"support", key:"ticket_status", type:"single_line_text_field", value:$st
        }]){
          userErrors { field message }
        }
      }`;
    const d2 = await adminGraphQL(q2, {
      ownerId: orderGid,
      value: JSON.stringify(map),
      tid: ticket_id,
      st: status
    });
    const err = d2?.metafieldsSet?.userErrors?.[0];
    if (err) throw new Error(err.message);

    res.json({ ok: true, ticket: map[ticket_id] });
  } catch (e) {
    console.error("POST /admin/tickets/update", e);
    res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

// ===== Optional: password-protected HTML admin panel =====
function requireUIPassword(req, res, next) {
  const hdr = req.headers.authorization || "";
  if (!hdr.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Tickets Admin"');
    return res.status(401).send("Auth required");
  }
  const [user, pass] = Buffer.from(hdr.split(" ")[1], "base64").toString("utf8").split(":");
  if (user === UI_USER && pass === UI_PASS) return next();
  res.set("WWW-Authenticate", 'Basic realm="Tickets Admin"');
  return res.status(401).send("Auth required");
}

// Serve the UI if you added public/admin-panel.html
app.get("/admin/panel", requireUIPassword, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-panel.html"));
});

// JSON that the HTML panel calls (same logic, but cookie/basic-auth)
app.get("/admin/ui/tickets", requireUIPassword, async (req, res) => {
  try {
    const { since, status = "all", limit = 200 } = req.query || {};
    const tickets = await collectTickets({ since, status, limit });
    const withShop = tickets.map(t => ({ ...t, shop_domain: SHOPIFY_SHOP }));
    res.json({ ok: true, count: tickets.length, tickets: withShop });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

app.post("/admin/ui/update", requireUIPassword, async (req, res) => {
  try {
    const { order_id, ticket_id, status = "pending" } = req.body || {};
    if (!order_id || !ticket_id) return res.status(400).json({ ok:false, error:"missing order_id/ticket_id" });

    const orderGid = `gid://shopify/Order/${order_id}`;
    const q1 = `
      query GetOrder($id:ID!){
        order(id:$id){
          name
          metafield(namespace:"support", key:"tickets"){ value }
        }
      }`;
    const d1 = await adminGraphQL(q1, { id: orderGid });
    let map = {};
    const raw = d1?.order?.metafield?.value;
    if (raw) { try { map = JSON.parse(raw); } catch(_){} }

    const now = new Date().toISOString();
    const prev = map[ticket_id] || {};
    map[ticket_id] = {
      ...(prev||{}),
      ticket_id, status, order_id,
      order_name: prev.order_name || d1?.order?.name || "",
      created_at: prev.created_at || now,
      updated_at: now
    };

    const q2 = `
      mutation Save($ownerId:ID!, $value:String!, $tid:String!, $st:String!){
        metafieldsSet(metafields:[{
          ownerId:$ownerId, namespace:"support", key:"tickets", type:"json", value:$value
        },{
          ownerId:$ownerId, namespace:"support", key:"ticket_id", type:"single_line_text_field", value:$tid
        },{
          ownerId:$ownerId, namespace:"support", key:"ticket_status", type:"single_line_text_field", value:$st
        }]){ userErrors { field message } }
      }`;
    const d2 = await adminGraphQL(q2, {
      ownerId: orderGid, value: JSON.stringify(map), tid: ticket_id, st: status
    });
    const err = d2?.metafieldsSet?.userErrors?.[0];
    if (err) throw new Error(err.message);

    res.json({ ok:true, ticket: map[ticket_id] });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// ---- Start
app.listen(PORT, () =>
  console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT} api=${API_VERSION}`)
);
