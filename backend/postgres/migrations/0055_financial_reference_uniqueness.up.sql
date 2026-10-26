CREATE UNIQUE INDEX financial_events_reference_uq
  ON rotamoto.financial_events (
    company_id,
    event_kind,
    (CASE WHEN order_id IS NULL THEN 'earning' ELSE 'order' END),
    (COALESCE(order_id, earning_id)),
    (lower(btrim(reference)))
  ) WHERE event_kind IN ('PAYMENT_CONFIRMED','REFUND','PAYOUT_SETTLED');
