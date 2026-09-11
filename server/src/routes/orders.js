const r = require('express').Router();
const { requireAuth, requireRole } = require('../auth');
const { one, many } = require('../db');
const { wrap, HttpError } = require('../util');
const orders = require('../services/orders');
const dispatch = require('../services/dispatch');

async function actorFor(req) {
  const a = { role: req.user.role, id: req.user.id, store_id: req.user.store_id };
  if (a.role === 'rider') { const rd = await one('SELECT id FROM riders WHERE user_id=$1', [a.id]); a.rider_id = rd && rd.id; }
  return a;
}

r.post('/quote', requireAuth, wrap(async (req, res) => {
  const b = req.body; const zone = await orders.findZone(b.dropoff || {});
  if (!zone) throw new HttpError(400, 'We do not deliver to this address yet');
  const store = b.store_id ? await one('SELECT * FROM stores WHERE id=$1', [b.store_id]) : null;
  const items = (b.items || []).map(i => ({ product_id: i.product_id, qty: Number(i.qty) || 1, modifiers: i.modifiers || [] }));
  res.json(await orders.priceQuote({ store, zone, items, dropoff: b.dropoff, promo: b.promo_code, customerId: req.user.id, type: b.type === 'parcel' ? 'parcel' : 'store' }));
}));
r.post('/', requireAuth, wrap(async (req, res) => res.status(201).json(await orders.createOrder(req.user, req.body))));

r.get('/mine', requireAuth, wrap(async (req, res) => {
  res.json(await many(`SELECT o.*, s.name_en AS store_name FROM orders o LEFT JOIN stores s ON s.id=o.store_id WHERE o.customer_id=$1 ORDER BY o.id DESC LIMIT 50`, [req.user.id]));
}));
r.get('/store', requireRole('merchant'), wrap(async (req, res) => {
  const active = req.query.all ? '' : ` AND o.status IN ('placed','awaiting_approval','accepted','preparing','ready')`;
  res.json(await many(`SELECT o.*, u.name AS customer_name, ru.name AS rider_name FROM orders o JOIN users u ON u.id=o.customer_id LEFT JOIN riders rr ON rr.id=o.rider_id LEFT JOIN users ru ON ru.id=rr.user_id WHERE o.store_id=$1 ${active} ORDER BY o.id DESC LIMIT 100`, [req.user.store_id]));
}));
r.get('/rider', requireRole('rider'), wrap(async (req, res) => {
  const a = await actorFor(req);
  res.json(await many(`SELECT o.*, s.name_en AS store_name, s.lat AS store_lat, s.lng AS store_lng, s.address AS store_address, u.name AS customer_name, u.phone AS customer_phone
    FROM orders o LEFT JOIN stores s ON s.id=o.store_id JOIN users u ON u.id=o.customer_id WHERE o.rider_id=$1 AND o.status IN ('accepted','preparing','ready','picked_up') ORDER BY o.id`, [a.rider_id]));
}));
r.get('/', requireRole('dispatcher', 'fleet', 'finance'), wrap(async (req, res) => {
  const params = []; let where = '1=1';
  if (req.query.status) { params.push(req.query.status); where += ` AND o.status=$${params.length}`; }
  else if (!req.query.all) where += ` AND o.status IN ('placed','awaiting_approval','accepted','preparing','ready','picked_up')`;
  res.json(await many(`SELECT o.*, s.name_en AS store_name, s.lat AS store_lat, s.lng AS store_lng, u.name AS customer_name, ru.name AS rider_name
    FROM orders o LEFT JOIN stores s ON s.id=o.store_id JOIN users u ON u.id=o.customer_id LEFT JOIN riders rr ON rr.id=o.rider_id LEFT JOIN users ru ON ru.id=rr.user_id
    WHERE ${where} ORDER BY o.id DESC LIMIT 200`, params));
}));
r.get('/:id', requireAuth, wrap(async (req, res) => {
  const o = await orders.getOrder(req.params.id);
  const a = await actorFor(req);
  const ok = ['admin', 'dispatcher', 'fleet', 'finance'].includes(a.role) || o.customer_id === a.id || (a.role === 'merchant' && o.store_id === a.store_id) || (a.role === 'rider' && o.rider_id === a.rider_id);
  if (!ok) throw new HttpError(403, 'Not allowed');
  res.json(o);
}));
r.post('/:id/status', requireAuth, wrap(async (req, res) => {
  const a = await actorFor(req);
  res.json(await orders.transition(Number(req.params.id), req.body.status, a, req.body));
}));
r.post('/:id/ack', requireRole('rider'), wrap(async (req, res) => {
  const a = await actorFor(req);
  const o = await dispatch.acknowledge(Number(req.params.id), a.rider_id);
  if (!o) throw new HttpError(409, 'Nothing to acknowledge');
  res.json(o);
}));
r.post('/:id/assign', requireRole('dispatcher'), wrap(async (req, res) => {
  res.json(await dispatch.reassign(Number(req.params.id), req.body.rider_id ? Number(req.body.rider_id) : null, { role: req.user.role, id: req.user.id }));
}));
r.post('/:id/rate', requireAuth, wrap(async (req, res) => { await orders.rate(Number(req.params.id), req.user, Number(req.body.rating), req.body.note); res.json({ ok: true }); }));
r.post('/:id/refund', requireRole('finance'), wrap(async (req, res) => {
  res.json(await orders.transition(Number(req.params.id), 'refunded', { role: req.user.role, id: req.user.id }, { amount: Number(req.body.amount), note: req.body.note }));
}));
module.exports = r;
