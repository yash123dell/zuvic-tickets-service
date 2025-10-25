// server.js (ESM)
import express from "express";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

const PORT         = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET || "";   // App proxy Signing secret (from Partner → App proxy)
const PROXY_MOUNT  = process.env.PROXY_MOUNT || "/tickets"; // you already set /tickets

// Health
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// --- Shopify App-Proxy signature verify
function verifyProxySignature(query) {
  if (!PROXY_SECRET) return false;
  const { signature, ...rest } = query || {};
  if (!signature) return false;

  const keys = Object.keys(rest).sort();
  let msg = "";
  for (const k of keys) {
    const v = Array.isArray(rest[k]) ? rest[k].join(",") : `${rest[k]}`;
    msg += `${k}=${v}`;
  }
  const expected = crypto.createHmac("sha256", PROXY_SECRET).update(msg).digest("hex");
  return expected === signature;
}

// --- Route hit by Shopify via:  /apps/support/attach-ticket  →  https://tickets.zuvic.in/tickets/attach-ticket
app.post(`${PROXY_MOUNT}/attach-ticket`, async (req, res) => {
  try {
    if (!verifyProxySignature(req.query)) {
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }

    const { order_id, ticket_id, status } = req.body || {};
    if (!order_id || !ticket_id || !status) {
      return res.status(400).json({ ok: false, error: "missing_fields", fields: ["order_id","ticket_id","status"] });
    }

    // TODO: your real logic (DB write, call ticket service, etc.)
    return res.status(200).json({ ok: true, order_id, ticket_id, status });
  } catch (err) {
    console.error("[attach-ticket] error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 404 JSON
app.use((req, res) => res.status(404).json({ ok: false, error: "not_found", path: req.path }));

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} mount=${PROXY_MOUNT}`);
});
