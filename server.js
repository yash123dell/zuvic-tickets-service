// server.js  (ESM)
import crypto from 'crypto';
import express from 'express';

const app = express();
app.disable('x-powered-by');
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== ENV =====
const SHOPIFY_SHOP   = process.env.SHOPIFY_SHOP;                // e.g. zuvic-in.myshopify.com
const ADMIN_TOKEN    = process.env.SHOPIFY_ADMIN_TOKEN || '';   // Admin API token
const PROXY_SECRET   = process.env.PROXY_SECRET || '';          // App proxy secret (HMAC)

// ---- Health ----
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// ---- HMAC verify for App Proxy ----
function verifySignature(query) {
  if (!PROXY_SECRET) return false;
  const { signature, ...rest } = query;
  if (!signature) return false;
  const msg = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('');
  const expected = crypto.createHmac('sha256', PROXY_SECRET).update(msg).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

// ---- REST helper (for the orders list page) ----
async function shopifyGet(path) {
  const url = `https://${SHOPIFY_SHOP}${path}`;
  const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`Shopify ${r.status} ${await r.text()}`);
  return r.json();
}

// ---- GraphQL helper (for metafields write) ----
async function shopifyGraphQL(query, variables) {
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-10/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await r.json();
  if (!r.ok || json.errors) throw new Error(JSON.stringify(json));
  return json.data;
}

// ---- Root/demo ----
app.get('/', (_req, res) => res.redirect(302, '/tickets/test'));

app.get('/tickets/test', (_req, res) => {
  res.type('html').send(`
    <div style="font-family:system-ui;padding:16px">
      <h1>ZUVIC Support Tickets</h1>
      <p>Proxy path: <code>/tickets/test</code></p>
      <p>Next step: render the customer's tickets here.</p>
    </div>
  `);
});

// ---- Orders list via customer_id (used by /apps/supporttickets?customer_id=...) ----
app.get('/tickets', async (req, res) => {
  try {
    const customerId = req.query.customer_id;
    if (!customerId) return res.status(400).type('text').send('Missing customer_id');
    const data = await shopifyGet(
      `/admin/api/2024-10/orders.json?customer_id=${encodeURIComponent(customerId)}&status=any&limit=10&fields=id,name,order_number,created_at,total_price,financial_status,fulfillment_status`
    );
    const orders = data.orders || [];
    const list = orders.map(o => {
      const created = (o.created_at || '').slice(0, 10);
      return `<li style="margin:8px 0">
        <strong>${o.name || '#' + o.order_number}</strong>
        <span style="opacity:.7"> • ${created}</span>
        <span style="opacity:.7"> • ₹${o.total_price}</span>
        <span style="opacity:.7"> • ${o.financial_status}/${o.fulfillment_status}</span>
        <a style="margin-left:8px" href="/pages/raise-ticket?order=${encodeURIComponent(o.name)}&order_id=${o.id}">Raise ticket</a>
      </li>`;
    }).join('') || '<li>No orders found.</li>';

    res.type('html').send(`
      <div style="font-family:system-ui;padding:16px;max-width:820px;margin:auto">
        <h1>Your Orders</h1>
        <ul style="padding-left:18px">${list}</ul>
      </div>
    `);
  } catch (e) {
    console.error(e);
    res.status(500).type('text').send('Failed to fetch orders.');
  }
});

// ---- NEW: write ticket metafields on an Order ----
// Proxied as:  /apps/supporttickets/attach-ticket  ->  /tickets/attach-ticket
app.post('/tickets/attach-ticket', async (req, res) => {
  try {
    // Enable this once PROXY_SECRET is set
    // if (!verifySignature(req.query)) return res.status(403).json({ ok: false, error: 'Invalid signature' });

    const { order_id, ticket_id, status } = req.body || {};
    if (!order_id || !ticket_id) {
      return res.status(400).json({ ok: false, error: 'order_id and ticket_id are required' });
    }

    const ownerId = `gid://shopify/Order/${order_id}`;
    const mutation = `
      mutation SetTicketMetafields($ownerId: ID!, $ticketId: String!, $status: String!) {
        metafieldsSet(metafields: [
          { ownerId: $ownerId, namespace: "support", key: "ticket_id",    type: "single_line_text_field", value: $ticketId },
          { ownerId: $ownerId, namespace: "support", key: "ticket_status", type: "single_line_text_field", value: $status }
        ]) {
          userErrors { field message }
        }
      }
    `;
    const data = await shopifyGraphQL(mutation, {
      ownerId,
      ticketId: String(ticket_id),
      status: String(status || 'pending')
    });

    const errs = data?.metafieldsSet?.userErrors || [];
    if (errs.length) return res.status(422).json({ ok: false, errors: errs });

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'metafieldsSet failed' });
  }
});

// ---- 404 ----
app.use((_req, res) => res.status(404).type('text').send('Not found'));

app.listen(PORT, () => console.log(`ZUVIC tickets service listening on :${PORT}`));
