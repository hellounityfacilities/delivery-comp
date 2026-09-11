const r = require('express').Router();
const { one, many } = require('../db');
const { wrap, HttpError, haversineKm } = require('../util');
const { findZone } = require('../services/orders');

r.get('/stores', wrap(async (req, res) => {
  const { vertical, lat, lng, search } = req.query;
  const pt = lat ? { lat: Number(lat), lng: Number(lng) } : null;
  const zone = pt ? await findZone(pt) : null;
  const params = []; let where = 's.active';
  if (vertical) { params.push(vertical); where += ` AND s.vertical=$${params.length}`; }
  if (zone) { params.push(zone.id); where += ` AND s.zone_id=$${params.length}`; }
  if (search) { params.push(`%${search}%`); where += ` AND (s.name_en ILIKE $${params.length} OR s.name_ar ILIKE $${params.length} OR EXISTS (SELECT 1 FROM products p WHERE p.store_id=s.id AND p.active AND (p.name_en ILIKE $${params.length} OR p.name_ar ILIKE $${params.length})))`; }
  let rows = await many(`SELECT s.*, z.base_fee, z.per_km FROM stores s LEFT JOIN zones z ON z.id=s.zone_id WHERE ${where} ORDER BY s.featured DESC, s.rating DESC`, params);
  rows = rows.map(s => {
    const km = pt ? haversineKm(pt, { lat: s.lat, lng: s.lng }) : null;
    return { ...s, km: km && Math.round(km * 10) / 10, eta_min: km != null ? Math.round(s.prep_time_min + km / 25 * 60) : null,
      delivery_fee: km != null && s.base_fee != null ? Math.round((Number(s.base_fee) + Number(s.per_km) * Math.max(0, km - 2)) * 100) / 100 : null };
  });
  res.json({ zone: zone ? { id: zone.id, name: zone.name, min_order: zone.min_order } : null, stores: rows });
}));
r.get('/stores/:id', wrap(async (req, res) => {
  const store = await one('SELECT * FROM stores WHERE id=$1 AND active', [req.params.id]);
  if (!store) throw new HttpError(404, 'Store not found');
  store.categories = await many('SELECT * FROM categories WHERE store_id=$1 ORDER BY sort,id', [store.id]);
  store.products = await many('SELECT * FROM products WHERE store_id=$1 AND active ORDER BY category_id,id', [store.id]);
  res.json(store);
}));
r.get('/zones/check', wrap(async (req, res) => {
  const z = await findZone({ lat: Number(req.query.lat), lng: Number(req.query.lng) });
  res.json({ deliverable: !!z, zone: z && { id: z.id, name: z.name, base_fee: z.base_fee, min_order: z.min_order } });
}));
module.exports = r;
