-- Return only memberships belonging to the user authenticated by this live session.
-- The SECURITY DEFINER boundary is needed because normal tenant RLS intentionally
-- prevents a client from enumerating memberships in other companies.
CREATE FUNCTION rotamoto.identity_company_options(target_session_digest bytea)
RETURNS TABLE(company_id text, company_name text, membership_status text, company_status text,
  is_active boolean, can_switch boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
  SELECT c.id::text,c.name,m.status,c.status,(c.id=s.active_company_id),
    (m.status='active' AND c.status='active')
  FROM rotamoto.sessions s
  JOIN rotamoto.memberships m ON m.user_id=s.user_id
  JOIN rotamoto.companies c ON c.id=m.company_id
  WHERE s.token_digest=target_session_digest
    AND s.revoked_at IS NULL AND s.idle_expires_at>now() AND s.absolute_expires_at>now()
  ORDER BY (c.id=s.active_company_id) DESC,c.name,c.id
$$;
REVOKE ALL ON FUNCTION rotamoto.identity_company_options(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.identity_company_options(bytea) TO rotamoto_app;
