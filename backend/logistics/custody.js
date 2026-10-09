'use strict';

const crypto = require('node:crypto');
const { uuidV7 } = require('../identity/service');

const ACTIVE_ROUTE = new Set(['PLANNED','ACTIVE','IN_PROGRESS','planned','active','in_progress']);
const STATES = Object.freeze({
  NOT_COLLECTED:'NOT_COLLECTED', WITH_DRIVER:'WITH_DRIVER', DECISION_REQUIRED:'DECISION_REQUIRED',
  DISPUTED:'DISPUTED', RETURN_REQUESTED:'RETURN_REQUESTED', RELEASED:'RELEASED', INCIDENT_OPEN:'INCIDENT_OPEN',
  AWAITING_RESTAURANT_RECEIPT:'AWAITING_RESTAURANT_RECEIPT', RECEIVED:'RECEIVED'
});
class CustodyError extends Error { constructor(code,message){super(message);this.name='CustodyError';this.code=code;} }
function fail(code,message){throw new CustodyError(code,message);}
function canonicalJson(value){
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value){return crypto.createHash('sha256').update(canonicalJson(value)).digest();}
function object(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function text(value,name,max=500){if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value.trim())>max||/[\u0000-\u001f\u007f]/u.test(value))fail('INVALID_INPUT',`${name} inválido.`);return value.trim();}
function uuid(value,name){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value))fail('INVALID_INPUT',`${name} inválido.`);return value.toLowerCase();}
function validateCommand(input,fields){if(!object(input)||Object.keys(input).some(key=>!fields.has(key)))fail('INVALID_INPUT','Comando de custódia inválido.');}

