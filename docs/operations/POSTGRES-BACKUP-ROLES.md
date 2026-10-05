# Provisionamento DBA das roles de backup

Este procedimento é uma operação PostgreSQL privilegiada e não é executado por
migration nem pelo runtime. Não conceda atributo/grants de backup a
`rotamoto_app` ou `rotamoto_migrator`. Preserve `ENABLE/FORCE ROW LEVEL
SECURITY` em todas as tabelas.

O DBA cria as duas roles sem senha na linha de comando e define credenciais pelo
prompt `\password`; as entradas correspondentes ficam no pgpass restrito do
operador do backup/restore. Não registrar o conteúdo no ticket ou shell history.

```sql
CREATE ROLE rotamoto_backup LOGIN BYPASSRLS;
CREATE ROLE rotamoto_restore LOGIN BYPASSRLS;
```

Como DBA, limitar leitura de backup ao database operacional:

```sql
GRANT CONNECT ON DATABASE rotamoto TO rotamoto_backup;
\connect rotamoto
GRANT USAGE ON SCHEMA rotamoto TO rotamoto_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA rotamoto TO rotamoto_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA rotamoto TO rotamoto_backup;
```

Como `rotamoto_migrator`, registrar grants para objetos futuros sem atribuir
propriedade ou DDL ao backup:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA rotamoto
  GRANT SELECT ON TABLES TO rotamoto_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA rotamoto
  GRANT SELECT ON SEQUENCES TO rotamoto_backup;
```

Para rehearsal, criar um database explicitamente descartável vazio e atribuir
somente ele ao restore:

```sql
CREATE DATABASE rotamoto_disposable_rehearsal OWNER rotamoto_restore;
```

Não conceder `CREATEDB`, `CREATEROLE`, membership em roles de aplicação ou
ownership sobre database `rotamoto` a nenhuma dessas roles. `rotamoto_restore`
não recebe grants em `rotamoto`; a role existe para BYPASSRLS durante carga
forçada do artefato validado no database descartável. Registre owner/attributes,
ACL das databases e RLS/FORCE após provisionar. Restrinja pgpass e arquivos de
backup, e remova/revogue as roles com o DBA depois do ensaio se a política
operacional não for mantê-las.

O runtime continua `NOBYPASSRLS`; não desligar RLS, não alterar FORCE e não
adicionar exceção de policy para backup. Se o restore exigir privilégios além
do database descartável, interromper e fazer a operação por procedimento DBA,
sem ampliar o acesso das roles runtime.
