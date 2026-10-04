REVOKE DELETE ON TABLE rotamoto.role_permissions FROM rotamoto_app;
REVOKE UPDATE (display_name, updated_at) ON TABLE rotamoto.roles FROM rotamoto_app;
-- Mantém membership_invitation no CHECK para preservar registros e futuras
-- auditorias já criadas e mantém mfa_verified_at para não invalidar a informação
-- de sessão em uso. São expansões de schema compatíveis e inertes sem API.