function createDeliveryCustodyService({clock=()=>new Date(),ensureInternalProvider=async()=>null}={}){
  async function serverTime(client){const result=await client.query('SELECT clock_timestamp() AS at');return result.rows[0].at;}
  async function requireOrdersManage(client,principal){
    const result=await client.query(`SELECT 1 FROM rotamoto.memberships m
      JOIN rotamoto.role_permissions rp ON rp.company_id=m.company_id AND rp.role_id=m.role_id
      WHERE m.company_id=$1 AND m.user_id=$2 AND m.status='active' AND rp.catalog_version=1
        AND rp.permission_key='orders.manage' LIMIT 1`,[principal.company_id,principal.user_id]);
    if(!result.rowCount)fail('FORBIDDEN','A decisão de custódia exige orders.manage.');
  }
  async function lockDelivery(client,companyId,deliveryId){
    const row=await client.query(`SELECT record_id::text,payload,version,created_at,updated_at,related_entity_type,related_record_id::text
      FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' AND deleted_at IS NULL FOR UPDATE`,[companyId,deliveryId]);
    if(!row.rowCount)fail('NOT_FOUND','Entrega não encontrada.');return row.rows[0];
  }
  async function restaurantInstallation(client,companyId){
    const row=await client.query(`SELECT id FROM rotamoto.sync_installations WHERE company_id=$1 AND app_key='restaurante'
      ORDER BY last_seen_at DESC,id LIMIT 1`,[companyId]);
    if(!row.rowCount)fail('INSTALLATION_REQUIRED','Sincronize o Restaurante antes da operação.');return row.rows[0].id;
  }
  async function lockRouteMembership(client,companyId){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 402119))',[companyId+':active-route-membership']);}
  async function emit(client,principal,installationId,entity,recordId,payload,driverId=null){
    const eventId=uuidV7(clock().getTime()),occurredAt=await serverTime(client);
    const event={eventId,type:'CANONICAL_RECORD_UPSERTED',entity,entityId:recordId,occurredAt:occurredAt.toISOString(),
      actor:{type:'user',id:principal.user_id},payload,protocolVersion:1};
    await client.query(`INSERT INTO rotamoto.sync_outbox(company_id,event_id,app_key,installation_id,recipient_driver_id,payload,created_at)
      VALUES($1,$2,'restaurante',$3,$4,$5::jsonb,clock_timestamp())`,[principal.company_id,eventId,installationId,driverId,JSON.stringify(event)]);
    return event;
  }
  async function appendFact(client,principal,installationId,deliveryId,driverId,type,payload={}){
    const now=await serverTime(client),eventId=`evt_${uuidV7(clock().getTime())}`,recordId=uuidV7(clock().getTime());
    const fact={eventId,entity:'Delivery',entityId:deliveryId,type,occurredAt:now.toISOString(),
      actor:{type:'user',id:principal.user_id},payload:{...payload,confirmedByServer:true},protocolVersion:1,
      id:recordId,companyId:principal.company_id,version:1,updatedAt:now.toISOString()};
    await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,
      related_entity_type,related_record_id,source_event_id,payload,version,created_at,updated_at)
      VALUES($1,$2,'DeliveryEvent','restaurante',$3,'Delivery',$4,$5,$6::jsonb,1,$7,$7)`,
    [principal.company_id,recordId,installationId,deliveryId,`custody:${eventId}`,JSON.stringify(fact),now]);
    await emit(client,principal,installationId,'DeliveryEvent',recordId,fact,driverId);
    return fact;
  }
  async function saveDelivery(client,principal,installationId,row,payload){
    const now=await serverTime(client),version=Number(row.version)+1;
    const next={...payload,id:row.record_id,companyId:principal.company_id,version,updatedAt:now.toISOString()};
    await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=$4,updated_at=$5
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[principal.company_id,row.record_id,JSON.stringify(next),version,now]);
    await emit(client,principal,installationId,'Delivery',row.record_id,next,next.driverId||null);
    return next;
  }
  async function locateRoute(client,companyId,deliveryId,routeId=null,lock=false){
    if(routeId){
      const result=await client.query(`SELECT record_id::text,payload,version FROM rotamoto.domain_records
        WHERE company_id=$1 AND record_id=$2 AND entity_type='Route' AND deleted_at IS NULL ${lock?'FOR UPDATE':''}`,[companyId,routeId]);
      if(result.rowCount&&ACTIVE_ROUTE.has(result.rows[0].payload.status))return result.rows[0];
      if(result.rowCount)fail('ROUTE_NOT_ACTIVE','A rota associada não está ativa.');
    }
    const result=await client.query(`SELECT record_id::text,payload,version FROM rotamoto.domain_records
      WHERE company_id=$1 AND entity_type='Route' AND deleted_at IS NULL AND payload->>'status'=ANY($3::text[])
        AND payload->'deliveryIds' ? $2 ORDER BY record_id LIMIT 1 ${lock?'FOR UPDATE':''}`,
    [companyId,deliveryId,[...ACTIVE_ROUTE]]);
    return result.rows[0]||null;
  }
  async function saveRoute(client,principal,installationId,row,deliveryIds){
    const now=await serverTime(client),version=Number(row.version)+1,payload={...row.payload,deliveryIds,version,updatedAt:now.toISOString()};
    const updated=await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=$4,updated_at=$5
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Route' AND version=$6`,[principal.company_id,row.record_id,JSON.stringify(payload),version,now,row.version]);
    if(updated.rowCount!==1)fail('REVISION_CONFLICT','A rota mudou; atualize antes de continuar.');
    await emit(client,principal,installationId,'Route',row.record_id,payload);
    await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES($1,$2,$3,'user','route.delivery-membership.changed','Route',$4,$5::jsonb)`,
    [uuidV7(clock().getTime()),principal.company_id,principal.user_id,row.record_id,JSON.stringify({removed:row.payload.deliveryIds.filter(id=>!deliveryIds.includes(id)),added:deliveryIds.filter(id=>!row.payload.deliveryIds.includes(id)),deliveryIds,version})]);
    return payload;
  }
  async function operationStart(client,principal,operationType,deliveryId,input){
    const key=text(input.idempotencyKey,'idempotencyKey',128);if(Buffer.byteLength(key)<16)fail('INVALID_INPUT','idempotencyKey inválida.');
    const digest=hash({...input,idempotencyKey:undefined});
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,781203))',[`${principal.company_id}:${operationType}:${key}`]);
    const prior=await client.query(`SELECT request_digest,result FROM rotamoto.delivery_custody_operations
      WHERE company_id=$1 AND operation_type=$2 AND idempotency_key=$3`,[principal.company_id,operationType,key]);
    if(prior.rowCount){if(!crypto.timingSafeEqual(prior.rows[0].request_digest,digest))fail('IDEMPOTENCY_CONFLICT','Chave de operação reutilizada com payload diferente.');return {duplicate:true,result:prior.rows[0].result,key,digest};}
    return {duplicate:false,key,digest};
  }
  async function operationFinish(client,principal,operationType,deliveryId,operation,result,returnId=null){
    await client.query(`INSERT INTO rotamoto.delivery_custody_operations(company_id,operation_type,idempotency_key,request_digest,
      delivery_id,result,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,transaction_timestamp())`,
    [principal.company_id,operationType,operation.key,operation.digest,deliveryId,JSON.stringify(result),principal.user_id]);
    return result;
  }
  async function assertInternal(client,principal,deliveryId){
    const fulfillment=await client.query(`SELECT mode FROM rotamoto.delivery_fulfillments WHERE company_id=$1 AND delivery_id=$2
      ORDER BY revision DESC LIMIT 1`,[principal.company_id,deliveryId]);
    if(fulfillment.rowCount&&fulfillment.rows[0].mode==='external')fail('EXTERNAL_PLATFORM_CONTROLLED','A plataforma controla a execução; use somente as informações e comandos documentados pela integração.');
  }
  async function getCustody(client,principal,deliveryId){
    uuid(deliveryId,'deliveryId');
    const result=await client.query(`SELECT d.record_id::text,d.payload,d.version,d.related_entity_type,d.related_record_id::text,
        o.payload AS order_payload
      FROM rotamoto.domain_records d LEFT JOIN rotamoto.domain_records o ON o.company_id=d.company_id
        AND o.record_id=d.related_record_id AND o.entity_type='Order'
      WHERE d.company_id=$1 AND d.record_id=$2 AND d.entity_type='Delivery' AND d.deleted_at IS NULL`,[principal.company_id,deliveryId]);
    if(!result.rowCount)fail('NOT_FOUND','Entrega não encontrada.');
    const row=result.rows[0],ext=row.payload.extensions||{},returnId=ext.x_rotamoto_return_delivery_id||null;
    const returnResult=returnId?await client.query(`SELECT record_id::text,payload,version FROM rotamoto.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' AND deleted_at IS NULL`,[principal.company_id,returnId]):{rows:[]};
    const facts=await client.query(`SELECT payload FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='DeliveryEvent'
      AND related_entity_type='Delivery' AND related_record_id=$2 ORDER BY created_at,record_id`,[principal.company_id,deliveryId]);
    const mode=await client.query(`SELECT mode,provider_id,external_reference,status FROM rotamoto.delivery_fulfillments
      WHERE company_id=$1 AND delivery_id=$2 ORDER BY revision DESC LIMIT 1`,[principal.company_id,deliveryId]);
    return {delivery:{id:row.record_id,status:row.payload.status,version:Number(row.version),orderId:row.payload.orderId||null,
      driverId:row.payload.driverId||null,pickedUpAt:row.payload.pickedUpAt||null,deliveryType:ext.x_rotamoto_delivery_type||'STANDARD',
      custodyState:ext.x_rotamoto_custody_state||(row.payload.pickedUpAt?STATES.WITH_DRIVER:STATES.NOT_COLLECTED),
      custodyDecision:ext.x_rotamoto_custody_decision||null,returnDeliveryId:returnId,orderSource:row.order_payload?.source||null,
      externalReference:row.order_payload?.externalId||null,fulfillmentMode:mode.rows[0]?.mode||'internal'},
      returnDelivery:returnResult.rows[0]?{id:returnResult.rows[0].record_id,status:returnResult.rows[0].payload.status,
        version:Number(returnResult.rows[0].version),driverId:returnResult.rows[0].payload.driverId,
        routePosition:(returnResult.rows[0].payload.extensions?.x_rotamoto_return_position??null),
        custodyState:returnResult.rows[0].payload.extensions?.x_rotamoto_custody_state||null}:null,
      events:facts.rows.map(item=>item.payload)};
  }
  async function cancelDelivery(client,principal,deliveryId,input){
    validateCommand(input,new Set(['expectedVersion','reason','idempotencyKey']));await requireOrdersManage(client,principal);
    uuid(deliveryId,'deliveryId');if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1)fail('INVALID_INPUT','expectedVersion inválida.');
    const reason=text(input.reason,'reason');const operation=await operationStart(client,principal,'CANCEL',deliveryId,{...input,reason});
    if(operation.duplicate)return {...operation.result,duplicate:true};
    const lookup=await client.query(`SELECT record_id::text,payload FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[principal.company_id,deliveryId]);
    if(!lookup.rowCount)fail('NOT_FOUND','Entrega não encontrada.');
    await lockRouteMembership(client,principal.company_id);
    let possibleRoute=await locateRoute(client,principal.company_id,deliveryId,lookup.rows[0].payload.extensions?.x_rotamoto_custody_route_id,false);
    if(possibleRoute)possibleRoute=await locateRoute(client,principal.company_id,deliveryId,possibleRoute.record_id,true);
    const delivery=await lockDelivery(client,principal.company_id,deliveryId);await assertInternal(client,principal,deliveryId);
    if(Number(delivery.version)!==input.expectedVersion)fail('REVISION_CONFLICT','A Delivery mudou; atualize antes de cancelar.');
    if(delivery.payload.status==='CANCELLED')return {deliveryId,status:'CANCELLED',version:Number(delivery.version),duplicate:true,
      custodyState:delivery.payload.extensions?.x_rotamoto_custody_state||STATES.DECISION_REQUIRED};
    if(!['CREATED','ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED'].includes(delivery.payload.status))fail('INVALID_STATE_TRANSITION','O estado atual não permite cancelamento operacional.');
    const now=await serverTime(client),driverId=delivery.payload.driverId||null,picked=!!delivery.payload.pickedUpAt;
    const custodyState=picked?STATES.DECISION_REQUIRED:STATES.NOT_COLLECTED,ext={...(delivery.payload.extensions||{}),
      x_rotamoto_custody_state:custodyState,x_rotamoto_custody_cancelled_at:now.toISOString(),
      x_rotamoto_custody_cancel_reason:reason,...(possibleRoute?{x_rotamoto_custody_route_id:possibleRoute.record_id}:{})};
    const updated=await saveDelivery(client,principal,await restaurantInstallation(client,principal.company_id),delivery,
      {...delivery.payload,status:'CANCELLED',extensions:ext});
    if(possibleRoute){const ids=(possibleRoute.payload.deliveryIds||[]).filter(id=>id!==deliveryId);await saveRoute(client,principal,await restaurantInstallation(client,principal.company_id),possibleRoute,ids);}
    await appendFact(client,principal,await restaurantInstallation(client,principal.company_id),deliveryId,driverId,'DELIVERY_CANCELLATION_RECORDED',
      {reason,custodyState,pickedUpConfirmed:picked,confirmedAt:now.toISOString()});
    const result={deliveryId,status:'CANCELLED',version:updated.version,updatedAt:updated.updatedAt,custodyState,returnRequired:picked};
    const fulfillment=await client.query(`UPDATE rotamoto.delivery_fulfillments SET status='cancelled',revision=revision+1,updated_by=$3,updated_at=transaction_timestamp()
      WHERE company_id=$1 AND delivery_id=$2 AND mode='internal' AND status IN ('selected','accepted','in_progress','arrived')`,
    [principal.company_id,deliveryId,principal.user_id]);
    if(fulfillment.rowCount)await audit(client,principal,'logistics.fulfillment.internal_cancelled',deliveryId,{reason:'delivery_cancelled',revisionAdvanced:fulfillment.rowCount});
    return operationFinish(client,principal,'CANCEL',deliveryId,operation,result);
  }
  async function decideCustody(client,principal,deliveryId,input){
    validateCommand(input,new Set(['decision','reason','expectedVersion','idempotencyKey','reconcileIncident']));await requireOrdersManage(client,principal);
    uuid(deliveryId,'deliveryId');if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1)fail('INVALID_INPUT','expectedVersion inválida.');
    if(!['RETURN','RELEASE','INCIDENT'].includes(input.decision))fail('INVALID_INPUT','Decisão de custódia inválida.');
    const reason=text(input.reason,'reason');if(input.reconcileIncident!==undefined&&typeof input.reconcileIncident!=='boolean')fail('INVALID_INPUT','reconcileIncident inválido.');
    const operationType=input.decision==='RETURN'?'RETURN':input.decision==='RELEASE'?'RELEASE':'INCIDENT';
    const op=await operationStart(client,principal,operationType,deliveryId,{...input,reason});if(op.duplicate)return {...op.result,duplicate:true};
    const lookup=await client.query(`SELECT payload FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[principal.company_id,deliveryId]);
    if(!lookup.rowCount)fail('NOT_FOUND','Entrega não encontrada.');
    const ext=lookup.rows[0].payload.extensions||{},routeId=ext.x_rotamoto_custody_route_id||null;
    await lockRouteMembership(client,principal.company_id);
    let route=await locateRoute(client,principal.company_id,deliveryId,routeId,false);
    if(route)route=await locateRoute(client,principal.company_id,deliveryId,route.record_id,true);
    const original=await lockDelivery(client,principal.company_id,deliveryId);await assertInternal(client,principal,deliveryId);
    if(original.payload.status!=='CANCELLED')fail('INVALID_STATE_TRANSITION','A decisão só pode ser registrada depois do cancelamento canônico.');
    if(Number(original.version)!==input.expectedVersion)fail('REVISION_CONFLICT','A entrega mudou; atualize antes de decidir.');
    const currentExt=original.payload.extensions||{},currentState=currentExt.x_rotamoto_custody_state||STATES.DECISION_REQUIRED;
    if(currentState==='DISPUTED'&&input.decision!=='INCIDENT'&&input.reconcileIncident!==true)fail('CUSTODY_RECONCILIATION_REQUIRED','Resolva a divergência de custódia explicitamente antes da decisão.');
    if(input.decision==='RETURN'){
      if(!original.payload.pickedUpAt||!original.payload.driverId)fail('CUSTODY_NOT_CONFIRMED','A coleta e o motoboy responsável precisam estar confirmados pelo servidor.');
      if(currentExt.x_rotamoto_return_delivery_id)fail('RETURN_ALREADY_EXISTS','Já existe corrida de devolução para esta entrega.');
      if(!route)fail('ACTIVE_ROUTE_REQUIRED','A devolução exige uma rota ativa para o motoboy responsável.');
      const orderId=original.payload.orderId;
      const order=await client.query(`SELECT payload FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Order'`,[principal.company_id,orderId]);
      const company=await client.query(`SELECT name,operational_address,operational_latitude,operational_longitude FROM rotamoto.companies WHERE id=$1`,[principal.company_id]);
      const now=await serverTime(client),returnId=uuidV7(clock().getTime()),installationId=await restaurantInstallation(client,principal.company_id);
      const destination={companyId:principal.company_id,name:company.rows[0]?.name||'Restaurante responsável',
        address:company.rows[0]?.operational_address||null,latitude:company.rows[0]?.operational_latitude==null?null:Number(company.rows[0].operational_latitude),
        longitude:company.rows[0]?.operational_longitude==null?null:Number(company.rows[0].operational_longitude)};
      const payload={id:returnId,companyId:principal.company_id,orderId,driverId:original.payload.driverId,status:'ASSIGNED',priority:original.payload.priority||'NORMAL',
        assignedAt:now.toISOString(),acceptedAt:null,pickedUpAt:null,arrivedAt:null,completedAt:null,createdAt:now.toISOString(),updatedAt:now.toISOString(),version:1,
        extensions:{x_rotamoto_delivery_type:'RETURN',x_rotamoto_return_of_delivery_id:deliveryId,x_rotamoto_return_reason:reason,
          x_rotamoto_return_decision:{decision:'RETURN',reason,operatorId:principal.user_id,decidedAt:now.toISOString()},
          x_rotamoto_return_destination:destination,x_rotamoto_return_route_id:route.record_id,x_rotamoto_custody_state:STATES.WITH_DRIVER}};
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,
        related_entity_type,related_record_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Delivery','restaurante',$3,'Delivery',$4,$5::jsonb,1,$6,$6)`,
      [principal.company_id,returnId,installationId,deliveryId,JSON.stringify(payload),now]);
      const priorFulfillment=await client.query(`SELECT provider_id FROM rotamoto.delivery_fulfillments WHERE company_id=$1
        AND delivery_id=$2 AND mode='internal' ORDER BY revision DESC LIMIT 1`,[principal.company_id,deliveryId]);
      const provider=priorFulfillment.rowCount?{id:priorFulfillment.rows[0].provider_id}:await ensureInternalProvider(client,principal);
      if(!provider?.id)fail('PROVIDER_UNAVAILABLE','Frota própria não está configurada para registrar a devolução.');
      await client.query(`INSERT INTO rotamoto.delivery_fulfillments(company_id,fulfillment_id,delivery_id,provider_id,mode,driver_id,
        status,selected_by,updated_by,revision,selected_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,'internal',$5,'selected',$6,$6,1,$7,$7,$7)`,
      [principal.company_id,uuidV7(clock().getTime()),returnId,provider.id,payload.driverId,principal.user_id,now]);
      const ids=(route.payload.deliveryIds||[]).filter(id=>id!==deliveryId);ids.push(returnId);
      await saveRoute(client,principal,installationId,route,ids);
      const updatedOriginal=await saveDelivery(client,principal,installationId,original,{...original.payload,extensions:{...currentExt,
        x_rotamoto_custody_state:STATES.RETURN_REQUESTED,x_rotamoto_return_delivery_id:returnId,
        x_rotamoto_custody_decision:{decision:'RETURN',reason,operatorId:principal.user_id,decidedAt:now.toISOString()},
        x_rotamoto_custody_route_id:route.record_id}});
      await emit(client,principal,installationId,'Delivery',returnId,payload,payload.driverId);
      await appendFact(client,principal,installationId,deliveryId,payload.driverId,'DELIVERY_RETURN_REQUESTED',{returnDeliveryId:returnId,reason,decision:'RETURN',decidedAt:now.toISOString()});
      await audit(client,principal,'delivery.return.created',deliveryId,{returnDeliveryId:returnId,driverId:payload.driverId,routeId:route.record_id,position:ids.length,orderId});
      const result={deliveryId,returnDeliveryId:returnId,status:'ASSIGNED',driverId:payload.driverId,routeId:route.record_id,routePosition:ids.length,
        originalVersion:updatedOriginal.version,returnVersion:1,custodyState:STATES.RETURN_REQUESTED};
      return operationFinish(client,principal,'RETURN',deliveryId,op,result,returnId);
    }
    if(currentState===STATES.NOT_COLLECTED)fail('CUSTODY_NOT_CONFIRMED','Não existe coleta confirmada; nenhuma devolução é necessária.');
    if(currentState===STATES.RETURN_REQUESTED||currentState===STATES.RELEASED||currentState===STATES.RECEIVED)
      fail('INVALID_STATE_TRANSITION','A custódia já recebeu uma decisão terminal.');
    const now=await serverTime(client),installationId=await restaurantInstallation(client,principal.company_id),nextState=input.decision==='RELEASE'?STATES.RELEASED:STATES.INCIDENT_OPEN;
    const decision={decision:input.decision,reason,operatorId:principal.user_id,decidedAt:now.toISOString(),
      ...(currentState==='DISPUTED'&&input.reconcileIncident?{reconciledAt:now.toISOString(),reconciledBy:principal.user_id}:{})};
    const updated=await saveDelivery(client,principal,installationId,original,{...original.payload,extensions:{...currentExt,x_rotamoto_custody_state:nextState,x_rotamoto_custody_decision:decision}});
    await appendFact(client,principal,installationId,deliveryId,original.payload.driverId||null,
      input.decision==='RELEASE'?'DELIVERY_CUSTODY_RELEASED':input.decision==='INCIDENT'?'DELIVERY_CUSTODY_INCIDENT_OPENED':'DELIVERY_CUSTODY_DECISION_RECORDED',decision);
    await audit(client,principal,`delivery.custody.${input.decision.toLowerCase()}`,deliveryId,decision);
    const result={deliveryId,status:updated.status,custodyState:nextState,version:updated.version,decision};
    return operationFinish(client,principal,operationType,deliveryId,op,result);
  }
  async function confirmReturnReceipt(client,principal,returnId,input){
    validateCommand(input,new Set(['expectedVersion','idempotencyKey','reason']));await requireOrdersManage(client,principal);
    uuid(returnId,'returnDeliveryId');if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1)fail('INVALID_INPUT','expectedVersion inválida.');
    const reason=text(input.reason,'reason');const op=await operationStart(client,principal,'RECEIPT',returnId,{...input,reason});if(op.duplicate)return {...op.result,duplicate:true};
    const lookup=await client.query(`SELECT related_record_id::text FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2
      AND entity_type='Delivery' AND payload->'extensions'->>'x_rotamoto_delivery_type'='RETURN'`,[principal.company_id,returnId]);
    if(!lookup.rowCount)fail('NOT_FOUND','Corrida de devolução não encontrada.');
    const originalId=lookup.rows[0].related_record_id;
    await lockRouteMembership(client,principal.company_id);
    const route=await locateRoute(client,principal.company_id,returnId,null,true);
    const ret=await lockDelivery(client,principal.company_id,returnId),original=await lockDelivery(client,principal.company_id,originalId);
    if(Number(ret.version)!==input.expectedVersion)fail('REVISION_CONFLICT','A devolução mudou; atualize antes de confirmar.');
    const retExt=ret.payload.extensions||{},originalExt=original.payload.extensions||{};
    if(ret.payload.status==='RETURNED'&&retExt.x_rotamoto_custody_state===STATES.RECEIVED)return {returnDeliveryId:returnId,duplicate:true,custodyState:STATES.RECEIVED};
    if(retExt.x_rotamoto_custody_state!==STATES.AWAITING_RESTAURANT_RECEIPT||ret.payload.status!=='ARRIVED')
      fail('INVALID_STATE_TRANSITION','O Motoboy precisa registrar chegada e entrega física antes do recebimento.');
    const now=await serverTime(client),installationId=await restaurantInstallation(client,principal.company_id);
    const received=await saveDelivery(client,principal,installationId,ret,{...ret.payload,status:'RETURNED',
      extensions:{...retExt,x_rotamoto_custody_state:STATES.RECEIVED,x_rotamoto_restaurant_received_at:now.toISOString(),
        x_rotamoto_restaurant_received_by:principal.user_id,x_rotamoto_receipt_reason:reason}});
    const updatedOriginal=await saveDelivery(client,principal,installationId,original,{...original.payload,extensions:{...originalExt,
      x_rotamoto_custody_state:STATES.RECEIVED,x_rotamoto_custody_received_at:now.toISOString(),x_rotamoto_custody_received_by:principal.user_id}});
    if(route){const ids=(route.payload.deliveryIds||[]).filter(id=>id!==returnId);await saveRoute(client,principal,installationId,route,ids);}
    await appendFact(client,principal,installationId,returnId,ret.payload.driverId,'DELIVERY_RETURN_RECEIPT_CONFIRMED',
      {originalDeliveryId:originalId,receivedBy:principal.user_id,receivedAt:now.toISOString(),reason});
    await appendFact(client,principal,installationId,originalId,ret.payload.driverId,'DELIVERY_CUSTODY_CLOSED',
      {returnDeliveryId:returnId,receivedBy:principal.user_id,receivedAt:now.toISOString()});
    await client.query(`UPDATE rotamoto.delivery_fulfillments SET status='completed',revision=revision+1,updated_by=$3,updated_at=$4
      WHERE company_id=$1 AND delivery_id=$2 AND mode='internal' AND status IN ('selected','accepted','in_progress','arrived')`,
    [principal.company_id,returnId,principal.user_id,now]);
    await audit(client,principal,'delivery.return.received',returnId,{originalDeliveryId:originalId,driverId:ret.payload.driverId,reason,receivedAt:now.toISOString()});
    const result={returnDeliveryId:returnId,originalDeliveryId:originalId,status:received.status,custodyState:STATES.RECEIVED,
      returnVersion:received.version,originalVersion:updatedOriginal.version,receivedAt:now.toISOString()};
    return operationFinish(client,principal,'RECEIPT',returnId,op,result);
  }
  async function audit(client,principal,action,deliveryId,details){
    await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES($1,$2,$3,'user',$4,'Delivery',$5,$6::jsonb)`,[uuidV7(clock().getTime()),principal.company_id,principal.user_id,action,deliveryId,JSON.stringify(details)]);
  }
  return Object.freeze({getCustody,cancelDelivery,decideCustody,confirmReturnReceipt});
}

module.exports={CustodyError,STATES,createDeliveryCustodyService};
