const r = require('express').Router();
const { requireRole } = require('../auth');
const { one, many, q } = require('../db');
const { wrap, HttpError } = require('../util');
r.use(requireRole('merchant'));
const sid = req => { if (!req.user.store_id) throw new HttpError(403, 'No store linked to this account'); return req.user.store_id; };

r.get('/store', wrap(async (req, res) => {
  const s = await one('SELECT * FROM stores WHERE id=$1', [sid(req)]);
  s.categories = await many('SELECT * FROM categories WHERE store_id=$1 ORDER BY sort,id', [s.id]);
  s.products = await many('SELECT * FROM products WHERE store_id=$1 ORDER BY category_id,id', [s.id]);
  res.json(s);
}));
r.patch('/store', wrap(async (req, res) => {
  const { status, prep_time_min, name_en, name_ar, address } = req.body;
  res.json(await one('UPDATE stores SET status=COALESCE($2,status), prep_time_min=COALESCE($3,prep_time_min), name_en=COALESCE($4,name_en), name_ar=COALESCE($5,name_ar), address=COALESCE($6,address) WHERE id=$1 RETURNING *', [sid(req), status, prep_time_min, name_en, name_ar, address]));
}));
r.post('/categories', wrap(async (req, res) => res.json(await one('INSERT INTO categories(store_id,name_en,name_ar,sort) VALUES($1,$2,$3,$4) RETURNING *', [sid(req), req.body.name_en, req.body.name_ar, req.body.sort || 0]))));
r.post('/products', wrap(async (req, res) => {
  const b = req.body;
  res.json(await one('INSERT INTO products(store_id,category_id,name_en,name_ar,description,price,unit,stock,requires_approval,attributes,image) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [sid(req), b.category_id || null, b.name_en, b.name_ar, b.description, b.price, b.unit || 'each', b.stock ?? null, !!b.requires_approval, JSON.stringify(b.attributes || {}), b.image || null]));
}));
r.patch('/products/:id', wrap(async (req, res) => {
  const b = req.body;
  const p = await one(`UPDATE products SET name_en=COALESCE($3,name_en), name_ar=COALESCE($4,name_ar), description=COALESCE($5,description), price=COALESCE($6,price), unit=COALESCE($7,unit), stock=CASE WHEN $8::text='untracked' THEN NULL WHEN $8 IS NULL THEN stock ELSE $8::int END, active=COALESCE($9,active), category_id=COALESCE($10,category_id), requires_approval=COALESCE($11,requires_approval), attributes=COALESCE($12,attributes), image=COALESCE($13,image)
     WHERE id=$1 AND store_id=$2 RETURNING *`, [req.params.id, sid(req), b.name_en, b.name_ar, b.description, b.price, b.unit, b.stock === undefined ? null : String(b.stock), b.active, b.category_id, b.requires_approval, b.attributes ? JSON.stringify(b.attributes) : null, b.image]);
  if (!p) throw new HttpError(404, 'Product not found'); res.json(p);
}));
r.delete('/products/:id', wrap(async (req, res) => { await q('UPDATE products SET active=false WHERE id=$1 AND store_id=$2', [req.params.id, sid(req)]); res.json({ ok: true }); }));
r.get('/report', wrap(async (req, res) => {
  const from = req.query.from || '1970-01-01', to = req.query.to || '2999-01-01';
  const summary = await one(`SELECT count(*)::int AS orders, COALESCE(sum(subtotal),0) AS sales FROM orders WHERE store_id=$1 AND status='delivered' AND delivered_at BETWEEN $2 AND $3`, [sid(req), from, to]);
  const ledger = await one(`SELECT COALESCE(sum(credit) FILTER (WHERE account='merchant_payable'),0) AS payable, COALESCE(sum(credit) FILTER (WHERE account='commission_revenue'),0) AS commission FROM ledger WHERE party_id=$1 AND account IN ('merchant_payable','commission_revenue') AND created_at BETWEEN $2 AND $3`, [sid(req), from, to]);
  res.json({ ...summary, ...ledger });
}));
module.exports = r;
