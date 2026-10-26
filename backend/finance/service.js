'use strict';

const { randomUUID } = require('node:crypto');
const OrderMoney = require('../../order-money');

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const METHODS=new Set(['cash','pix','credit','debit','transfer','voucher','marketplace','other']);
const MAX_MINOR=9000000000000000;
function fail(code,message){const error=new Error(message);error.code=code;throw error}
function validateInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('INVALID_INPUT','Evento financeiro inválido.');
  const allowed=new Set(['eventId','idempotencyKey','kind','orderId','earningId','relatedEventId','amountMinor','currency','method','reference','reason']);
  if(Object.keys(input).some(key=>!allowed.has(key)))fail('INVALID_INPUT','Campo financeiro não permitido.');
  for(const key of ['eventId','idempotencyKey'])if(!UUID.test(input[key]||''))fail('INVALID_INPUT',`${key} inválido.`);
  if(!['PAYMENT_CONFIRMED','REFUND','ADJUSTMENT','PAYOUT_SETTLED'].includes(input.kind))fail('INVALID_INPUT','Tipo de evento financeiro inválido.');
  if(!Number.isSafeInteger(input.amountMinor)||input.amountMinor===0||Math.abs(input.amountMinor)>MAX_MINOR)fail('INVALID_INPUT','Valor deve ser um inteiro não nulo em unidade monetária mínima.');
  if(OrderMoney.currencyScale(input.currency)===null)fail('INVALID_INPUT','Moeda ISO não suportada.');
  for(const key of ['reference','reason'])if(typeof input[key]!=='string'||!input[key].trim()||input[key].trim().length>(key==='reference'?160:500)||/[\u0000-\u001f\u007f]/u.test(input[key]))fail('INVALID_INPUT',`${key} inválido.`);
  if(input.kind==='PAYOUT_SETTLED'){
    if(!UUID.test(input.earningId||'')||input.orderId!==undefined||input.relatedEventId!==undefined||input.amountMinor<0||input.method!==undefined)fail('INVALID_INPUT','Liquidação exige earning canônico e valor positivo.');
  }else if(!UUID.test(input.orderId||'')||input.earningId!==undefined)fail('INVALID_INPUT','Evento exige Order canônica.');
  if(input.kind==='REFUND'&&(!UUID.test(input.relatedEventId||'')||input.amountMinor<0||!METHODS.has(input.method)))fail('INVALID_INPUT','Estorno exige pagamento original, método e valor positivo.');
  if(input.kind==='PAYMENT_CONFIRMED'&&(input.amountMinor<0||!METHODS.has(input.method)||input.relatedEventId!==undefined))fail('INVALID_INPUT','Pagamento confirmado exige método e valor positivo.');
  if(input.kind==='ADJUSTMENT'&&(!UUID.test(input.relatedEventId||'')||input.method!==undefined))fail('INVALID_INPUT','Ajuste exige evento relacionado e não representa pagamento.');
  return input;
}
function createFinanceService({clock=()=>new Date() }={}){
  async function record(client,principal,raw){
    const input=validateInput(raw),companyId=principal.company_id;
    const targetKind=input.orderId?'order':'earning',targetId=input.orderId||input.earningId;
    const normalizedReference=input.reference.trim().toLocaleLowerCase('en-US');
    const lockKeys=[`${companyId}:event:${input.eventId}`,`${companyId}:idempotency:${input.idempotencyKey}`,
      `${companyId}:reference:${input.kind}:${targetKind}:${targetId}:${normalizedReference}`].sort();
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 92041)) FROM unnest($1::text[]) AS keys(lock_key) ORDER BY lock_key`,[lockKeys]);
    const existing=await client.query(`SELECT event_id::text,idempotency_key::text,event_kind,order_id::text,earning_id::text,
      related_event_id::text,amount_minor::text,currency,payment_method,reference,reason
      FROM rotamoto.financial_events WHERE company_id=$1 AND (event_id=$2 OR idempotency_key=$3)`,
    [companyId,input.eventId,input.idempotencyKey]);
    if(existing.rowCount){
      const row=existing.rows[0];
      const identical=row.event_id===input.eventId&&row.idempotency_key===input.idempotencyKey&&row.event_kind===input.kind&&
        row.order_id===(input.orderId||null)&&row.earning_id===(input.earningId||null)&&row.related_event_id===(input.relatedEventId||null)&&
        BigInt(row.amount_minor)===BigInt(input.amountMinor)&&row.currency===input.currency&&row.payment_method===(input.method||null)&&
        row.reference===input.reference.trim()&&row.reason===input.reason.trim();
      if(!identical)fail('IDEMPOTENCY_CONFLICT','A chave de idempotência já identifica outro fato financeiro.');
      return {duplicate:true,event:existing.rows[0]};
    }
    const sameReference=input.kind==='ADJUSTMENT'?{rowCount:0}:await client.query(`SELECT event_id::text FROM rotamoto.financial_events
      WHERE company_id=$1 AND event_kind=$2
        AND (CASE WHEN order_id IS NULL THEN 'earning' ELSE 'order' END)=$3
        AND COALESCE(order_id,earning_id)=$4 AND lower(btrim(reference))=$5 LIMIT 1`,
    [companyId,input.kind,targetKind,targetId,normalizedReference]);
    if(sameReference.rowCount)fail('DUPLICATE_FINANCIAL_REFERENCE','A referência já identifica outro evento financeiro neste pedido ou repasse.');
    let order=null,deliveryId=null;
    if(input.kind!=='PAYOUT_SETTLED'){
      const result=await client.query(`SELECT payload,version FROM rotamoto.domain_records
        WHERE company_id=$1 AND entity_type='Order' AND record_id=$2 AND deleted_at IS NULL FOR UPDATE`,[companyId,input.orderId]);
      if(!result.rowCount)fail('NOT_FOUND','Pedido canônico não encontrado nesta empresa.');
      order=result.rows[0].payload;
      if(!order.money||order.money.completeness!=='complete'||!Number.isSafeInteger(order.money.components?.totalMinor))fail('ORDER_VALUE_UNPROVEN','Pedido não possui composição monetária canônica completa.');
      if(order.money.currency!==input.currency)fail('CURRENCY_MISMATCH','Moeda do evento não corresponde ao pedido.');
      if(input.kind==='PAYMENT_CONFIRMED'&&['CANCELADA','CANCELADO','CANCELLED','CANCELED'].includes(String(order.status||'').toUpperCase()))fail('ORDER_CANCELLED','Não é possível registrar novo pagamento em pedido cancelado.');
      const delivery=await client.query(`SELECT record_id::text FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Delivery'
        AND related_entity_type='Order' AND related_record_id=$2 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,[companyId,input.orderId]);
      deliveryId=delivery.rows[0]?.record_id||null;
      if(input.kind==='PAYMENT_CONFIRMED'){
        const totals=await client.query(`SELECT COALESCE(sum(amount_minor) FILTER (WHERE event_kind='PAYMENT_CONFIRMED'),0)::text AS paid,
          COALESCE(sum(amount_minor) FILTER (WHERE event_kind='REFUND'),0)::text AS refunded
          FROM rotamoto.financial_events WHERE company_id=$1 AND order_id=$2`,[companyId,input.orderId]);
        const net=BigInt(totals.rows[0].paid)-BigInt(totals.rows[0].refunded);
        if(net+BigInt(input.amountMinor)>BigInt(order.money.components.totalMinor))fail('PAYMENT_EXCEEDS_ORDER','Pagamento excede o saldo comercial registrado.');
      }else if(input.kind==='REFUND'){
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 92042))',[`${companyId}:refund:${input.relatedEventId}`]);
        const original=await client.query(`SELECT event_kind,order_id::text,amount_minor::text,currency FROM rotamoto.financial_events
          WHERE company_id=$1 AND event_id=$2`,[companyId,input.relatedEventId]);
        if(!original.rowCount||original.rows[0].event_kind!=='PAYMENT_CONFIRMED'||original.rows[0].order_id!==input.orderId||original.rows[0].currency!==input.currency)fail('REFUND_SOURCE_INVALID','Estorno deve referenciar pagamento confirmado do mesmo pedido e moeda.');
        const prior=await client.query(`SELECT COALESCE(sum(amount_minor),0)::text AS total FROM rotamoto.financial_events
          WHERE company_id=$1 AND event_kind='REFUND' AND related_event_id=$2`,[companyId,input.relatedEventId]);
        if(BigInt(prior.rows[0].total)+BigInt(input.amountMinor)>BigInt(original.rows[0].amount_minor))fail('REFUND_EXCEEDS_PAYMENT','Estorno excede o saldo do pagamento original.');
      }else{
        const related=await client.query(`SELECT event_kind,order_id::text,currency FROM rotamoto.financial_events WHERE company_id=$1 AND event_id=$2`,[companyId,input.relatedEventId]);
        if(!related.rowCount||related.rows[0].order_id!==input.orderId||related.rows[0].currency!==input.currency||related.rows[0].event_kind==='PAYOUT_SETTLED')fail('ADJUSTMENT_SOURCE_INVALID','Ajuste deve referenciar fato financeiro do mesmo pedido e moeda.');
      }
    }else{
      const result=await client.query(`SELECT payload,related_record_id::text AS delivery_id FROM rotamoto.domain_records
        WHERE company_id=$1 AND entity_type='Earning' AND record_id=$2 AND deleted_at IS NULL FOR UPDATE`,[companyId,input.earningId]);
      if(!result.rowCount)fail('NOT_FOUND','Earning canônico não encontrado nesta empresa.');
      const earning=result.rows[0].payload;deliveryId=earning.deliveryId||result.rows[0].delivery_id;
      if(earning.currency!==input.currency||!Number.isSafeInteger(earning.amountMinor))fail('CURRENCY_MISMATCH','Moeda ou valor do Earning canônico é inválido.');
      const paid=await client.query(`SELECT COALESCE(sum(amount_minor),0)::text AS total FROM rotamoto.financial_events
        WHERE company_id=$1 AND event_kind='PAYOUT_SETTLED' AND earning_id=$2`,[companyId,input.earningId]);
      if(BigInt(paid.rows[0].total)+BigInt(input.amountMinor)>BigInt(earning.amountMinor))fail('PAYOUT_EXCEEDS_EARNING','Liquidação excede o saldo do repasse devido.');
    }
    const occurredAt=clock();
    const inserted=await client.query(`INSERT INTO rotamoto.financial_events(company_id,event_id,idempotency_key,order_id,delivery_id,earning_id,
      related_event_id,event_kind,amount_minor,currency,payment_method,reference,reason,actor_user_id,occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING event_id::text,idempotency_key::text,order_id::text,delivery_id::text,earning_id::text,related_event_id::text,event_kind,
      amount_minor::text,currency,payment_method,reference,reason,source_kind,actor_user_id::text,occurred_at,created_at`,
    [companyId,input.eventId,input.idempotencyKey,input.orderId||null,deliveryId,input.earningId||null,input.relatedEventId||null,input.kind,
      input.amountMinor,input.currency,input.method||null,input.reference.trim(),input.reason.trim(),principal.user_id,occurredAt]);
    return {duplicate:false,event:inserted.rows[0]};
  }
  async function list(client,principal,query={}){
    const allowed=new Set(['from','to','orderId','earningId','kind']);
    if(Object.keys(query).some(key=>!allowed.has(key)))fail('INVALID_INPUT','Filtro financeiro não permitido.');
    const where=['company_id=$1'],params=[principal.company_id];
    if(query.orderId!==undefined){if(!UUID.test(query.orderId))fail('INVALID_INPUT','orderId inválido.');params.push(query.orderId);where.push(`order_id=$${params.length}`)}
    if(query.earningId!==undefined){if(!UUID.test(query.earningId))fail('INVALID_INPUT','earningId inválido.');params.push(query.earningId);where.push(`earning_id=$${params.length}`)}
    if(query.kind!==undefined){if(!['PAYMENT_CONFIRMED','REFUND','ADJUSTMENT','PAYOUT_SETTLED'].includes(query.kind))fail('INVALID_INPUT','kind inválido.');params.push(query.kind);where.push(`event_kind=$${params.length}`)}
    for(const key of ['from','to'])if(query[key]!==undefined){const date=new Date(query[key]);if(!Number.isFinite(date.getTime())||date.toISOString()!==query[key])fail('INVALID_INPUT',`${key} deve ser timestamp ISO UTC.`);params.push(date.toISOString());where.push(`occurred_at${key==='from'?'>=':'<'}$${params.length}::timestamptz`)}
    const result=await client.query(`SELECT event_id::text,idempotency_key::text,order_id::text,delivery_id::text,earning_id::text,related_event_id::text,
      event_kind,amount_minor::text,currency,payment_method,reference,reason,source_kind,actor_user_id::text,occurred_at,created_at
      FROM rotamoto.financial_events WHERE ${where.join(' AND ')} ORDER BY occurred_at,event_id LIMIT 501`,params);
    const truncated=result.rowCount>500;
    return {events:result.rows.slice(0,500),coverage:{complete:false,recordedEventsComplete:!truncated,truncated,
      reason:'A API retorna eventos financeiros registrados; ela não comprova cobertura externa de todos os meios de pagamento.'}};
  }
  return Object.freeze({record,list});
}
module.exports={MAX_MINOR,validateInput,createFinanceService};
