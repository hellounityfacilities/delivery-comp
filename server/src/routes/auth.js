const r = require('express').Router();
const { issueOtp, verifyOtp, requireAuth } = require('../auth');
const { one, q } = require('../db');
const { wrap, HttpError } = require('../util');

r.post('/otp', wrap(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  if (!/^\+?\d{8,15}$/.test(phone)) throw new HttpError(400, 'Enter a valid mobile number');
  const code = issueOtp(phone);
  res.json({ ok: true, dev_code: code });
}));
r.post('/verify', wrap(async (req, res) => {
  const out = await verifyOtp(String(req.body.phone || '').replace(/\s/g, ''), req.body.code, req.body.name);
  if (out.user.role === 'rider') out.user.rider = await one('SELECT * FROM riders WHERE user_id=$1', [out.user.id]);
  res.json(out);
}));
r.get('/me', requireAuth, wrap(async (req, res) => {
  const user = await one('SELECT id,phone,name,role,lang,store_id FROM users WHERE id=$1', [req.user.id]);
  const wallet = await one('SELECT balance FROM wallets WHERE user_id=$1', [req.user.id]);
  const rider = user.role === 'rider' ? await one('SELECT * FROM riders WHERE user_id=$1', [user.id]) : null;
  res.json({ ...user, wallet: wallet ? Number(wallet.balance) : 0, rider });
}));
r.patch('/me', requireAuth, wrap(async (req, res) => {
  const { name, lang } = req.body;
  res.json(await one('UPDATE users SET name=COALESCE($1,name), lang=COALESCE($2,lang) WHERE id=$3 RETURNING id,phone,name,role,lang', [name, lang, req.user.id]));
}));
r.get('/addresses', requireAuth, wrap(async (req, res) => res.json((await q('SELECT * FROM addresses WHERE user_id=$1 ORDER BY id', [req.user.id])).rows)));
r.post('/addresses', requireAuth, wrap(async (req, res) => {
  const { label, line, notes, lat, lng } = req.body;
  res.json(await one('INSERT INTO addresses(user_id,label,line,notes,lat,lng) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [req.user.id, label, line, notes, lat, lng]));
}));
r.delete('/addresses/:id', requireAuth, wrap(async (req, res) => { await q('DELETE FROM addresses WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); res.json({ ok: true }); }));
module.exports = r;
