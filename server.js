// server.js
// ENVs:
// - SHOPIFY_ADMIN_TOKEN, SHOPIFY_SHOP, PROXY_SECRET
// - PROXY_MOUNT (default "/tickets")
// - SHOPIFY_API_VERSION or API_VERSION (fallback to "2024-10")
// Optional: SKIP_PROXY_VERIFY=1 (skip App Proxy signature verification for local dev)

import express from "express";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

const PORT         = process.env.PORT || 3000;
const PROXY_MOUNT  = process.env.PROXY_MOUNT || "/tickets";
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || "";        // e.g. zuvic-in.myshopify.com
const ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION  = process.env.SHOPIFY_API_VERSION || process.env.API_VERSION || "2024-10";
const SKIP_VERIFY  = process.env.SKIP_PROXY_VERIFY === "1";

// ---- health
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
// POST /attach-ticket  (called from /apps/support/attach-ticket)
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
      }
    `;
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
          { ownerId:$ownerId, namespace:"support", key:"tickets",       type:"json",                     value:$value },
          { ownerId:$ownerId, namespace:"support", key:"ticket_id",     type:"single_line_text_field",   value:$ticketId },
          { ownerId:$ownerId, namespace:"support", key:"ticket_status", type:"single_line_text_field",   value:$status }
        ]) { userErrors { field message } }
      }
    `;
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
// GET /find-ticket  (called from /apps/support/find-ticket)
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
          tickets:     metafield(namespace:"support", key:"tickets")       { value }
          tId:         metafield(namespace:"support", key:"ticket_id")     { value }
          tStatus:     metafield(namespace:"support", key:"ticket_status") { value }
        }
      }
    `;
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

app.listen(PORT, () =>
  console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT} api=${API_VERSION}`)
);
