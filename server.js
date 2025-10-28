// server.js
// ENVs (required)
// - SHOPIFY_ADMIN_TOKEN, SHOPIFY_SHOP, PROXY_SECRET
// - PROXY_MOUNT (default "/tickets")
// - SHOPIFY_API_VERSION or API_VERSION (fallback "2024-10")
// - ADMIN_UI_KEY (Bearer for programmatic admin API)
// - UI_USER, UI_PASS, UI_SECRET (HMAC), ORIGIN=https://tickets.zuvic.in
// Optional: UI_SESSION_TTL (seconds, default 900), UI_ALWAYS_PROMPT=1, SKIP_PROXY_VERIFY=1

import express from "express";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");

// ---------- Security hardening ----------
const ORIGIN = process.env.ORIGIN || "https://tickets.zuvic.in";
app.use(helmet({
  xPoweredBy: false,
  frameguard: { action: "deny" },
  referrerPolicy: { policy: "no-referrer" },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "same-origin" },
  // Admin panel uses inline CSS/JS in fallback; allow only self + inline.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'","data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));

// Global JSON/body & cookies
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Serve /public if you later add a physical admin-panel.html
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: res => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }
}));

// CORS (lock to same origin)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-UI-Key, X-CSRF-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- Config ----------
const PORT         = process.env.PORT || 3000;
const PROXY_MOUNT  = process.env.PROXY_MOUNT || "/tickets";
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP || "";  // e.g. zuvic-in.myshopify.com
const ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION  = process.env.SHOPIFY_API_VERSION || process.env.API_VERSION || "2024-10";
const SKIP_VERIFY  = process.env.SKIP_PROXY_VERIFY === "1";

// ---- health
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// ---------- Helpers ----------
const subtleEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

// App Proxy signature (Shopify computes HMAC over sorted query w/o "signature")
function expectedHmacFromReq(req, secret) {
  const rawQs = (req.originalUrl.split("?")[1] || "");
  const usp = new URLSearchParams(rawQs);
  const pairs = [];
  for (const [k, v] of usp) if (k !== "signature") pairs.push([k, v]);
  pairs.sort((a,b)=> a[0]===b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0]));
  const msg = pairs.map(([k,v]) => `${k}=${v}`).join("");
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}
function verifyProxySignature(req) {
  if (SKIP_VERIFY) return true;
  const provided = String(req.query.signature || "").toLowerCase();
  if (!PROXY_SECRET || !provided) return false;
  const expected = expectedHmacFromReq(req, PROXY_SECRET).toLowerCase();
  return subtleEq(provided, expected);
}

// Shopify Admin GraphQL
async function adminGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json", "X-Shopify-Access-Token": ADMIN_TOKEN },
    body: JSON.stringify({ query, variables })
  });
  const body = await r.json().catch(()=> ({}));
  if (!r.ok || body.errors) {
    const msg = body?.errors?.[0]?.message || r.statusText;
    throw new Error(`[AdminGraphQL] ${r.status} ${msg}`);
  }
  return body.data;
}

