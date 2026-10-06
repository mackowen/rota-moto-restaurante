'use strict';

const crypto = require('node:crypto');
const Money = require('../../order-money');
const D = require('./domain');
const { resolveTestProviderConfiguration } = require('./provider-integration');

const POLICIES = Object.freeze(['lowest_cost','prefer_internal','earliest_eta']);
const MAX_MINOR = 9000000000000000;

function invalid(message) { throw Object.assign(new Error(message), { code: 'INVALID_INPUT' }); }
function normalizePolicy(value) {
  if (!POLICIES.includes(value)) invalid('Política de recomendação inválida.');
  return value;
}
function normalizeSettings(input) {
  const allowed = new Set(['expectedVersion','fixedCostPerDeliveryMinor','variableCostPerKmMinor','currency','defaultPolicy']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key)) ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid('Configuração econômica inválida.');
  const raw = [input.fixedCostPerDeliveryMinor,input.variableCostPerKmMinor,input.currency];
  const cleared = raw.every(value => value === null || value === undefined);
  const configured = raw.every(value => value !== null && value !== undefined);
  if (!cleared && !configured) invalid('Informe custo fixo, custo por km e moeda juntos; zero explícito é válido.');
  let costModel = null;
  if (configured) {
    if (![input.fixedCostPerDeliveryMinor,input.variableCostPerKmMinor].every(value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MINOR) ||
        Money.currencyScale(input.currency) === null) invalid('Valores do perfil de frota inválidos.');
    costModel = { fixedCostPerDeliveryMinor: input.fixedCostPerDeliveryMinor,
      variableCostPerKmMinor: input.variableCostPerKmMinor, currency: input.currency };
  }
  return { expectedVersion: input.expectedVersion, costModel,
    defaultPolicy: input.defaultPolicy === undefined ? undefined : normalizePolicy(input.defaultPolicy) };
}

function estimateInternalCost(model, distanceM) {
  if (!model) return { status: 'insufficient_data', reason: 'FLEET_COST_MODEL_NOT_CONFIGURED' };
  if (model.variableCostPerKmMinor > 0 && !Number.isSafeInteger(distanceM))
    return { status: 'insufficient_data', reason: 'DELIVERY_DISTANCE_UNKNOWN' };
  const variable = model.variableCostPerKmMinor === 0 ? 0 : Number((BigInt(model.variableCostPerKmMinor) * BigInt(distanceM) + 999n) / 1000n);
  const amount = model.fixedCostPerDeliveryMinor + variable;
  if (!Number.isSafeInteger(amount) || amount > MAX_MINOR) return { status: 'insufficient_data', reason: 'COST_MODEL_OVERFLOW' };
  return { status: 'known', amountMinor: amount, currency: model.currency, fixedCostMinor: model.fixedCostPerDeliveryMinor,
    variableCostMinor: variable, variableCostPerKmMinor: model.variableCostPerKmMinor, distanceM: Number.isSafeInteger(distanceM) ? distanceM : null,
    rounding: 'variable component rounded up to the next minor unit', source: 'operator_configured_fleet_model', componentsKnown: 2, componentsTotal: 2 };
}

