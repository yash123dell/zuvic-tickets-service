import crypto from 'crypto';
import express from 'express';

const app = express();
app.disable('x-powered-by');

const PORT = process.env.PORT || 3000;

// Use your app's "API secret key" (from Shopify → App → API credentials)
const PROXY_SECRET = process.env.PROXY_SECRET || '';

// ---- Health check for Render ----
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// ---- Optional: verify Shopify App Proxy signature ----
function verifySignature(query) {
  if (!PROXY_SECRET) return false;
  const { signature, ...rest } = query;
  if (!signature) return false;

  const msg = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join(''); // App Proxy spec: concatenate without separators

  const expected = crypto
    .createHmac('sha256', PROXY_SECRET)
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

// ---- Root route: fix "Not found" at "/" ----
app.get('/', (_req, res) => res.redirect(302, '/tickets/test'));

// Optional: make "/tickets" work without the trailing segment
app.get('/tickets', (_req, res) => res.redirect(302, '/tickets/test'));

// ---- App Proxy endpoint (Shopify forwards /apps/supporttickets/* here) ----
app.get('/tickets/*', (req, res) => {
  // Uncomment to enforce HMAC:
  // if (!verifySignature(req.query)) return res.status(403).type('text').send('Invalid signature');

  res.type('html').status(200).send(`
    <div style="font-family:system-ui;padding:16px">
      <h2>ZUVIC Support Tickets</h2>
      <p>Proxy path: <code>${req.path}</code></p>
      <p>Next step: render the customer's tickets here.</p>
    </div>
  `);
});

// ---- 404 fallback ----
app.use((_req, res) => res.status(404).type('text').send('Not found'));

app.listen(PORT, () => {
  console.log(`ZUVIC tickets service listening on :${PORT}`);
});
