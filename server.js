// server.js — Zuvic Tickets API (ESM)
import express from "express";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

// ---- ENV (set these in Render)
const PORT                = process.env.PORT || 3000;
const PROXY_SECRET        = process.env.PROXY_SECRET || "";
const PROXY_MOUNT         = process.env.PROXY_MOUNT || "/tickets";
const PROXY_DEBUG         = process.env.PROXY_DEBUG === "1"; // optional
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const SHOPIFY_SHOP        = process.env.SHOPIFY_SHOP || "";  // e.g. dsdg2d-ii.myshopify.com
const API_VERSION         = "2025-10"; // use a real, current version

// ---------------- HMAC (App Proxy) ----------------
function expectedHmacFromReq(req, secret) {
  const rawQs = (req.originalUrl.split("?")[1] || "");
  const pairs = [];
  const usp = new URLSearchParams(rawQs);
  for (const [k, v] of usp) if (k !== "signature") pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const msg = pairs.map(([k, v]) => `${k}=${v}`).join("");
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}
function verifyProxySignature(req) {
  if (!PROXY_SECRET) return false;
  const provided = String(req.query.signature || "").toLowerCase();
  if (!provided) return false;
  const expected = expectedHmacFromReq(req, PROXY_SECRET).toLowerCase();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok && PROXY_DEBUG) console.error("[proxy] hmac mismatch", { provided, expected, qs: req.originalUrl.split("?")[1] || "" });
  return ok;
}

// ---------------- Shopify Admin helpers ----------------
async function adminGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.errors) {
    throw new Error(`[AdminGraphQL] ${r.status} ${JSON.stringify(body.errors || body)}`);
  }
  return body.data;
}

// ---------------- Health & landing ----------------
app.get("/healthz", (_req, res) => res.type("text").send("ok"));
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<meta charset="utf-8"><title>Zuvic Tickets API</title>
<style>body{font:14px system-ui,Segoe UI,Roboto,Helvetica,Arial;margin:40px;line-height:1.5}</style>
<h1>Zuvic Tickets API</h1>
<ul>
  <li>Health: <a href="/healthz">/healthz</a></li>
  <li>Create (POST): <code>${PROXY_MOUNT}/attach-ticket</code></li>
  <li>List (GET): <code>${PROXY_MOUNT}/my-tickets</code></li>
</ul>`);
});

// Optional GET guard for the POST endpoint
app.get(`${PROXY_MOUNT}/attach-ticket`, (_req, res) =>
  res.status(405).json({ ok: false, error: "method_not_allowed", method: "GET" })
);

// ---------------- Create ticket: write to ORDER metafields ----------------
app.post(`${PROXY_MOUNT}/attach-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) return res.status(401).json({ ok: false, error: "invalid_signature" });

    const { order_id, ticket_id, status } = req.body || {};
    if (!order_id || !ticket_id || !status) {
      return res.status(400).json({ ok: false, error: "missing_fields", fields: ["order_id", "ticket_id", "status"] });
    }

    const ownerId = `gid://shopify/Order/${String(order_id)}`;

    // Write metafields support.ticket_id / support.ticket_status on the order
    const m = `
      mutation SetMF($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key namespace value }
          userErrors { field message }
        }
      }`;
    const metafields = [
      { ownerId, namespace: "support", key: "ticket_id",    type: "single_line_text_field", value: String(ticket_id) },
      { ownerId, namespace: "support", key: "ticket_status", type: "single_line_text_field", value: String(status) }
    ];
    const out = await adminGraphQL(m, { metafields });
    const errs = out.metafieldsSet.userErrors;
    if (errs?.length) throw new Error(JSON.stringify(errs));

    return res.status(200).json({ ok: true, order_id, ticket_id, status });
  } catch (e) {
    console.error("[attach-ticket] error", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------------- List tickets for the logged-in customer ----------------
app.get(`${PROXY_MOUNT}/my-tickets`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) return res.status(401).json({ ok: false, error: "invalid_signature" });

    const cid = req.query.logged_in_customer_id;
    if (!cid) return res.status(401).json({ ok: false, error: "not_logged_in" });

    const customerId = `gid://shopify/Customer/${cid}`;

    // Pull recent orders + the two support metafields
    const q = `
      query($id: ID!) {
        customer(id: $id) {
          id
          orders(first: 50, reverse: true) {
            nodes {
              id
              name
              createdAt
              metafield(namespace: "support", key: "ticket_id") { value }
              metafield(namespace: "support", key: "ticket_status") { value }
            }
          }
        }
      }`;
    const data = await adminGraphQL(q, { id: customerId });

    const nodes = data?.customer?.orders?.nodes || [];
    const tickets = nodes
      .map(n => ({
        id: n.id,
        order_id: n.id?.split("/").pop(),
        order_name: n.name?.replace("#", ""),
        createdAt: n.createdAt,
        ticket_id: n.metafield?.value ?? null,
        status: (n.metafield?.value && n.metafield?.value !== null) ? (n.metafield__ticket_status?.value || n.metafield?.value) : (n.metafield__ticket_status?.value || null) // fallback
      }))
      .filter(t => t.ticket_id); // only orders that have a ticket

    return res.status(200).json({ ok: true, tickets });
  } catch (e) {
    console.error("[my-tickets] error", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: "not_found", path: req.path }));

app.listen(PORT, () => console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT}`));
