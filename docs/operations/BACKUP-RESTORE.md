# Backup e restore self-hosted

O backup operacional usa `pg_dump` custom, cifra AES-256-GCM antes de gravar,
cria manifesto com versão/database/timestamp/tamanho/checksum e HMAC, e guarda o
par no filesystem privado configurado em `ROTAMOTO_BACKUP_DIRECTORY`. A chave
AES fica em `ROTAMOTO_BACKUP_KEY_FILE`, fora do PostgreSQL e do diretório do
artefato. Volume de mídia ainda precisa de snapshot independente; o campo
`objectsIncluded` fica `false` até essa integração existir.

## Pré-requisitos do operador

- Node da versão suportada e `pg_dump`/`pg_restore` compatíveis com a versão do
  PostgreSQL.
- `rotamoto_backup` é uma role administrativa separada, configurada pelo DBA
  para leitura completa necessária ao dump sob `FORCE ROW LEVEL SECURITY`. Essa
  role não pode ser runtime nem membro de `rotamoto_app`; ela deve ter acesso
  restrito, credencial em pgpass do operador e `BYPASSRLS` somente nesse login de
  backup. RLS/FORCE continuam habilitados e runtime permanece `NOBYPASSRLS`.
- Restore usa outra role `rotamoto_restore`, com `BYPASSRLS` e ownership apenas
  do database descartável provisionado pelo DBA. Ela não recebe `CREATEDB`, não
  é runtime e não é owner/concedida no database `rotamoto`.
- O provisionamento de role/grants é uma ação DBA fora do runtime e não foi
  executado por esta campanha. Sem ela, backup PostgreSQL completo falha
  claramente; não usar `rotamoto_migrator` para contornar RLS.
- Chave de backup provisionada com 32 bytes, owner do serviço e modo `0600`.
  `backup-key-init` cria a chave uma única vez com `O_EXCL`; copiar a chave para
  cofre/offline seguro antes de depender dos backups.

```sh
umask 077
ROTAMOTO_BACKUP_KEY_FILE=/etc/rotamoto/backup.key \
  node scripts/rotamoto-operator.js backup-key-init
ROTAMOTO_BACKUP_DIRECTORY=/var/backups/rotamoto \
ROTAMOTO_BACKUP_KEY_FILE=/etc/rotamoto/backup.key \
BACKUP_DATABASE_URL=postgresql://rotamoto_backup@db.internal:5432/rotamoto \
ROTAMOTO_BACKUP_RETENTION_DAYS=30 npm run backup:create
```

`BACKUP_DATABASE_URL` não aceita senha embutida; pgpass autentica. O CLI não
escreve a URL em logs. Em ambiente local de campanha a role `rotamoto_backup`
não existe, então nenhum dump PostgreSQL de verdade foi executado.

## Verificação, retenção e cópia offsite

```sh
ROTAMOTO_BACKUP_DIRECTORY=/var/backups/rotamoto \
ROTAMOTO_BACKUP_KEY_FILE=/etc/rotamoto/backup.key \
  npm run backup:verify -- <uuid-do-backup>
```

A verificação checa permissões/owner/hardlinks, checksum SHA-256, HMAC do
manifesto e envelope AES-GCM quando a chave está disponível. Criação executa
retenção depois de finalizar o manifesto: só remove arquivos/manifestos
privados e expirados conforme `ROTAMOTO_BACKUP_RETENTION_DAYS`. Guarde uma cópia
offsite cifrada do artefato e uma cópia separada da chave em locais/contas
distintos; isso é uma opção de deployment, mas manter apenas no host não cobre
perda física do host. Nunca sincronize artefato plaintext ou master key para
bucket genérico.

## Restore em alvo descartável

Restore não é automático e recusa `rotamoto` e `rotamoto_e2e`. O alvo deve ser
informado por URL explícita e seu nome deve ser `rotamoto_disposable_<nome>`.
`--clean`
substitui os objetos existentes nesse alvo. O pgpass deve autenticar
`rotamoto_restore`, owner do database descartável alvo.

```sh
ROTAMOTO_BACKUP_DIRECTORY=/var/backups/rotamoto \
ROTAMOTO_BACKUP_KEY_FILE=/etc/rotamoto/backup.key \
  npm run backup:restore -- <uuid-do-backup> \
  postgresql://rotamoto_restore@127.0.0.1:5432/rotamoto_disposable_rehearsal
```

O fluxo valida manifesto/checksum/HMAC/GCM, grava dump temporário com `0600`,
confere `pg_restore --list` e só então inicia restore. Após restore, rode status
de migration, valide owners/grants/RLS/FORCE/policies, readiness HTTP, operação
canônica e contagens/invariantes sem exportar PII para logs. Recrie runtime e
migrator por processo DBA aprovado antes de expor API. O comando não apaga nem
cria databases e não contém opção de alvo `rotamoto`.

Esta campanha testou cifra, manifesto, hash, HMAC, descriptografia, listagem e
guard de alvo com `pg_dump`/`pg_restore` de teste. O rehearsal real de
PostgreSQL está bloqueado até o DBA provisionar a role e um alvo descartável
isolado; não se restaurou em `rotamoto`, `rotamoto_e2e` nem outro database real.

## RPO/RTO e recuperação

Defina frequência de backup e retenção conforme o RPO aprovado. Meça o RTO em
restore real incluindo provisionamento de PostgreSQL, restore, migrations,
ownership/grants, validação de readiness e reconciliação dos Motoboys offline.
O cliente mantém provas/outbox localmente durante desconexões, mas isso não
substitui backup PostgreSQL nem garante retenção indefinida no dispositivo.
Inclua no procedimento o volume de mídia e as chaves. Se a chave de backup for
perdida, AES-GCM impede recuperação; se o keystore/master key for perdido,
segredos TOTP/SMTP cifrados também ficam indisponíveis.

## Backup Local-First

O formato `rotamoto-local-backup` v1 é plaintext sensível e contém dados de
negócio, PII, endereços, localização, provas/mídia local, inbox/outbox,
tombstones e conflitos. Segredos de autenticação não fazem parte do arquivo.
Guardar em local privado, controlar cópias e não importar sobre perfis ativos
sem revisar o resumo; a importação existente faz merge aditivo e não sobrescreve
linhas em colisão. Isso é diferente do dump PostgreSQL criptografado acima.
