const r = require('express').Router();
const { requireRole } = require('../auth');
const { one, many, q, tx } = require('../db');
const { wrap, HttpError } = require('../util');
const ledger = require('../services/ledger');
const bus = require('../services/bus');
const OPS = ['dispatcher', 'fleet', 'finance'];

// ---- Dashboard ----
r.get('/dashboard', requireRole(...OPS), wrap(async (req, res) => {
  const today = await one(`SELECT count(*)::int AS orders, count(*) FILTER (WHERE status='delivered')::int AS delivered, count(*) FILTER (WHERE status='cancelled')::int AS cancelled,
      COALESCE(sum(total) FILTER (WHERE status='delivered'),0) AS gmv FROM orders WHERE created_at::date=CURRENT_DATE`);
  const live = await one(`SELECT count(*) FILTER (WHERE status IN ('placed','awaiting_approval'))::int AS awaiting_merchant, count(*) FILTER (WHERE status IN ('accepted','preparing','ready'))::int AS preparing, count(*) FILTER (WHERE status='picked_up')::int AS en_route,
      count(*) FILTER (WHERE status IN ('accepted','preparing','ready') AND rider_id IS NULL)::int AS unassigned FROM orders`);
  const riders = await one(`SELECT count(*) FILTER (WHERE status='available')::int AS available, count(*) FILTER (WHERE status='on_task')::int AS on_task, count(*) FILTER (WHERE status='break')::int AS on_break, count(*) FILTER (WHERE status='offline')::int AS offline FROM riders WHERE active`);
  const byVertical = await many(`SELECT vertical, count(*)::int AS n FROM orders WHERE created_at::date=CURRENT_DATE GROUP BY vertical`);
  res.json({ today, live, riders, byVertical });
}));
r.get('/live', requireRole(...OPS), wrap(async (req, res) => {
  const riders = await many(`SELECT r.*, u.name, u.phone, (SELECT code FROM orders o WHERE o.rider_id=r.id AND o.status IN ('accepted','preparing','ready','picked_up') LIMIT 1) AS current_order FROM riders r JOIN users u ON u.id=r.user_id WHERE r.active AND r.status<>'offline'`);
  res.json({ riders });
}));

// ---- Zones ----
r.get('/zones', requireRole(...OPS), wrap(async (req, res) => res.json(await many('SELECT * FROM zones ORDER BY id'))));
r.post('/zones', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body; if (!Array.isArray(b.polygon) || b.polygon.length < 3) throw new HttpError(400, 'Polygon needs at least 3 points');
  res.json(await one('INSERT INTO zones(name,polygon,base_fee,per_km,min_order,service_fee_pct) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [b.name, JSON.stringify(b.polygon), b.base_fee ?? 10, b.per_km ?? 2, b.min_order ?? 20, b.service_fee_pct ?? 5]));
}));
r.patch('/zones/:id', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body;
  res.json(await one('UPDATE zones SET name=COALESCE($2,name), polygon=COALESCE($3,polygon), base_fee=COALESCE($4,base_fee), per_km=COALESCE($5,per_km), min_order=COALESCE($6,min_order), service_fee_pct=COALESCE($7,service_fee_pct), active=COALESCE($8,active) WHERE id=$1 RETURNING *',
    [req.params.id, b.name, b.polygon ? JSON.stringify(b.polygon) : null, b.base_fee, b.per_km, b.min_order, b.service_fee_pct, b.active]));
}));

