// Dispatch engine for an employed fleet: auto-assign by score, 60s acknowledge window, reassign on timeout.
const { q, one, many } = require('../db');
const { haversineKm } = require('../util');
const bus = require('./bus');
const ACK_WINDOW_MS = Number(process.env.ACK_WINDOW_MS || 60000);
const timers = new Map(); // order_id -> timeout

async function candidateRiders(order) {
  const origin = order.type === 'parcel' ? order.pickup : { lat: order.store_lat, lng: order.store_lng };
  const riders = await many(`SELECT r.*, u.name FROM riders r JOIN users u ON u.id=r.user_id
     WHERE r.active AND r.status IN ('available','on_task') AND r.lat IS NOT NULL AND r.cash_in_hand < r.cash_limit
       AND (r.zone_id=$1 OR r.zone_id IS NULL) AND r.last_seen > NOW() - INTERVAL '10 minutes'`, [order.zone_id]);
  const scored = [];
  for (const r of riders) {
    const km = haversineKm({ lat: r.lat, lng: r.lng }, origin);
    let score = km / 25 * 60; // minutes at ~25 km/h city speed
    if (r.status === 'on_task') {
      const active = await one("SELECT count(*)::int AS n FROM orders WHERE rider_id=$1 AND status IN ('ready','picked_up','accepted','preparing')", [r.id]);
      if (active.n >= 1) continue; // no batching in v1: one live task per rider
    }
    scored.push({ rider: r, score, km });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored;
}

async function assign(orderId, excludeRiderIds = [], actor = { role: 'system' }) {
  const order = await one(`SELECT o.*, s.lat AS store_lat, s.lng AS store_lng FROM orders o LEFT JOIN stores s ON s.id=o.store_id WHERE o.id=$1`, [orderId]);
  if (!order || !['accepted', 'preparing', 'ready'].includes(order.status)) return null;
  const cands = (await candidateRiders(order)).filter(c => !excludeRiderIds.includes(c.rider.id));
  if (!cands.length) { bus.emit('ops:alert', { type: 'no_rider', order_id: orderId, code: order.code }); return null; }
  const pick = cands[0].rider;
  await q('UPDATE orders SET rider_id=$1, assigned_at=NOW(), acknowledged_at=NULL, updated_at=NOW() WHERE id=$2', [pick.id, orderId]);
  await q("UPDATE riders SET status='on_task' WHERE id=$1", [pick.id]);
  await q('INSERT INTO order_events(order_id,status,actor_role,actor_id,note) VALUES($1,$2,$3,$4,$5)', [orderId, 'rider_assigned', actor.role, actor.id || null, `${pick.name || 'Rider ' + pick.id} (${cands[0].km.toFixed(1)} km)`]);
  const updated = await one('SELECT * FROM orders WHERE id=$1', [orderId]);
  bus.emit('order:update', updated);
  bus.emit('rider:task', { rider_id: pick.id, order: updated });
  clearTimeout(timers.get(orderId));
  timers.set(orderId, setTimeout(() => onAckTimeout(orderId, pick.id), ACK_WINDOW_MS));
  return pick;
}

async function onAckTimeout(orderId, riderId) {
  const o = await one('SELECT * FROM orders WHERE id=$1', [orderId]);
  if (!o || o.rider_id !== riderId || o.acknowledged_at) return;
  bus.emit('ops:alert', { type: 'ack_timeout', order_id: orderId, code: o.code, rider_id: riderId });
  await q("UPDATE riders SET status='available' WHERE id=$1 AND status='on_task'", [riderId]);
  await q('INSERT INTO order_events(order_id,status,actor_role,note) VALUES($1,$2,$3,$4)', [orderId, 'rider_unassigned', 'system', 'No acknowledgement in time']);
  await assign(orderId, [riderId]);
}

async function acknowledge(orderId, riderId) {
  const r = await one('UPDATE orders SET acknowledged_at=NOW() WHERE id=$1 AND rider_id=$2 AND acknowledged_at IS NULL RETURNING *', [orderId, riderId]);
  if (r) { clearTimeout(timers.get(orderId)); timers.delete(orderId); bus.emit('order:update', r); }
  return r;
}

async function reassign(orderId, riderId, actor) {
  const o = await one('SELECT * FROM orders WHERE id=$1', [orderId]);
  if (!o) return null;
  clearTimeout(timers.get(orderId));
  if (o.rider_id) await q("UPDATE riders SET status='available' WHERE id=$1 AND status='on_task'", [o.rider_id]);
  if (riderId) {
    await q('UPDATE orders SET rider_id=$1, assigned_at=NOW(), acknowledged_at=NULL WHERE id=$2', [riderId, orderId]);
    await q("UPDATE riders SET status='on_task' WHERE id=$1", [riderId]);
    await q('INSERT INTO order_events(order_id,status,actor_role,actor_id,note) VALUES($1,$2,$3,$4,$5)', [orderId, 'rider_assigned', actor.role, actor.id, 'Manual assignment']);
    const updated = await one('SELECT * FROM orders WHERE id=$1', [orderId]);
    bus.emit('order:update', updated); bus.emit('rider:task', { rider_id: riderId, order: updated });
    timers.set(orderId, setTimeout(() => onAckTimeout(orderId, riderId), ACK_WINDOW_MS));
    return updated;
  }
  return assign(orderId, o.rider_id ? [o.rider_id] : [], actor);
}

// Hook: dispatch when merchant accepts (rider heads to store as it prepares) and again on ready if unassigned.
bus.on('order:update', o => {
  if (['accepted', 'ready'].includes(o.status) && !o.rider_id) assign(o.id).catch(e => console.error('dispatch', e.message));
});

module.exports = { assign, acknowledge, reassign, candidateRiders };
