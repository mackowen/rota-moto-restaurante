# Roles de runtime para provider externo

Estas roles são identidades de serviço separadas. Nunca usar `rotamoto_migrator` como runtime e nunca conceder `secret_ref` para `rotamoto_app` ou `rotamoto_provider_worker`.

## Descoberta administrativa e bootstrap idempotente

Não assuma que a role administrativa se chama `postgres`. No Termux ela pode ter o nome do usuário que inicializou o cluster. Primeiro descubra o alvo pelo serviço/configuração local e conecte-se usando o credential store autorizado. Autentique interativamente, sem senha na URL, argumento ou variável:

```sh
pg_isready -h 127.0.0.1 -p 5432
psql -X -W -h 127.0.0.1 -p 5432 -U <role-administrativa-comprovada> -d rotamoto
```

Na sessão autenticada, confirme `current_user=session_user`, atributo administrativo em `pg_roles`, versão, database/schema/table owners, memberships e roles de runtime. O UID do processo PostgreSQL não prova sozinho a senha de login, e uma falha da role `postgres` não prova ausência de administrador. Nunca enfraqueça `pg_hba.conf` para `trust` nem redefina credenciais sem procedimento administrativo autorizado.

Com a role administrativa comprovada, execute o bootstrap versionado e idempotente:

```sh
psql -X -W -v ON_ERROR_STOP=1 -d rotamoto -f backend/postgres/admin/provider-runtime-role-bootstrap.sql
```

O script exige sessão superuser, cria apenas roles ausentes e falha fechado se as existentes tiverem atributos inesperados ou memberships. Ele não contém senha. Em `psql` interativo, configure cada senha usando `\password rotamoto_provider_resolver` e `\password rotamoto_provider_worker`; persista as credenciais somente no secret provider autorizado, acessível por refs ao serviço. Nenhuma senha deve aparecer em shell history, URL, Git, log ou registro de campanha.

## Ordem operacional para installer

1. Preflight do processo, versão, data directory, socket/host/port, `pg_hba.conf`, `pg_isready`, owners, roles e memberships; descobrir a role admin por catálogo.
2. Autenticar com credencial administrativa existente e executar o bootstrap idempotente das roles de aplicação/runtime. Migrator continua `NOCREATEROLE`/`NOBYPASSRLS`.
3. Inicializar/configurar secret provider e referências das credenciais de worker/resolver. URL PostgreSQL permanece sem senha; Client/Pool recebe password callback resolvido no boundary autorizado.
4. Configurar paths privados de mídia, backup, chave CSPRNG e auditoria; validar owner, modo e separação entre raízes. Backup/migration local não exigem `PUBLIC_BASE_URL`; callback OAuth/webhook público exige HTTPS de deployment.
5. Executar `backup:create` e `backup:verify` para o database oficial e registrar o recovery set sanitizado antes de qualquer DDL.
6. Aplicar migrations pelo runner oficial; reaplicar `provider-runtime-grants.sql` após o bootstrap e migrations.
7. Validar ledgers/checksums, RLS/FORCE, policies, owners e ACL/security parity entre oficial e E2E.
8. Provar conexões `current_user` efetivas e isolamento como resolver/worker, sem migrator substituto; só então iniciar serviços/worker e scheduler.

Depois de criar as roles e aplicar migrations, reaplique os grants mínimos usando uma conexão administrativa segura:

```sh
psql -X -v ON_ERROR_STOP=1 -d rotamoto -f backend/postgres/admin/provider-runtime-grants.sql
```

As migrations 0023 e 0035–0038 aplicam grants condicionalmente quando as roles já existem. Se as roles forem criadas depois das migrations, reaplique `provider-runtime-grants.sql` em cada database: ele concede CONNECT somente ao database corrente, `current_tenant_id()` para as policies RLS e grants de logistics/marketplace, incluindo a projeção restrita de `logistics_decisions` e o status de reautorização. O worker não pode ler `external_accounts.secret_ref` nem tabelas de verifier OAuth. O resolver é o único runtime que lê/escreve referências de segredo e limpa os verifiers one-shot. Confira as ACLs por coluna/função antes de ligar os serviços.

O worker exige `ROTAMOTO_PROVIDER_WORKER_ENABLED=true`, URLs sem senha para as roles dedicadas, refs de senha no secret provider e allowlist tenant explícita. O resolver abre transação, define `app.tenant_id`, verifica `current_user=rotamoto_provider_resolver`, lê somente o `secret_ref` do provider ativo e resolve o conteúdo no secret provider. O app HTTP nunca recebe a conexão resolver.

O provider continua fail-closed com `api_enabled=false` sem credencial/configuração comercial. Provisionar roles não autoriza tráfego iFood. A configuração requer vínculo/eligibilidade/contrato/homologação e procedimento de ativação separado. O script `start:provider-worker` não foi executado nesta campanha.