// ---- Stores & merchants ----
r.get('/stores', requireRole(...OPS), wrap(async (req, res) => res.json(await many(`SELECT s.*, z.name AS zone_name, (SELECT count(*)::int FROM products p WHERE p.store_id=s.id AND p.active) AS products FROM stores s LEFT JOIN zones z ON z.id=s.zone_id ORDER BY s.id`))));
r.post('/stores', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body;
  const { findZone } = require('../services/orders');
  const zone = b.zone_id ? { id: b.zone_id } : await findZone({ lat: Number(b.lat), lng: Number(b.lng) });
  const s = await one('INSERT INTO stores(name_en,name_ar,vertical,zone_id,lat,lng,address,commission_pct,prep_time_min,image,featured) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [b.name_en, b.name_ar, b.vertical, zone && zone.id, b.lat, b.lng, b.address, b.commission_pct ?? 15, b.prep_time_min ?? 20, b.image || null, !!b.featured]);
  if (b.owner_phone) {
    const phone = String(b.owner_phone).replace(/\s/g, '');
    await q(`INSERT INTO users(phone,name,role,store_id) VALUES($1,$2,'merchant',$3) ON CONFLICT (phone) DO UPDATE SET role='merchant', store_id=$3`, [phone, b.owner_name || null, s.id]);
  }
  res.json(s);
}));
r.patch('/stores/:id', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body;
  res.json(await one('UPDATE stores SET name_en=COALESCE($2,name_en), name_ar=COALESCE($3,name_ar), vertical=COALESCE($4,vertical), zone_id=COALESCE($5,zone_id), lat=COALESCE($6,lat), lng=COALESCE($7,lng), address=COALESCE($8,address), commission_pct=COALESCE($9,commission_pct), prep_time_min=COALESCE($10,prep_time_min), status=COALESCE($11,status), featured=COALESCE($12,featured), active=COALESCE($13,active), image=COALESCE($14,image) WHERE id=$1 RETURNING *',
    [req.params.id, b.name_en, b.name_ar, b.vertical, b.zone_id, b.lat, b.lng, b.address, b.commission_pct, b.prep_time_min, b.status, b.featured, b.active, b.image]));
}));

// ---- Riders (fleet) ----
r.get('/riders', requireRole(...OPS), wrap(async (req, res) => res.json(await many(`SELECT r.*, u.name, u.phone, z.name AS zone_name, (SELECT clock_in FROM shifts sh WHERE sh.rider_id=r.id AND sh.clock_out IS NULL LIMIT 1) AS shift_started FROM riders r JOIN users u ON u.id=r.user_id LEFT JOIN zones z ON z.id=r.zone_id ORDER BY r.id`))));
r.post('/riders', requireRole('fleet'), wrap(async (req, res) => {
  const b = req.body; const phone = String(b.phone || '').replace(/\s/g, '');
  const rider = await tx(async c => {
    const { rows: [u] } = await c.query(`INSERT INTO users(phone,name,role) VALUES($1,$2,'rider') ON CONFLICT (phone) DO UPDATE SET role='rider', name=COALESCE(EXCLUDED.name,users.name) RETURNING *`, [phone, b.name]);
    const { rows: [rd] } = await c.query('INSERT INTO riders(user_id,zone_id,vehicle,cash_limit) VALUES($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET zone_id=EXCLUDED.zone_id, vehicle=EXCLUDED.vehicle RETURNING *', [u.id, b.zone_id || null, b.vehicle || 'motorbike', b.cash_limit ?? 1500]);
    return { ...rd, name: u.name, phone: u.phone };
  });
  res.json(rider);
}));
r.patch('/riders/:id', requireRole('fleet'), wrap(async (req, res) => {
  const b = req.body;
  const rd = await one('UPDATE riders SET zone_id=COALESCE($2,zone_id), vehicle=COALESCE($3,vehicle), cash_limit=COALESCE($4,cash_limit), active=COALESCE($5,active) WHERE id=$1 RETURNING *', [req.params.id, b.zone_id, b.vehicle, b.cash_limit, b.active]);
  if (b.name) await q('UPDATE users SET name=$1 WHERE id=$2', [b.name, rd.user_id]);
  res.json(rd);
}));
r.post('/riders/:id/settle', requireRole('fleet', 'finance'), wrap(async (req, res) => {
  const amount = Number(req.body.amount); if (!(amount > 0)) throw new HttpError(400, 'Amount required');
  await tx(async c => {
    const { rows: [sh] } = await c.query('SELECT id FROM shifts WHERE rider_id=$1 ORDER BY id DESC LIMIT 1', [req.params.id]);
    await ledger.settleRiderCash(c, Number(req.params.id), amount, sh && sh.id);
    await c.query('INSERT INTO audit_log(user_id,action,target,detail) VALUES($1,$2,$3,$4)', [req.user.id, 'rider_settle', `rider:${req.params.id}`, JSON.stringify({ amount })]);
  });
  res.json(await one('SELECT * FROM riders WHERE id=$1', [req.params.id]));
}));
r.get('/riders/:id/shifts', requireRole('fleet'), wrap(async (req, res) => res.json(await many('SELECT * FROM shifts WHERE rider_id=$1 ORDER BY id DESC LIMIT 30', [req.params.id]))));

