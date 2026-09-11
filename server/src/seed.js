// Demo seed. RESETS all data, then builds a realistic two-week history across every module.
require('dotenv').config();
const db = require('./db');
const ledger = require('./services/ledger');
const { orderCode, money, haversineKm } = require('./util');

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (d, h = rnd(11, 22), m = rnd(0, 59)) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(h, m, 0, 0); return x; };
const addMin = (d, n) => new Date(d.getTime() + n * 60000);

async function main() {
  await db.migrate();
  const { q, one } = db;
  await q('TRUNCATE ledger, order_events, orders, shifts, riders, wallets, addresses, products, categories, stores, promos, users, zones, audit_log RESTART IDENTITY CASCADE');

  // ---- Zones ----
  const zone = await one(`INSERT INTO zones(name,polygon,base_fee,per_km,min_order,service_fee_pct) VALUES('Doha Central',$1,8,2,20,5) RETURNING *`,
    [JSON.stringify([[25.36, 51.42], [25.36, 51.62], [25.18, 51.62], [25.18, 51.42]])]);
  const zone2 = await one(`INSERT INTO zones(name,polygon,base_fee,per_km,min_order,service_fee_pct) VALUES('Al Wakrah',$1,10,2.5,25,5) RETURNING *`,
    [JSON.stringify([[25.20, 51.55], [25.20, 51.66], [25.13, 51.66], [25.13, 51.55]])]);

  // ---- Stores ----
  const STORES = [
    { name_en: 'Shawarma House', name_ar: 'بيت الشاورما', vertical: 'food', lat: 25.2867, lng: 51.5333, address: 'Al Sadd, C-Ring Road', prep: 20, featured: true, rating: 4.6, cats: [
      { en: 'Wraps', ar: 'لفائف', items: [['Chicken Shawarma', 'شاورما دجاج', 18, 'Marinated chicken, garlic sauce, pickles'], ['Beef Shawarma', 'شاورما لحم', 22, 'Slow-roasted beef, tahini'], ['Falafel Wrap', 'لفافة فلافل', 12, 'Crispy falafel, hummus, salad'], ['Family Platter', 'صحن عائلي', 75, 'Mixed shawarma for 4 with fries']] },
      { en: 'Sides', ar: 'أطباق جانبية', items: [['Fries', 'بطاطس', 8], ['Hummus', 'حمص', 10], ['Garlic Sauce', 'ثومية', 3]] },
      { en: 'Drinks', ar: 'مشروبات', items: [['Lemon Mint', 'ليمون بالنعناع', 10], ['Ayran', 'عيران', 5], ['Water', 'ماء', 2]] }] },
    { name_en: 'Corniche Grill', name_ar: 'مشاوي الكورنيش', vertical: 'food', lat: 25.2950, lng: 51.5410, address: 'Corniche Street', prep: 30, rating: 4.4, cats: [
      { en: 'Grills', ar: 'مشاوي', items: [['Mixed Grill', 'مشاوي مشكلة', 65, 'Kebab, tikka, shish tawook'], ['Chicken Tikka', 'تكا دجاج', 42], ['Lamb Kebab', 'كباب لحم', 55], ['Grilled Hammour', 'هامور مشوي', 85]] },
      { en: 'Starters', ar: 'مقبلات', items: [['Fattoush', 'فتوش', 18], ['Tabbouleh', 'تبولة', 16], ['Kibbeh (4 pcs)', 'كبة', 20]] }] },
    { name_en: 'Karak Corner', name_ar: 'ركن الكرك', vertical: 'food', lat: 25.2790, lng: 51.5260, address: 'Al Mirqab Al Jadeed', prep: 10, rating: 4.8, cats: [
      { en: 'Hot drinks', ar: 'مشروبات ساخنة', items: [['Karak Tea', 'شاي كرك', 3], ['Zafran Karak', 'كرك زعفران', 5], ['Turkish Coffee', 'قهوة تركية', 8]] },
      { en: 'Snacks', ar: 'وجبات خفيفة', items: [['Cheese Chapati', 'شباتي جبن', 6], ['Egg Chapati', 'شباتي بيض', 7], ['Samosa (3 pcs)', 'سمبوسة', 6]] }] },
    { name_en: 'FreshMart', name_ar: 'فريش مارت', vertical: 'grocery', lat: 25.2760, lng: 51.5200, address: 'Bin Mahmoud', prep: 15, rating: 4.3, cats: [
      { en: 'Fruit & Veg', ar: 'فواكه وخضار', items: [['Bananas', 'موز', 6, null, 'kg', 40], ['Tomatoes', 'طماطم', 5, null, 'kg', 30], ['Cucumber', 'خيار', 4, null, 'kg', 25], ['Apples', 'تفاح', 9, null, 'kg', 35], ['Lemons', 'ليمون', 7, null, 'kg', 20]] },
      { en: 'Dairy & Eggs', ar: 'ألبان وبيض', items: [['Fresh Milk 1L', 'حليب طازج ١ لتر', 7, null, 'each', 50], ['Laban 500ml', 'لبن ٥٠٠ مل', 4, null, 'each', 40], ['Eggs (30)', 'بيض ٣٠', 16, null, 'each', 25], ['Yoghurt 1kg', 'زبادي', 9, null, 'each', 30]] },
      { en: 'Bakery & Staples', ar: 'مخبوزات ومواد أساسية', items: [['Arabic Bread (5)', 'خبز عربي', 2, null, 'each', 60], ['Basmati Rice 5kg', 'أرز بسمتي ٥ كجم', 38, null, 'each', 15], ['Sunflower Oil 1.8L', 'زيت دوار الشمس', 19, null, 'each', 20], ['Sugar 2kg', 'سكر', 8, null, 'each', 0]] }] },
    { name_en: 'Wellcare Pharmacy', name_ar: 'صيدلية ويلكير', vertical: 'pharmacy', lat: 25.2810, lng: 51.5480, address: 'Al Mansoura', prep: 10, rating: 4.7, cats: [
      { en: 'Over the counter', ar: 'بدون وصفة', items: [['Paracetamol 500mg (20)', 'باراسيتامول', 8, null, 'each', 100], ['Vitamin C 1000mg', 'فيتامين سي', 25, null, 'each', 60], ['Antiseptic Cream', 'كريم مطهر', 14, null, 'each', 40], ['Oral Rehydration Salts', 'أملاح الإماهة', 6, null, 'each', 80]] },
      { en: 'Baby care', ar: 'العناية بالطفل', items: [['Diapers Size 4 (44)', 'حفاضات مقاس ٤', 45, null, 'each', 30], ['Baby Wipes (80)', 'مناديل أطفال', 12, null, 'each', 50]] },
      { en: 'Prescription only', ar: 'بوصفة طبية', items: [['Amoxicillin 500mg (21)', 'أموكسيسيلين', 30, null, 'each', 40, true], ['Metformin 500mg (60)', 'ميتفورمين', 22, null, 'each', 30, true], ['Omeprazole 20mg (28)', 'أوميبرازول', 28, null, 'each', 35, true]] }] },
    { name_en: 'Wakrah Seafood Kitchen', name_ar: 'مطبخ الوكرة للمأكولات البحرية', vertical: 'food', lat: 25.1720, lng: 51.6030, address: 'Al Wakrah Souq', prep: 25, rating: 4.5, zone: 2, cats: [
      { en: 'Seafood', ar: 'مأكولات بحرية', items: [['Grilled Prawns', 'روبيان مشوي', 60], ['Fish Machboos', 'مجبوس سمك', 45], ['Seafood Platter', 'صحن بحري', 120]] }] },
  ];
  const stores = [], products = {};
  for (let i = 0; i < STORES.length; i++) {
    const s = STORES[i];
    const st = await one('INSERT INTO stores(name_en,name_ar,vertical,zone_id,lat,lng,address,prep_time_min,featured,rating,rating_count,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [s.name_en, s.name_ar, s.vertical, s.zone === 2 ? zone2.id : zone.id, s.lat, s.lng, s.address, s.prep, !!s.featured, s.rating, rnd(20, 140), i === 2 ? 'busy' : 'open']);
    await q(`INSERT INTO users(phone,name,role,store_id) VALUES($1,$2,'merchant',$3)`, [`+9745500000${i + 1}`, `${s.name_en} Owner`, st.id]);
    products[st.id] = [];
    for (const c of s.cats) {
      const cat = await one('INSERT INTO categories(store_id,name_en,name_ar) VALUES($1,$2,$3) RETURNING *', [st.id, c.en, c.ar]);
      for (const [en, ar, price, desc = null, unit = 'each', stock = null, rx = false] of c.items) {
        const p = await one('INSERT INTO products(store_id,category_id,name_en,name_ar,description,price,unit,stock,requires_approval) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [st.id, cat.id, en, ar, desc, price, unit, stock, rx]);
        products[st.id].push(p);
      }
    }
    stores.push(st);
  }

  // ---- Staff, riders, customers ----
  for (const [phone, name, role] of [['+97455000010', 'Ops Admin', 'admin'], ['+97455000011', 'Dispatcher Khalid', 'dispatcher'], ['+97455000012', 'Fleet Manager Noor', 'fleet'], ['+97455000013', 'Finance Team', 'finance']])
    await q('INSERT INTO users(phone,name,role) VALUES($1,$2,$3)', [phone, name, role]);
  const RIDERS = [['+97455000021', 'Ahmed Hassan', 25.2850, 51.5300, 'available', zone.id], ['+97455000022', 'Farhan Ali', 25.2900, 51.5450, 'available', zone.id], ['+97455000023', 'Rizwan Khan', 25.2780, 51.5230, 'break', zone.id], ['+97455000024', 'Sameer Rahman', 25.1750, 51.6000, 'offline', zone2.id]];
  const riders = [];
  for (const [phone, name, lat, lng, status, zid] of RIDERS) {
    const u = await one(`INSERT INTO users(phone,name,role) VALUES($1,$2,'rider') RETURNING *`, [phone, name]);
    const r = await one('INSERT INTO riders(user_id,zone_id,lat,lng,last_seen,status,cash_limit) VALUES($1,$2,$3,$4,NOW(),$5,1500) RETURNING *', [u.id, zid, lat, lng, status]);
    r.name = name; riders.push(r);
    for (let d = 14; d >= 1; d--) { if (d % 7 === 5) continue; const ci = daysAgo(d, 10, rnd(0, 20)); await q('INSERT INTO shifts(rider_id,clock_in,clock_out,cash_settled) VALUES($1,$2,$3,$4)', [r.id, ci, addMin(ci, rnd(480, 560)), rnd(150, 700)]); }
    if (status !== 'offline') await q('INSERT INTO shifts(rider_id,clock_in) VALUES($1,$2)', [r.id, daysAgo(0, 9, rnd(0, 40))]);
  }
  const CUSTOMERS = [['+97455011111', 'Fatima Al-Kuwari'], ['+97455022222', 'Mohammed Al-Thani'], ['+97455033333', 'Sara Ahmed'], ['+97455044444', 'Omar Siddiqui'], ['+97455055555', 'Layla Hussain'], ['+97455066666', 'Rajesh Kumar'], ['+97455077777', 'Maria Santos'], ['+97455088888', 'Yousef Al-Marri']];
  const ADDRS = [['Villa 12, Al Sadd', 25.2830, 51.5350], ['Tower 3, Apt 1204, West Bay', 25.3210, 51.5300], ['House 45, Bin Mahmoud', 25.2745, 51.5225], ['Building 8, Flat 3, Al Mansoura', 25.2800, 51.5500], ['Villa 7, Al Hilal', 25.2650, 51.5450], ['Compound 22, Al Waab', 25.2600, 51.4700], ['Apt 502, Al Muntazah', 25.2700, 51.5320], ['Villa 3, Old Airport', 25.2600, 51.5600]];
  const customers = [];
  for (let i = 0; i < CUSTOMERS.length; i++) {
    const u = await one('INSERT INTO users(phone,name,created_at) VALUES($1,$2,$3) RETURNING *', [CUSTOMERS[i][0], CUSTOMERS[i][1], daysAgo(rnd(15, 40))]);
    const [line, lat, lng] = ADDRS[i];
    await q('INSERT INTO addresses(user_id,label,line,lat,lng) VALUES($1,$2,$3,$4,$5)', [u.id, 'Home', line, lat, lng]);
    await q('INSERT INTO wallets(user_id,balance) VALUES($1,$2)', [u.id, i % 3 === 0 ? rnd(10, 60) : 0]);
    customers.push({ ...u, addr: { line, lat, lng, phone: u.phone, name: u.name } });
  }

  // ---- Promos ----
  await q(`INSERT INTO promos(code,type,value,min_order,first_order_only,used,max_uses) VALUES('WELCOME20','percent',20,30,true,14,null), ('FREEDEL','free_delivery',0,50,false,31,200), ('RAMADAN10','fixed',10,40,false,8,100), ('GROCERY15','percent',15,60,false,5,null)`);
  await q(`UPDATE promos SET vertical='grocery' WHERE code='GROCERY15'`);
  await q(`INSERT INTO promos(code,type,value,min_order,active,expires_at) VALUES('EID25','percent',25,50,false,NOW()-INTERVAL '30 days')`);

  // ---- Orders ----
  const doha = stores.filter(s => s.zone_id === zone.id);
  const dohaRiders = riders.filter(r => r.zone_id === zone.id);
  let n = 0;
  async function makeOrder({ status, store, customer, when, rider, type = 'store', pay, rating, promo, cod_collect = 0 }) {
    const zoneRow = store && store.zone_id === zone2.id ? zone2 : zone;
    let items = [], subtotal = 0, requires = false, prescription = null;
    if (type === 'store') {
      const pool = products[store.id].filter(p => status === 'awaiting_approval' ? p.requires_approval : !p.requires_approval);
      const k = rnd(1, 3);
      for (const p of [...pool].sort(() => Math.random() - .5).slice(0, k)) {
        const qty = p.unit === 'kg' ? rnd(1, 2) : rnd(1, 3); const line = money(Number(p.price) * qty);
        items.push({ product_id: p.id, qty, name: p.name_en, name_ar: p.name_ar, unit_price: Number(p.price), modifiers: [], line_total: line, requires_approval: p.requires_approval });
        subtotal += line; if (p.requires_approval) { requires = true; prescription = 'data:image/png;base64,demo'; }
      }
      if (subtotal < Number(zoneRow.min_order)) { const p = pool[0]; const qty = Math.ceil((Number(zoneRow.min_order) - subtotal) / Number(p.price)) + 1; items[0] = { product_id: p.id, qty, name: p.name_en, name_ar: p.name_ar, unit_price: Number(p.price), modifiers: [], line_total: money(Number(p.price) * qty), requires_approval: p.requires_approval }; subtotal = items.reduce((s, i) => s + i.line_total, 0); }
    }
    const dropoff = customer.addr; const pickup = type === 'parcel' ? { lat: 25.2900 + Math.random() * .02, lng: 51.5400 + Math.random() * .02, line: 'Office, Msheireb', phone: customer.phone } : null;
    const km = haversineKm(type === 'parcel' ? pickup : { lat: store.lat, lng: store.lng }, dropoff);
    const delivery_fee = money(Number(zoneRow.base_fee) + Number(zoneRow.per_km) * Math.max(0, km - 2));
    const service_fee = money(subtotal * Number(zoneRow.service_fee_pct) / 100);
    let discount = 0; if (promo === 'WELCOME20') discount = money(subtotal * .2); if (promo === 'FREEDEL') discount = delivery_fee; if (promo === 'RAMADAN10') discount = 10;
    const total = money(subtotal + delivery_fee + service_fee - discount);
    const vertical = type === 'parcel' ? 'parcel' : store.vertical;
    pay = pay || pick(['cod', 'cod', 'card', 'card', 'wallet']); if (pay === 'wallet' && total > 60) pay = 'card';
    const final = ['delivered', 'cancelled', 'refunded'].includes(status);
    const paid = pay !== 'cod' || status === 'delivered' || status === 'refunded';
    const o = await one(`INSERT INTO orders(code,type,vertical,customer_id,store_id,zone_id,rider_id,status,items,dropoff,pickup,subtotal,delivery_fee,service_fee,discount,total,promo_code,payment_method,payment_status,cod_collect,prescription_url,requires_approval,prep_time_min,created_at,updated_at,assigned_at,acknowledged_at,delivered_at,rating,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) RETURNING *`,
      [orderCode(), type, vertical, customer.id, store && store.id, zoneRow.id, rider && rider.id, status, JSON.stringify(items), JSON.stringify(dropoff), pickup && JSON.stringify(pickup), money(subtotal), delivery_fee, service_fee, discount, total, promo || null, pay,
       status === 'refunded' ? 'refunded' : paid ? 'paid' : 'pending', cod_collect, prescription, requires, store ? store.prep_time_min : null,
       when, final ? addMin(when, rnd(25, 55)) : addMin(when, rnd(1, 12)), rider ? addMin(when, rnd(3, 8)) : null, rider && status !== 'accepted' ? addMin(when, rnd(4, 9)) : null, status === 'delivered' ? addMin(when, rnd(25, 55)) : null, status === 'delivered' ? rating : null, pick([null, null, null, 'Please call on arrival', 'Leave at the gate', 'Extra sauce please', 'No onions'])]);
    const seq = { placed: ['placed'], awaiting_approval: ['awaiting_approval'], accepted: ['placed', 'accepted', 'rider_assigned'], preparing: ['placed', 'accepted', 'rider_assigned', 'preparing'], ready: ['placed', 'accepted', 'rider_assigned', 'preparing', 'ready'], picked_up: ['placed', 'accepted', 'rider_assigned', 'preparing', 'ready', 'picked_up'],
      delivered: ['placed', 'accepted', 'rider_assigned', 'preparing', 'ready', 'picked_up', 'delivered'], cancelled: ['placed', 'cancelled'], refunded: ['placed', 'accepted', 'rider_assigned', 'preparing', 'ready', 'picked_up', 'delivered', 'refunded'] }[status].filter(s => s !== 'rider_assigned' || rider);
    const roles = { placed: 'customer', awaiting_approval: 'customer', accepted: type === 'parcel' ? 'system' : 'merchant', rider_assigned: 'system', preparing: 'merchant', ready: 'merchant', picked_up: 'rider', delivered: 'rider', cancelled: pick(['customer', 'merchant']), refunded: 'finance' };
    let tm = when;
    for (const st of seq) { await q('INSERT INTO order_events(order_id,status,actor_role,note,created_at) VALUES($1,$2,$3,$4,$5)', [o.id, st, roles[st], st === 'rider_assigned' ? `${rider.name} (${km.toFixed(1)} km)` : st === 'cancelled' ? pick(['Customer changed mind', 'Item unavailable', 'Store too busy']) : st === 'refunded' ? 'Missing item, partial refund' : null, tm]); tm = addMin(tm, rnd(2, 9)); }
    await db.tx(async c => {
      if (pay === 'card' && status !== 'cancelled') await ledger.postCardCapture(c, o);
      if (pay === 'wallet' && status !== 'cancelled') await ledger.postWalletPayment(c, o);
      if (status === 'delivered' || status === 'refunded') await ledger.postDelivery(c, o);
      if (status === 'refunded') await ledger.postRefund(c, o, money(total * .4), 'Missing item, partial refund');
      await c.query('UPDATE ledger SET created_at=$2 WHERE order_id=$1', [o.id, addMin(when, 40)]);
    });
    if (status === 'delivered') await q('UPDATE riders SET deliveries=deliveries+1 WHERE id=$1', [rider.id]);
    n++;
    return o;
  }

  // history: 14 days, 2–5 orders per day, mostly delivered
  for (let d = 14; d >= 1; d--) {
    const count = rnd(2, 5);
    for (let i = 0; i < count; i++) {
      const isParcel = Math.random() < .12;
      const store = isParcel ? null : pick(doha);
      const r = Math.random(); const status = r < .82 ? 'delivered' : r < .94 ? 'cancelled' : 'refunded';
      await makeOrder({ status, store, customer: pick(customers), when: daysAgo(d), rider: status === 'cancelled' ? null : pick(dohaRiders), type: isParcel ? 'parcel' : 'store', rating: pick([5, 5, 5, 4, 4, 3, null]), promo: Math.random() < .25 ? pick(['WELCOME20', 'FREEDEL', 'RAMADAN10']) : null, cod_collect: isParcel && Math.random() < .5 ? rnd(50, 300) : 0 });
    }
  }
  // today: delivered earlier, then live orders in every stage
  const today = h => daysAgo(0, h, rnd(0, 50));
  for (let i = 0; i < 3; i++) await makeOrder({ status: 'delivered', store: pick(doha), customer: pick(customers), when: today(9 + i), rider: pick(dohaRiders.slice(0, 2)), rating: pick([5, 4]) });
  const [ahmed, farhan] = dohaRiders;
  await makeOrder({ status: 'picked_up', store: stores[0], customer: customers[0], when: addMin(new Date(), -22), rider: ahmed, pay: 'cod' });
  await makeOrder({ status: 'ready', store: stores[3], customer: customers[2], when: addMin(new Date(), -18), rider: farhan, pay: 'card' });
  await makeOrder({ status: 'preparing', store: stores[1], customer: customers[4], when: addMin(new Date(), -9), rider: null, pay: 'card' });
  await makeOrder({ status: 'placed', store: stores[0], customer: customers[5], when: addMin(new Date(), -2), rider: null, pay: 'cod' });
  await makeOrder({ status: 'placed', store: stores[3], customer: customers[6], when: addMin(new Date(), -1), rider: null, pay: 'cod', promo: 'FREEDEL' });
  await makeOrder({ status: 'awaiting_approval', store: stores[4], customer: customers[1], when: addMin(new Date(), -6), rider: null, pay: 'card' });
  await makeOrder({ status: 'accepted', store: null, customer: customers[7], when: addMin(new Date(), -4), rider: null, type: 'parcel', pay: 'cod', cod_collect: 150 });
  await q("UPDATE riders SET status='on_task' WHERE id=ANY($1)", [[ahmed.id, farhan.id]]);
  for (const r of dohaRiders) { const c = await one(`SELECT COALESCE(sum(total),0) AS t FROM orders WHERE rider_id=$1 AND status='delivered' AND payment_method='cod' AND delivered_at::date=CURRENT_DATE`, [r.id]); await q('UPDATE riders SET cash_in_hand=$2 WHERE id=$1', [r.id, c.t]); }
  await q(`UPDATE stores s SET rating=COALESCE(x.avg, s.rating), rating_count=COALESCE(x.n, s.rating_count) FROM (SELECT store_id, round(avg(rating)::numeric,2) AS avg, count(rating)::int AS n FROM orders WHERE rating IS NOT NULL GROUP BY store_id) x WHERE x.store_id=s.id`);

  console.log(`Seeded ${stores.length} stores, ${riders.length} riders, ${customers.length} customers, ${n} orders (history + live).`);
  console.log('Sign in with OTP 123456 (dev): admin +97455000010 · dispatcher +97455000011 · fleet +97455000012 · finance +97455000013 · merchants +97455000001..6 · riders +97455000021..24 · customers +97455011111 etc. or any new number.');
  await db.pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
