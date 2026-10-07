# Backup e restore self-hosted coordenado

`npm run backup:create` produz um conjunto versionado `rotamoto-recovery-set-v1`:
PostgreSQL custom cifrado, blobs canônicos DeliveryProof cifrados individualmente e
manifesto autenticado que relaciona os componentes, hashes, tamanhos e referências.
Os blobs permanecem fora do PostgreSQL. O payload do manifesto é cifrado; nomes
dos arquivos de mídia dentro do conjunto são índices opacos. Nenhum path local,
segredo ou conteúdo de prova aparece no manifesto legível.

Cada objeto usa AES-256-GCM; dump e arquivos usam SHA-256; o manifesto do conjunto
usa HMAC com a chave de backup mantida fora do banco. Arquivos são privados
(0600), diretórios 0700, publicação do manifesto ocorre por último e componentes
incompletos falham na verificação. Limites atuais: 10.000 objetos, 8 MiB por
objeto e 8 GiB por conjunto. Symlink, hardlink, traversal, arquivo inesperado,
componente faltante/corrompido e versão desconhecida causam falha fechada.

## Consistência banco + mídia

Upload, confirmação canônica de DeliveryProof e GC compartilham um advisory lock
transacional. O backup adquire o lock de sessão antes de consultar as referências,
executa `pg_dump`, valida/copia os objetos referenciados e só então publica o
manifesto autenticado. Novos uploads, confirmação de sync de provas e GC aguardam
esse lock. Assim uma prova comprometida no dump tem o blob correspondente no
conjunto; uploads ainda offline permanecem no cliente ou no upload intent e não
são tratados como uma prova canônica concluída. A janela de pausa corresponde
à duração do dump e da leitura/verificação das mídias; operação de negócio segue,
mas esses passos de mídia podem aguardar. Não há alegação de transação distribuída
entre PostgreSQL e filesystem.

A proteção depende de todos os processos que gravam/limpam DeliveryProof usarem
o lock compartilhado. Não altere manualmente blobs ou registros durante a janela.
O backup inclui apenas blobs referenciados por DeliveryProof canônico; órfãos não
são parte de uma recuperação válida.

## Pré-requisitos

- Node suportado e `pg_dump`/`pg_restore` compatíveis com PostgreSQL.
- `rotamoto_backup` é role separada, com leitura completa sob FORCE ROW LEVEL SECURITY (FORCE RLS) e
  BYPASSRLS somente para backup; nunca runtime/API. `rotamoto_restore` é isolada,
  owner apenas do database descartável provisionado e sem acesso ao oficial.
  Não se usa `rotamoto_migrator` como contorno.
- `BACKUP_DATABASE_URL` aponta sem senha para `rotamoto_backup`; pgpass autentica.
- `ROTAMOTO_BACKUP_KEY_FILE` tem 32 bytes, owner do operador e modo 0600, fora
  do PostgreSQL. Preserve cópia offline protegida da chave e teste recuperação.
- `ROTAMOTO_BACKUP_DIRECTORY` e `ROTAMOTO_MEDIA_DIRECTORY` são absolutos,
  separados, privados e acessíveis ao operador.
- `ROTAMOTO_OPERATOR_AUDIT_LOG` é arquivo absoluto privado (modo 0600) em diretório
  privado (0700); `ROTAMOTO_OPERATOR_ACTOR_REF` é identificador operacional sem PII.
  Ambos são obrigatórios para comandos mutáveis do CLI; ausência gera erro de configuração sanitizado.

```sh
umask 077
ROTAMOTO_BACKUP_KEY_FILE=/etc/rotamoto/backup.key node scripts/rotamoto-operator.js backup-key-init
BACKUP_DATABASE_URL=postgresql://rotamoto_backup@db.internal:5432/rotamoto \
ROTAMOTO_BACKUP_KEY_FILE=/etc/rotamoto/backup.key \
ROTAMOTO_BACKUP_DIRECTORY=/var/backups/rotamoto \
ROTAMOTO_MEDIA_DIRECTORY=/var/lib/rotamoto/media \
ROTAMOTO_OPERATOR_AUDIT_LOG=/var/log/rotamoto/operator-audit.jsonl \
ROTAMOTO_OPERATOR_ACTOR_REF=operator:backup-scheduler \
ROTAMOTO_BACKUP_RETENTION_DAYS=30 npm run backup:create
```

## Verificar e reter

```sh
ROTAMOTO_BACKUP_DIRECTORY=/var/backups/rotamoto \
ROTAMOTO_BACKUP_KEY_FILE=/etc/rotamoto/backup.key \
ROTAMOTO_OPERATOR_AUDIT_LOG=/var/log/rotamoto/operator-audit.jsonl \
ROTAMOTO_OPERATOR_ACTOR_REF=operator:backup-verifier \
  npm run backup:verify -- <uuid-do-conjunto>
```

