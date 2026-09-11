require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');
const db = require('./db');
const { authenticate, socketUser } = require('./auth');
const bus = require('./services/bus');
const { one } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(authenticate);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/catalog', require('./routes/catalog'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/merchant', require('./routes/merchant'));
app.use('/api/rider', require('./routes/riders'));
app.use('/api/admin', require('./routes/admin'));

// Front-end apps served from the same process (one Railway service)
const apps = path.join(__dirname, '..', '..', 'apps');
for (const a of ['customer', 'merchant', 'rider', 'console', 'shared', 'demo']) app.use('/' + a, express.static(path.join(apps, a)));
app.get('/', (req, res) => res.sendFile(path.join(apps, 'demo', 'index.html')));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  const u = socketUser(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('unauthorized'));
  socket.user = u; next();
});
io.on('connection', async socket => {
  const u = socket.user;
  socket.join('user:' + u.id);
  if (['admin', 'dispatcher', 'fleet', 'finance'].includes(u.role)) socket.join('ops');
  if (u.role === 'merchant' && u.store_id) socket.join('store:' + u.store_id);
  if (u.role === 'rider') { const rd = await one('SELECT id FROM riders WHERE user_id=$1', [u.id]); if (rd) socket.join('rider:' + rd.id); }
  socket.on('watch', orderId => socket.join('order:' + orderId));
});

// Fan out domain events to interested rooms
const fan = (o, event) => {
  io.to('ops').emit(event, o);
  io.to('user:' + o.customer_id).emit(event, o);
  io.to('order:' + o.id).emit(event, o);
  if (o.store_id) io.to('store:' + o.store_id).emit(event, o);
  if (o.rider_id) io.to('rider:' + o.rider_id).emit(event, o);
};
bus.on('order:new', o => fan(o, 'order:new'));
bus.on('order:update', o => fan(o, 'order:update'));
bus.on('rider:task', ({ rider_id, order }) => io.to('rider:' + rider_id).emit('rider:task', order));
bus.on('rider:update', r => io.to('ops').emit('rider:update', r));
bus.on('ops:alert', a => io.to('ops').emit('ops:alert', a));
bus.on('rider:location', async r => {
  io.to('ops').emit('rider:location', r);
  const orders = await db.many("SELECT id, customer_id FROM orders WHERE rider_id=$1 AND status IN ('ready','picked_up')", [r.id]);
  for (const o of orders) { io.to('order:' + o.id).emit('rider:location', { order_id: o.id, lat: r.lat, lng: r.lng }); io.to('user:' + o.customer_id).emit('rider:location', { order_id: o.id, lat: r.lat, lng: r.lng }); }
});

const PORT = process.env.PORT || 3000;
db.migrate().then(() => server.listen(PORT, () => console.log(`Delivery platform API on :${PORT}`)))
  .catch(e => { console.error('Migration failed', e); process.exit(1); });
