// server.js
// Required ENVs on Render (or your host):
// SHOPIFY_ADMIN_TOKEN, SHOPIFY_SHOP, PROXY_SECRET, PROXY_MOUNT (optional), SHOPIFY_API_VERSION (optional)
// Optional: SKIP_PROXY_VERIFY=1 (local testing without Shopify signature)

import express from "express";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

const PORT           = process.env.PORT || 3000;
const PROXY_MOUNT    = process.env.PROXY_MOUNT || "/tickets";
const PROXY_SECRET   = process.env.PROXY_SECRET || "";
const SHOPIFY_SHOP   = process.env.SHOPIFY_SHOP || "";      // e.g. zuvic-in.myshopify.com
const ADMIN_TOKEN    = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION    = process.env.SHOPIFY_API_VERSION || "2024-10";
const SKIP_VERIFY    = process.env.SKIP_PROXY_VERIFY === "1";

// ---- tiny health route
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// ---- proxy signature helpers
function expectedHmacFromReq(req, secret) {
  // Build message by sorting all query params except 'signature'
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

// ---- POST /<PROXY_MOUNT>/attach-ticket
// Merges full JSON into support.tickets (type=json), keyed by ticket_id.
// Also mirrors ticket_id and ticket_status into text metafields for quick filters.
app.post(`${PROXY_MOUNT}/attach-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    const {
      order_id,               // required (numeric)
      ticket_id,              // required e.g. "ZUVIC-123456"
      status = "pending",
      issue = "",
      message = "",
      phone = "",
      email = "",
      name = "",
      order_name = "",        // optional; will fallback to order.name
      created_at,             // optional client ts
    } = req.body || {};

    if (!order_id || !ticket_id) {
      return res.status(400).json({
        ok: false,
        error: "missing_fields",
        fields: ["order_id", "ticket_id"],
      });
    }

    const orderGid = `gid://shopify/Order/${String(order_id)}`;

    // 1) Read existing support.tickets (JSON) + order name
    const q1 = `
      query GetOrder($id: ID!) {
        order(id: $id) {
          id
          name
          metafield(namespace: "support", key: "tickets") { id value }
        }
      }
    `;
    const d1 = await adminGraphQL(q1, { id: orderGid });

    let map = {};
    const mf = d1?.order?.metafield;
    if (mf?.value) {
      try { map = JSON.parse(mf.value); } catch (_) { map = {}; }
    }

    // 2) Merge / upsert this ticket
    const now = new Date().toISOString();
    const prev = map[ticket_id] || {};
    map[ticket_id] = {
      ticket_id,
      status,
      issue: issue || prev.issue || "",
      message: message || prev.message || "",
      phone: phone || prev.phone || "",
      email: email || prev.email || "",
      name:  name  || prev.name  || "",
      order_id,
      order_name: order_name || d1?.order?.name || prev.order_name || "",
      created_at: prev.created_at || created_at || now,
      updated_at: now,
    };

    // 3) Save JSON metafield + the 2 mirror text metafields
    const q2 = `
      mutation SaveTickets($ownerId: ID!, $value: String!, $ticketId: String!, $status: String!) {
        metafieldsSet(metafields: [
          {
            ownerId: $ownerId,
            namespace: "support",
            key: "tickets",
            type: "json",
            value: $value
          },
          {
            ownerId: $ownerId,
            namespace: "support",
            key: "ticket_id",
            type: "single_line_text_field",
            value: $ticketId
          },
          {
            ownerId: $ownerId,
            namespace: "support",
            key: "ticket_status",
            type: "single_line_text_field",
            value: $status
          }
        ]) {
          userErrors { field message }
        }
      }
    `;
    const d2 = await adminGraphQL(q2, {
      ownerId: orderGid,
      value: JSON.stringify(map),
      ticketId: ticket_id,
      status,
    });

    const err = d2?.metafieldsSet?.userErrors?.[0];
    if (err) throw new Error(err.message);

    return res.json({ ok: true, ticket: map[ticket_id] });
  } catch (e) {
    console.error("[attach-ticket]", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Optional: quick read endpoint to fetch all tickets for an order
app.get(`${PROXY_MOUNT}/get-tickets`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }
    const order_id = req.query.order_id;
    if (!order_id) return res.status(400).json({ ok: false, error: "missing order_id" });

    const orderGid = `gid://shopify/Order/${String(order_id)}`;
    const q = `
      query GetOrder($id: ID!) {
        order(id: $id) {
          id
          name
          metafield(namespace: "support", key: "tickets") { value }
        }
      }
    `;
    const d = await adminGraphQL(q, { id: orderGid });
    const json = d?.order?.metafield?.value;
    const map = json ? JSON.parse(json) : {};
    res.json({ ok: true, order_name: d?.order?.name, tickets: map });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () =>
  console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT} api=${API_VERSION}`)
);
