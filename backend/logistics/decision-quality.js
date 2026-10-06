'use strict';

function finiteTime(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
function snapshotAlternative(decision, id) {
  return (decision.snapshot?.alternatives || []).find(item => item.id === id) || null;
}
function costOf(alternative) {
  const cost = alternative?.decisionCost || alternative?.cost;
  return cost?.status === 'known' && Number.isSafeInteger(Number(cost.amountMinor)) && /^[A-Z]{3}$/u.test(cost.currency || '')
    ? { amountMinor: Number(cost.amountMinor), currency: cost.currency } : null;
}
function classifyOutcome(decision, fulfillment, attemptStatus) {
  if (!['execution_requested','executed','failed','unknown_outcome','cancelled'].includes(decision.status)) return 'not_executed';
  const status = fulfillment?.status || null;
  if (status === 'completed') return 'success';
  if (status === 'failed' || attemptStatus === 'failed' || decision.status === 'failed') return 'failure';
  if (status === 'cancelled' || attemptStatus === 'cancelled' || decision.status === 'cancelled') return 'cancelled';
  if (status === 'unknown' || attemptStatus === 'unknown' || decision.status === 'unknown_outcome') return 'unknown';
  return 'pending';
}
function createBucket() {
  return { count: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0, pending: 0 };
}
function buildDecisionQuality(rows, { generatedAt = new Date().toISOString(), limit = rows.length } = {}) {
  const decisions = rows.map(row => {
    const recommended = snapshotAlternative(row, row.recommended_alternative_id);
    const selected = snapshotAlternative(row, row.selected_alternative_id);
    const recommendedCost = costOf(recommended), selectedCost = costOf(selected);
    const knownAlternatives=(row.snapshot?.alternatives||[]).filter(item=>item.eligible&&costOf(item));
    const pair=(left,right)=>left&&right&&left.id!==right.id&&costOf(left)?.currency===costOf(right)?.currency
      ? { currency:costOf(left).currency,baselineAlternativeId:left.id,baselineProviderName:left.providerName||null,comparedAlternativeId:right.id,comparedProviderName:right.providerName||null,
        baselineAmountMinor:costOf(left).amountMinor,comparedAmountMinor:costOf(right).amountMinor,
        estimatedDifferenceMinor:costOf(right).amountMinor-costOf(left).amountMinor,
        meaning:'estimated_difference_between_alternatives_at_decision_time' } : null;
    const pairwise=[];
    for(let leftIndex=0;leftIndex<knownAlternatives.length;leftIndex++)for(let rightIndex=leftIndex+1;rightIndex<knownAlternatives.length;rightIndex++){
      const comparison=pair(knownAlternatives[leftIndex],knownAlternatives[rightIndex]);if(comparison)pairwise.push(comparison);
    }
    const counterfactual=pair(recommended,selected&&recommended?.id!==selected.id?selected:null) ||
      pair(recommended,knownAlternatives.find(item=>item.id!==recommended?.id)) ||
      (!recommended?pair(knownAlternatives[0],knownAlternatives[1]):null);
    const fulfillment = row.outcome_fulfillment_id ? {
      id: row.outcome_fulfillment_id, mode: row.outcome_mode, providerId: row.outcome_provider_id, status: row.outcome_fulfillment_status,
      estimatedCost: row.outcome_estimated_cost_minor == null ? null : { amountMinor: Number(row.outcome_estimated_cost_minor), currency: row.outcome_estimated_cost_currency },
      finalCost: row.outcome_final_cost_minor == null ? null : { amountMinor: Number(row.outcome_final_cost_minor), currency: row.outcome_final_cost_currency },
      selectedAt: row.outcome_selected_at
    } : null;
    const outcome = classifyOutcome(row, fulfillment, row.outcome_attempt_status);
    const completedAt = row.delivery_completed_at;
    const evaluatedAt = finiteTime(row.evaluated_at), completionTime = finiteTime(completedAt);
    const expectedDurationMs = selected && finiteTime(selected.etaAt) !== null && evaluatedAt !== null && finiteTime(selected.etaAt) >= evaluatedAt
      ? finiteTime(selected.etaAt) - evaluatedAt : null;
    const observedDurationMs = outcome === 'success' && completionTime !== null && evaluatedAt !== null && completionTime >= evaluatedAt
      ? completionTime - evaluatedAt : null;
    const costComparable = selectedCost && fulfillment?.finalCost && selectedCost.currency === fulfillment.finalCost.currency;
    return {
      id: row.decision_id, deliveryId: row.delivery_id, version: Number(row.version), policyVersion: Number.isSafeInteger(Number(row.snapshot?.policyVersion)) ? Number(row.snapshot.policyVersion) : null,
      status: row.status, policy: row.policy, decidedAt: row.decided_at || null, decidedBy: row.decided_by || null,
      evaluatedAt: row.evaluated_at, recommendedAlternative: recommended ? { id: recommended.id, mode: recommended.mode, providerName: recommended.providerName || null, cost: recommendedCost, etaAt: recommended.etaAt || null } : null,
      selectedAlternative: selected ? { id: selected.id, mode: selected.mode, providerName: selected.providerName || null, cost: selectedCost, etaAt: selected.etaAt || null } : null,
      recommendationAccepted: ['approved','execution_requested','executed','failed','unknown_outcome','cancelled'].includes(row.status) && Boolean(recommended && selected && recommended.id === selected.id),
      recommendationDiverged: ['approved','execution_requested','executed','failed','unknown_outcome','cancelled'].includes(row.status) && Boolean(recommended && selected && recommended.id !== selected.id),
      decided: ['approved','rejected','execution_requested','executed','failed','unknown_outcome','cancelled'].includes(row.status),
      outcome: { status: outcome, providerId: fulfillment?.providerId || selected?.providerId || null, mode: fulfillment?.mode || selected?.mode || null,
        fulfillmentStatus: fulfillment?.status || null, attemptStatus: row.outcome_attempt_status || null,
        selectedAt: fulfillment?.selectedAt || null, completedAt: completedAt || null,
        estimatedCost: selectedCost, finalReconciledCost: fulfillment?.finalCost || null,
        absoluteCostErrorMinor: costComparable ? Math.abs(selectedCost.amountMinor - fulfillment.finalCost.amountMinor) : null,
        expectedDurationMs, observedDurationMs },
      estimatedDifferenceBetweenAlternatives: counterfactual,
      estimatedAlternativeDifferences:pairwise,
      abstentionReasons: row.snapshot?.recommendation?.status === 'insufficient_data'
        ? [row.snapshot.recommendation.why?.message || row.snapshot.recommendation.reason || 'Dados insuficientes'] : [],
      snapshot: row.snapshot
    };
  });
  const recommended = decisions.filter(item => item.recommendedAlternative);
  const decidedRecommendations = recommended.filter(item => item.decided);
  const approved = decisions.filter(item => item.status === 'approved' || ['execution_requested','executed','failed','unknown_outcome','cancelled'].includes(item.status));
  const comparableApprovals = approved.filter(item => item.recommendedAlternative && item.selectedAlternative);
  const outcomes = decisions.filter(item => item.outcome.status !== 'not_executed');
  const costComparable = decisions.filter(item => item.outcome.absoluteCostErrorMinor !== null);
  const etaComparable = decisions.filter(item => item.outcome.expectedDurationMs !== null && item.outcome.observedDurationMs !== null);
  const byAlternative = new Map();
  for (const item of outcomes) {
    const alternative = item.selectedAlternative;
    const key = alternative?.id || 'unknown';
    const bucket = byAlternative.get(key) || { alternativeId: key, mode: alternative?.mode || null, providerName: alternative?.providerName || null, ...createBucket() };
    bucket.count += 1; bucket[item.outcome.status === 'success' ? 'succeeded' : item.outcome.status === 'failure' ? 'failed' : item.outcome.status] += 1;
    byAlternative.set(key, bucket);
  }
  return {
    generatedAt, sample: { returned: decisions.length, limit, truncated: decisions.length >= limit && limit > 0 },
    metrics: {
      recommendations: recommended.length, decidedRecommendations: decidedRecommendations.length,
      recommendationApproval: { numerator: decidedRecommendations.filter(item => item.recommendationAccepted).length, denominator: decidedRecommendations.length,
        rate: decidedRecommendations.length ? decidedRecommendations.filter(item => item.recommendationAccepted).length / decidedRecommendations.length : null },
      humanDivergence: { numerator: comparableApprovals.filter(item => item.recommendationDiverged).length, denominator: comparableApprovals.length,
        rate: comparableApprovals.length ? comparableApprovals.filter(item => item.recommendationDiverged).length / comparableApprovals.length : null },
      outcomes: { total: outcomes.length, succeeded: outcomes.filter(item => item.outcome.status === 'success').length,
        failed: outcomes.filter(item => item.outcome.status === 'failure').length, cancelled: outcomes.filter(item => item.outcome.status === 'cancelled').length,
        unknown: outcomes.filter(item => item.outcome.status === 'unknown').length, pending: outcomes.filter(item => item.outcome.status === 'pending').length },
      estimatedVsFinalCost: { comparable: costComparable.length, coverage: outcomes.length ? costComparable.length / outcomes.length : null,
        absoluteErrorMinorByCurrency: [...new Set(costComparable.map(item => item.selectedAlternative.cost.currency))].map(currency => {
          const matching = costComparable.filter(item => item.selectedAlternative.cost.currency === currency);
          return { currency, count: matching.length, averageAbsoluteErrorMinor: Math.round(matching.reduce((sum, item) => sum + item.outcome.absoluteCostErrorMinor, 0) / matching.length) };
        }) },
      etaVsObservedDuration: { comparable: etaComparable.length, coverage: outcomes.length ? etaComparable.length / outcomes.length : null,
        averageAbsoluteErrorMs: etaComparable.length ? Math.round(etaComparable.reduce((sum, item) => sum + Math.abs(item.outcome.expectedDurationMs - item.outcome.observedDurationMs), 0) / etaComparable.length) : null },
      byAlternative: [...byAlternative.values()],
      byPolicy: [...new Set(decisions.map(item => item.policy))].sort().map(policy => ({ policy, decisions: decisions.filter(item => item.policy === policy).length,
        recommendations: recommended.filter(item => item.policy === policy).length,
        abstentions: decisions.filter(item => item.policy === policy && !item.recommendedAlternative).length }))
    },
    decisions
  };
}

module.exports = { buildDecisionQuality };
