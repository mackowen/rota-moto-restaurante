'use strict';
const assert = require('node:assert/strict');
const { buildDecisionQuality } = require('../backend/logistics/decision-quality');
const base={decision_id:'d1',delivery_id:'delivery1',version:2,status:'executed',policy:'lowest_cost',
  recommended_alternative_id:'own',selected_alternative_id:'partner',decided_at:'2026-01-01T10:00:10Z',decided_by:'operator1',evaluated_at:'2026-01-01T10:00:00Z',snapshot:{policyVersion:4,
    alternatives:[{id:'own',mode:'internal',providerName:'Frota própria',eligible:true,decisionCost:{status:'known',amountMinor:500,currency:'BRL'},etaAt:'2026-01-01T10:30:00Z'},
      {id:'partner',mode:'external_api',providerId:'p1',providerName:'Provider',eligible:true,decisionCost:{status:'known',amountMinor:700,currency:'BRL'},etaAt:'2026-01-01T10:40:00Z'}],
    recommendation:{status:'recommended',selectedAlternativeId:'own',why:{code:'LOWEST_KNOWN_AMOUNT',message:'Menor custo'}}},
  outcome_fulfillment_id:'f1',outcome_mode:'external',outcome_provider_id:'p1',outcome_fulfillment_status:'completed',
  outcome_estimated_cost_minor:'700',outcome_estimated_cost_currency:'BRL',outcome_final_cost_minor:'800',outcome_final_cost_currency:'BRL',
  outcome_selected_at:'2026-01-01T10:01:00Z',outcome_attempt_status:'completed',delivery_completed_at:'2026-01-01T10:25:00Z'};
const report=buildDecisionQuality([base],{generatedAt:'2026-01-01T11:00:00Z',limit:1000});
assert.equal(report.metrics.recommendationApproval.rate,0,'human approval of a different option does not count as accepting the recommendation');
assert.equal(report.metrics.humanDivergence.rate,1);
assert.deepEqual(report.decisions[0].estimatedDifferenceBetweenAlternatives,{currency:'BRL',baselineAlternativeId:'own',baselineProviderName:'Frota própria',comparedAlternativeId:'partner',comparedProviderName:'Provider',baselineAmountMinor:500,comparedAmountMinor:700,estimatedDifferenceMinor:200,meaning:'estimated_difference_between_alternatives_at_decision_time'});
assert.equal(report.decisions[0].outcome.absoluteCostErrorMinor,100);
assert.equal(report.decisions[0].policyVersion,4);assert.equal(report.decisions[0].decidedBy,'operator1');assert.equal(report.decisions[0].decidedAt,'2026-01-01T10:00:10Z');
assert.equal(report.decisions[0].outcome.expectedDurationMs,40*60*1000);
assert.equal(report.decisions[0].outcome.observedDurationMs,25*60*1000);
assert.equal(report.metrics.outcomes.succeeded,1);
const noFinal={...base,outcome_final_cost_minor:null,outcome_final_cost_currency:null};
assert.equal(buildDecisionQuality([noFinal]).decisions[0].outcome.absoluteCostErrorMinor,null,'unknown final cost is not zero');
const incompatible={...base,outcome_final_cost_currency:'USD'};
assert.equal(buildDecisionQuality([incompatible]).metrics.estimatedVsFinalCost.comparable,0,'currencies are never converted');
const partial=buildDecisionQuality([base,noFinal]);
assert.equal(partial.metrics.estimatedVsFinalCost.coverage,0.5,'coverage reports partial known cost outcomes');
for(const [finalCost,expected] of [[600,100],[700,0],[400,300]]){
  const known={...base,outcome_final_cost_minor:String(finalCost)};
  assert.equal(buildDecisionQuality([known]).decisions[0].outcome.absoluteCostErrorMinor,expected,'absolute error is unsigned and deterministic for higher/lower/equal final values');
}
const noEta={...base,snapshot:{...base.snapshot,alternatives:base.snapshot.alternatives.map(option=>({...option,etaAt:null}))}};
assert.equal(buildDecisionQuality([noEta]).metrics.etaVsObservedDuration.comparable,0,'missing ETA remains uncovered');
const stale={...base,status:'stale',selected_alternative_id:null,outcome_fulfillment_id:null};
const staleReport=buildDecisionQuality([stale]);
assert.equal(staleReport.decisions[0].outcome.status,'not_executed','stale decision has no fabricated outcome');
assert.equal(staleReport.metrics.outcomes.total,0);
const abstained={...base,status:'proposed',recommended_alternative_id:null,selected_alternative_id:null,snapshot:{recommendation:{status:'insufficient_data',why:{message:'Cobertura insuficiente'}},alternatives:[]},outcome_fulfillment_id:null};
assert.deepEqual(buildDecisionQuality([abstained]).decisions[0].abstentionReasons,['Cobertura insuficiente']);
const accepted={...base,status:'executed',recommended_alternative_id:'partner',selected_alternative_id:'partner'};
assert.equal(buildDecisionQuality([accepted]).metrics.recommendationApproval.rate,1);
const rejected={...base,status:'rejected',selected_alternative_id:null,outcome_fulfillment_id:null};
assert.equal(buildDecisionQuality([rejected]).metrics.recommendationApproval.rate,0,'rejected recommendation remains in the human decision denominator');
for(const [status,expected] of [['failed','failure'],['cancelled','cancelled'],['unknown_outcome','unknown']]){
  assert.equal(buildDecisionQuality([{...base,status,outcome_fulfillment_status:null,outcome_attempt_status:null}]).decisions[0].outcome.status,expected);
}
const historicalSnapshot=structuredClone(base.snapshot);buildDecisionQuality([base]);assert.deepEqual(base.snapshot,historicalSnapshot,'analytics does not rewrite the original recommendation snapshot');
console.log('Decision quality snapshot, outcomes, coverage and comparability checks passed.');
