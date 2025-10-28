// server.js
// ENVs:
// - SHOPIFY_ADMIN_TOKEN, SHOPIFY_SHOP, PROXY_SECRET
// - PROXY_MOUNT (default "/tickets")
// - SHOPIFY_API_VERSION or API_VERSION (fallback to "2024-10")
// - ADMIN_UI_KEY (Bearer for programmatic admin API)
// - UI_USER, UI_PASS (for the password-protected HTML admin panel)
// Optional: SKIP_PROXY_VERIFY=1 (skip App Proxy signature verification for local dev)

import express from "express";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

// Serve /public (only used if you later add a real admin-panel.html file)
app.use(express.static(path.join(__dirname, "public")));

const PORT         = process.env.PORT || 3000;
const PROXY_MOUNT  = process.env.PROXY_MOUNT || "/tickets";
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || "";  // e.g. zuvic-in.myshopify.com
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
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.errors) {
    const msg = body?.errors?.[0]?.message || r.statusText;
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
          { ownerId:$ownerId, namespace:"support", key:"tickets",       type:"json",                   value:$value },
          { ownerId:$ownerId, namespace:"support", key:"ticket_id",     type:"single_line_text_field", value:$ticketId },
          { ownerId:$ownerId, namespace:"support", key:"ticket_status", type:"single_line_text_field", value:$status }
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

// ==== Admin (Bearer) endpoints ====
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-UI-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Helper to pull orders in pages and flatten tickets (NO PII requested)
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
    const data = await adminGraphQL(q, {
      first: 50,
      after,
      query: shopQuery
    });

    const edges = data?.orders?.edges || [];
    if (!edges.length) break;

    for (const { cursor, node } of edges) {
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

    after = edges[edges.length - 1].cursor;
    if (!data.orders.pageInfo.hasNextPage) break;
  }

  return out.slice(0, max);
}

