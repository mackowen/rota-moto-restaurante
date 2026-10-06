# Roles de runtime para provider externo

Estas roles são identidades de serviço separadas. Nunca usar `rotamoto_migrator` como runtime e nunca conceder `secret_ref` para `rotamoto_app` ou `rotamoto_provider_worker`.

Antes de iniciar os serviços, um DBA provisiona no cluster:

```sql
CREATE ROLE rotamoto_provider_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE rotamoto_provider_resolver LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
```

Configure a senha de cada role por `\password rotamoto_provider_worker` e `\password rotamoto_provider_resolver` em `psql` interativo, sem colocá-la no shell history, URL, Git ou logs. Grave cada senha no secret store externo e forneça ao serviço apenas os `*_PASSWORD_REF` autorizados.

Depois de criar as roles, reaplique os grants mínimos usando uma conexão administrativa segura:

```sh
psql -X -v ON_ERROR_STOP=1 -d rotamoto -f backend/postgres/admin/provider-runtime-grants.sql
```

Migration 0023 aplica esses grants condicionalmente quando as roles já existem e revoga o claim de `rotamoto_app`. Se o schema já está em 0023 e as roles foram criadas depois, o arquivo acima reaplica as permissões. Confira as ACLs por coluna/função antes de ligar o worker.

O worker exige `ROTAMOTO_PROVIDER_WORKER_ENABLED=true`, URLs sem senha para as roles dedicadas, refs de senha no secret provider e allowlist tenant explícita. O resolver abre transação, define `app.tenant_id`, verifica `current_user=rotamoto_provider_resolver`, lê somente o `secret_ref` do provider ativo e resolve o conteúdo no secret provider. O app HTTP nunca recebe a conexão resolver.

O provider continua fail-closed com `api_enabled=false` sem credencial/configuração comercial. Provisionar roles não autoriza tráfego iFood. A configuração requer vínculo/eligibilidade/contrato/homologação e procedimento de ativação separado. O script `start:provider-worker` não foi executado nesta campanha.
