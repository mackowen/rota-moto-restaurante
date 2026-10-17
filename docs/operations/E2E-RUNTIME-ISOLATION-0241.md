# Runtime E2E e reset da instalação — Campanha 0241

## Papel do processo HTTP

A API de homologação usa `rotamoto_e2e_app` como `session_user`. Essa role tem `LOGIN`, `NOINHERIT`, `NOBYPASSRLS`, não possui capacidades administrativas e tem `CONNECT` somente no banco `rotamoto_e2e`. Ela é membro de `rotamoto_app` com herança desabilitada e opção `SET` habilitada. O processo HTTP inicia a sessão PostgreSQL com `options=-c role=rotamoto_app`; isso preserva as políticas RLS existentes sem conceder à role de login acesso ao banco oficial.

O serviço runit `rotamoto-api-e2e` deve definir:

```sh
NODE_ENV=test
HOST=127.0.0.1
PORT=8787
ROTAMOTO_E2E_RUNTIME_ROLE=rotamoto_e2e_app
E2E_RUNTIME_DATABASE_URL=postgresql://rotamoto_e2e_app@127.0.0.1:5432/rotamoto_e2e
```

As credenciais PostgreSQL permanecem em `~/.pgpass` modo `0600`. Senhas não devem ser incluídas na URL ou no arquivo runit. No startup a API valida `current_database()`, `current_user` e `session_user` antes de abrir o listener.

## Reset controlado

O script `scripts/reset-e2e-installation.js` está guardado para `NODE_ENV=test`, campanha `0241`, banco loopback `rotamoto_e2e`, role `rotamoto_migrator` e confirmação literal `ROTAMOTO_E2E_RESET_0241_CONFIRMED`. Ele para a API E2E, recusa conexões concorrentes, verifica as 47 migrations e os checksums, compara a estrutura operacional, RLS, políticas, grants, funções, constraints, índices e triggers, e registra eventos sanitizados fora do repositório.

Os schemas de campanha com nome validado e propriedade do migrator são removidos individualmente com `DROP SCHEMA ... CASCADE` em transações separadas, comparando a estrutura operacional antes de cada commit. A limpeza das tabelas operacionais e o reset do latch são aplicados juntos em uma transação com `TRUNCATE ... RESTRICT`. O ledger `schema_migrations`, a tabela `permissions` e o singleton `installation_bootstrap` são preservados. Uma tentativa concluída não pode ser repetida pela mesma campanha.

Não executar o reset contra `rotamoto`, nem em `NODE_ENV=development` ou `production`. Não execute o Bootstrap durante este procedimento. Backups autenticados e a lista privada das 135 referências sintéticas descartadas ficam somente em `~/rotamoto-data/development/` e nunca devem ser copiados para Git.
