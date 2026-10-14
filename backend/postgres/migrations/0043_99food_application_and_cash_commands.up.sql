-- Preserve only the minimal, allow-listed data needed to answer 99Food
-- cancellation/refund callbacks and acknowledge documented cash collection.
ALTER TABLE rotamoto.marketplace_event_inbox
  DROP CONSTRAINT marketplace_event_inbox_event_data_check,
  ADD CONSTRAINT marketplace_event_inbox_event_data_check CHECK (
    jsonb_typeof(event_data)='object' AND
    event_data - ARRAY['id','orderId','eventType','status','occurredAt','externalStatus','code','fullCode','createdAt','kind','application']::text[] = '{}'::jsonb
  );

ALTER TABLE rotamoto.marketplace_command_outbox
  DROP CONSTRAINT marketplace_command_outbox_operation_check,
  ADD CONSTRAINT marketplace_command_outbox_operation_check CHECK (operation IN
    ('CONFIRM','START_PREPARATION','READY','DISPATCH_MERCHANT','CANCEL_ORDER','SHIPPING_QUOTE','SHIPPING_REQUEST',
     'SHIPPING_CANCEL','SHIPPING_TRACKING','RECONCILE','CANCEL_REQUEST','REFUND_REQUEST','DELIVERED','CONFIRM_CASH_PAYMENT'));

COMMENT ON COLUMN rotamoto.marketplace_event_inbox.event_data IS
  'PII-minimized normalized provider event data; 99Food application metadata contains only apply ID and bounded reason choices, never raw payloads or evidence URLs.';
