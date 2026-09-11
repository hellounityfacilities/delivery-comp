const jwt = require('jsonwebtoken');
const { one, q } = require('./db');
const { HttpError } = require('./util');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const otps = new Map(); // phone -> {code, exp}

function issueOtp(phone) {
  const code = process.env.NODE_ENV === 'production' ? String(Math.floor(100000 + Math.random() * 900000)) : '123456';
  otps.set(phone, { code, exp: Date.now() + 5 * 60 * 1000 });
  // TODO: send via SMS provider (Ooredoo/Vodafone gateway or Twilio)
  return process.env.NODE_ENV === 'production' ? null : code;
}

async function verifyOtp(phone, code, name) {
  const rec = otps.get(phone);
  if (!rec || rec.exp < Date.now() || rec.code !== String(code)) throw new HttpError(401, 'Invalid or expired code');
  otps.delete(phone);
  let user = await one('SELECT * FROM users WHERE phone=$1', [phone]);
  if (!user) user = await one('INSERT INTO users(phone,name) VALUES($1,$2) RETURNING *', [phone, name || null]);
  else if (name && !user.name) user = await one('UPDATE users SET name=$1 WHERE id=$2 RETURNING *', [name, user.id]);
  if (!user.active) throw new HttpError(403, 'Account disabled');
  await q('INSERT INTO wallets(user_id) VALUES($1) ON CONFLICT DO NOTHING', [user.id]);
  const token = jwt.sign({ id: user.id, role: user.role, store_id: user.store_id }, SECRET, { expiresIn: '30d' });
  return { token, user };
}

function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null);
  if (!token) return next();
  try { req.user = jwt.verify(token, SECRET); } catch { /* ignore */ }
  next();
}
const requireAuth = (req, res, next) => req.user ? next() : next(new HttpError(401, 'Sign in required'));
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Sign in required'));
  if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
  next(new HttpError(403, 'Not allowed'));
};
function socketUser(token) { try { return jwt.verify(token, SECRET); } catch { return null; } }
module.exports = { issueOtp, verifyOtp, authenticate, requireAuth, requireRole, socketUser };
