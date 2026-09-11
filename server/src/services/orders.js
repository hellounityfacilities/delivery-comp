const { q, one, many, tx } = require('../db');
const { HttpError, money, orderCode, haversineKm, pointInPolygon } = require('../util');
const ledger = require('./ledger');
const bus = require('./bus');

// status -> { next: [...], who: roles allowed to trigger each }
const TRANSITIONS = {
  placed:            { awaiting_approval: ['system'], accepted: ['merchant', 'system'], cancelled: ['customer', 'merchant', 'dispatcher', 'admin', 'system'] },
  awaiting_approval: { accepted: ['merchant'], cancelled: ['merchant', 'customer', 'dispatcher', 'admin', 'system'] },
  accepted:          { preparing: ['merchant'], ready: ['merchant'], cancelled: ['dispatcher', 'admin', 'merchant'] },
  preparing:         { ready: ['merchant'], cancelled: ['dispatcher', 'admin'] },
  ready:             { picked_up: ['rider'], cancelled: ['dispatcher', 'admin'] },
  picked_up:         { delivered: ['rider'], cancelled: ['dispatcher', 'admin'] },
  delivered:         { refunded: ['finance', 'admin'] },
  cancelled:         { refunded: ['finance', 'admin', 'system'] },
  refunded:          {},
};
const ACTIVE = ['placed', 'awaiting_approval', 'accepted', 'preparing', 'ready', 'picked_up'];

async function findZone(pt) {
  const zones = await many('SELECT * FROM zones WHERE active');
  return zones.find(z => pointInPolygon(pt, z.polygon)) || null;
}

async function priceQuote({ store, zone, items, dropoff, promo, customerId, type }) {
  let subtotal = 0;
  if (type === 'store') {
    for (const it of items) {
      const p = await one('SELECT * FROM products WHERE id=$1 AND store_id=$2 AND active', [it.product_id, store.id]);
      if (!p) throw new HttpError(400, `Product ${it.product_id} unavailable`);
      if (p.stock !== null && p.stock < it.qty) throw new HttpError(400, `${p.name_en} is out of stock`);
      it.name = p.name_en; it.name_ar = p.name_ar; it.unit_price = Number(p.price); it.requires_approval = p.requires_approval;
      const modifiersTotal = (it.modifiers || []).reduce((s, m) => s + Number(m.price || 0), 0);
      it.line_total = money((it.unit_price + modifiersTotal) * it.qty);
      subtotal += it.line_total;
    }
  }
  const origin = type === 'store' ? { lat: store.lat, lng: store.lng } : null;
  const km = origin ? haversineKm(origin, dropoff) : 0;
  let delivery_fee = money(Number(zone.base_fee) + Number(zone.per_km) * Math.max(0, km - 2));
  let service_fee = money(subtotal * Number(zone.service_fee_pct) / 100);
  let discount = 0, promo_code = null;
  if (promo) {
    const pr = await one('SELECT * FROM promos WHERE code=$1 AND active', [promo.toUpperCase()]);
    if (!pr) throw new HttpError(400, 'Promo code not valid');
    if (pr.expires_at && new Date(pr.expires_at) < new Date()) throw new HttpError(400, 'Promo code expired');
    if (pr.max_uses && pr.used >= pr.max_uses) throw new HttpError(400, 'Promo code fully used');
    if (pr.vertical && store && pr.vertical !== store.vertical) throw new HttpError(400, 'Promo not valid for this store');
    if (subtotal < Number(pr.min_order)) throw new HttpError(400, `Minimum order for this promo is ${pr.min_order}`);
    if (pr.first_order_only) {
      const prev = await one('SELECT 1 FROM orders WHERE customer_id=$1 AND status<>$2 LIMIT 1', [customerId, 'cancelled']);
      if (prev) throw new HttpError(400, 'Promo is for first orders only');
    }
    if (pr.type === 'percent') discount = money(subtotal * Number(pr.value) / 100);
    else if (pr.type === 'fixed') discount = Math.min(money(pr.value), subtotal);
    else if (pr.type === 'free_delivery') { discount = delivery_fee; }
    promo_code = pr.code;
  }
  if (type === 'store' && subtotal < Number(zone.min_order)) throw new HttpError(400, `Minimum order in this zone is QAR ${zone.min_order}`);
  const total = money(subtotal + delivery_fee + service_fee - discount);
  return { subtotal: money(subtotal), delivery_fee, service_fee, discount, total, promo_code, km: money(km) };
}

