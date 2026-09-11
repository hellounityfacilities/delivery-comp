// Seeds a Doha demo: one zone, four stores across verticals, staff users, two riders, a promo.
require('dotenv').config();
const db = require('./db');
async function main() {
  await db.migrate();
  const { q, one } = db;
  const zone = await one(`INSERT INTO zones(name,polygon,base_fee,per_km,min_order,service_fee_pct) VALUES('Doha Central',$1,8,2,20,5) RETURNING *`,
    [JSON.stringify([[25.36, 51.42], [25.36, 51.62], [25.18, 51.62], [25.18, 51.42]])]);
  const stores = [
    { name_en: 'Shawarma House', name_ar: 'بيت الشاورما', vertical: 'food', lat: 25.2867, lng: 51.5333, address: 'Al Sadd', prep: 20, featured: true, cats: [
      { name_en: 'Wraps', name_ar: 'لفائف', items: [['Chicken Shawarma', 'شاورما دجاج', 18], ['Beef Shawarma', 'شاورما لحم', 22], ['Falafel Wrap', 'لفافة فلافل', 12]] },
      { name_en: 'Drinks', name_ar: 'مشروبات', items: [['Lemon Mint', 'ليمون بالنعناع', 10], ['Water', 'ماء', 2]] }] },
    { name_en: 'Corniche Grill', name_ar: 'مشاوي الكورنيش', vertical: 'food', lat: 25.2950, lng: 51.5410, address: 'Corniche', prep: 30, cats: [
      { name_en: 'Mains', name_ar: 'أطباق رئيسية', items: [['Mixed Grill', 'مشاوي مشكلة', 65], ['Chicken Tikka', 'تكا دجاج', 42]] }] },
    { name_en: 'FreshMart', name_ar: 'فريش مارت', vertical: 'grocery', lat: 25.2760, lng: 51.5200, address: 'Bin Mahmoud', prep: 15, cats: [
      { name_en: 'Fruit & Veg', name_ar: 'فواكه وخضار', items: [['Bananas', 'موز', 6, 'kg', 40], ['Tomatoes', 'طماطم', 5, 'kg', 30], ['Cucumber', 'خيار', 4, 'kg', 25]] },
      { name_en: 'Dairy', name_ar: 'ألبان', items: [['Fresh Milk 1L', 'حليب طازج ١ لتر', 7, 'each', 50], ['Laban 500ml', 'لبن ٥٠٠ مل', 4, 'each', 40]] }] },
    { name_en: 'Wellcare Pharmacy', name_ar: 'صيدلية ويلكير', vertical: 'pharmacy', lat: 25.2810, lng: 51.5480, address: 'Al Mansoura', prep: 10, cats: [
      { name_en: 'Over the counter', name_ar: 'بدون وصفة', items: [['Paracetamol 500mg', 'باراسيتامول', 8, 'each', 100], ['Vitamin C', 'فيتامين سي', 25, 'each', 60]] },
      { name_en: 'Prescription', name_ar: 'بوصفة', items: [['Amoxicillin 500mg', 'أموكسيسيلين', 30, 'each', 40, true]] }] },
  ];
  let i = 1;
  for (const s of stores) {
    const st = await one('INSERT INTO stores(name_en,name_ar,vertical,zone_id,lat,lng,address,prep_time_min,featured,rating,rating_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,4.5,12) RETURNING *', [s.name_en, s.name_ar, s.vertical, zone.id, s.lat, s.lng, s.address, s.prep, !!s.featured]);
    await q(`INSERT INTO users(phone,name,role,store_id) VALUES($1,$2,'merchant',$3)`, [`+9745500000${i}`, `${s.name_en} Owner`, st.id]);
    for (const c of s.cats) {
      const cat = await one('INSERT INTO categories(store_id,name_en,name_ar) VALUES($1,$2,$3) RETURNING *', [st.id, c.name_en, c.name_ar]);
      for (const [en, ar, price, unit = 'each', stock = null, rx = false] of c.items)
        await q('INSERT INTO products(store_id,category_id,name_en,name_ar,price,unit,stock,requires_approval) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [st.id, cat.id, en, ar, price, unit, stock, rx]);
    }
    i++;
  }
  for (const [phone, name, role] of [['+97455000010', 'Ops Admin', 'admin'], ['+97455000011', 'Dispatcher', 'dispatcher'], ['+97455000012', 'Fleet Manager', 'fleet'], ['+97455000013', 'Finance', 'finance']])
    await q('INSERT INTO users(phone,name,role) VALUES($1,$2,$3)', [phone, name, role]);
  for (const [phone, name, lat, lng] of [['+97455000021', 'Rider Ahmed', 25.2850, 51.5300], ['+97455000022', 'Rider Farhan', 25.2900, 51.5450]]) {
    const u = await one(`INSERT INTO users(phone,name,role) VALUES($1,$2,'rider') RETURNING *`, [phone, name]);
    await q('INSERT INTO riders(user_id,zone_id,lat,lng,last_seen) VALUES($1,$2,$3,$4,NOW())', [u.id, zone.id, lat, lng]);
  }
  await q(`INSERT INTO promos(code,type,value,min_order,first_order_only) VALUES('WELCOME20','percent',20,30,true), ('FREEDEL','free_delivery',0,50,false)`);
  console.log('Seeded. Sign in with OTP 123456 (dev) using: admin +97455000010, dispatcher +97455000011, fleet +97455000012, finance +97455000013, merchants +97455000001..4, riders +97455000021/22, or any new number as a customer.');
  await db.pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
