ALTER TABLE rotamoto.provisioning_requests
  ADD CONSTRAINT provisioning_requests_membership_fk
  FOREIGN KEY (company_id, user_id)
  REFERENCES rotamoto.memberships(company_id, user_id)
  ON DELETE RESTRICT;