// ---- Promos ----
r.get('/promos', requireRole(...OPS), wrap(async (req, res) => res.json(await many('SELECT * FROM promos ORDER BY id DESC'))));
r.post('/promos', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body;
  res.json(await one('INSERT INTO promos(code,type,value,min_order,vertical,max_uses,first_order_only,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [String(b.code).toUpperCase(), b.type || 'percent', b.value || 0, b.min_order || 0, b.vertical || null, b.max_uses || null, !!b.first_order_only, b.expires_at || null]));
}));
r.patch('/promos/:id', requireRole('admin'), wrap(async (req, res) => res.json(await one('UPDATE promos SET active=COALESCE($2,active) WHERE id=$1 RETURNING *', [req.params.id, req.body.active]))));

// ---- Finance ----
r.get('/ledger', requireRole('finance'), wrap(async (req, res) => {
  const params = []; let where = '1=1';
  if (req.query.account) { params.push(req.query.account); where += ` AND account=$${params.length}`; }
  if (req.query.order_id) { params.push(req.query.order_id); where += ` AND order_id=$${params.length}`; }
  res.json(await many(`SELECT l.*, o.code FROM ledger l LEFT JOIN orders o ON o.id=l.order_id WHERE ${where} ORDER BY l.id DESC LIMIT 500`, params));
}));
r.get('/ledger/summary', requireRole('finance'), wrap(async (req, res) => {
  const from = req.query.from || '1970-01-01', to = req.query.to || '2999-01-01';
  res.json(await many(`SELECT account, sum(debit) AS debit, sum(credit) AS credit FROM ledger WHERE created_at BETWEEN $1 AND $2 GROUP BY account ORDER BY account`, [from, to]));
}));
r.get('/payouts', requireRole('finance'), wrap(async (req, res) => {
  const from = req.query.from || '1970-01-01', to = req.query.to || '2999-01-01';
  res.json(await many(`SELECT s.id, s.name_en, count(DISTINCT l.order_id)::int AS orders,
     COALESCE(sum(l.credit) FILTER (WHERE l.account='merchant_payable'),0) AS payable, COALESCE(sum(l.credit) FILTER (WHERE l.account='commission_revenue'),0) AS commission
     FROM stores s LEFT JOIN ledger l ON l.party_id=s.id AND l.account IN ('merchant_payable','commission_revenue') AND l.created_at BETWEEN $1 AND $2 GROUP BY s.id ORDER BY payable DESC`, [from, to]));
}));

// ---- Users ----
r.get('/users', requireRole('admin'), wrap(async (req, res) => res.json(await many('SELECT id,phone,name,role,store_id,active,created_at FROM users ORDER BY id DESC LIMIT 500'))));
r.patch('/users/:id', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body;
  res.json(await one('UPDATE users SET role=COALESCE($2,role), store_id=COALESCE($3,store_id), active=COALESCE($4,active), name=COALESCE($5,name) WHERE id=$1 RETURNING id,phone,name,role,store_id,active', [req.params.id, b.role, b.store_id, b.active, b.name]));
}));
r.get('/alerts', requireRole(...OPS), wrap(async (req, res) => {
  const stale = await many(`SELECT o.id, o.code, o.status, o.created_at, o.assigned_at, o.acknowledged_at, s.name_en AS store_name, EXTRACT(EPOCH FROM (NOW()-o.updated_at))/60 AS minutes_in_state
     FROM orders o LEFT JOIN stores s ON s.id=o.store_id WHERE o.status IN ('placed','awaiting_approval','accepted','preparing','ready','picked_up') AND (
       (o.status='placed' AND o.created_at < NOW()-INTERVAL '3 minutes') OR (o.status='awaiting_approval' AND o.created_at < NOW()-INTERVAL '15 minutes') OR
       (o.status IN ('accepted','preparing','ready') AND o.rider_id IS NULL AND o.updated_at < NOW()-INTERVAL '2 minutes') OR
       (o.status='ready' AND o.updated_at < NOW()-INTERVAL '10 minutes') OR (o.status='picked_up' AND o.updated_at < NOW()-INTERVAL '30 minutes'))`);
  res.json(stale);
}));
module.exports = r;
