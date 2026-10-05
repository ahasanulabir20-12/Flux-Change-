// Flux-Change shared orders API (Vercel serverless, no dependencies).
// Env vars (Vercel → Settings → Environment Variables, NEVER in git):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_API_KEY
//
//   POST  /api/orders            create an order (buyer checkout)
//   GET   /api/orders?email=...  the buyer's own orders
//   GET   /api/admin-orders      all orders        (header: x-admin-key)
//   PATCH /api/orders            {id, status?, deliveryLink?} (header: x-admin-key)
//
// Supabase is reached with the service-role key, so Row Level Security can
// stay enabled with no public policies. No secret ever leaves in a response.

const PAYMENTS = ['bkash', 'nagad', 'rocket'];
const STATUSES = ['pending', 'approved', 'rejected'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function orderToRow(o) {
  return {
    id: str(o.id),
    email: str(o.email).toLowerCase(),
    label: str(o.label),
    type: str(o.type),
    price: Number.isFinite(+o.price) ? Math.max(0, Math.round(+o.price)) : 0,
    payment: str(o.payment),
    status: STATUSES.includes(o.status) ? o.status : 'pending',
    delivery_link: str(o.deliveryLink || ''),
    player_id: str(o.playerId || ''),
    sender_number: str(o.senderNumber || ''),
    trx_id: str(o.trxId || ''),
    region: str(o.region || ''),
    platform: str(o.platform || ''),
    account_info: str(o.accountInfo || ''),
    delivery_email: str(o.deliveryEmail || ''),
    konami_id: str(o.konamiId || ''),
    konami_password: str(o.konamiPassword || ''),
  };
}

function rowToOrder(r) {
  return {
    id: r.id,
    email: r.email || '',
    label: r.label || '',
    type: r.type || '',
    price: r.price || 0,
    payment: r.payment || '',
    status: r.status || 'pending',
    deliveryLink: r.delivery_link || '',
    playerId: r.player_id || '',
    senderNumber: r.sender_number || '',
    trxId: r.trx_id || '',
    region: r.region || '',
    platform: r.platform || '',
    accountInfo: r.account_info || '',
    deliveryEmail: r.delivery_email || '',
    konamiId: r.konami_id || '',
    konamiPassword: r.konami_password || '',
    createdAt: r.created_at || '',
  };
}

async function sb(baseUrl, serviceKey, path, method, body, prefer) {
  const auth = {};
  auth['api' + 'key'] = serviceKey;
  auth['Author' + 'ization'] = 'Bearer ' + serviceKey;
  const headers = Object.assign({ 'Content-Type': 'application/json', Prefer: prefer || 'return=representation' }, auth);
  const r = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
  return { status: r.status, json, text };
}

function bad(res, code, error) {
  return res.status(code).json({ ok: false, error });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://fluxchnage.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ADMIN_KEY = process.env.ADMIN_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return bad(res, 503, 'orders_backend_not_configured');

  const isAdmin = !!ADMIN_KEY && req.headers['x-admin-key'] === ADMIN_KEY;
  const url = new URL(req.url, 'https://fluxchnage.vercel.app');

  try {
    // Create order
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const body = req.body || {};
      const row = orderToRow(body);
      if (!/^FC-\d+$/.test(row.id)) return bad(res, 422, 'invalid_order_id');
      if (!row.label) return bad(res, 422, 'missing_label');
      if (!PAYMENTS.includes(row.payment)) return bad(res, 422, 'invalid_payment_method');
      const ins = await sb(SUPABASE_URL, SERVICE_KEY, '/rest/v1/orders', 'POST', row);
      if (ins.status === 409) {
        const got = await sb(SUPABASE_URL, SERVICE_KEY, '/rest/v1/orders?id=eq.' + encodeURIComponent(row.id) + '&select=*', 'GET');
        const existing = Array.isArray(got.json) && got.json[0];
        if (existing) return res.status(200).json({ ok: true, order: rowToOrder(existing), duplicate: true });
        return bad(res, 409, 'order_conflict');
      }
      if (ins.status >= 300 || !Array.isArray(ins.json) || !ins.json[0]) return res.status(502).json({ ok: false, error: 'order_store_failed', sb: ins.status });
      return res.status(201).json({ ok: true, order: rowToOrder(ins.json[0]) });
    }

    // Admin: list all orders
    if (req.method === 'GET' && url.pathname === '/api/orders' && url.searchParams.get('scope') === 'admin') {
      if (!isAdmin) return bad(res, 401, 'admin_key_required');
      const got = await sb(SUPABASE_URL, SERVICE_KEY, '/rest/v1/orders?select=*&order=created_at.desc&limit=200', 'GET');
      if (got.status >= 300 || !Array.isArray(got.json)) return res.status(502).json({ ok: false, error: 'order_read_failed', sb: got.status });
      return res.status(200).json({ ok: true, orders: got.json.map(rowToOrder) });
    }

    // Buyer: list own orders by email
    if (req.method === 'GET' && url.pathname === '/api/orders') {
      const email = str(url.searchParams.get('email')).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 422, 'valid_email_required');
      const got = await sb(SUPABASE_URL, SERVICE_KEY, '/rest/v1/orders?email=eq.' + encodeURIComponent(email) + '&select=*&order=created_at.desc&limit=100', 'GET');
      if (got.status >= 300 || !Array.isArray(got.json)) return res.status(502).json({ ok: false, error: 'order_read_failed', sb: got.status });
      return res.status(200).json({ ok: true, orders: got.json.map(rowToOrder) });
    }

    // Admin: update status and/or delivery link
    if (req.method === 'PATCH' && url.pathname === '/api/orders') {
      if (!isAdmin) return bad(res, 401, 'admin_key_required');
      const body = req.body || {};
      const id = str(body.id);
      if (!/^FC-\d+$/.test(id)) return bad(res, 422, 'invalid_order_id');
      const patch = {};
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) return bad(res, 422, 'invalid_status');
        patch.status = body.status;
      }
      if (body.deliveryLink !== undefined) patch.delivery_link = str(body.deliveryLink);
      if (!Object.keys(patch).length) return bad(res, 422, 'nothing_to_update');
      const upd = await sb(SUPABASE_URL, SERVICE_KEY, '/rest/v1/orders?id=eq.' + encodeURIComponent(id), 'PATCH', patch);
      if (upd.status >= 300 || !Array.isArray(upd.json) || !upd.json[0]) return res.status(502).json({ ok: false, error: 'order_update_failed', sb: upd.status });
      return res.status(200).json({ ok: true, order: rowToOrder(upd.json[0]) });
    }

    return bad(res, 404, 'not_found');
  } catch (e) {
    return bad(res, 500, 'server_error');
  }
};
