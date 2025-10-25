// server.js (ESM)
import express from "express";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

const PORT          = process.env.PORT || 3000;
const PROXY_SECRET  = process.env.PROXY_SECRET || "";   // App proxy -> Signing secret
const PROXY_MOUNT   = process.env.PROXY_MOUNT || "/tickets"; // you set /tickets
const PROXY_DEBUG   = process.env.PROXY_DEBUG === "1";  // optional: logs expected/provided HMAC

// -------- Health
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// -------- HMAC helpers (Shopify App Proxy)
function expectedHmacFromReq(req, secret) {
  // Raw querystring after '?'
  const rawQs = (req.originalUrl.split("?")[1] || "");

  // Collect ALL pairs except "signature" exactly as sent
  const pairs = [];
  const usp = new URLSearchParams(rawQs);
  for (const [k, v] of usp) {
    if (k === "signature") continue;
    pairs.push([k, v]);
  }

  // Sort by key, then by value (covers duplicate keys deterministically)
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  // Concatenate "k=v" with NO separators between pairs
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

// -------- Route hit via: /apps/support/attach-ticket  →  https://tickets.zuvic.in/tickets/attach-ticket
app.post(`${PROXY_MOUNT}/attach-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req)) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    const { order_id, ticket_id, status } = req.body || {};
    if (!order_id || !ticket_id || !status) {
      return res.status(400).json({ ok: false, error: "missing_fields", fields: ["order_id","ticket_id","status"] });
    }

    // TODO: your real logic here (DB write / external call)
    return res.status(200).json({ ok: true, order_id, ticket_id, status });
  } catch (err) {
    console.error("[attach-ticket] error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// -------- 404 JSON
app.use((req, res) => res.status(404).json({ ok: false, error: "not_found", path: req.path }));

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT}`);
});