// GET /admin/tickets?since=YYYY-MM-DD&status=pending|resolved|closed|in_progress|all&limit=200
app.get("/admin/tickets", requireAdmin, async (req, res) => {
  try {
    const { since, status, limit } = req.query || {};
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
const UI_USER = process.env.UI_USER || "admin";
const UI_PASS = process.env.UI_PASS || "change-me";

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

// Serve the HTML panel (open /admin/panel). If the file is missing, serve an inline fallback.
app.get("/admin/panel", requireUIPassword, (req, res) => {
  const panelPath = path.join(__dirname, "public", "admin-panel.html");
  if (fs.existsSync(panelPath)) {
    return res.sendFile(panelPath);
  }
  // Fallback inline HTML so you never see 404/ENOENT
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Support tickets</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7fb;margin:0;padding:24px;color:#0f172a}
    h1{margin:0 0 16px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px}
    .grid{display:grid;gap:12px;grid-template-columns:180px 180px 120px 1fr auto auto}
    table{width:100%;border-collapse:collapse;margin-top:14px}
    th,td{padding:10px;border-bottom:1px solid #eee;font-size:14px}
    th{font-weight:600;color:#334155;text-align:left}
    input,select,button{height:36px;border:1px solid #cbd5e1;border-radius:8px;padding:0 10px;background:#fff}
    button{background:#1d4ed8;color:#fff;border-color:#1d4ed8;cursor:pointer}
    .muted{color:#64748b}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#eef2ff;color:#3730a3;font-size:12px}
  </style>
</head>
<body>
  <h1>Support tickets</h1>
  <div class="card">
    <div class="grid">
      <label>Status
        <select id="st"><option value="all">All</option><option>pending</option><option>in_progress</option><option>resolved</option><option>closed</option></select>
      </label>
      <label>Updated since
        <input id="since" type="date" />
      </label>
      <label>Limit
        <input id="lim" type="number" value="200" min="1" max="1000" />
      </label>
      <label>Search (ticket/order/name/email)
        <input id="q" placeholder="Type to filter…" />
      </label>
      <button id="go">Refresh</button>
      <button id="clr" type="button">Clear</button>
    </div>

    <div id="err" class="muted" style="margin-top:10px;display:none"></div>

    <table id="tbl">
      <thead>
        <tr>
          <th>TICKET</th><th>STATUS</th><th>ORDER</th><th>CREATED</th><th>UPDATED</th>
          <th>NAME</th><th>EMAIL</th><th>PHONE</th><th>ISSUE</th><th>MESSAGE</th><th>ACTIONS</th>
        </tr>
      </thead>
      <tbody><tr><td colspan="11" class="muted">Loading…</td></tr></tbody>
    </table>
  </div>

<script>
const $ = (s)=>document.querySelector(s);
const fmt = (d)=> new Date(d).toLocaleString();
const row = (t) => \`
<tr>
  <td><code>\${t.ticket_id||""}</code></td>
  <td><span class="pill">\${(t.status||"").replace("_"," ")}</span></td>
  <td><code>\${t.order_name||t.order_id||""}</code></td>
  <td>\${t.created_at?fmt(t.created_at):""}</td>
  <td>\${t.updated_at?fmt(t.updated_at):""}</td>
  <td>\${t.name||""}</td>
  <td>\${t.email||""}</td>
  <td>\${t.phone||""}</td>
  <td>\${t.issue||""}</td>
  <td>\${t.message||""}</td>
  <td>
    <select class="set">
      <option value="pending" \${t.status==="pending"?"selected":""}>pending</option>
      <option value="in_progress" \${t.status==="in_progress"?"selected":""}>in_progress</option>
      <option value="resolved" \${t.status==="resolved"?"selected":""}>resolved</option>
      <option value="closed" \${t.status==="closed"?"selected":""}>closed</option>
    </select>
    <button class="save" data-oid="\${t.order_id}" data-tid="\${t.ticket_id}">Save</button>
  </td>
</tr>\`;

async function load(){
  $("#err").style.display="none";
  const qs = new URLSearchParams({
    status: $("#st").value || "all",
    since:  $("#since").value || "",
    limit:  $("#lim").value || 200
  });
  const r = await fetch("/admin/ui/tickets?"+qs.toString(), {credentials:"include"});
  const j = await r.json().catch(()=>({ok:false,error:"bad_json"}));
  if(!j.ok){ $("#err").textContent = "Failed: " + j.error; $("#err").style.display="block"; $("#tbl tbody").innerHTML=""; return; }
  const q = ($("#q").value||"").toLowerCase();
  const rows = j.tickets.filter(t =>
    !q || [t.ticket_id,t.order_name,t.name,t.email].filter(Boolean).some(x=>String(x).toLowerCase().includes(q))
  ).map(row).join("");
  $("#tbl tbody").innerHTML = rows || '<tr><td colspan="11" class="muted">No tickets</td></tr>';

  // wire saves
  $("#tbl").querySelectorAll(".save").forEach(btn=>{
    btn.onclick = async ()=>{
      const tr = btn.closest("tr");
      const status = tr.querySelector(".set").value;
      const body = { order_id: btn.dataset.oid, ticket_id: btn.dataset.tid, status };
      const r2 = await fetch("/admin/ui/update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body), credentials:"include"});
      const j2 = await r2.json();
      if(!j2.ok) alert("Update failed: " + j2.error);
      else load();
    };
  });
}

$("#go").onclick = load;
$("#clr").onclick = ()=>{ $("#st").value="all"; $("#since").value=""; $("#lim").value=200; $("#q").value=""; load(); };
$("#q").oninput = ()=> load();
load();
</script>
</body></html>`);
});

// JSON that the HTML panel calls
app.get("/admin/ui/tickets", requireUIPassword, async (req, res) => {
  try {
    const { since, status = "all", limit = 200 } = req.query || {};
    const tickets = await collectTickets({ since, status, limit });
    res.json({ ok: true, count: tickets.length, tickets });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

app.post("/admin/ui/update", requireUIPassword, async (req, res) => {
  try {
    const { order_id, ticket_id, status = "pending" } = req.body || {};
    if (!order_id || !ticket_id) return res.status(400).json({ ok:false, error:"missing order_id/ticket_id" });

    const orderGid = `gid://shopify/Order/${order_id}`;
    const q1 = `query GetOrder($id:ID!){ order(id:$id){ name metafield(namespace:"support", key:"tickets"){ value } } }`;
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

app.listen(PORT, () =>
  console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT} api=${API_VERSION}`)
);
