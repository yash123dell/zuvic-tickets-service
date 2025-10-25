// server.js  (add these envs in Render)
// SHOPIFY_ADMIN_TOKEN, SHOPIFY_SHOP, PROXY_SECRET, PROXY_MOUNT

import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "512kb" }));

const PORT = process.env.PORT || 3000;
const PROXY_MOUNT  = process.env.PROXY_MOUNT || "/tickets";
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || "";         // e.g. dsdg2d-ii.myshopify.com
const ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION  = "2025-10";

// --- proxy signature helpers (unchanged) ---
function expectedHmacFromReq(req, secret) {
  const rawQs = (req.originalUrl.split("?")[1] || "");
  const usp = new URLSearchParams(rawQs);
  const pairs = [];
  for (const [k, v] of usp) if (k !== "signature") pairs.push([k, v]);
  pairs.sort((a,b)=> (a[0]===b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const msg = pairs.map(([k,v]) => `${k}=${v}`).join("");
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}
function verifyProxySignature(req) {
  const provided = String(req.query.signature || "").toLowerCase();
  if (!PROXY_SECRET || !provided) return false;
  const expected = expectedHmacFromReq(req, PROXY_SECRET).toLowerCase();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- admin graphql helper ---
async function adminGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const body = await r.json();
  if (!r.ok || body.errors) {
    throw new Error(`[AdminGraphQL] ${r.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

// --- routes ---
app.get("/healthz", (_req, res) => res.send("ok"));

app.post(`${PROXY_MOUNT}/attach-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) {
      return res.status(401).json({ ok:false, error:"invalid_signature" });
    }
    const { order_id, ticket_id, status } = req.body || {};
    if (!order_id || !ticket_id || !status) {
      return res.status(400).json({ ok:false, error:"missing_fields", fields:["order_id","ticket_id","status"] });
    }

    const orderGid = `gid://shopify/Order/${String(order_id)}`;

    // write 2 metafields on the order (namespace: support)
    const m = `
      mutation Set($metafields:[MetafieldsSetInput!]!) {
        metafieldsSet(metafields:$metafields) {
          metafields { key namespace }
          userErrors { field message }
        }
      }`;

    const metafields = [
      {
        ownerId: orderGid,
        namespace: "support",
        key: "ticket_id",
        type: "single_line_text_field",
        value: ticket_id
      },
      {
        ownerId: orderGid,
        namespace: "support",
        key: "ticket_status",
        type: "single_line_text_field",
        value: String(status)
      }
    ];

    const out = await adminGraphQL(m, { metafields });
    const errs = out.metafieldsSet.userErrors;
    if (errs?.length) throw new Error(`metafieldsSet errors: ${JSON.stringify(errs)}`);

    return res.json({ ok:true });
  } catch (e) {
    console.error("[attach-ticket]", e);
    return res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

app.listen(PORT, ()=> console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT}`));
