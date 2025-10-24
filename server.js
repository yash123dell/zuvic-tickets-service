import crypto from "crypto";
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET || "";

// Simple HMAC check for Shopify App Proxy requests
function verifyHmac(query) {
  if (!PROXY_SECRET) return false;
  const { signature, ...rest } = query;               // Shopify sends signature
  const message = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('');
  const digest = crypto.createHmac('sha256', PROXY_SECRET)
    .update(message)
    .digest('hex');
  return digest === signature;
}

// Health check
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Your App Proxy base path (Render URL must end with /tickets/)
app.get("/tickets/*", (req, res) => {
  // OPTIONAL: uncomment to enforce HMAC
  // if (!verifyHmac(req.query)) return res.status(403).send("Invalid signature");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`
    <div style="font-family:system-ui;padding:16px">
      <h2>ZUVIC Support Tickets</h2>
      <p>This is the App Proxy endpoint responding at <code>/tickets</code>.</p>
      <p>Next step: render the customer's tickets here.</p>
    </div>
  `);
});

app.listen(PORT, () => {
  console.log(`ZUVIC tickets service listening on :${PORT}`);
});
