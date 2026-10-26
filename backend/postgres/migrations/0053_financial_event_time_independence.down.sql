ALTER TABLE rotamoto.financial_events ADD CONSTRAINT financial_events_check6 CHECK (occurred_at<=created_at);
