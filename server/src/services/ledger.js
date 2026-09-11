const { money } = require('../util');
// Double-entry ledger. Every order money movement lands here.
async function post(c, rows) {
  for (const r of rows) await c.query('INSERT INTO ledger(order_id,account,party_id,debit,credit,memo) VALUES($1,$2,$3,$4,$5,$6)',
    [r.order_id, r.account, r.party_id || null, money(r.debit || 0), money(r.credit || 0), r.memo || null]);
}
// Card capture at checkout: gateway holds the money on our behalf.
async function postCardCapture(c, o) {
  await post(c, [{ order_id: o.id, account: 'card_gateway', debit: o.total, memo: `Card capture ${o.code}` },
                 { order_id: o.id, account: 'customer_prepaid', party_id: o.customer_id, credit: o.total, memo: `Prepaid ${o.code}` }]);
}
async function postWalletPayment(c, o) {
  await post(c, [{ order_id: o.id, account: 'customer_wallet', party_id: o.customer_id, debit: o.total, memo: `Wallet payment ${o.code}` },
                 { order_id: o.id, account: 'customer_prepaid', party_id: o.customer_id, credit: o.total, memo: `Prepaid ${o.code}` }]);
}
// On delivery: recognise revenue, merchant payable, and (for COD) rider cash.
async function postDelivery(c, o) {
  const rows = [];
  const total = Number(o.total), subtotal = Number(o.subtotal);
  if (o.payment_method === 'cod') {
    rows.push({ order_id: o.id, account: 'cash_riders', party_id: o.rider_id, debit: total, memo: `Cash collected ${o.code}` });
    await c.query('UPDATE riders SET cash_in_hand=cash_in_hand+$1 WHERE id=$2', [total, o.rider_id]);
    if (Number(o.cod_collect) > 0) await c.query('UPDATE riders SET cash_in_hand=cash_in_hand+$1 WHERE id=$2', [o.cod_collect, o.rider_id]);
  } else {
    rows.push({ order_id: o.id, account: 'customer_prepaid', party_id: o.customer_id, debit: total, memo: `Prepaid applied ${o.code}` });
  }
  if (o.store_id) {
    const { rows: [s] } = await c.query('SELECT commission_pct FROM stores WHERE id=$1', [o.store_id]);
    const commission = money(subtotal * Number(s.commission_pct) / 100);
    rows.push({ order_id: o.id, account: 'merchant_payable', party_id: o.store_id, credit: money(subtotal - commission), memo: `Sale ${o.code}` });
    rows.push({ order_id: o.id, account: 'commission_revenue', party_id: o.store_id, credit: commission, memo: `Commission ${o.code}` });
  }
  rows.push({ order_id: o.id, account: 'delivery_revenue', credit: o.delivery_fee, memo: `Delivery fee ${o.code}` });
  rows.push({ order_id: o.id, account: 'service_revenue', credit: o.service_fee, memo: `Service fee ${o.code}` });
  if (Number(o.discount) > 0) rows.push({ order_id: o.id, account: 'discounts', debit: o.discount, memo: `Promo ${o.promo_code || ''} ${o.code}` });
  if (Number(o.cod_collect) > 0) {
    rows.push({ order_id: o.id, account: 'cash_riders', party_id: o.rider_id, debit: o.cod_collect, memo: `Parcel COD collected ${o.code}` });
    rows.push({ order_id: o.id, account: 'sender_payable', party_id: o.customer_id, credit: o.cod_collect, memo: `Parcel COD owed to sender ${o.code}` });
  }
  await post(c, rows);
}
// Refunds go to wallet by default (instant); card reversal is a gateway call in production.
async function postRefund(c, o, amount, memo) {
  amount = money(amount);
  await post(c, [{ order_id: o.id, account: 'refunds', debit: amount, memo },
                 { order_id: o.id, account: 'customer_wallet', party_id: o.customer_id, credit: amount, memo }]);
  await c.query('INSERT INTO wallets(user_id,balance) VALUES($1,$2) ON CONFLICT (user_id) DO UPDATE SET balance=wallets.balance+$2', [o.customer_id, amount]);
}
async function settleRiderCash(c, riderId, amount, shiftId) {
  amount = money(amount);
  await post(c, [{ account: 'cash_office', debit: amount, party_id: riderId, memo: `Rider ${riderId} settlement` },
                 { account: 'cash_riders', credit: amount, party_id: riderId, memo: `Rider ${riderId} settlement` }]);
  await c.query('UPDATE riders SET cash_in_hand=GREATEST(0,cash_in_hand-$1) WHERE id=$2', [amount, riderId]);
  if (shiftId) await c.query('UPDATE shifts SET cash_settled=COALESCE(cash_settled,0)+$1 WHERE id=$2', [amount, shiftId]);
}
module.exports = { post, postCardCapture, postWalletPayment, postDelivery, postRefund, settleRiderCash };
