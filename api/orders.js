// POST /api/orders — Flux-Change Phase 1 order pipeline.
// Env vars (Vercel → Settings → Environment Variables, NEVER in git):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, NOTIFY_EMAIL
//
// Flow: validate → rate-limit → insert order (service_role) → email via Resend.
// Email failure NEVER fails the order. No secret ever leaves in a response.

const MERCHANT_NUMBERS = {
  bkash: '01913156741',
  nagad: '01965155166',
  rocket: '01709539837',
};

const RATE_LIMIT_MAX = 10; // orders per IP
const RATE_LIMIT_WINDOW_MIN = 10;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

async function sb(path, serviceKey, baseUrl, method, body) {
  const r = await fetch(baseUrl + path, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
  if (!SUPABASE_URL || !SERVICE_KEY) return bad(res, 503, 'service_unavailable');

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};

  // ---------- validation (mirrors client-side rules) ----------
  const game = str(b.game);
  const packLabel = str(b.packLabel || b.pack);
  const price = Number(b.price);
  const payment = str(b.payment).toLowerCase();
  const orderType = str(b.orderType || 'topup'); // topup | code | subscription
  const playerUid = str(b.playerUid || b.uid || b.playerId);
  const region = str(b.region);
  const platform = str(b.platform);
  const deliveryEmail = str(b.deliveryEmail);
  const accountInfo = str(b.accountInfo);
  const senderNumber = str(b.senderNumber).replace(/[\s-]/g, '');
  const trxId = str(b.trxId);

  if (!game || !packLabel || !(price > 0)) return bad(res, 400, 'invalid_order');
  if (!['bkash', 'nagad', 'rocket'].includes(payment)) return bad(res, 400, 'invalid_payment');
  if (orderType === 'topup' && !playerUid) return bad(res, 400, 'missing_uid');
  if (orderType === 'topup' && !region) return bad(res, 400, 'missing_region');
  if (orderType === 'code') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(deliveryEmail)) return bad(res, 400, 'invalid_email');
    if (!['EA', 'Steam'].includes(platform)) return bad(res, 400, 'invalid_platform');
  }
  if (orderType === 'subscription' && !accountInfo) return bad(res, 400, 'missing_account_info');
  if (!/^01\d{9}$/.test(senderNumber)) return bad(res, 400, 'invalid_sender_number');
  if (!trxId) return bad(res, 400, 'missing_trx_id');

  const ip =
    str((req.headers['x-forwarded-for'] || '').split(',')[0]) ||
    str(req.headers['x-real-ip']) ||
    'unknown';

  try {
    const rest = SUPABASE_URL.replace(/\/$/, '') + '/rest/v1';

    // ---------- rate limit ----------
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60 * 1000).toISOString();
    const counted = await sb(
      '/order_attempts?select=id&ip=eq.' + encodeURIComponent(ip) +
      '&created_at=gte.' + encodeURIComponent(windowStart),
      SERVICE_KEY, rest, 'GET'
    );
    if (counted.status === 200 && Array.isArray(counted.json) &&
        counted.json.length >= RATE_LIMIT_MAX) {
      return bad(res, 429, 'too_many_requests');
    }
    await sb('/order_attempts', SERVICE_KEY, rest, 'POST', { ip });

    // ---------- order number ----------
    const noRes = await sb('/rpc/next_order_no', SERVICE_KEY, rest, 'POST', {});
    const orderNo = typeof noRes.json === 'string' ? noRes.json
      : (noRes.json && noRes.json[0]) || null;
    if (!orderNo) return bad(res, 500, 'order_failed');

    // ---------- insert ----------
    const row = {
      order_no: orderNo,
      game, pack_label: packLabel, price_bdt: price,
      payment_method: payment,
      merchant_number: MERCHANT_NUMBERS[payment] || null,
      player_uid: playerUid || null,
      region: region || null,
      platform: platform || null,
      delivery_email: deliveryEmail || null,
      account_info: accountInfo || null,
      sender_number: senderNumber,
      trx_id: trxId,
      order_type: orderType,
      status: 'pending',
      customer_ip: ip,
    };
    const ins = await sb('/orders', SERVICE_KEY, rest, 'POST', row);
    if (ins.status !== 201) return bad(res, 500, 'order_failed');

    // ---------- email (never fails the order) ----------
    if (RESEND_API_KEY && NOTIFY_EMAIL) {
      try {
        const lines = [
          'Order: ' + orderNo,
          'Game: ' + game + ' — ' + packLabel,
          'Price: ৳' + price + ' via ' + payment.toUpperCase() +
            ' (' + (MERCHANT_NUMBERS[payment] || '-') + ')',
          playerUid ? 'UID / Player ID: ' + playerUid : null,
          region ? 'Region: ' + region : null,
          platform ? 'Platform: ' + platform : null,
          deliveryEmail ? 'Delivery email: ' + deliveryEmail : null,
          accountInfo ? 'Account info: ' + accountInfo : null,
          'Sender number: ' + senderNumber,
          'TrxID: ' + trxId,
          'Status: pending review',
        ].filter(Boolean).join('\n');
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + RESEND_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Flux-Change <onboarding@resend.dev>',
            to: NOTIFY_EMAIL,
            subject: '🧾 New order ' + orderNo + ' — ' + game + ' ' + packLabel,
            text: lines,
          }),
        });
      } catch (e) { /* email is best-effort */ }
    }

    return res.status(200).json({ ok: true, order_no: orderNo });
  } catch (e) {
    return bad(res, 500, 'order_failed');
  }
};
