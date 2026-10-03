# Runbook — DBA, migrator e runtime PostgreSQL

Preparação versionada; **não executar automaticamente**. Este procedimento foi
preparado após auditoria read-only do PostgreSQL oficial 18.6 em
`127.0.0.1:5432/rotamoto`. O script `role-split.sql` exige uma sessão superuser
`u0_a436`, mas o comando não inclui senha. O backend HTTP continua conectando
como `rotamoto_app`; `rotamoto_migrator` é somente para migrations e DDL.

## Inventário observado

- Database `rotamoto`: owner atual `rotamoto_app`, ACL nula (ACL padrão); a
  role runtime tem CONNECT, CREATE e TEMP, inclusive CREATE efetivo em `public`
  pelo papel especial `pg_database_owner`.
- Schemas não sistêmicos: `public` (owner `pg_database_owner`) e `rotamoto`
  (owner `rotamoto_app`). O runtime tem USAGE e CREATE em `rotamoto`.
- Schema `rotamoto`: 18 tabelas, todas atualmente owned por `rotamoto_app`;
  inclui `schema_migrations`. Não existem sequences, views ou materialized
  views. Há as funções `current_tenant_id()` e
  `guard_audit_log_immutable()` e um trigger append-only em `audit_log`.
- Dez tabelas de tenant possuem policy `tenant_isolation`, RLS enabled e
  `FORCE ROW LEVEL SECURITY`. Nenhuma migration precisa ser editada e o script
  não modifica o ledger ou as policies.
- Não há default privileges personalizados no schema. Não há membership de
  `rotamoto_app` em outra role; os únicos logins observados eram `u0_a436` e
  `rotamoto_app`.
- A API atual usa SELECT/INSERT/UPDATE, com INSERT append-only em `audit_log`;
  não emite DELETE nem precisa do ledger. O script não concede acesso runtime
  às tabelas de integrações/sync ainda não usadas pelo servidor.

## Checklist antes da execução

1. Confirmar que o alvo continua sendo a instância oficial, database
   `rotamoto`, host `127.0.0.1`, porta `5432`, versão 18.6.
2. Agendar janela curta e parar o serviço HTTP e qualquer runner de migration;
   isso evita requests concorrentes durante a troca de owners/grants.
3. Fazer e validar um **dump completo** usando a sessão DBA `u0_a436`, que pode
   ler as tabelas mesmo com RLS forced. Guardar fora do Git, em diretório
   privado, modo 0600. Exemplo (a autenticação deve pedir a senha no terminal;
   nunca passe senha como argumento ou variável):

   ```sh
   mkdir -p "$HOME/projetos/db-checkpoints"
   chmod 700 "$HOME/projetos/db-checkpoints"
   pg_dump -Fc -W -h 127.0.0.1 -p 5432 -U u0_a436 -d rotamoto \
     -f "$HOME/projetos/db-checkpoints/rotamoto-pre-role-split.dump"
   chmod 600 "$HOME/projetos/db-checkpoints/rotamoto-pre-role-split.dump"
   pg_restore --list "$HOME/projetos/db-checkpoints/rotamoto-pre-role-split.dump" >/dev/null
   ```

   Conferir também tamanho não nulo e retenção/cópia segura. O dump parcial
   `.incomplete` do Registro 0031 não serve para este procedimento.
4. Revisar `role-split.sql` e confirmar que as queries prévias ainda retornam
   o inventário acima. O script aborta se owners, logins, memberships ou RLS
   tiverem divergido.
5. A senha de `u0_a436` será solicitada pelo `-W` no terminal. Não compartilhar
   a senha nem capturar a entrada em log/transcript.

## Execução manual

No checkout validado do Restaurante, executar exatamente:

```sh
psql -X -W -v ON_ERROR_STOP=1 -v checkpoint_confirmed=on \
  -h 127.0.0.1 -p 5432 -U u0_a436 -d rotamoto \
  -f backend/postgres/admin/role-split.sql
```

O `ALTER DATABASE ... OWNER` fica fora da transação porque PostgreSQL não
permite essa forma em transaction block. Ele transfere o database para o DBA
de emergência antes da transação. Roles, owners de objetos, ACLs, RLS e
postconditions restantes ficam numa transação; erro nela reverte essa parte e
o `ON_ERROR_STOP` termina o psql. Se isso acontecer, o owner do database pode
já ser `u0_a436`, enquanto schema/tabelas/API continuam no estado anterior;
inspecione, não repita às cegas.

Depois do sucesso, abra uma sessão psql interativa (a senha de `u0_a436` será
solicitada no terminal):

```sh
psql -X -W -h 127.0.0.1 -p 5432 -U u0_a436 -d rotamoto
```

No prompt psql, defina a senha do migrator sem colocá-la no comando, histórico,
variável ou arquivo do projeto:

```text
\password rotamoto_migrator
```

O psql solicita e confirma a senha sem ecoá-la. A senha nunca deve ser enviada
ao Codex. Para uso local futuro do runner, disponibilize essa credencial apenas
por mecanismo local aprovado (por exemplo `.pgpass` modo 0600, editado sem
imprimir o segredo); não a exporte no ambiente do servidor HTTP.

