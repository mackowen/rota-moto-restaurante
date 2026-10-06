'use strict';

const crypto = require('node:crypto');
const { uuidV7 } = require('../identity/service');
const { buildDecisionQuality } = require('./decision-quality');
function fail(code, message) { throw Object.assign(new Error(message), { name:'LogisticsDecisionError', code }); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function safeSnapshot(comparison) {
  const snapshot = { ...comparison, inputs: { ...(comparison.inputs || {}) } };
  delete snapshot.inputs.currentTime;
  return snapshot;
}
function fingerprintSnapshot(comparison) {
  const copy=structuredClone(safeSnapshot(comparison));
  const visit=value=>{
    if(Array.isArray(value)){for(const item of value)visit(item);return;}
    if(!value||typeof value!=='object')return;
    if(value.providerId==='osrm-route-v1')delete value.evaluatedAt;
    for(const child of Object.values(value))visit(child);
  };
  visit(copy);return copy;
}

function createHumanDecisionService({ clock = () => new Date(), compare, selectFulfillment, selectProviderQuote, requestProviderDispatch, assignDeliveryToRoute = null }) {
  if (![compare, selectFulfillment, selectProviderQuote, requestProviderDispatch].every(fn => typeof fn === 'function'))
    throw new TypeError('Logistics decision dependencies are required.');

  async function context(client, companyId, deliveryId, policy, lockCurrent = false) {
    const lock=lockCurrent?' FOR UPDATE':'';
    const delivery = await client.query(`SELECT version,payload->>'status' AS status FROM rotamoto.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' AND deleted_at IS NULL${lock}`, [companyId, deliveryId]);
    if (!delivery.rowCount) fail('NOT_FOUND', 'Entrega não encontrada.');
    const fulfillment = await client.query(`SELECT fulfillment_id,provider_id,mode,status,driver_id,revision
      FROM rotamoto.delivery_fulfillments WHERE company_id=$1 AND delivery_id=$2 ORDER BY revision DESC LIMIT 1${lock}`, [companyId, deliveryId]);
    const quotes = await client.query(`SELECT quote_id,provider_id,fulfillment_id,status,currency,amount_minor,eta_at,issued_at,expires_at,version
      FROM rotamoto.provider_quotes WHERE company_id=$1 AND delivery_id=$2 ORDER BY quote_id${lock}`, [companyId, deliveryId]);
    const routes = await client.query(`SELECT record_id::text AS route_id,version,payload->>'status' AS status,payload->'deliveryIds' AS delivery_ids
      FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Route' AND deleted_at IS NULL
        AND upper(coalesce(payload->>'status',''))=ANY($2::text[]) ORDER BY record_id${lock}`, [companyId,['PLANNED','ACTIVE','IN_PROGRESS']]);
    const capacity = await client.query(`SELECT record_id::text AS driver_id,version,payload->>'status' AS status,payload->'capacity' AS capacity
      FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Driver' AND deleted_at IS NULL ORDER BY record_id${lock}`, [companyId]);
    const assigned = await client.query(`SELECT record_id::text AS delivery_id,payload->>'driverId' AS driver_id,payload->>'status' AS status,version
      FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Delivery' AND deleted_at IS NULL
        AND NULLIF(payload->>'driverId','') IS NOT NULL ORDER BY record_id${lock}`, [companyId]);
    const settings = await client.query(`SELECT version,default_policy,fixed_cost_per_delivery_minor,variable_cost_per_km_minor,currency
      FROM rotamoto.logistics_intelligence_settings WHERE company_id=$1${lock}`, [companyId]);
    const providerConfig = await client.query(`SELECT provider_id,version,enabled,integration_mode,api_enabled,capabilities
      FROM rotamoto.logistics_providers WHERE company_id=$1 ORDER BY provider_id${lock}`, [companyId]);
    const geoSnapshots = await client.query(`SELECT geo.delivery_id::text AS delivery_id,geo.version,geo.provenance,geo.accuracy_m,geo.resolved_at
      FROM rotamoto.delivery_geo_snapshots geo WHERE geo.company_id=$1 AND (geo.delivery_id=$2 OR EXISTS(
        SELECT 1 FROM rotamoto.domain_records route
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(route.payload->'deliveryIds')='array'
          THEN route.payload->'deliveryIds' ELSE '[]'::jsonb END) stop_id(value)
        WHERE route.company_id=$1 AND route.entity_type='Route' AND route.deleted_at IS NULL
          AND upper(coalesce(route.payload->>'status',''))=ANY(ARRAY['PLANNED','ACTIVE','IN_PROGRESS']::text[])
          AND stop_id.value=geo.delivery_id::text)) ORDER BY geo.delivery_id`,[companyId,deliveryId]);
    const basis = { deliveryVersion: Number(delivery.rows[0].version), deliveryStatus: delivery.rows[0].status,
      fulfillment: fulfillment.rows[0] || null, quotes: quotes.rows, routes: routes.rows, drivers: capacity.rows, assignedDeliveries: assigned.rows,
      settings: settings.rows[0] || null, providers: providerConfig.rows, geoSnapshots:geoSnapshots.rows, policy };
    return { basis, fingerprint: digest(basis) };
  }

  async function evaluate(client, principal, deliveryId, policy) {
    const comparison = await compare(client, principal, deliveryId, policy);
    const snapshot = safeSnapshot(comparison);
    const current = await context(client, principal.company_id, deliveryId, comparison.policy);
    current.fingerprint=digest({basis:current.basis,comparison:fingerprintSnapshot(comparison)});
    const decisionId = uuidV7(clock().getTime());
    const result = await client.query(`INSERT INTO rotamoto.logistics_decisions
      (company_id,decision_id,delivery_id,status,policy,recommended_alternative_id,snapshot,state_fingerprint,evaluated_at,proposed_by)
      VALUES($1,$2,$3,'proposed',$4,$5,$6::jsonb,$7,$8,$9)
      RETURNING decision_id,delivery_id,version,status,policy,recommended_alternative_id,snapshot,state_fingerprint,evaluated_at,created_at,updated_at`,
    [principal.company_id, decisionId, deliveryId, comparison.policy,
      comparison.recommendation?.selectedAlternativeId || null, JSON.stringify(snapshot), current.fingerprint, clock(), principal.user_id]);
    await audit(client, principal, 'logistics.decision.proposed', decisionId,
      { deliveryId, version: 1, policy: comparison.policy, recommended: comparison.recommendation?.selectedAlternativeId || null });
    return { decision: project(result.rows[0]), history: undefined };
  }
  function validateInput(input, allowed) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.has(key)))
      fail('INVALID_INPUT','Campos de decisão inválidos.');
  }

  async function audit(client, principal, action, id, details) {
    await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES($1,$2,$3,'user',$4,'logistics_decision',$5,$6::jsonb)`,
    [uuidV7(clock().getTime()),principal.company_id,principal.user_id,action,id,JSON.stringify(details)]);
  }
  function project(row) {
    return { id: row.decision_id, deliveryId: row.delivery_id, version: Number(row.version), status: row.status, policy: row.policy,
      recommendedAlternativeId: row.recommended_alternative_id, selectedAlternativeId: row.selected_alternative_id,
      snapshot: row.snapshot, evaluatedAt: row.evaluated_at, decidedAt: row.decided_at || null, decidedBy: row.decided_by || null,
      executionResult: row.execution_result || null, updatedAt: row.updated_at };
  }
  async function list(client, principal, deliveryId) {
    const result = await client.query(`SELECT decision_id,delivery_id,version,status,policy,recommended_alternative_id,selected_alternative_id,
      snapshot,state_fingerprint,evaluated_at,decided_at,decided_by,execution_result,created_at,updated_at
      FROM rotamoto.logistics_decisions WHERE company_id=$1 AND delivery_id=$2 ORDER BY created_at DESC LIMIT 30`,
    [principal.company_id,deliveryId]);
    return { decisions: result.rows.map(project) };
  }
  async function quality(client, principal) {
    const result = await client.query(`WITH selected AS (
      SELECT d.*, alternative.value AS selected_alternative,
        alternative.value->>'mode' AS selected_mode
      FROM rotamoto.logistics_decisions d
      LEFT JOIN LATERAL jsonb_array_elements(COALESCE(d.snapshot->'alternatives','[]'::jsonb)) alternative(value)
        ON alternative.value->>'id'=d.selected_alternative_id
      WHERE d.company_id=$1
      ORDER BY d.created_at DESC,d.decision_id DESC LIMIT 1000
    ) SELECT d.decision_id,d.delivery_id,d.version,d.status,d.policy,d.recommended_alternative_id,d.selected_alternative_id,
        d.snapshot,d.evaluated_at,d.decided_at,d.decided_by,d.execution_result,d.created_at,
        f.fulfillment_id AS outcome_fulfillment_id,f.mode AS outcome_mode,f.provider_id AS outcome_provider_id,
        f.status AS outcome_fulfillment_status,f.estimated_cost_minor AS outcome_estimated_cost_minor,
        f.estimated_cost_currency AS outcome_estimated_cost_currency,f.final_cost_minor AS outcome_final_cost_minor,
        f.final_cost_currency AS outcome_final_cost_currency,f.selected_at AS outcome_selected_at,
        a.status AS outcome_attempt_status,delivery.payload->>'completedAt' AS delivery_completed_at
      FROM selected d
      LEFT JOIN rotamoto.dispatch_attempts a ON d.selected_mode='external_api'
        AND a.company_id=d.company_id AND a.attempt_id=CASE
          WHEN d.execution_result->>'fulfillmentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (d.execution_result->>'fulfillmentId')::uuid ELSE NULL END
      LEFT JOIN rotamoto.delivery_fulfillments f ON f.company_id=d.company_id AND f.delivery_id=d.delivery_id AND
        ((d.selected_mode='external_api' AND f.fulfillment_id=a.fulfillment_id) OR
         (d.selected_mode<>'external_api' AND f.fulfillment_id=CASE
          WHEN d.execution_result->>'fulfillmentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (d.execution_result->>'fulfillmentId')::uuid ELSE NULL END))
      LEFT JOIN rotamoto.domain_records delivery ON delivery.company_id=d.company_id AND delivery.record_id=d.delivery_id
        AND delivery.entity_type='Delivery'
      ORDER BY d.created_at DESC,d.decision_id DESC`,[principal.company_id]);
    return buildDecisionQuality(result.rows,{generatedAt:clock().toISOString(),limit:1000});
  }
  async function getForUpdate(client, principal, decisionId, expectedVersion, idempotency = null) {
    const result = await client.query(`SELECT * FROM rotamoto.logistics_decisions
      WHERE company_id=$1 AND decision_id=$2 FOR UPDATE`, [principal.company_id,decisionId]);
    if (!result.rowCount) fail('NOT_FOUND','Decisão não encontrada.');
    const row=result.rows[0];
    if (Number(row.version)!==expectedVersion && !(idempotency && idempotency(row))) fail('REVISION_CONFLICT','A decisão mudou em outra sessão. Atualize a tela.');
    return row;
  }
  async function markStale(client, principal, row, currentFingerprint) {
    const changed=await client.query(`UPDATE rotamoto.logistics_decisions SET status='stale',version=version+1,updated_at=$3
      WHERE company_id=$1 AND decision_id=$2 AND version=$4 RETURNING *`,
    [principal.company_id,row.decision_id,clock(),row.version]);
    await audit(client,principal,'logistics.decision.stale',row.decision_id,{deliveryId:row.delivery_id,version:changed.rows[0]?.version,
      previousFingerprint:row.state_fingerprint,currentFingerprint});
    return changed.rows[0] ? project(changed.rows[0]) : project(row);
  }
  async function revalidate(client, principal, row) {
    const current=await context(client,principal.company_id,row.delivery_id,row.policy,true);
    const comparison=await compare(client,principal,row.delivery_id,row.policy);
    current.fingerprint=digest({basis:current.basis,comparison:fingerprintSnapshot(comparison)});
    if (current.fingerprint!==row.state_fingerprint) return { stale: true, decision: await markStale(client,principal,row,current.fingerprint) };
    return { stale:false, current };
  }
  async function approve(client, principal, decisionId, input) {
    validateInput(input,new Set(['expectedVersion','alternativeId']));
    if (!Number.isSafeInteger(input?.expectedVersion) || input.expectedVersion < 1) fail('INVALID_INPUT','Revisão inválida.');
    if(typeof input.alternativeId!=='string')fail('INVALID_INPUT','Selecione explicitamente a alternativa que está aprovando.');
    const row=await getForUpdate(client,principal,decisionId,input.expectedVersion,previous=>previous.status==='approved');
    if (row.status==='approved') {
      if(row.selected_alternative_id!==input.alternativeId)fail('REVISION_CONFLICT','Outra alternativa já foi aprovada nesta decisão.');
      return { decision:project(row),duplicate:true };
    }
    if (row.status!=='proposed') fail('INVALID_STATE_TRANSITION','Somente uma proposta atual pode ser aprovada.');
    const approvedAlternative=(row.snapshot.alternatives||[]).find(item=>item.id===input.alternativeId);
    if(!approvedAlternative?.eligible)fail('INVALID_INPUT','A alternativa selecionada não está elegível nesta avaliação.');
    const validated=await revalidate(client,principal,row);
    if(validated.stale)return {decision:validated.decision,stale:true};
    const result=await client.query(`UPDATE rotamoto.logistics_decisions SET status='approved',selected_alternative_id=$3,decided_by=$4,decided_at=$5,
      version=version+1,updated_at=$5 WHERE company_id=$1 AND decision_id=$2 AND version=$6 RETURNING *`,
    [principal.company_id,decisionId,input.alternativeId,principal.user_id,clock(),row.version]);
    if(!result.rowCount)fail('REVISION_CONFLICT','A decisão foi alterada por outra sessão.');
    await audit(client,principal,'logistics.decision.approved',decisionId,{deliveryId:row.delivery_id,version:result.rows[0].version,
      recommendation:row.recommended_alternative_id,approvedAlternativeId:input.alternativeId});
    return {decision:project(result.rows[0]),duplicate:false};
  }
  async function reject(client, principal, decisionId, input) {
    validateInput(input,new Set(['expectedVersion']));
    if (!Number.isSafeInteger(input?.expectedVersion) || input.expectedVersion < 1) fail('INVALID_INPUT','Revisão inválida.');
    const row=await getForUpdate(client,principal,decisionId,input.expectedVersion,previous=>previous.status==='rejected');
    if(row.status==='rejected')return {decision:project(row),duplicate:true};
    if(row.status!=='proposed')fail('INVALID_STATE_TRANSITION','Somente uma proposta pode ser rejeitada.');
    const result=await client.query(`UPDATE rotamoto.logistics_decisions SET status='rejected',decided_by=$3,decided_at=$4,
      version=version+1,updated_at=$4 WHERE company_id=$1 AND decision_id=$2 AND version=$5 RETURNING *`,
    [principal.company_id,decisionId,principal.user_id,clock(),row.version]);
    await audit(client,principal,'logistics.decision.rejected',decisionId,{deliveryId:row.delivery_id,version:result.rows[0].version});
    return {decision:project(result.rows[0]),duplicate:false};
  }
  async function recalculate(client, principal, decisionId, input) {
    validateInput(input,new Set(['expectedVersion']));
    if(!Number.isSafeInteger(input?.expectedVersion)||input.expectedVersion<1)fail('INVALID_INPUT','Revisão inválida.');
    const row=await getForUpdate(client,principal,decisionId,input.expectedVersion);
    if(!['proposed','stale'].includes(row.status))fail('INVALID_STATE_TRANSITION','Somente uma proposta pode ser recalculada.');
    if(row.status==='proposed'){
      await client.query(`UPDATE rotamoto.logistics_decisions SET status='stale',version=version+1,updated_at=$3
        WHERE company_id=$1 AND decision_id=$2`,[principal.company_id,decisionId,clock()]);
      await audit(client,principal,'logistics.decision.recalculated',decisionId,{deliveryId:row.delivery_id,previousVersion:row.version});
    }
    return evaluate(client,principal,row.delivery_id,row.policy);
  }
  async function execute(client, principal, decisionId, input) {
    validateInput(input,new Set(['expectedVersion','confirmExecution','idempotencyKey','alternativeId','selectedAlternativeId','driverId','routeId',
      'expectedFulfillmentRevision','fulfillmentId','quoteId','expectedQuoteVersion','routePosition','expectedRouteVersion']));
    if (!Number.isSafeInteger(input?.expectedVersion) || input.expectedVersion < 1 || input?.confirmExecution!==true ||
        typeof input?.idempotencyKey!=='string' || input.idempotencyKey.length<16 || input.idempotencyKey.length>128)
      fail('INVALID_INPUT','Confirme a execução, a revisão e a chave idempotente.');
    const expectedKey=`${principal.company_id}:${decisionId}:${input.idempotencyKey}`;
    const executionRequestFingerprint=digest({alternativeId:input.alternativeId||null,driverId:input.driverId||null,routeId:input.routeId||null,
      routePosition:input.routePosition??null,expectedRouteVersion:input.expectedRouteVersion??null,
      expectedFulfillmentRevision:input.expectedFulfillmentRevision??null,fulfillmentId:input.fulfillmentId||null,
      quoteId:input.quoteId||null,expectedQuoteVersion:input.expectedQuoteVersion??null});
    const row=await getForUpdate(client,principal,decisionId,input.expectedVersion,previous=>
      ['execution_requested','executed','failed','unknown_outcome'].includes(previous.status)&&previous.execution_key===expectedKey);
    if(['execution_requested','executed','failed','unknown_outcome'].includes(row.status)&&row.execution_key===expectedKey){
      if(row.execution_result?.requestFingerprint!==executionRequestFingerprint)fail('IDEMPOTENCY_CONFLICT','A chave idempotente já foi usada com outra execução.');
      return {decision:project(row),duplicate:true};
    }
    if(row.status==='unknown_outcome')fail('RECONCILIATION_REQUIRED','Resultado desconhecido exige reconciliação antes de nova execução.');
    if(row.status!=='approved')fail('INVALID_STATE_TRANSITION','A decisão precisa estar aprovada antes da execução.');
    const validated=await revalidate(client,principal,row);
    if(validated.stale)return {decision:validated.decision,stale:true};
    const snapshot=row.snapshot, alternativeId=input.alternativeId;
    if(alternativeId!==row.selected_alternative_id)fail('INVALID_STATE_TRANSITION','A execução deve usar exatamente a alternativa aprovada.');
    const alternative=(snapshot.alternatives||[]).find(item=>item.id===alternativeId);
    if(!alternative||!alternative.eligible)fail('INVALID_INPUT','Alternativa escolhida não está elegível nesta decisão.');
    if(input.selectedAlternativeId && input.selectedAlternativeId!==alternativeId)fail('INVALID_INPUT','Alternativa de execução inconsistente.');
    const key=expectedKey;
    let action;
    if(alternative.mode==='internal'){
      if(!input.driverId)fail('INVALID_INPUT','Escolha explicitamente um Driver interno.');
      const routeCandidate=(alternative.routeAssessment?.candidates||[]).find(item=>item.driverId===input.driverId&&item.compatibility==='compatible');
      const driverHasRoute=(alternative.routeAssessment?.candidates||[]).some(item=>item.driverId===input.driverId);
      if(driverHasRoute&&!routeCandidate)fail('REVISION_CONFLICT','A rota deste Driver não tem distância/ordem/capacidade suficientes para validar a inserção. Recalcule ou escolha outra alternativa.');
      if(alternative.marginalCost?.basis==='marginal_route_insertion'&&(!routeCandidate||input.routeId!==routeCandidate.routeId))
        fail('INVALID_INPUT','Escolha a rota e Driver candidatos da inserção.');
      const driverEvidence=(alternative.fleetCapacity?.byDriver||[]).find(item=>item.driverId===input.driverId);
      if(!driverEvidence||!driverEvidence.active||driverEvidence.capacityStatus!=='slots_available')
        fail('INVALID_DRIVER','A execução da frota própria exige Driver ativo, capacidade conhecida e slot disponível. Recalcule.');
      const expectedRevision=Number(input.expectedFulfillmentRevision);
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail('INVALID_INPUT','Revisão de fulfillment inválida.');
      action=await selectFulfillment(client,principal,row.delivery_id,{providerId:alternative.providerId,mode:'internal',driverId:input.driverId,
        fulfillmentId:input.fulfillmentId,expectedRevision,externalReference:null,etaAt:null,
        ...(alternative.decisionCost?.status==='known'?{estimatedCostMinor:alternative.decisionCost.amountMinor,estimatedCostCurrency:alternative.decisionCost.currency}:{})});
      if(routeCandidate){
        if(typeof assignDeliveryToRoute!=='function'||!routeCandidate||!Number.isSafeInteger(input.routePosition)||
          input.routePosition!==routeCandidate.insertion.bestPosition||input.expectedRouteVersion!==routeCandidate.routeVersion)
          fail('REVISION_CONFLICT','Rota, posição ou serviço canônico de planejamento mudou; recalcule a decisão.');
        await assignDeliveryToRoute(client,principal,{routeId:routeCandidate.routeId,deliveryId:row.delivery_id,driverId:input.driverId,
          position:input.routePosition,expectedRouteVersion:input.expectedRouteVersion});
      }
    }else if(alternative.mode==='external_api'){
      if(!input.quoteId)fail('INVALID_INPUT','Selecione explicitamente a cotação válida.');
      const expectedQuoteVersion=Number(input.expectedQuoteVersion),expectedRevision=Number(input.expectedFulfillmentRevision);
      const fulfillmentId=input.fulfillmentId;
      const quoteState=await client.query(`SELECT status,fulfillment_id,expires_at FROM rotamoto.provider_quotes
        WHERE company_id=$1 AND delivery_id=$2 AND quote_id=$3 FOR UPDATE`,[principal.company_id,row.delivery_id,input.quoteId]);
      if(!quoteState.rowCount||quoteState.rows[0].expires_at<=clock())fail('INVALID_STATE_TRANSITION','A cotação expirou; recalcule a decisão.');
      if(quoteState.rows[0].status==='available')
        await selectProviderQuote(client,principal,row.delivery_id,{quoteId:input.quoteId,expectedQuoteVersion,expectedRevision,fulfillmentId});
      else if(quoteState.rows[0].status!=='selected'||!quoteState.rows[0].fulfillment_id)
        fail('INVALID_STATE_TRANSITION','A cotação não está selecionável para despacho.');
      action=await requestProviderDispatch(client,principal,row.delivery_id,{quoteId:input.quoteId,idempotencyKey:key});
    }else if(alternative.mode==='external_manual'){
      if(!input.fulfillmentId||!Number.isSafeInteger(input.expectedFulfillmentRevision))fail('INVALID_INPUT','Selecione provider manual e revisão atual.');
      action=await selectFulfillment(client,principal,row.delivery_id,{providerId:alternative.providerId,mode:'external',driverId:null,
        fulfillmentId:input.fulfillmentId,expectedRevision:input.expectedFulfillmentRevision,externalReference:null,etaAt:null});
    }else fail('INVALID_INPUT','Alternativa de execução não suportada.');
    const resultPayload={operation:alternative.mode==='external_api'?'dispatch_requested':'fulfillment_selected',
      status:action?.status||action?.fulfillment?.status||'selected',commandId:action?.commandId||null,
      fulfillmentId:action?.fulfillment?.id||action?.attemptId||null,requiresAsyncConfirmation:alternative.mode==='external_api',
      requestFingerprint:executionRequestFingerprint};
    const decisionStatus=alternative.mode==='external_api'?'execution_requested':'executed';
    const update=await client.query(`UPDATE rotamoto.logistics_decisions SET status=$8,selected_alternative_id=$3,
      execution_key=$4,execution_result=$5::jsonb,version=version+1,updated_at=$6
      WHERE company_id=$1 AND decision_id=$2 AND status='approved' AND version=$7 RETURNING *`,
    [principal.company_id,decisionId,alternativeId,key,JSON.stringify(resultPayload),clock(),row.version,decisionStatus]);
    if(!update.rowCount)fail('REVISION_CONFLICT','A decisão mudou durante a execução.');
    await audit(client,principal,`logistics.decision.${decisionStatus}`,decisionId,{deliveryId:row.delivery_id,version:update.rows[0].version,
      alternativeId,mode:alternative.mode,status:resultPayload.status,commandId:resultPayload.commandId});
    return {decision:project(update.rows[0]),action,duplicate:false};
  }
  return Object.freeze({evaluate,list,quality,approve,reject,recalculate,execute});
}

module.exports={createHumanDecisionService};
