// server.js (ESM) — Zuvic Tickets API (hard-coded config for quick testing)
import express from "express";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

// ---- HARD-CODED CONFIG (put your real values here) ----
const PORT         = 3000;                 // or whatever your host uses
const PROXY_SECRET = "";
const PROXY_MOUNT  = "/tickets";
const PROXY_DEBUG  = true;                // set true to log HMAC mismatches
// ------------------------------------------------------

// Health
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// Landing page for Admin “App URL”
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<meta charset="utf-8">
<title>Zuvic Tickets API</title>
<style>body{font:14px system-ui,Segoe UI,Roboto,Helvetica,Arial;margin:40px;line-height:1.5}</style>
<h1>Zuvic Tickets API</h1>
<p>Status: <code>ok</code></p>
<ul>
  <li>Health: <a href="/healthz">/healthz</a></li>
  <li>Proxy endpoint (POST only): <code>${PROXY_MOUNT}/attach-ticket</code></li>
</ul>`);
});

// Optional GET guard so manual visits show a clear message
app.get(`${PROXY_MOUNT}/attach-ticket`, (_req, res) => {
  res.status(405).json({ ok: false, error: "method_not_allowed", method: "GET" });
});

// ---- Shopify App Proxy HMAC (from RAW query string; exact behavior)
function expectedHmacFromReq(req, secret) {
  const rawQs = (req.originalUrl.split("?")[1] || "");
  const pairs = [];
  const usp = new URLSearchParams(rawQs);
  for (const [k, v] of usp) {
    if (k === "signature") continue;
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const msg = pairs.map(([k, v]) => `${k}=${v}`).join("");
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

function verifyProxySignature(req) {
  const provided = String(req.query.signature || "").toLowerCase();
  if (!PROXY_SECRET || !provided) return false;
  const expected = expectedHmacFromReq(req, PROXY_SECRET).toLowerCase();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok && PROXY_DEBUG) {
    console.error("[proxy] bad signature", { provided, expected, rawQs: req.originalUrl.split("?")[1] || "" });
  }
  return ok;
}

// ---- Proxy route: /apps/support/attach-ticket → https://tickets.zuvic.in/tickets/attach-ticket
app.post(`${PROXY_MOUNT}/attach-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    const { order_id, ticket_id, status } = req.body || {};
    if (!order_id || !ticket_id || !status) {
      return res.status(400).json({ ok: false, error: "missing_fields", fields: ["order_id","ticket_id","status"] });
    }

    // TODO: your real logic (DB write / call ticket system)
    return res.status(200).json({ ok: true, order_id, ticket_id, status });
  } catch (err) {
    console.error("[attach-ticket] unhandled error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Fallback
app.use((req, res) => res.status(404).json({ ok: false, error: "not_found", path: req.path }));

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT}`);
});