function makeRecommendation(alternatives, policy) {
  const eligible = alternatives.filter(item => item.eligible);
  const abstain = (code, message, details = {}) => ({ status: 'insufficient_data', selectedAlternativeId: null,
    tiedAlternativeIds: [], why: { code, message, ...details } });
  if (eligible.length < 2) return abstain('NOT_ENOUGH_ELIGIBLE_ALTERNATIVES', 'São necessárias pelo menos duas alternativas operacionais elegíveis para recomendar.');
  if (policy === 'prefer_internal') {
    const own = eligible.find(item => item.mode === 'internal');
    if (!own) return abstain('INTERNAL_FLEET_UNAVAILABLE', 'A frota própria não está elegível neste recorte.');
    if (own.cost.status !== 'known') return abstain(own.cost.reason || 'INTERNAL_COST_UNKNOWN', 'A preferência pela frota própria não substitui os dados de custo ausentes.', { requirements: ['configure fixed cost, variable cost per km and currency', 'provide a valid delivery distance when the variable rate is positive'] });
    return { status: 'recommended', selectedAlternativeId: own.id, tiedAlternativeIds: [], why: {
      code: 'POLICY_PREFER_INTERNAL', message: 'A frota própria foi recomendada pela política configurada; a decisão final e a confirmação de capacidade são humanas.',
      evidence: [{ code: 'INTERNAL_FLEET_PREFERENCE', value: policy }, { code: 'CONFIGURED_COST', amountMinor: own.cost.amountMinor, currency: own.cost.currency }],
      limitations: ['fleet capacity is not verified by this comparison', 'this is a configured estimate, not realized operating cost'] } };
  }
  if (policy === 'lowest_cost') {
    const missing = eligible.filter(item => item.cost.status !== 'known');
    if (missing.length) return abstain('COST_COVERAGE_INCOMPLETE', 'Há alternativas elegíveis sem custo conhecido; não é possível afirmar qual tem menor custo.', { missingAlternativeIds: missing.map(item => item.id) });
    const currencies = [...new Set(eligible.map(item => item.cost.currency))];
    if (currencies.length !== 1) return abstain('CURRENCY_MISMATCH', 'As alternativas usam moedas diferentes; nenhuma conversão é feita.', { currencies });
    const min = Math.min(...eligible.map(item => item.cost.amountMinor));
    const winners = eligible.filter(item => item.cost.amountMinor === min).sort((a,b) => a.id.localeCompare(b.id));
    if (winners.length > 1) return { status: 'tie', selectedAlternativeId: null, tiedAlternativeIds: winners.map(item => item.id),
      why: { code: 'COST_TIE', message: 'As alternativas têm o mesmo valor nominal conhecido; a decisão continua humana.', currency: currencies[0], amountMinor: min } };
    return { status: 'recommended', selectedAlternativeId: winners[0].id, tiedAlternativeIds: [], why: {
      code: 'LOWEST_KNOWN_AMOUNT', message: 'Menor valor nominal entre custos/quotes conhecidos na mesma moeda; escopos e cobertura são exibidos por alternativa.',
      evidence: [{ code: 'LOWEST_AMOUNT', amountMinor: min, currency: currencies[0] }],
      limitations: ['external quote is not a realized charge', 'fleet estimate covers only the configured fixed and distance components', 'capacity is not verified; operator must decide'] } };
  }
  if (eligible.some(item => !item.etaAt)) return abstain('ETA_COVERAGE_INCOMPLETE', 'ETA não é conhecido para todas as alternativas elegíveis; o sistema não estima nem inventa prazo.', { missingAlternativeIds: eligible.filter(item => !item.etaAt).map(item => item.id) });
  const dated = eligible.filter(item => Number.isFinite(Date.parse(item.etaAt))).sort((a,b) => Date.parse(a.etaAt)-Date.parse(b.etaAt) || a.id.localeCompare(b.id));
  if (dated.length !== eligible.length) return abstain('ETA_INVALID', 'Uma ou mais alternativas têm ETA indisponível ou inválido.');
  const first = Date.parse(dated[0].etaAt), tied = dated.filter(item => Date.parse(item.etaAt) === first);
  if (tied.length > 1) return { status: 'tie', selectedAlternativeId: null, tiedAlternativeIds: tied.map(item => item.id),
    why: { code: 'ETA_TIE', message: 'As alternativas têm o mesmo ETA conhecido; a decisão continua humana.' } };
  return { status: 'recommended', selectedAlternativeId: dated[0].id, tiedAlternativeIds: [], why: {
    code: 'EARLIEST_KNOWN_ETA', message: 'Menor ETA explicitamente fornecido entre alternativas elegíveis.',
    evidence: [{ code: 'EARLIEST_ETA', etaAt: dated[0].etaAt }], limitations: ['capacity is not verified; operator must decide'] } };
}