async function createOrder(user, body) {
  const type = body.type === 'parcel' ? 'parcel' : 'store';
  const dropoff = body.dropoff;
  if (!dropoff || dropoff.lat == null) throw new HttpError(400, 'Delivery address required');
  const zone = await findZone(dropoff);
  if (!zone) throw new HttpError(400, 'We do not deliver to this address yet');
  let store = null, vertical = 'parcel';
  if (type === 'store') {
    store = await one('SELECT * FROM stores WHERE id=$1 AND active', [body.store_id]);
    if (!store) throw new HttpError(404, 'Store not found');
    if (store.status !== 'open') throw new HttpError(400, 'Store is not accepting orders right now');
    if (!body.items || !body.items.length) throw new HttpError(400, 'Cart is empty');
    vertical = store.vertical;
  } else if (!body.pickup || body.pickup.lat == null) throw new HttpError(400, 'Pickup address required');

  const items = type === 'store' ? body.items.map(i => ({ product_id: i.product_id, qty: Number(i.qty) || 1, modifiers: i.modifiers || [], notes: i.notes })) : [];
  const quote = await priceQuote({ store, zone, items, dropoff, promo: body.promo_code, customerId: user.id, type });
  const requiresApproval = items.some(i => i.requires_approval);
  if (requiresApproval && !body.prescription_url) throw new HttpError(400, 'Prescription upload is required for one or more items');
  const method = ['cod', 'card', 'wallet'].includes(body.payment_method) ? body.payment_method : 'cod';

  return tx(async c => {
    if (method === 'wallet') {
      const w = await c.query('SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE', [user.id]);
      if (!w.rows[0] || Number(w.rows[0].balance) < quote.total) throw new HttpError(400, 'Insufficient wallet balance');
      await c.query('UPDATE wallets SET balance=balance-$1 WHERE user_id=$2', [quote.total, user.id]);
    }
    const status = requiresApproval ? 'awaiting_approval' : 'placed';
    const { rows: [order] } = await c.query(`INSERT INTO orders(code,type,vertical,customer_id,store_id,zone_id,status,items,dropoff,pickup,subtotal,delivery_fee,service_fee,discount,total,promo_code,payment_method,payment_status,cod_collect,prescription_url,requires_approval,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [orderCode(), type, vertical, user.id, store && store.id, zone.id, status, JSON.stringify(items), JSON.stringify(dropoff), body.pickup ? JSON.stringify(body.pickup) : null,
       quote.subtotal, quote.delivery_fee, quote.service_fee, quote.discount, quote.total, quote.promo_code, method,
       method === 'cod' ? 'pending' : 'paid', Number(body.cod_collect || 0), body.prescription_url || null, requiresApproval, body.notes || null]);
    await c.query('INSERT INTO order_events(order_id,status,actor_role,actor_id) VALUES($1,$2,$3,$4)', [order.id, status, 'customer', user.id]);
    if (quote.promo_code) await c.query('UPDATE promos SET used=used+1 WHERE code=$1', [quote.promo_code]);
    for (const it of items) await c.query('UPDATE products SET stock=stock-$1 WHERE id=$2 AND stock IS NOT NULL', [it.qty, it.product_id]);
    if (method === 'card') await ledger.postCardCapture(c, order); // gateway capture is stubbed
    if (method === 'wallet') await ledger.postWalletPayment(c, order);
    return order;
  }).then(async order => {
    bus.emit('order:new', order);
    // parcels have no merchant: auto-accept so dispatch starts immediately
    if (type === 'parcel') return transition(order.id, 'accepted', { role: 'system' });
    return order;
  });
}

async function transition(orderId, next, actor, opts = {}) {
  return tx(async c => {
    const { rows: [order] } = await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
    if (!order) throw new HttpError(404, 'Order not found');
    const allowed = TRANSITIONS[order.status] && TRANSITIONS[order.status][next];
    if (!allowed) throw new HttpError(409, `Cannot move order from ${order.status} to ${next}`);
    if (actor.role !== 'admin' && actor.role !== 'system' && !allowed.includes(actor.role)) throw new HttpError(403, `${actor.role} cannot ${next} this order`);
    if (actor.role === 'customer' && actor.id !== order.customer_id) throw new HttpError(403, 'Not your order');
    if (actor.role === 'merchant' && actor.store_id !== order.store_id) throw new HttpError(403, 'Not your store');
    if (actor.role === 'rider' && actor.rider_id !== order.rider_id) throw new HttpError(403, 'Not your task');

    const sets = ['status=$2', 'updated_at=NOW()'];
    const params = [orderId, next];
    if (next === 'accepted' && opts.prep_time_min) { params.push(Number(opts.prep_time_min)); sets.push(`prep_time_min=$${params.length}`); }
    if (next === 'delivered') {
      sets.push('delivered_at=NOW()');
      if (opts.proof_url) { params.push(opts.proof_url); sets.push(`proof_url=$${params.length}`); }
      if (order.payment_method === 'cod') sets.push(`payment_status='paid'`);
    }
    if (next === 'refunded') sets.push(`payment_status='refunded'`);
    const { rows: [updated] } = await c.query(`UPDATE orders SET ${sets.join(',')} WHERE id=$1 RETURNING *`, params);
    await c.query('INSERT INTO order_events(order_id,status,actor_role,actor_id,note) VALUES($1,$2,$3,$4,$5)', [orderId, next, actor.role, actor.id || null, opts.note || null]);

    if (next === 'delivered') {
      await ledger.postDelivery(c, updated);
      await c.query('UPDATE riders SET status=$1, deliveries=deliveries+1 WHERE id=$2', ['available', updated.rider_id]);
    }
    if (next === 'cancelled') {
      for (const it of updated.items) await c.query('UPDATE products SET stock=stock+$1 WHERE id=$2 AND stock IS NOT NULL', [it.qty, it.product_id]);
      if (updated.rider_id) await c.query('UPDATE riders SET status=$1 WHERE id=$2 AND status=$3', ['available', updated.rider_id, 'on_task']);
      if (updated.payment_status === 'paid') await ledger.postRefund(c, updated, Number(updated.total), 'Cancellation refund');
    }
    if (next === 'refunded' && opts.amount) await ledger.postRefund(c, updated, Number(opts.amount), opts.note || 'Refund');
    bus.emit('order:update', updated);
    return updated;
  });
}

async function getOrder(id) {
  const order = await one(`SELECT o.*, s.name_en AS store_name, s.name_ar AS store_name_ar, s.lat AS store_lat, s.lng AS store_lng, s.address AS store_address,
      u.name AS customer_name, u.phone AS customer_phone, ru.name AS rider_name, ru.phone AS rider_phone, r.lat AS rider_lat, r.lng AS rider_lng
    FROM orders o LEFT JOIN stores s ON s.id=o.store_id JOIN users u ON u.id=o.customer_id
    LEFT JOIN riders r ON r.id=o.rider_id LEFT JOIN users ru ON ru.id=r.user_id WHERE o.id=$1`, [id]);
  if (!order) throw new HttpError(404, 'Order not found');
  order.events = await many('SELECT status, actor_role, note, created_at FROM order_events WHERE order_id=$1 ORDER BY id', [id]);
  return order;
}

async function rate(orderId, user, rating, note) {
  const o = await one('SELECT * FROM orders WHERE id=$1 AND customer_id=$2', [orderId, user.id]);
  if (!o || o.status !== 'delivered') throw new HttpError(400, 'Only delivered orders can be rated');
  await q('UPDATE orders SET rating=$1, rating_note=$2 WHERE id=$3', [rating, note || null, orderId]);
  if (o.store_id) await q('UPDATE stores SET rating=((rating*rating_count)+$1)/(rating_count+1), rating_count=rating_count+1 WHERE id=$2', [rating, o.store_id]);
}

module.exports = { createOrder, transition, getOrder, rate, priceQuote, findZone, TRANSITIONS, ACTIVE };
