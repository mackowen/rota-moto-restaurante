-- Do not mistake an existing installation for a first-install bootstrap just
-- because the deployment latch was introduced after its original provisioning.
UPDATE rotamoto.installation_bootstrap
SET completed_at=coalesce(completed_at,now()),
    request_digest=coalesce(request_digest,decode(repeat('00',32),'hex'))
WHERE singleton=true
  AND (EXISTS (SELECT 1 FROM rotamoto.companies)
    OR EXISTS (SELECT 1 FROM rotamoto.provisioning_requests));
