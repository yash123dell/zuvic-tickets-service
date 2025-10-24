import crypto from 'crypto';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// Use your app's "API secret key" (from Shopify → App → API credentials)
const PROXY_SECRET = process.env.PROXY_SECRET || '';

// ---- Health check for Render ----
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---- Optional: verify Shopify App Proxy signature ----
function verifySignature(query) {
  if (!PROXY_SECRET) return false;
  const { signature, ...rest } = query;
  if (!signature) return false;

  const msg = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join(''); // per App Proxy spec: concatenate without separators

  const expected = crypto.createHmac('sha256', PROXY_SECRET)
    .update(msg)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

// ---- App Proxy endpoint (Shopify forwards /apps/supporttickets/* here) ----
app.get('/tickets/*', (req, res) => {
  // Uncomment to enforce HMAC:
  // if (!verifySignature(req.query)) return res.status(403).send('Invalid signature');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`
    <div style="font-family:system-ui;padding:16px">
      <h2>ZUVIC Support Tickets</h2>
      <p>Proxy path: <code>${req.path}</code></p>
      <p>Next step: render the customer's tickets here.</p>
    </div>
  `);
});

// Fallback
app.use((_req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`ZUVIC tickets service listening on :${PORT}`);
});
