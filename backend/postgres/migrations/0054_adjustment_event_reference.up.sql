ALTER TABLE rotamoto.financial_events DROP CONSTRAINT financial_events_check2;
ALTER TABLE rotamoto.financial_events ADD CONSTRAINT financial_events_reference_kind_check CHECK (
  (event_kind='REFUND' AND related_event_id IS NOT NULL AND amount_minor>0) OR
  (event_kind='ADJUSTMENT' AND related_event_id IS NOT NULL) OR
  (event_kind IN ('PAYMENT_CONFIRMED','PAYOUT_SETTLED') AND related_event_id IS NULL)
);
