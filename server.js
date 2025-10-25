// server.js — Zuvic Tickets API (ESM)
import express from "express";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

// ---- ENV
const PORT                = process.env.PORT || 3000;
const PROXY_SECRET        = process.env.PROXY_SECRET || "";
const PROXY_MOUNT         = process.env.PROXY_MOUNT || "/tickets";
const PROXY_DEBUG         = process.env.PROXY_DEBUG === "1";
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const SHOPIFY_SHOP        = process.env.SHOPIFY_SHOP || ""; // e.g. dsdg2d-ii.myshopify.com
const API_VERSION         = "2025-10";

// ---- Health & landing
app.get("/healthz", (_req, res) => res.type("text").send("ok"));
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<meta charset="utf-8">
<title>Zuvic Tickets API</title>
<style>body{font:14px system-ui,Segoe UI,Roboto,Helvetica,Arial;margin:40px;line-height:1.5}</style>
<h1>Zuvic Tickets API</h1>
<ul>
  <li>Health: <a href="/healthz">/healthz</a></li>
  <li>Create (POST): <code>${PROXY_MOUNT}/attach-ticket</code></li>
  <li>List (GET): <code>${PROXY_MOUNT}/my-tickets</code></li>
</ul>`);
});

// ---- Shopify App-Proxy HMAC (use raw query string)
function expectedHmacFromReq(req, secret) {
  const rawQs = (req.originalUrl.split("?")[1] || "");
  const pairs = [];
  const usp = new URLSearchParams(rawQs);
  for (const [k, v] of usp) if (k !== "signature") pairs.push([k, v]);
  pairs.sort((a, b) =>
    a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])
  );
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
  if (!ok && PROXY_DEBUG) {
    console.error("[proxy] bad signature", {
      provided, expected, rawQs: req.originalUrl.split("?")[1] || ""
    });
  }
  return ok;
}

// ---- Admin GraphQL helper
async function adminGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json();
  if (!r.ok || body.errors) {
    throw new Error(`[AdminGraphQL] ${r.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

// ---- Ensure metaobject definition
async function ensureTicketDefinition() {
  const q = `query($type: String!){ metaobjectDefinitionByType(type:$type){ id type } }`;
  const d = await adminGraphQL(q, { type: "support_ticket" });
  if (d.metaobjectDefinitionByType) return d.metaobjectDefinitionByType.id;

  const m = `mutation($def: MetaobjectDefinitionCreateInput!){
    metaobjectDefinitionCreate(definition:$def){
      metaobjectDefinition{ id type }
      userErrors{ field message }
    }
  }`;
  const def = {
    name: "Support ticket",
    type: "support_ticket",
    ownerType: "CUSTOMER",
    access: { admin: "READ_WRITE", storefront: "NONE", customerAccounts: "READ" },
    fieldDefinitions: [
      { name: "Order Name", key: "order_name", type: "SINGLE_LINE_TEXT_FIELD" },
      { name: "Order ID",   key: "order_id",   type: "SINGLE_LINE_TEXT_FIELD" },
      { name: "Ticket ID",  key: "ticket_id",  type: "SINGLE_LINE_TEXT_FIELD" },
      { name: "Status",     key: "status",     type: "SINGLE_LINE_TEXT_FIELD" },
      { name: "Created",    key: "created_at", type: "DATE_TIME" }
    ]
  };
  const resp = await adminGraphQL(m, { def });
  const errs = resp.metaobjectDefinitionCreate.userErrors;
  if (errs?.length) throw new Error(`define errors: ${JSON.stringify(errs)}`);
  return resp.metaobjectDefinitionCreate.metaobjectDefinition.id;
}

// ---- Create a ticket for the order’s customer
async function createTicket({ orderIdRaw, ticket_id, status }) {
  const orderGid = `gid://shopify/Order/${orderIdRaw}`;
  const q = `query($id:ID!){ order(id:$id){ id name customer{ id email } } }`;
  const d = await adminGraphQL(q, { id: orderGid });
  const order = d.order;
  if (!order || !order.customer?.id) throw new Error("order_or_customer_not_found");

  await ensureTicketDefinition();

  const m = `mutation($owner:ID!, $fields:[MetaobjectFieldInput!]!){
    metaobjectCreate(metaobject:{
      type:"support_ticket", ownerId:$owner, fields:$fields
    }){
      metaobject{ id }
      userErrors{ field message }
    }
  }`;

  const fields = [
    { key: "order_name", value: order.name },
    { key: "order_id",   value: orderIdRaw },
    { key: "ticket_id",  value: ticket_id },
    { key: "status",     value: status },
    { key: "created_at", value: new Date().toISOString() },
  ];
  const resp = await adminGraphQL(m, { owner: order.customer.id, fields });
  const errs = resp.metaobjectCreate.userErrors;
  if (errs?.length) throw new Error(`create errors: ${JSON.stringify(errs)}`);
  return resp.metaobjectCreate.metaobject.id;
}

// ---- List tickets for the logged-in customer
async function listTicketsByCustomer(ownerId) {
  const q = `query($owner:ID!){
    metaobjects(type:"support_ticket", first:50, ownerId:$owner, reverse:true){
      nodes{ id createdAt fields{ key value } }
    }
  }`;
  const d = await adminGraphQL(q, { owner: ownerId });
  return (d.metaobjects?.nodes || []).map(n => {
    const obj = { id: n.id, createdAt: n.createdAt };
    n.fields.forEach(f => (obj[f.key] = f.value));
    return obj;
  });
}

// ---- Routes
app.get(`${PROXY_MOUNT}/attach-ticket`, (_req, res) =>
  res.status(405).json({ ok:false, error:"method_not_allowed", method:"GET" })
);

// Create ticket (called by your “Raise a ticket” button)
app.post(`${PROXY_MOUNT}/attach-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) return res.status(401).json({ ok:false, error:"invalid_signature" });

    const { order_id, ticket_id, status } = req.body || {};
    if (!order_id || !ticket_id || !status) {
      return res.status(400).json({ ok:false, error:"missing_fields", fields:["order_id","ticket_id","status"] });
    }

    const metaobjectId = await createTicket({ orderIdRaw: String(order_id), ticket_id, status });
    return res.status(200).json({ ok:true, ticket_metaobject_id: metaobjectId });
  } catch (e) {
    console.error("[attach-ticket] error", e);
    return res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

// List tickets for the account page (“Your Tickets”)
app.get(`${PROXY_MOUNT}/my-tickets`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) return res.status(401).json({ ok:false, error:"invalid_signature" });

    const cid = req.query.logged_in_customer_id; // provided by proxy when logged in
    if (!cid) return res.status(401).json({ ok:false, error:"not_logged_in" });

    const ownerId = `gid://shopify/Customer/${cid}`;
    const items = await listTicketsByCustomer(ownerId);
    return res.status(200).json({ ok:true, tickets: items });
  } catch (e) {
    console.error("[my-tickets] error", e);
    return res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

// 404
app.use((req, res) => res.status(404).json({ ok:false, error:"not_found", path:req.path }));

// Start
app.listen(PORT, () => console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT}`));