## Queries pós-execução

Executar como `u0_a436` e conferir os resultados esperados:

```sql
SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
       r.rolbypassrls, r.rolinherit
FROM pg_roles r
WHERE r.rolname IN ('u0_a436','rotamoto_migrator','rotamoto_app')
ORDER BY r.rolname;

SELECT datname, pg_get_userbyid(datdba) AS owner,
       has_database_privilege('rotamoto_app', oid, 'CONNECT') AS app_connect,
       has_database_privilege('rotamoto_app', oid, 'CREATE') AS app_create,
       has_database_privilege('rotamoto_app', oid, 'TEMP') AS app_temp,
       has_database_privilege('rotamoto_migrator', oid, 'CREATE') AS migrator_create
FROM pg_database WHERE datname='rotamoto';

SELECT nspname, pg_get_userbyid(nspowner) AS owner,
       has_schema_privilege('rotamoto_app', oid, 'USAGE') AS app_usage,
       has_schema_privilege('rotamoto_app', oid, 'CREATE') AS app_create
FROM pg_namespace WHERE nspname IN ('rotamoto','public') ORDER BY nspname;

SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity, c.relforcerowsecurity,
       has_table_privilege('rotamoto_app', c.oid, 'SELECT') AS app_select,
       has_table_privilege('rotamoto_app', c.oid, 'INSERT') AS app_insert,
       has_table_privilege('rotamoto_app', c.oid, 'UPDATE') AS app_update,
       has_table_privilege('rotamoto_app', c.oid, 'DELETE') AS app_delete,
       has_table_privilege('rotamoto_app', c.oid, 'TRUNCATE') AS app_truncate
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p') ORDER BY c.relname;

SELECT s.relname AS sequence, pg_get_userbyid(s.relowner) AS owner,
       s.relacl
FROM pg_class s JOIN pg_namespace n ON n.oid=s.relnamespace
WHERE n.nspname='rotamoto' AND s.relkind='S';

SELECT p.tablename, p.policyname, p.roles, p.cmd,
       c.relrowsecurity, c.relforcerowsecurity
FROM pg_policies p JOIN pg_namespace n ON n.nspname=p.schemaname
JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=p.tablename
WHERE p.schemaname='rotamoto' ORDER BY p.tablename,p.policyname;

SELECT n.nspname, p.proname, pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef, p.proacl
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='rotamoto' ORDER BY p.proname;

SELECT c.relname, t.tgname, t.tgenabled,
       pg_get_triggerdef(t.oid, true) AS definition
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='rotamoto' AND NOT t.tgisinternal;

SELECT d.defaclrole::regrole AS creator, n.nspname, d.defaclobjtype, d.defaclacl
FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
WHERE d.defaclrole='rotamoto_migrator'::regrole ORDER BY 2,3;

SELECT migration_id, checksum_sha256, applied_at
FROM rotamoto.schema_migrations ORDER BY migration_id;
```

Esperado: database owner `u0_a436`; schema/18 tabelas/duas funções owned por
`rotamoto_migrator`; runtime CONNECT e USAGE sem CREATE/TEMP/DDL; ledger sem
grant para runtime e ainda com as mesmas quatro migrations/checksums; dez
policies tenant com RLS enabled/forced; API grants apenas nas tabelas da
identidade; auditoria somente INSERT; defaults sem grants para PUBLIC/runtime.
Nenhuma migration é executada pelo script.

Depois, teste uma conexão Node da API com `DATABASE_URL` autenticando
`rotamoto_app` e `migrate.js status` com `MIGRATOR_DATABASE_URL` apontando a
`rotamoto_migrator`. A suíte `npm run test:postgres` requer as duas URLs e
separa operações de DDL/fixtures dos testes de privilégio runtime.

## Rollback de emergência

É tecnicamente possível restaurar o modelo anterior, mas isso reabre a falha
de segurança. Use somente para recuperar a aplicação, com o HTTP e migrations
parados, checkpoint completo e decisão operacional explícita. Não reverta após
migrations novas criarem objetos sem auditar sua ownership.

Como `ALTER DATABASE OWNER` não é transacional, a reversão exige duas etapas:

1. Como superuser, numa transação, revogar os grants runtime/migrator,
   transferir tabelas/sequences/functions/types e o schema de volta para
   `rotamoto_app`, remover os default privileges criados para
   `rotamoto_migrator` e restaurar os grants de database/schema anteriores.
   Preservar RLS/FORCE e o ledger; não usar `DROP OWNED`/`CASCADE`.
2. Depois do commit dessa transação, executar fora dela
   `ALTER DATABASE rotamoto OWNER TO rotamoto_app;` e restaurar CONNECT/TEMP
   de PUBLIC se a reversão precisar reproduzir exatamente o ACL anterior.
   Manter `rotamoto_migrator` como `NOLOGIN` até revisão; não apagar role nem
   senha automaticamente.

Se qualquer owner/grant não corresponder ao estado esperado, interrompa e
restaure do checkpoint sob procedimento DBA; não improvise rollback parcial.
