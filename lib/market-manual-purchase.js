"use strict";

const RESULT_PREFIX = "ALPHANINE_MARKET_PURCHASE:";
const CONFIRM_TEXT = "BUY AND PAY";
const MAX_TOTAL = 999999999;

function positiveId(value) {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > 9223372036854775807n) throw new Error("Invalid market record ID.");
  return text;
}

function literal(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

function eligibleListingSql(orderId) {
  return `select o.id as order_id, o.exchange_id, o.access_point_id, o.owner_id,
    o.template_id, o.item_id, o.item_price, i.stack_size, o.expiration_time,
    floor(extract(epoch from ((clock_timestamp() at time zone 'UTC') - fv.universe_time_timestamp)))::bigint as game_now
  from dune.dune_exchange_orders o
  join dune.dune_exchange_sell_orders s on s.order_id=o.id
  join dune.items i on i.id=o.item_id and i.template_id=o.template_id
  join dune.dune_exchanges e on e.id=o.exchange_id and e.inventory_id=i.inventory_id
  join dune.inventories inv on inv.id=i.inventory_id and (inv.exchange_id is null or inv.exchange_id=o.exchange_id)
  join dune.dune_exchange_accesspoints ap on ap.id=o.access_point_id and ap.exchange_id=o.exchange_id
  join dune.actors a on a.id=o.owner_id and a.owner_account_id is not null
  join dune.accounts acct on acct.id=a.owner_account_id
  join dune.farm_variables fv on fv.one_row=true and fv.universe_time_timestamp is not null
  where o.id=${positiveId(orderId)} and o.is_npc_order=false
    and o.item_price between 1 and ${MAX_TOTAL} and i.stack_size between 1 and 50000
    and o.item_price::numeric*i.stack_size <= ${MAX_TOTAL}
    and exists(select 1 from dune.dune_exchange_users u where u.owner_id=o.owner_id)
    and not exists(select 1 from dune.dune_exchange_fulfilled_orders f where f.order_id=o.id or f.original_order_id=o.id)
    and not exists(select 1 from dune.dune_exchange_orders other where other.item_id=o.item_id and other.id<>o.id)`;
}

function buildInspectSql(orderId) {
  return `select json_build_object(
    'orderId',p.order_id::text,'exchangeId',p.exchange_id::text,'accessPointId',p.access_point_id::text,
    'sellerActorId',p.owner_id::text,'template',p.template_id,'itemId',p.item_id::text,
    'unitPrice',p.item_price::text,'stackSize',p.stack_size::text,'expirationTime',p.expiration_time::text,
    'totalPaid',(p.item_price::numeric*p.stack_size)::text
  )::text from (${eligibleListingSql(orderId)}) p where p.game_now>0 and p.expiration_time>p.game_now;`;
}

function buildApplySql(expected) {
  const orderId = positiveId(expected.orderId);
  const fields = { exchange_id: "exchangeId", access_point_id: "accessPointId", owner_id: "sellerActorId", template_id: "template", item_id: "itemId", item_price: "unitPrice", stack_size: "stackSize", expiration_time: "expirationTime" };
  for (const field of Object.values(fields)) if (expected[field] == null || String(expected[field]) === "") throw new Error("Incomplete market purchase preview.");
  const changed = Object.entries(fields).map(([column, field]) => `p.${column}::text is distinct from ${literal(expected[field])}`).join("\n      or ");
  let delimiter = "$manual_purchase$";
  while (JSON.stringify(expected).includes(delimiter)) delimiter = delimiter.replace(/\$$/, "_$");
  return `begin;
set local lock_timeout='5s';
set local statement_timeout='20s';
do ${delimiter}
declare p record; payment_id bigint; affected integer;
begin
  ${eligibleListingSql(orderId).replace("\n  from dune.dune_exchange_orders", "\n  into p from dune.dune_exchange_orders")}
  for update of o,s,i;
  if not found then raise exception 'Listing unavailable, already purchased, or not an eligible player listing.'; end if;
  if p.game_now is null or p.game_now<=0 then raise exception 'Server game clock is unavailable.'; end if;
  if p.expiration_time<=p.game_now then raise exception 'Listing has expired.'; end if;
  if ${changed} then raise exception 'Listing changed. Refresh and confirm a new purchase.'; end if;

  -- Administrative funding: native seller claim, no player buyer wallet is charged.
  -- The game pays item_price * fulfilled.stack_size; keep the price per unit.
  insert into dune.dune_exchange_orders(exchange_id,access_point_id,owner_id,template_id,expiration_time,
    durability_cur,durability_max,item_price,category_mask,category_depth,is_npc_order)
  values(p.exchange_id,p.access_point_id,p.owner_id,p.template_id,999999999,1.0,1.0,p.item_price,0,0,false)
  returning id into payment_id;
  insert into dune.dune_exchange_fulfilled_orders(order_id,source_order_id,completion_type,stack_size,original_order_id)
  values(payment_id,null,4,p.stack_size,p.order_id);

  delete from dune.dune_exchange_sell_orders where order_id=p.order_id;
  get diagnostics affected = row_count;
  if affected<>1 then raise exception 'Sell-row removal verification failed.'; end if;
  delete from dune.dune_exchange_orders where id=p.order_id;
  get diagnostics affected = row_count;
  if affected<>1 then raise exception 'Order removal verification failed.'; end if;
  delete from dune.items where id=p.item_id;
  get diagnostics affected = row_count;
  if affected<>1 then raise exception 'Item removal verification failed.'; end if;
end
${delimiter};
select ${literal(RESULT_PREFIX)} || json_build_object('orderId',f.original_order_id::text,
  'paymentOrderId',o.id::text,'sellerActorId',o.owner_id::text,'template',o.template_id,
  'unitPrice',o.item_price::text,'stackSize',f.stack_size::text,
  'totalPaid',(o.item_price::numeric*f.stack_size)::text)::text
from dune.dune_exchange_fulfilled_orders f join dune.dune_exchange_orders o on o.id=f.order_id
where f.original_order_id=${orderId} and f.completion_type=4;
commit;`;
}

function parseReceipt(output) {
  const lines = String(output || "").split(/\r?\n/).filter(line => line.startsWith(RESULT_PREFIX));
  if (lines.length !== 1) throw new Error("Purchase result could not be confirmed. Refresh listings and check the seller's Exchange claims before retrying.");
  return JSON.parse(lines[0].slice(RESULT_PREFIX.length));
}

module.exports = { CONFIRM_TEXT, MAX_TOTAL, positiveId, buildInspectSql, buildApplySql, parseReceipt };
