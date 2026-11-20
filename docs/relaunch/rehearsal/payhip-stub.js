'use strict';
// Stub Payhip licence API (GET /api/v2/license/verify?license_key=...).
// Responds per key so the rehearsal can drive every licence state:
//   KAL-VALID    -> enabled licence for the activation product
//   KAL-DISABLED -> licence disabled (Payhip disables it when a sale is refunded)
//   KAL-WRONG    -> a licence for a different product
//   anything else -> 404 (Payhip's "not found")
const http = require('http');
const PRODUCT_LINK = 'ACTIVATION';
const PORT = Number(process.env.PAYHIP_STUB_PORT || 5432);
const hits = [];

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.endsWith('/license/usage')) {
    hits.push({ path: 'usage' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"data":{"uses":1}}');
  }
  if (!url.pathname.endsWith('/license/verify')) { res.writeHead(404); return res.end(); }
  const key = url.searchParams.get('license_key');
  const secret = req.headers['product-secret-key'];
  hits.push({ key, secretPresent: !!secret });
  if (!secret) { res.writeHead(401); return res.end(); }
  const table = {
    'KAL-VALID': { enabled: true, product_link: PRODUCT_LINK, buyer_email: 'buyer@example.com', uses: 0 },
    'KAL-DISABLED': { enabled: false, product_link: PRODUCT_LINK, buyer_email: 'buyer@example.com', uses: 1 },
    'KAL-WRONG': { enabled: true, product_link: 'OTHERPRODUCT', buyer_email: 'buyer@example.com', uses: 0 }
  };
  const data = table[key];
  if (!data) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data }));
}).listen(PORT, '127.0.0.1', () => console.log('[payhip-stub] listening on ' + PORT));
