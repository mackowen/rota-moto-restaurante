'use strict';

const TRANSITIONS = Object.freeze({
  DELIVERY_RETURN_STARTED: Object.freeze({ from: 'ASSIGNED', to: 'OUT_FOR_DELIVERY' }),
  DELIVERY_RETURN_ARRIVED: Object.freeze({ from: 'OUT_FOR_DELIVERY', to: 'ARRIVED' }),
  DELIVERY_RETURN_HANDED_OVER: Object.freeze({ from: 'ARRIVED', to: null })
});

function validateReturnEvent({ type, deliveryType, status, custodyState, expectedVersion, canonicalVersion }) {
  const transition = TRANSITIONS[type];
  if (!transition) return null;
  if (deliveryType !== 'RETURN') return { error: 'FORBIDDEN_EVENT', message: 'Ação de retorno só pode ser registrada em uma Delivery RETURN.' };
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== Number(canonicalVersion))
    return { error: 'REVISION_CONFLICT', message: 'A devolução mudou; sincronize antes de registrar a ação.' };
  if (status !== transition.from)
    return { error: 'INVALID_TRANSITION', message: `Ação de retorno incompatível com ${status}.` };
  if (type === 'DELIVERY_RETURN_HANDED_OVER' && ['RECEIVED', 'AWAITING_RESTAURANT_RECEIPT'].includes(custodyState))
    return { error: 'INVALID_TRANSITION', message: custodyState === 'RECEIVED'
      ? 'A custódia da devolução já foi encerrada.' : 'A entrega física já foi registrada; aguarde confirmação do Restaurante.' };
  return { transition, custodyState: type === 'DELIVERY_RETURN_HANDED_OVER'
    ? 'AWAITING_RESTAURANT_RECEIPT' : custodyState };
}

module.exports = { TRANSITIONS, validateReturnEvent };