function createLogisticsIntelligenceService({ clock = () => new Date(), testProvider = null, ensureInternalProvider } = {}) {
  async function readSettings(client, companyId) {
    const result = await client.query(`SELECT fixed_cost_per_delivery_minor,variable_cost_per_km_minor,currency,default_policy,version,updated_at
      FROM rotamoto.logistics_intelligence_settings WHERE company_id=$1`, [companyId]);
    const row = result.rows[0];
    return row ? { configured: row.fixed_cost_per_delivery_minor !== null,
      costModel: row.fixed_cost_per_delivery_minor === null ? null : { fixedCostPerDeliveryMinor: Number(row.fixed_cost_per_delivery_minor),
        variableCostPerKmMinor: Number(row.variable_cost_per_km_minor), currency: row.currency,
        formula: 'fixedCostPerDelivery + ceil(variableCostPerKm × estimatedDistanceM / 1000)' },
      defaultPolicy: row.default_policy, version: row.version, updatedAt: row.updated_at } :
      { configured: false, costModel: null, defaultPolicy: 'lowest_cost', version: 0, updatedAt: null };
  }
  async function getSettings(client, principal) { return { settings: await readSettings(client, principal.company_id), policies: POLICIES }; }
  async function updateSettings(client, principal, input) {
    const normalized = normalizeSettings(input);
    if (typeof ensureInternalProvider !== 'function') throw new Error('Internal provider initializer unavailable.');
    const internal = await ensureInternalProvider(client, principal);
    const prior = await client.query(`SELECT version FROM rotamoto.logistics_intelligence_settings WHERE company_id=$1 FOR UPDATE`, [principal.company_id]);
    const version = prior.rowCount ? prior.rows[0].version : 0;
    if (version !== normalized.expectedVersion) throw Object.assign(new Error('Configuração alterada em outra sessão.'), { code: 'REVISION_CONFLICT' });
    const policy = normalized.defaultPolicy || (await readSettings(client, principal.company_id)).defaultPolicy;
    const model = normalized.costModel;
    const result = await client.query(`INSERT INTO rotamoto.logistics_intelligence_settings
      (company_id,internal_provider_id,fixed_cost_per_delivery_minor,variable_cost_per_km_minor,currency,default_policy,version,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,1,$7)
      ON CONFLICT(company_id) DO UPDATE SET internal_provider_id=EXCLUDED.internal_provider_id,
        fixed_cost_per_delivery_minor=EXCLUDED.fixed_cost_per_delivery_minor,variable_cost_per_km_minor=EXCLUDED.variable_cost_per_km_minor,
        currency=EXCLUDED.currency,default_policy=EXCLUDED.default_policy,version=rotamoto.logistics_intelligence_settings.version+1,
        updated_by=EXCLUDED.updated_by,updated_at=now()
      WHERE rotamoto.logistics_intelligence_settings.version=$8
      RETURNING fixed_cost_per_delivery_minor,variable_cost_per_km_minor,currency,default_policy,version,updated_at`,
    [principal.company_id,internal.id,model?.fixedCostPerDeliveryMinor ?? null,model?.variableCostPerKmMinor ?? null,model?.currency ?? null,policy,principal.user_id,normalized.expectedVersion]);
    if (!result.rowCount) throw Object.assign(new Error('Configuração alterada em outra sessão.'), { code: 'REVISION_CONFLICT' });
    const auditId = crypto.randomUUID();
    await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES($1,$2,$3,'user','logistics.intelligence.settings_updated','logistics_intelligence_settings',$4,$5::jsonb)`,
    [auditId,principal.company_id,principal.user_id,internal.id,JSON.stringify({ version: result.rows[0].version,
      configured: model !== null, currency: model?.currency || null, fixedCostPerDeliveryMinor: model?.fixedCostPerDeliveryMinor ?? null,
      variableCostPerKmMinor: model?.variableCostPerKmMinor ?? null, defaultPolicy: policy })]);
    return { settings: { configured: model !== null, costModel: model && { ...model,
      formula: 'fixedCostPerDelivery + ceil(variableCostPerKm × estimatedDistanceM / 1000)' }, defaultPolicy: policy,
      version: result.rows[0].version, updatedAt: result.rows[0].updated_at }, policies: POLICIES };
  }

  async function compareDelivery(client, principal, deliveryId, requestedPolicy) {
    D.uuid(deliveryId, 'deliveryId');
    const policy = requestedPolicy === undefined || requestedPolicy === null || requestedPolicy === '' ?
      (await readSettings(client, principal.company_id)).defaultPolicy : normalizePolicy(requestedPolicy);
    const deliveryResult = await client.query(`SELECT d.payload AS delivery_payload,o.payload AS order_payload
      FROM rotamoto.domain_records d LEFT JOIN rotamoto.domain_records o ON o.company_id=d.company_id AND o.record_id=
        CASE WHEN d.related_record_id IS NOT NULL THEN d.related_record_id ELSE NULLIF(d.payload->>'orderId','')::uuid END AND o.entity_type='Order' AND o.deleted_at IS NULL
      WHERE d.company_id=$1 AND d.record_id=$2 AND d.entity_type='Delivery' AND d.deleted_at IS NULL`, [principal.company_id,deliveryId]);
    if (!deliveryResult.rowCount) throw Object.assign(new Error('Entrega não encontrada.'), { code: 'NOT_FOUND' });
    const delivery = deliveryResult.rows[0].delivery_payload || {}, order = deliveryResult.rows[0].order_payload || {};
    const rawDistanceM = Number.isSafeInteger(delivery.estimatedDistanceM) && delivery.estimatedDistanceM >= 0 ? delivery.estimatedDistanceM :
      Number.isFinite(order.km) && order.km >= 0 && order.km <= Number.MAX_SAFE_INTEGER / 1000 ? Math.round(order.km * 1000) : null;
    const distanceSource = Number.isSafeInteger(delivery.estimatedDistanceM) ? 'Delivery.estimatedDistanceM' : rawDistanceM !== null ? 'Order.km (legacy estimate)' : null;
    const settings = await readSettings(client, principal.company_id);
    const internalResult = await client.query(`SELECT provider_id,enabled FROM rotamoto.logistics_providers
      WHERE company_id=$1 AND code='internal_fleet'`, [principal.company_id]);
    const alternatives = [];
    if (internalResult.rowCount && internalResult.rows[0].enabled) {
      const cost = estimateInternalCost(settings.costModel, rawDistanceM);
      alternatives.push({ id: `internal:${internalResult.rows[0].provider_id}`, mode: 'internal', providerId: internalResult.rows[0].provider_id,
        providerName: 'Frota própria', kind: 'configured_estimate', eligible: true, availability: { status: 'unverified', requiresHumanConfirmation: true },
        etaAt: null, etaStatus: 'unknown', cost, reasons: [{ code: 'FLEET_CAPACITY_NOT_VERIFIED', message: 'A disponibilidade de motoboy precisa ser confirmada pelo operador.' }] });
    }
    const providersResult = await client.query(`SELECT provider_id,code,display_name,provider_class,enabled,integration_mode,api_enabled,capabilities
      FROM rotamoto.logistics_providers WHERE company_id=$1 AND provider_class<>'internal_fleet' ORDER BY provider_id`, [principal.company_id]);
    const quotesResult = await client.query(`SELECT q.quote_id,q.provider_id,q.external_quote_id,q.status,q.currency,q.amount_minor,q.eta_at,q.issued_at,q.expires_at,
        p.code,p.display_name,p.enabled,p.integration_mode,p.api_enabled,p.capabilities
      FROM rotamoto.provider_quotes q JOIN rotamoto.logistics_providers p USING(company_id,provider_id)
      WHERE q.company_id=$1 AND q.delivery_id=$2 ORDER BY q.created_at DESC LIMIT 50`, [principal.company_id,deliveryId]);
    const now = clock().getTime();
    for (const row of providersResult.rows) {
      const test = testProvider ? resolveTestProviderConfiguration(testProvider, principal.company_id, row.provider_id) : null;
      const apiEligible = row.enabled && (test ? row.code === test.providerCode && test.capabilities.includes('quote') && test.capabilities.includes('dispatch') :
        row.integration_mode === 'api' && row.api_enabled && row.capabilities.includes('quote') && row.capabilities.includes('dispatch'));
      const providerQuotes = quotesResult.rows.filter(quote => quote.provider_id === row.provider_id);
      const validQuotes = providerQuotes.filter(quote => apiEligible && ['available','selected'].includes(quote.status) && Date.parse(quote.expires_at) > now);
      for (const quote of validQuotes) alternatives.push({ id: `quote:${quote.quote_id}`, mode: 'external_api', providerId: row.provider_id,
        providerName: row.display_name, kind: 'provider_quote', eligible: true,
        availability: { status: 'quote_valid', requiresHumanConfirmation: true }, etaAt: quote.eta_at,
        etaStatus: quote.eta_at ? 'known_from_quote' : 'unknown', quote: { id: quote.quote_id, reference: quote.external_quote_id,
          issuedAt: quote.issued_at, expiresAt: quote.expires_at, status: quote.status },
        cost: { status: 'known', amountMinor: Number(quote.amount_minor), currency: quote.currency, source: 'provider_quote',
          scope: 'quoted provider price; not realized charge', componentsKnown: 1, componentsTotal: 1 }, reasons: [] });
      const currentManual = await client.query(`SELECT mode,estimated_cost_minor,estimated_cost_currency,eta_at,status FROM rotamoto.delivery_fulfillments
        WHERE company_id=$1 AND delivery_id=$2 AND provider_id=$3 AND mode='external' AND status<>'superseded'
        ORDER BY revision DESC LIMIT 1`, [principal.company_id,deliveryId,row.provider_id]);
      const canManual = row.enabled && (!apiEligible || !validQuotes.length);
      if (canManual) {
        const current = currentManual.rows[0];
        const cost = current?.estimated_cost_minor == null ? { status: 'insufficient_data', reason: 'MANUAL_PRICE_NOT_RECORDED' } :
          { status: 'known', amountMinor: Number(current.estimated_cost_minor), currency: current.estimated_cost_currency,
            source: 'operator_recorded_estimate', scope: 'manual estimate; not realized charge', componentsKnown: 1, componentsTotal: 1 };
        alternatives.push({ id: `manual:${row.provider_id}`, mode: 'external_manual', providerId: row.provider_id, providerName: row.display_name,
          kind: 'manual_operation', eligible: true, availability: { status: 'requires_operator', requiresHumanConfirmation: true },
          etaAt: current?.eta_at || null, etaStatus: current?.eta_at ? 'known_operator_input' : 'unknown', cost,
          reasons: current ? [] : [{ code: 'MANUAL_PRICE_NOT_RECORDED', message: 'Informe uma estimativa manual para comparar este provider.' }] });
      }
      const expired = providerQuotes.filter(quote => ['available','selected'].includes(quote.status) && Date.parse(quote.expires_at) <= now);
      for (const quote of expired.slice(0,3)) alternatives.push({ id: `expired:${quote.quote_id}`, mode: 'external_api', providerId: row.provider_id,
        providerName: row.display_name, kind: 'expired_quote', eligible: false, availability: { status: 'expired' }, etaAt: quote.eta_at,
        etaStatus: quote.eta_at ? 'known_from_expired_quote' : 'unknown', cost: { status: 'insufficient_data', reason: 'QUOTE_EXPIRED' },
        quote: { id: quote.quote_id, expiresAt: quote.expires_at, status: 'expired' }, reasons: [{ code: 'QUOTE_EXPIRED', message: 'Cotação vencida não pode ser comparada como alternativa atual.' }] });
      if (apiEligible && !validQuotes.length && !providerQuotes.some(quote => ['available','selected'].includes(quote.status) && Date.parse(quote.expires_at) <= now))
        alternatives.push({ id: `api:${row.provider_id}`, mode: 'external_api', providerId: row.provider_id, providerName: row.display_name,
          kind: 'api_without_valid_quote', eligible: false, availability: { status: 'quote_required' }, etaAt: null, etaStatus: 'unknown',
          cost: { status: 'insufficient_data', reason: 'VALID_QUOTE_REQUIRED' }, reasons: [{ code: 'VALID_QUOTE_REQUIRED', message: 'Uma cotação válida é necessária para comparar o provider API.' }] });
    }
    const earningResult = await client.query(`SELECT payload->>'amountMinor' AS amount_minor,payload->>'currency' AS currency
      FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Earning' AND deleted_at IS NULL
        AND (payload->>'deliveryId'=$2 OR related_record_id::text=$2)`, [principal.company_id,deliveryId]);
    const payoutByCurrency = new Map();
    for (const row of earningResult.rows) if (/^\d+$/u.test(row.amount_minor || '') && Money.currencyScale(row.currency)) {
      const current = payoutByCurrency.get(row.currency) || 0n; payoutByCurrency.set(row.currency,current+BigInt(row.amount_minor));
    }
    const payout = [...payoutByCurrency.entries()].map(([currency,amount]) => ({ currency,amountMinor:amount.toString(),
      meaning:'canonical Earning / driver payout record; not proof of payment or total operating cost' }));
    const recommendation = makeRecommendation(alternatives,policy);
    const knownCosts = alternatives.filter(item=>item.eligible&&item.cost.status==='known');
    const earliestEta = alternatives.filter(item=>item.eligible&&item.etaAt&&Number.isFinite(Date.parse(item.etaAt)))
      .sort((a,b)=>Date.parse(a.etaAt)-Date.parse(b.etaAt)||a.id.localeCompare(b.id))[0] || null;
    const comparisons = alternatives.map(item=>{
      const sameCurrency = item.eligible&&item.cost.status==='known' ? knownCosts.filter(other=>other.cost.currency===item.cost.currency) : [];
      const cheapest = sameCurrency.length ? [...sameCurrency].sort((a,b)=>a.cost.amountMinor-b.cost.amountMinor||a.id.localeCompare(b.id))[0] : null;
      const deltaEta = item.etaAt&&earliestEta&&Number.isFinite(Date.parse(item.etaAt)) ? Date.parse(item.etaAt)-Date.parse(earliestEta.etaAt) : null;
      return { alternativeId:item.id, ...(cheapest?{costBaselineAlternativeId:cheapest.id,costDifferenceMinor:item.cost.amountMinor-cheapest.cost.amountMinor,currency:item.cost.currency}:{}),
        ...(deltaEta===null?{}:{etaBaselineAlternativeId:earliestEta.id,etaDifferenceMs:deltaEta}) };
    });
    return { deliveryId, policy, alternatives, comparisons, recommendation,
      inputs: { estimatedDistanceM: rawDistanceM, distanceSource, currencyConversion: false,
        commercialOrderValueUsed: false, earningUsedAsTotalCost: false,
        driverPayout: payout, currentTime: clock().toISOString() },
      explanation: { costBasis: 'internal: configured fixed-per-delivery plus variable-per-kilometer estimate; external: valid quote or operator-entered manual estimate',
        limitations: ['Order value/revenue is not logistics cost', 'Earning is a driver payout record and is shown separately',
          'quote and estimates are not realized charges', 'fixed and variable profile covers only the components explicitly configured',
          'fleet/provider capacity is not guaranteed; the operator makes the final decision', 'the recommendation never dispatches'] } };
  }

  async function economicAnalytics(client, principal) {
    const result = await client.query(`WITH latest AS (
      SELECT DISTINCT ON(f.delivery_id) f.delivery_id,f.mode,f.provider_id,p.code,p.display_name,f.status,
        f.estimated_cost_minor,f.estimated_cost_currency,f.final_cost_minor,f.final_cost_currency
      FROM rotamoto.delivery_fulfillments f JOIN rotamoto.logistics_providers p USING(company_id,provider_id)
      WHERE f.company_id=$1 AND f.status<>'superseded' ORDER BY f.delivery_id,f.revision DESC
    ), costs AS (
      SELECT mode,status,count(*)::int AS allocations,
        count(*) FILTER(WHERE estimated_cost_minor IS NOT NULL)::int AS estimated_count,
        count(*) FILTER(WHERE final_cost_minor IS NOT NULL)::int AS realized_count,
        count(*) FILTER(WHERE status='completed')::int AS completed_count,
        COALESCE(jsonb_agg(jsonb_build_object('currency',estimated_cost_currency,'amountMinor',estimated_cost_minor)) FILTER(WHERE estimated_cost_minor IS NOT NULL),'[]'::jsonb) AS estimates,
        COALESCE(jsonb_agg(jsonb_build_object('currency',final_cost_currency,'amountMinor',final_cost_minor)) FILTER(WHERE final_cost_minor IS NOT NULL),'[]'::jsonb) AS realized
      FROM latest GROUP BY mode,status
    ), earning AS (
      SELECT count(DISTINCT d.record_id)::int AS deliveries_with_earning,
        count(DISTINCT d.record_id) FILTER(WHERE e.payload->>'currency' IS NOT NULL)::int AS known,
        COALESCE(jsonb_agg(jsonb_build_object('currency',e.payload->>'currency','amountMinor',e.payload->>'amountMinor')) FILTER(WHERE e.record_id IS NOT NULL),'[]'::jsonb) AS payouts
      FROM latest l JOIN rotamoto.domain_records d ON d.company_id=$1 AND d.record_id=l.delivery_id AND d.entity_type='Delivery'
      LEFT JOIN rotamoto.domain_records e ON e.company_id=d.company_id AND e.entity_type='Earning' AND e.deleted_at IS NULL
        AND (e.payload->>'deliveryId'=d.record_id::text OR e.related_record_id=d.record_id)
      WHERE l.mode='internal'
    ) SELECT COALESCE(jsonb_agg(to_jsonb(costs)),'[]'::jsonb) AS modes,(SELECT to_jsonb(earning) FROM earning) AS earning FROM costs`, [principal.company_id]);
    const settings = await readSettings(client,principal.company_id);
    const modes = result.rows[0]?.modes || [];
    const internalRows = modes.filter(item=>item.mode==='internal'), externalRows=modes.filter(item=>item.mode==='external');
    const summarize = rows => {
      const combine = (field) => {
        const sums=new Map(); for (const row of rows) for (const item of row[field]||[]) if (item.currency && item.amountMinor!==null) {
          const prior=sums.get(item.currency)||{amount:0n,count:0}; sums.set(item.currency,{amount:prior.amount+BigInt(item.amountMinor),count:prior.count+1});
        }
        return [...sums.entries()].map(([currency,value])=>({currency,amountMinor:value.amount.toString(),count:value.count,
          averageAmountMinor:((value.amount+BigInt(Math.floor(value.count/2)))/BigInt(value.count)).toString()})).sort((a,b)=>a.currency.localeCompare(b.currency));
      };
      const total=rows.reduce((n,row)=>n+row.allocations,0),completed=rows.reduce((n,row)=>n+row.completed_count,0),estimated=rows.reduce((n,row)=>n+row.estimated_count,0),realized=rows.reduce((n,row)=>n+row.realized_count,0);
      return { allocations:total,completed,estimatedCount:estimated,realizedCount:realized,
        estimatedCoverage:total?estimated/total:null,realizedCoverage:completed?realized/completed:null,
        estimatedByCurrency:combine('estimates'),realizedByCurrency:combine('realized'),
        limitations:['amounts are grouped by currency; currencies are never summed together','realized means a final cost explicitly reconciled on fulfillment','estimated fulfillment amount may be a provider quote or operator estimate'] };
    };
    const earning=result.rows[0]?.earning||{};
    const payouts=new Map(); for (const item of earning.payouts||[]) if(item.currency&&/^\d+$/u.test(String(item.amountMinor||''))) payouts.set(item.currency,(payouts.get(item.currency)||0n)+BigInt(item.amountMinor));
    const ownFleet=summarize(internalRows);
    return { settings, ownFleet, external:summarize(externalRows),
      driverPayout:{ deliveriesWithEarning:Number(earning.known||0),totalEligibleDeliveries:ownFleet.completed,
        coverage:ownFleet.completed?Number(earning.known||0)/ownFleet.completed:null,
        byCurrency:[...payouts.entries()].map(([currency,amount])=>({currency,amountMinor:amount.toString()})),
        note:'Earning representa repasse canônico calculado; não confirma pagamento nem representa custo total da operação.' },
      comparisonNote:'Diferença entre estimativas não é economia gerada pelo RotaMoto: não existe baseline contrafactual de decisões alternativas.' };
  }
  return Object.freeze({ getIntelligenceSettings:getSettings, updateIntelligenceSettings:updateSettings,
    compareLogisticsAlternatives:compareDelivery, logisticsEconomicAnalytics:economicAnalytics });
}

module.exports = { POLICIES, normalizePolicy, normalizeSettings, estimateInternalCost, makeRecommendation, createLogisticsIntelligenceService };
