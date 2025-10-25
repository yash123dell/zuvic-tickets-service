// server.js (ESM)
import express from "express";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

// --- ENV
const PORT         = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET || "";     // App proxy → Signing secret (from Partner dashboard)
const PROXY_MOUNT  = process.env.PROXY_MOUNT || "/tickets"; // You set this to /tickets
const PROXY_DEBUG  = process.env.PROXY_DEBUG === "1";    // optional debug logging

// --- Health
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// --- Friendly landing so Admin "App URL" isn't 404
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<meta charset="utf-8">
<title>Zuvic Tickets API</title>
<style>body{font:14px system-ui,Segoe UI,Roboto,Helvetica,Arial;margin:40px;line-height:1.4}</style>
<h1>Zuvic Tickets API</h1>
<p>Status: <code>ok</code></p>
<ul>
  <li>Health: <a href="/healthz">/healthz</a></li>
  <li>Proxy endpoint (POST only): <code>${PROXY_MOUNT}/attach-ticket</code></li>
</ul>`);
});

// --- Optional: make GET on the proxy route return a clear message (route is POST-only)
app.get(`${PROXY_MOUNT}/attach-ticket`, (_req, res) => {
  res.status(405).json({ ok: false, error: "method_not_allowed", method: "GET" });
});

// ===== Shopify App-Proxy signature verification (exact) =====
function expectedHmacFromReq(req, secret) {
  // raw querystring after '?'
  const rawQs = (req.originalUrl.split("?")[1] || "");

  // collect all pairs except "signature", exactly as sent
  const pairs = [];
  const usp = new URLSearchParams(rawQs);
  for (const [k, v] of usp) {
    if (k === "signature") continue;
    pairs.push([k, v]);
  }

  // deterministic order: by key, then by value
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  // concatenate k=v with NO separators between pairs
  const msg = pairs.map(([k, v]) => `${k}=${v}`).join("");

  // HMAC-SHA256 hex (lowercase)
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

function verifyProxySignature(req) {
  if (!PROXY_SECRET) return false;
  const provided = String(req.query.signature || "").toLowerCase();
  if (!provided) return false;

  const expected = expectedHmacFromReq(req, PROXY_SECRET).toLowerCase();

  // timing-safe compare
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok && PROXY_DEBUG) {
    console.error("[proxy] bad signature", {
      provided,
      expected,
      rawQs: req.originalUrl.split("?")[1] || ""
    });
  }
  return ok;
}

// ===== Proxy ROUTE:  /apps/support/attach-ticket → https://tickets.zuvic.in/tickets/attach-ticket =====
app.post(`${PROXY_MOUNT}/attach-ticket`, async (req, res) => {
  try {
    // 1) Verify Shopify app-proxy signature
    if (!verifyProxySignature(req)) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    // 2) Validate body
    const { order_id, ticket_id, status } = req.body || {};
    if (!order_id || !ticket_id || !status) {
      return res.status(400).json({
        ok: false,
        error: "missing_fields",
        fields: ["order_id", "ticket_id", "status"]
      });
    }

    // 3) TODO: your real logic (DB write / external call to your ticket system)
    // Example success echo:
    return res.status(200).json({ ok: true, order_id, ticket_id, status });
  } catch (err) {
    console.error("[attach-ticket] unhandled error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// --- 404 fallback (JSON only)
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found", path: req.path });
});

// --- Start
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT}`);
});
