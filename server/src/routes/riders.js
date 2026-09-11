const r = require('express').Router();
const { requireRole } = require('../auth');
const { one, many, q, tx } = require('../db');
const { wrap, HttpError } = require('../util');
const bus = require('../services/bus');
const ledger = require('../services/ledger');
r.use(requireRole('rider'));
const me = async req => { const rd = await one('SELECT * FROM riders WHERE user_id=$1 AND active', [req.user.id]); if (!rd) throw new HttpError(403, 'No rider profile'); return rd; };

r.get('/me', wrap(async (req, res) => {
  const rd = await me(req);
  rd.shift = await one('SELECT * FROM shifts WHERE rider_id=$1 AND clock_out IS NULL ORDER BY id DESC LIMIT 1', [rd.id]);
  rd.today = await one(`SELECT count(*)::int AS deliveries, COALESCE(sum(total) FILTER (WHERE payment_method='cod'),0) AS cash FROM orders WHERE rider_id=$1 AND status='delivered' AND delivered_at::date=CURRENT_DATE`, [rd.id]);
  res.json(rd);
}));
r.post('/clock-in', wrap(async (req, res) => {
  const rd = await me(req);
  const open = await one('SELECT id FROM shifts WHERE rider_id=$1 AND clock_out IS NULL', [rd.id]);
  const shift = open || await one('INSERT INTO shifts(rider_id) VALUES($1) RETURNING *', [rd.id]);
  await q("UPDATE riders SET status='available', lat=COALESCE($2,lat), lng=COALESCE($3,lng), last_seen=NOW() WHERE id=$1", [rd.id, req.body.lat, req.body.lng]);
  bus.emit('rider:update', await one('SELECT * FROM riders WHERE id=$1', [rd.id]));
  res.json(shift);
}));
r.post('/clock-out', wrap(async (req, res) => {
  const rd = await me(req);
  if (rd.status === 'on_task') throw new HttpError(400, 'Finish your current delivery first');
  await q('UPDATE shifts SET clock_out=NOW() WHERE rider_id=$1 AND clock_out IS NULL', [rd.id]);
  await q("UPDATE riders SET status='offline' WHERE id=$1", [rd.id]);
  bus.emit('rider:update', await one('SELECT * FROM riders WHERE id=$1', [rd.id]));
  res.json({ ok: true, cash_in_hand: rd.cash_in_hand });
}));
r.post('/status', wrap(async (req, res) => {
  const rd = await me(req);
  if (!['available', 'break'].includes(req.body.status)) throw new HttpError(400, 'Status must be available or break');
  if (rd.status === 'on_task') throw new HttpError(400, 'You have an active task');
  const u = await one('UPDATE riders SET status=$2 WHERE id=$1 RETURNING *', [rd.id, req.body.status]);
  bus.emit('rider:update', u); res.json(u);
}));
r.post('/location', wrap(async (req, res) => {
  const rd = await me(req);
  const { lat, lng } = req.body;
  if (lat == null) throw new HttpError(400, 'lat/lng required');
  const u = await one('UPDATE riders SET lat=$2, lng=$3, last_seen=NOW() WHERE id=$1 RETURNING id,lat,lng,status', [rd.id, lat, lng]);
  bus.emit('rider:location', u);
  res.json({ ok: true });
}));
r.get('/history', wrap(async (req, res) => {
  const rd = await me(req);
  res.json(await many(`SELECT id, code, vertical, total, payment_method, delivered_at, rating FROM orders WHERE rider_id=$1 AND status='delivered' ORDER BY id DESC LIMIT 50`, [rd.id]));
}));
module.exports = r;
