# Runbook — backup e restore

Os procedimentos abaixo ainda não foram ensaiados em ambiente de produção. O
PostgreSQL e Termux existentes são desenvolvimento/homologação. Nunca tratar um
dump interrompido, parcial ou não listado por `pg_restore` como backup válido.

## PostgreSQL

### Backup

1. Operador autorizado confirma host/database, espaço, janela e política de
   retenção. Para tabelas com RLS forced, usar papel de backup aprovado que
   consiga ler todo o escopo; a role runtime `rotamoto_app` não é papel de
   backup e não se deve desabilitar RLS para contornar essa restrição.
2. Escolher destino privado fora do Git com diretório `0700` e arquivo `0600`.
   Credencial vem exclusivamente do mecanismo do operador, nunca argumento,
   variável impressa ou transcript.
3. Criar dump custom-format e verificar código de saída, tamanho, checksum e
   listagem do TOC. Documentar database/server version, timestamp, migration
   status e identidade do operador sem registrar secrets.

Exemplo de forma (placeholders não são valores operacionais):

```sh
umask 077
pg_dump --format=custom --no-password \
  --host="$PGHOST" --port="$PGPORT" --username="$BACKUP_ROLE" \
  --dbname="$PGDATABASE" --file="$BACKUP_FILE"
test -s "$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" >/dev/null
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"
chmod 600 "$BACKUP_FILE" "$BACKUP_FILE.sha256"
```

Não definir `PGPASSWORD`; `--no-password` faz a operação falhar se o
credential store aprovado não resolver autenticação sem prompt. Arquivos de
globals/roles são artefatos separados, altamente restritos, aprovados pelo DBA;
não restaurar globals cegamente nem mudar ownership/grants existentes. Backup
contém PII e pode conter dados operacionais sensíveis.

### Restore de ensaio

1. Verificar checksum e `pg_restore --list`; rejeitar artefato incompleto.
2. Restaurar em instância/database descartável isolada com versões compatíveis,
   roles e owners previamente criados por procedimento aprovado. Não usar o
   database oficial como alvo de ensaio.
3. Validar migration ledger/checksum com `migrate.js status` usando migrator;
   validar owners/grants com DBA; verificar RLS ENABLE/FORCE e policies;
   conectar como runtime e testar readiness/default-deny/cross-tenant.
4. Comparar contagens e invariantes sem imprimir payload/PII; registrar duração,
   tamanho, resultado e RPO/RTO observado.

### Restore operacional

Somente com incidente declarado, change approval e checkpoint do alvo atual.
Parar writers, restaurar em alvo isolado primeiro, reconciliar replicação/sync,
verificar ownership, roles, ledger, RLS e smoke de aplicação; trocar tráfego
depois de aprovação. Nunca desabilitar RLS nem elevar runtime para restaurar.
RPO/RTO e política de PITR/WAL permanecem decisão operacional pendente.

## Backup IndexedDB / Local-First

- Formato `rotamoto-local-backup` v1 registra app, data, versão do schema e
  snapshot das stores conhecidas; import valida formato e faz merge aditivo,
  mantendo as linhas atuais em colisão. Não é restore destrutivo nem snapshot
  transacional entre abas.
- Inclui dados de negócio, PII, endereços, localização, provas/mídia local,
  histórico, tombstones, aliases, inbox/outbox, syncState e conflitos conforme
  stores exportadas. Segredos de autenticação são removidos; senha, sessão,
  cookie, CSRF, MFA e credenciais não fazem parte do backup.
- O JSON é plaintext sensível. Guardar em local privado, controlar cópias e
  apagar segundo política aprovada. Export cifrado permanece bloqueado até haver
  escolha explícita de UX/chave e implementação criptográfica revisável.
- Antes da importação, validar app/formato/schema e revisar resumo. Usar merge
  não destrutivo. Outbox pendente, conflitos e tombstones são evidência de
  recuperação; não limpar para “resolver” divergência. O backup não substitui
  sync canônico nem backup PostgreSQL.
- Em falha de upgrade IndexedDB, fechar outras abas, preservar perfil/browser
  storage, repetir abertura e coletar erro sem exportar PII para logs. Não
  apagar IndexedDB nem reinstalar PWA como primeiro passo. Browser QA de upgrade
  e restore integrado continua reservado para F9.