A verificação exige o dump, manifesto PostgreSQL, diretório de mídia e manifesto
do conjunto; confere HMAC, checksums, GCM, metadata e ausência de arquivos extras.
Cada backup é publicado como um único diretório `<uuid>.set` por rename; manifesto
e componentes só aparecem juntos no nome final. Retenção opera sob lock local,
valida o conjunto e move atomicamente o diretório inteiro para quarentena antes
de removê-lo; conjunto parcial/corrompido faz a operação falhar e permanece para
diagnóstico. Operações concorrentes de backup são serializadas pelo
advisory lock PostgreSQL. O operador mostra último sucesso/falha e código
sanitizado; nunca expõe chave, credencial ou path no log de operação.

Instale um cron/timer sob o usuário dedicado do serviço; mantenha environment e
pgpass privados e envie stdout/stderr ao journal com acesso restrito. Exemplo de
entrada diária (horário, frequência, retenção e alertas são decisões do operador):

```cron
17 2 * * * cd /opt/rotamoto && BACKUP_DATABASE_URL=postgresql://rotamoto_backup@127.0.0.1:5432/rotamoto ROTAMOTO_BACKUP_KEY_FILE=/etc/rotamoto/backup.key ROTAMOTO_BACKUP_DIRECTORY=/var/backups/rotamoto ROTAMOTO_MEDIA_DIRECTORY=/var/lib/rotamoto/media ROTAMOTO_OPERATOR_AUDIT_LOG=/var/log/rotamoto/operator-audit.jsonl ROTAMOTO_OPERATOR_ACTOR_REF=operator:backup-scheduler ROTAMOTO_BACKUP_RETENTION_DAYS=30 npm run backup:create
```

Uma cópia offsite cifrada é opcional, mas necessária para tolerar perda do host.
Copie apenas conjuntos completos, preserve todos os componentes e manifesto e
mantenha a chave em canal/cofre separado. Nunca sincronize plaintext ou chave
para bucket genérico.

## Restore coordenado

Restore é explícito e somente aceita database `rotamoto_disposable_*`. O destino
de mídia precisa estar ausente, nomeado `rotamoto-disposable-media-<UUID>`, dentro
de um diretório temporário dedicado 0700, e separado do `ROTAMOTO_MEDIA_DIRECTORY`
operacional. O comando não cria nem apaga database e não promove mídia para o
volume de produção.

```sh
ROTAMOTO_BACKUP_DIRECTORY=/var/backups/rotamoto \
ROTAMOTO_BACKUP_KEY_FILE=/etc/rotamoto/backup.key \
ROTAMOTO_MEDIA_DIRECTORY=/var/lib/rotamoto/media \
  npm run backup:restore -- <uuid-do-conjunto> \
  postgresql://rotamoto_restore@127.0.0.1:5432/rotamoto_disposable_rehearsal \
  /tmp/rotamoto-disposable-media-parent-<UUID>/rotamoto-disposable-media-<UUID>
```

O pipeline verifica o conjunto e prepara mídia em staging privado; restaura
PostgreSQL pelo caminho aprovado (`--no-owner --no-acl --exit-on-error --clean
--if-exists`); compara referências canônicas (tenant, Delivery, key, MIME, hash,
tamanho) e promove a árvore somente após validação. Falha antes da promoção
limpa staging. Se a etapa PostgreSQL já terminou e a validação/promoção de mídia
falhar, o database descartável pode conter o restore; preserve o diagnóstico,
não use o alvo operacional e refaça somente após reset DBA autorizado do
 descartável. Nunca restaurar sobre `rotamoto` ou `rotamoto_e2e`.

## RPO/RTO e recovery

Frequência/retention devem seguir o RPO que o operador aprovar; não há prazo
legal presumido pelo produto. Meça RTO incluindo provisionamento, restore DB,
validação de ledger/RLS/FORCE e mídias, readiness e reconciliação dos clientes
offline. Perda da chave de backup torna os artefatos irrecuperáveis. O rehearsal
real deve usar database e diretório descartáveis, comprovar contagens e validar
integridade sem extrair conteúdo de negócio para logs.

## Backup Local-First

O formato `rotamoto-local-backup` v1 é distinto e plaintext sensível, podendo
conter PII, endereços, localização, provas, inbox/outbox e tombstones. Segredos de
autenticação não fazem parte dele. Guardar cópias localmente de forma privada e
revisar o resumo antes de importar; o merge existente não sobrescreve linhas em
colisão.