// ---------- Ticket endpoints (unchanged business logic; no PII) ----------
app.post(`${PROXY_MOUNT}/attach-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) return res.status(401).json({ ok:false, error:"invalid_signature" });
    const { order_id, ticket_id, status="pending", issue="", message="", phone="", email="", name="", order_name="", created_at } = req.body || {};
    if (!order_id || !ticket_id) return res.status(400).json({ ok:false, error:"missing_fields", fields:["order_id","ticket_id"] });
    const orderGid = `gid://shopify/Order/${String(order_id)}`;

    const q1 = `query GetOrder($id:ID!){ order(id:$id){ id name tickets:metafield(namespace:"support",key:"tickets"){id value} } }`;
    const d1 = await adminGraphQL(q1, { id: orderGid });

    let map = {}; const mf = d1?.order?.tickets;
    if (mf?.value) { try { map = JSON.parse(mf.value); } catch { map = {}; } }

    const now = new Date().toISOString();
    const prev = map[ticket_id] || {};
    map[ticket_id] = {
      ticket_id, status,
      issue: issue || prev.issue || "", message: message || prev.message || "",
      phone: phone || prev.phone || "", email: email || prev.email || "", name: name || prev.name || "",
      order_id, order_name: order_name || d1?.order?.name || prev.order_name || "",
      created_at: prev.created_at || created_at || now, updated_at: now,
    };

    const q2 = `
      mutation SaveTickets($ownerId:ID!,$value:String!,$ticketId:String!,$status:String!){
        metafieldsSet(metafields:[
          {ownerId:$ownerId,namespace:"support",key:"tickets",type:"json",value:$value},
          {ownerId:$ownerId,namespace:"support",key:"ticket_id",type:"single_line_text_field",value:$ticketId},
          {ownerId:$ownerId,namespace:"support",key:"ticket_status",type:"single_line_text_field",value:$status}
        ]){ userErrors{ field message } }
      }`;
    const d2 = await adminGraphQL(q2, { ownerId: orderGid, value: JSON.stringify(map), ticketId: ticket_id, status });
    const err = d2?.metafieldsSet?.userErrors?.[0]; if (err) throw new Error(err.message);
    res.json({ ok:true, ticket: map[ticket_id] });
  } catch (e) { console.error("[attach-ticket]", e); res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

app.get(`${PROXY_MOUNT}/find-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) return res.status(401).json({ ok:false, error:"invalid_signature" });
    const ticket_id = String(req.query.ticket_id||"").trim();
    const order_id  = String(req.query.order_id||"").trim();
    if (!ticket_id) return res.status(400).json({ ok:false, error:"missing ticket_id" });
    if (!order_id)  return res.status(400).json({ ok:false, error:"missing order_id" });

    const orderGid = `gid://shopify/Order/${order_id}`;
    const q = `query GetOrderForTicket($id:ID!){
      order(id:$id){
        id name createdAt
        tickets:metafield(namespace:"support",key:"tickets"){ value }
        tId:metafield(namespace:"support",key:"ticket_id"){ value }
        tStatus:metafield(namespace:"support",key:"ticket_status"){ value }
      }}`;
    const d = await adminGraphQL(q, { id: orderGid });
    const order = d?.order; if (!order) return res.json({ ok:false, error:"order_not_found" });

    let ticket=null, status=null;
    const json = order.tickets?.value;
    if (json) { try { const map = JSON.parse(json); if (map && map[ticket_id]) { ticket = map[ticket_id]; status = ticket.status || null; } } catch {} }
    if (!ticket && order.tId?.value === ticket_id) { ticket = { ticket_id, status: order.tStatus?.value || "pending" }; status = ticket.status; }
    if (!ticket) return res.json({ ok:false, error:"ticket_not_found" });

    res.json({ ok:true, ticket, status: status || "pending", order_id, order_name: order.name, order_created_at: order.createdAt });
  } catch (e) { console.error("[find-ticket]", e); res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

// ---------- Admin (Bearer) programmatic API ----------
const ADMIN_UI_KEY = process.env.ADMIN_UI_KEY || "";
function requireAdmin(req, res, next) {
  const bearer = String(req.headers.authorization||"").replace(/^Bearer\s+/i,"").trim();
  const xkey   = String(req.headers["x-admin-ui-key"]||"").trim();
  if (ADMIN_UI_KEY && (bearer===ADMIN_UI_KEY || xkey===ADMIN_UI_KEY)) return next();
  return res.status(401).json({ ok:false, error:"unauthorized" });
}

// Helper: collect tickets without PII
async function collectTickets({ since, status, limit=200 }) {
  const out=[]; let after=null; const max=Math.min(Number(limit||200),1000);
  const shopQuery = since ? `updated_at:>=${since}` : null;

  while (out.length < max) {
    const q = `query Orders($first:Int!,$after:String,$query:String){
      orders(first:$first,after:$after,query:$query,sortKey:UPDATED_AT,reverse:true){
        edges{ cursor node{
          id name createdAt updatedAt
          mfJSON:metafield(namespace:"support",key:"tickets"){ value }
          mfId:metafield(namespace:"support",key:"ticket_id"){ value }
          mfSt:metafield(namespace:"support",key:"ticket_status"){ value }
        } }
        pageInfo{ hasNextPage }
      }}`;
    const data = await adminGraphQL(q, { first:50, after, query: shopQuery });
    const edges = data?.orders?.edges || [];
    if (!edges.length) break;

    for (const { node } of edges) {
      const orderId = Number(String(node.id).split("/").pop());
      const base = { order_id:orderId, order_name:node.name, order_created_at:node.createdAt, order_updated_at:node.updatedAt };

      let map = {}; const raw = node.mfJSON?.value; if (raw) { try { map = JSON.parse(raw); } catch {} }
      if (Object.keys(map).length) {
        for (const [key,t] of Object.entries(map)) {
          const rec = {
            ...base, ticket_id: t.ticket_id||key, status: t.status||"pending",
            issue: t.issue||"", message: t.message||"",
            phone: t.phone||"", email: t.email||"", name: t.name||"",
            created_at: t.created_at||base.order_created_at, updated_at: t.updated_at||base.order_updated_at
          };
          if (!status || status==="all" || rec.status.toLowerCase()===String(status).toLowerCase()) {
            out.push(rec); if (out.length>=max) break;
          }
        }
      } else if (node.mfId?.value) {
        const rec = { ...base, ticket_id: node.mfId.value, status: node.mfSt?.value||"pending",
          issue:"", message:"", phone:"", email:"", name:"", created_at:base.order_created_at, updated_at:base.order_updated_at };
        if (!status || status==="all" || rec.status.toLowerCase()===String(status).toLowerCase()) out.push(rec);
      }
      if (out.length>=max) break;
    }
    after = edges.at(-1)?.cursor;
    if (!data.orders.pageInfo.hasNextPage) break;
  }
  return out.slice(0, max);
}

app.get("/admin/tickets", requireAdmin, async (req,res)=>{
  try {
    const { since, status, limit } = req.query||{};
    const tickets = await collectTickets({ since, status, limit });
    res.json({ ok:true, count:tickets.length, tickets });
  } catch (e) { console.error("GET /admin/tickets", e); res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

app.post("/admin/tickets/update", requireAdmin, async (req,res)=>{
  try {
    const { order_id, ticket_id, status="pending" } = req.body||{};
    if (!order_id || !ticket_id) return res.status(400).json({ ok:false, error:"missing order_id/ticket_id" });
    const orderGid = `gid://shopify/Order/${order_id}`;

    const q1 = `query GetOrder($id:ID!){ order(id:$id){ name metafield(namespace:"support",key:"tickets"){ value } } }`;
    const d1 = await adminGraphQL(q1, { id: orderGid });

    let map={}; const raw=d1?.order?.metafield?.value; if (raw) { try { map=JSON.parse(raw); } catch{} }
    const now=new Date().toISOString(); const prev=map[ticket_id]||{};
    map[ticket_id] = { ...(prev||{}), ticket_id, status, order_id, order_name: prev.order_name || d1?.order?.name || "", created_at: prev.created_at || now, updated_at: now };

    const q2 = `mutation Save($ownerId:ID!,$value:String!,$tid:String!,$st:String!){
      metafieldsSet(metafields:[
        {ownerId:$ownerId,namespace:"support",key:"tickets",type:"json",value:$value},
        {ownerId:$ownerId,namespace:"support",key:"ticket_id",type:"single_line_text_field",value:$tid},
        {ownerId:$ownerId,namespace:"support",key:"ticket_status",type:"single_line_text_field",value:$st}
      ]){ userErrors{ field message } }}`;
    const d2 = await adminGraphQL(q2, { ownerId: orderGid, value: JSON.stringify(map), tid: ticket_id, st: status });
    const err = d2?.metafieldsSet?.userErrors?.[0]; if (err) throw new Error(err.message);

    res.json({ ok:true, ticket: map[ticket_id] });
  } catch (e) { console.error("POST /admin/tickets/update", e); res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

// ---------- Password-protected Admin Panel (session cookie + CSRF) ----------
const UI_USER   = process.env.UI_USER   || "admin";
const UI_PASS   = process.env.UI_PASS   || "change-me";
const UI_SECRET = process.env.UI_SECRET || (process.env.PROXY_SECRET || "super-secret-change-me");
const UI_TTL    = Number(process.env.UI_SESSION_TTL || 900); // seconds
const ALWAYS    = process.env.UI_ALWAYS_PROMPT === "1";

// Login brute-force limiter
const loginLimiter = rateLimit({ windowMs: 10*60*1000, max: 20, standardHeaders: true, legacyHeaders: false });

// Token helpers (HMAC; no server storage)
function sign(payload) {
  const json = JSON.stringify(payload);
  const b64  = Buffer.from(json).toString("base64url");
  const mac  = crypto.createHmac("sha256", UI_SECRET).update(b64).digest("base64url");
  return `${b64}.${mac}`;
}
function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [b64, mac] = token.split(".");
  const good = crypto.createHmac("sha256", UI_SECRET).update(b64).digest("base64url");
  if (!subtleEq(mac, good)) return null;
  const data = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  if (!data.exp || Date.now() > data.exp) return null;
  return data;
}

function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}

function requireSession(req, res, next) {
  const tok = req.cookies.adm || "";
  const data = verify(tok);
  if (!data) {
    setNoStore(res);
    return res.redirect(302, "/admin/login");
  }
  req.user = data.u;
  next();
}

function requireCsrf(req, res, next) {
  const c = req.cookies.csrf || "";
  const h = req.headers["x-csrf-token"] || "";
  if (!c || !h || !subtleEq(c, h)) return res.status(403).json({ ok:false, error:"bad_csrf" });
  next();
}

// Login page
app.get("/admin/login", (req, res) => {
  setNoStore(res);
  const html = `<!doctype html><meta charset="utf-8">
  <title>Sign in · Tickets Admin</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{display:grid;place-items:center;height:100svh;background:#0f172a;color:#e2e8f0;font-family:system-ui,Segoe UI,Roboto,Arial}
    .box{background:#111827;border:1px solid #1f2937;border-radius:16px;padding:28px;min-width:320px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
    h1{margin:0 0 16px;font-size:20px}
    label{display:block;margin:10px 0 6px}
    input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #374151;background:#0b1220;color:#e5e7eb}
    button{margin-top:14px;width:100%;height:40px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:600}
    .err{color:#fca5a5;margin-top:10px}
  </style>
  <div class="box">
    <h1>Tickets Admin</h1>
    <form method="post" action="/admin/login">
      <label>Username</label><input name="u" autocomplete="username">
      <label>Password</label><input name="p" type="password" autocomplete="current-password">
      <button>Sign in</button>
      ${req.query.e ? `<div class="err">Invalid credentials</div>` : ``}
    </form>
  </div>`;
  res.type("html").send(html);
});

// Handle login
app.post("/admin/login", loginLimiter, (req, res) => {
  const { u, p } = req.body || {};
  if (!subtleEq(u||"", UI_USER) || !subtleEq(p||"", UI_PASS)) {
    setNoStore(res);
    return res.redirect(302, "/admin/login?e=1");
  }
  const exp = Date.now() + (UI_TTL*1000);
  const token = sign({ u: UI_USER, exp, n: crypto.randomUUID() });
  const csrf  = crypto.randomBytes(24).toString("base64url");

  // httpOnly on session token; CSRF cookie is readable (double-submit pattern)
  res.cookie("adm", token, { httpOnly:true, secure:true, sameSite:"Strict", path:"/admin", maxAge: UI_TTL*1000 });
  res.cookie("csrf", csrf, { httpOnly:false, secure:true, sameSite:"Strict", path:"/" });

  setNoStore(res);
  return res.redirect(302, "/admin/panel");
});

// Logout (clear cookies)
app.post("/admin/logout", (req,res)=>{
  res.clearCookie("adm", { path:"/admin" });
  res.clearCookie("csrf", { path:"/" });
  setNoStore(res);
  res.redirect(302, "/admin/login");
});

// Admin panel (session required)
app.get("/admin/panel", requireSession, (req, res) => {
  setNoStore(res);
  const panelPath = path.join(__dirname, "public", "admin-panel.html");
  if (fs.existsSync(panelPath)) {
    res.sendFile(panelPath);
  } else {
    // Inline, professional panel with bulk actions + sorting
    res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Support tickets</title>
<style>
  :root{--bg:#f6f7fb;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e5e7eb;--brand:#1d4ed8;--ok:#16a34a;--warn:#ca8a04;--bad:#dc2626}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial}
  header{padding:28px 24px 0} h1{margin:0 0 16px;font-size:34px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;margin:0 24px 24px;padding:18px}
  .row{display:grid;grid-template-columns:180px 190px 110px 1fr auto auto;gap:12px}
  input,select,button{height:38px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;padding:0 10px}
  button{background:var(--brand);color:#fff;border-color:var(--brand);cursor:pointer} .ghost{background:#eef2ff;color:#3730a3}
  table{width:100%;border-collapse:collapse;margin-top:12px} th,td{padding:10px;border-bottom:1px solid #eee;font-size:14px;text-align:left}
  th{color:#334155;user-select:none;cursor:pointer}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
  .s-pending{background:#fff7ed;color:#b45309}.s-in_progress{background:#e0f2fe;color:#075985}.s-resolved{background:#dcfce7;color:#166534}.s-closed{background:#fee2e2;color:#7f1d1d}
  .muted{color:var(--muted)} .flex{display:flex;gap:8px;align-items:center}
  .toast{position:fixed;right:18px;bottom:18px;background:#111827;color:#e5e7eb;border-radius:12px;padding:12px 14px}
</style></head>
<body>
<header><h1>Support tickets</h1></header>
<section class="card">
  <div class="row">
    <label>Status<br><select id="st"><option value="all">All</option><option>pending</option><option>in_progress</option><option>resolved</option><option>closed</option></select></label>
    <label>Updated since<br><input id="since" type="date"></label>
    <label>Limit<br><input id="lim" type="number" value="200" min="1" max="1000"></label>
    <label>Search (ticket / order / name / email)<br><input id="q" placeholder="Type to filter…"></label>
    <div class="flex" style="align-self:end"><button id="go">Refresh</button><button id="clr" class="ghost" type="button">Clear</button></div>
    <div class="flex" style="align-self:end;justify-self:end">
      <select id="bulkStatus">
        <option value="">Bulk set status…</option>
        <option value="pending">pending</option>
        <option value="in_progress">in_progress</option>
        <option value="resolved">resolved</option>
        <option value="closed">closed</option>
      </select>
      <button id="bulkApply" class="ghost">Apply</button>
      <form id="logoutForm" method="post" action="/admin/logout" style="margin:0"><button style="margin-left:8px;background:#334155">Logout</button></form>
    </div>
  </div>
  <div id="err" class="muted" style="margin-top:10px;display:none"></div>
  <table id="tbl"><thead><tr>
    <th data-k="ticket_id">TICKET</th><th data-k="status">STATUS</th><th data-k="order_name">ORDER</th>
    <th data-k="created_at">CREATED</th><th data-k="updated_at">UPDATED</th>
    <th data-k="name">NAME</th><th data-k="email">EMAIL</th><th data-k="phone">PHONE</th>
    <th data-k="issue">ISSUE</th><th data-k="message">MESSAGE</th><th>ACTIONS</th>
  </tr></thead><tbody><tr><td colspan="11" class="muted">Loading…</td></tr></tbody></table>
</section>
<div id="toast" class="toast" style="display:none"></div>
<script>
  const $  = s=>document.querySelector(s);
  const $$ = s=>Array.from(document.querySelectorAll(s));
  const fmt = d => d ? new Date(d).toLocaleString() : "";
  const csrf = (document.cookie.split("; ").find(x=>x.startsWith("csrf="))||"").split("=")[1]||"";

  let data=[], sortKey="updated_at", sortDir=-1; // -1 desc, 1 asc

  function toast(msg){ const t=$("#toast"); t.textContent=msg; t.style.display="block"; setTimeout(()=>t.style.display="none", 2200); }

  function paint(){
    const q = ($("#q").value||"").toLowerCase();
    const rows = data
      .filter(t => !q || [t.ticket_id,t.order_name,t.name,t.email].filter(Boolean).some(x=>String(x).toLowerCase().includes(q)))
      .sort((a,b)=> (a[sortKey]||"") > (b[sortKey]||"") ? sortDir : -sortDir)
      .map(t => \`<tr>
        <td><label><input type="checkbox" class="pick" data-oid="\${t.order_id}" data-tid="\${t.ticket_id}"> <code>\${t.ticket_id||""}</code></label></td>
        <td><span class="pill s-\${t.status||"pending"}">\${(t.status||"").replace("_"," ")}</span></td>
        <td><code>\${t.order_name||t.order_id||""}</code></td>
        <td>\${fmt(t.created_at)}</td>
        <td>\${fmt(t.updated_at)}</td>
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
          <button class="ghost copy" data-txt="\${t.ticket_id}">Copy</button>
        </td>
      </tr>\`).join("");
    $("#tbl tbody").innerHTML = rows || '<tr><td colspan="11" class="muted">No tickets</td></tr>';
    // Wire per-row actions
    $$("#tbl .save").forEach(btn => btn.onclick = async ()=>{
      const tr = btn.closest("tr"); const status = tr.querySelector(".set").value;
      const body = { order_id: btn.dataset.oid, ticket_id: btn.dataset.tid, status };
      const r = await fetch("/admin/ui/update",{ method:"POST", headers:{ "Content-Type":"application/json","X-CSRF-Token":csrf }, credentials:"include", body: JSON.stringify(body) });
      const j = await r.json(); if (!j.ok) alert("Update failed: " + j.error); else { toast("Saved"); load(); }
    });
    $$("#tbl .copy").forEach(btn => btn.onclick = ()=>{ navigator.clipboard.writeText(btn.dataset.txt); toast("Copied"); });
  }

  async function load(){
    $("#err").style.display="none";
    const qs = new URLSearchParams({ status: $("#st").value||"all", since: $("#since").value||"", limit: $("#lim").value||200 });
    const r = await fetch("/admin/ui/tickets?"+qs.toString(), { credentials:"include" });
    const j = await r.json().catch(()=>({ok:false,error:"bad_json"}));
    if(!j.ok){ $("#err").textContent = "Failed: " + j.error; $("#err").style.display="block"; $("#tbl tbody").innerHTML=""; return; }
    data = j.tickets || []; paint();
  }

  // Sorting
  $$("#tbl th[data-k]").forEach(th => th.onclick = ()=>{
    const k = th.dataset.k; sortKey === k ? sortDir*=-1 : (sortKey=k, sortDir=-1); paint();
  });

  $("#go").onclick = load;
  $("#clr").onclick = ()=>{ $("#st").value="all"; $("#since").value=""; $("#lim").value=200; $("#q").value=""; load(); };
  $("#q").oninput = ()=> paint();

  // Bulk update
  $("#bulkApply").onclick = async ()=>{
    const val = $("#bulkStatus").value; if(!val) return;
    const picks = $$("#tbl .pick:checked").map(x=>({ order_id:x.dataset.oid, ticket_id:x.dataset.tid }));
    for (const p of picks) {
      await fetch("/admin/ui/update",{ method:"POST", headers:{ "Content-Type":"application/json","X-CSRF-Token":csrf }, credentials:"include", body: JSON.stringify({ ...p, status: val }) });
    }
    toast("Bulk saved"); load();
  };

  load();
</script>
</body></html>`);
  }
  // If "always prompt", expire session immediately after serving the panel
  if (ALWAYS) {
    res.on("finish", () => {
      try { res.clearCookie("adm", { path:"/admin" }); } catch {}
    });
  }
});

// JSON endpoints used by the panel (session + CSRF required)
const uiLimiter = rateLimit({ windowMs: 60*1000, max: 120, standardHeaders:true, legacyHeaders:false });
app.get("/admin/ui/tickets", requireSession, uiLimiter, async (req,res)=>{
  try {
    const { since, status="all", limit=200 } = req.query||{};
    const tickets = await collectTickets({ since, status, limit });
    res.json({ ok:true, count:tickets.length, tickets });
  } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
});
app.post("/admin/ui/update", requireSession, requireCsrf, uiLimiter, async (req,res)=>{
  try {
    const { order_id, ticket_id, status="pending" } = req.body||{};
    if (!order_id || !ticket_id) return res.status(400).json({ ok:false, error:"missing order_id/ticket_id" });
    const orderGid = `gid://shopify/Order/${order_id}`;
    const q1 = `query GetOrder($id:ID!){ order(id:$id){ name metafield(namespace:"support",key:"tickets"){ value } } }`;
    const d1 = await adminGraphQL(q1, { id: orderGid });

    let map={}; const raw=d1?.order?.metafield?.value; if (raw) { try { map=JSON.parse(raw); } catch{} }
    const now=new Date().toISOString(); const prev=map[ticket_id]||{};
    map[ticket_id] = { ...(prev||{}), ticket_id, status, order_id, order_name: prev.order_name || d1?.order?.name || "", created_at: prev.created_at || now, updated_at: now };

    const q2 = `mutation Save($ownerId:ID!,$value:String!,$tid:String!,$st:String!){
      metafieldsSet(metafields:[
        {ownerId:$ownerId,namespace:"support",key:"tickets",type:"json",value:$value},
        {ownerId:$ownerId,namespace:"support",key:"ticket_id",type:"single_line_text_field",value:$tid},
        {ownerId:$ownerId,namespace:"support",key:"ticket_status",type:"single_line_text_field",value:$st}
      ]){ userErrors{ field message } }}`;
    const d2 = await adminGraphQL(q2, { ownerId: orderGid, value: JSON.stringify(map), tid: ticket_id, st: status });
    const err = d2?.metafieldsSet?.userErrors?.[0]; if (err) throw new Error(err.message);

    res.json({ ok:true, ticket: map[ticket_id] });
  } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

// ---------- Start ----------
app.listen(PORT, ()=> console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT} api=${API_VERSION}`));
