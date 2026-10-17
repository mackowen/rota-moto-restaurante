# Recuperação RotaMoto — Termux e Linux

Este procedimento é um guia de preparação. A cópia pós-0047 foi verificada e
restaurada em um PostgreSQL 18 descartável na Campanha 0235. Isso não prova
recovery fora do dispositivo, continuidade de mídia ou um RTO aprovado. Não
restaure sobre `rotamoto` nem `rotamoto_e2e`.

## Artefatos e dependências

- PostgreSQL 18 da mesma major do backup; `pg_dump`, `pg_restore`, `initdb`, `pg_ctl` e `psql`.
- Node.js e dependências do Restaurante instaladas com o lockfile (`npm ci`).
- OpenSSL CLI e tar para as cópias de identidade; o helper versionado é
  `scripts/verify-local-recovery-envelopes.js`.
- Recovery set pós-0047 em `~/projetos/backups/campanha-0235/sets/`, UUID
  `fcb45701-fadb-4711-a736-7d341dff72e0`; chave de backup separada do set.
- Envelopes privados em `~/rotamoto-data/identity/keys/`. A senha da role
  PostgreSQL deve vir de `.pgpass` privado, nunca de URL, ambiente versionado
  ou argumentos.

No Termux, runit supervisiona PostgreSQL, Nginx e as APIs. Em Linux, configure
usuário/grupo de serviço próprios e systemd; não copie as unidades Termux nem
use a mesma identidade para a API e operação administrativa. Restaure e valide
o banco antes de apontar qualquer aplicação a ele.

## Validar envelopes existentes

A Campanha 0236 confirmou apenas estrutura dos envelopes: arquivos regulares
mode 0600, diretórios 0700, cabeçalho `Salted__` e comprimento compatível com
AES-256-CBC. O histórico do operador registra AES-256-CBC + PBKDF2-SHA-256,
600.000 iterações. Esse formato legado não tem autenticação AEAD embutida.
Não o converta ou sobrescreva automaticamente.

No dispositivo que contém a identidade operacional, rode no Termux:

```sh
node scripts/verify-local-recovery-envelopes.js --metadata-only
node scripts/verify-local-recovery-envelopes.js --refresh-stale
```

O segundo comando solicita em terminal interativo (sem eco) a passphrase da
chave mestra e a do backup do keystore. Se o backup não corresponder aos
arquivos atuais, solicita uma passphrase nova (24 a 1024 bytes) duas vezes e
cria `keys/keystore-recovery-0238.enc` sem substituir o envelope anterior.
Escreve primeiro um arquivo criptografado privado no mesmo diretório e valida
o formato legado e a descriptografia antes de publicar por rename atômico sem
substituição. Registra evento sanitizado na auditoria, com fase e errno
permitido em caso de erro, sem registrar caminhos. O arquivo contém cópia
criptografada de `master.key`, referência SMTP e keystore; guarde a nova
passphrase fora do aparelho. Não use pipe, background, gravação de terminal ou
ChatGPT para fornecer frases-senha.

Após a Campanha 0238, o erro de publicação `EACCES` do hard link anterior foi
reproduzido somente com fixtures sintéticas. O helper agora usa `mv` GNU
`--no-clobber`/`--no-target-directory` (disponível no Termux coreutils) e falha
sem tocar num destino existente. Em um erro, confira `stage` e `causeCode` no
diagnóstico JSON sanitizado; não repita com `--force` nem remova envelopes.

O helper grava temporariamente dados recuperados em diretório privado 0700,
com arquivos 0600, compara a chave restaurada com a chave ativa e valida que a
referência SMTP e blobs cifrados correspondem ao keystore atual. Ao fim remove
o diretório temporário e falha se não conseguir removê-lo. Remoção lógica não
garante apagamento físico em armazenamento flash.

## Preparar uma instalação de recovery isolada

1. Copie manualmente apenas conjuntos completos já cifrados para mídia externa
   aprovada. Mantenha a chave de backup e suas passphrases em canal/cofre
   separado. Não envie nada automaticamente e não coloque material privado no
   GitHub. A pasta `~/projetos/backups/campanha-0236/recovery-package/` é um
   staging local; não significa que exista cópia fora do dispositivo.
2. Em outro Termux ou host Linux isolado, instale PostgreSQL 18 e crie um
   cluster temporário sem conexões externas, ouvindo apenas em loopback. Use
   diretório e porta livres. O ensaio 0235 usou 55439; confirme disponibilidade
   antes de reutilizar.
3. Crie nesse cluster somente as roles necessárias ao restore. `rotamoto_restore`
   pode ser superuser somente dentro do cluster temporário descartável; nunca
   lhe conceda essa atribuição no cluster operacional. Crie um database vazio
   com nome `rotamoto_disposable_<id>` e owner dessa role.
4. Configure `ROTAMOTO_BACKUP_DIRECTORY`, `ROTAMOTO_BACKUP_KEY_FILE`,
   `ROTAMOTO_MEDIA_DIRECTORY` e auditoria em arquivos privados; use URL local
   sem password embutida. Crie um destino de mídia inexistente sob um diretório
   temporário 0700. Verifique a assinatura e integridade antes do restore:

```sh
ROTAMOTO_BACKUP_DIRECTORY=/caminho/privado/sets \
ROTAMOTO_BACKUP_KEY_FILE=/caminho/privado/backup.key \
  npm run backup:verify -- <uuid-do-set>
```

5. Restaure somente para o nome `rotamoto_disposable_<id>` com
   `npm run backup:restore -- <uuid> postgresql://rotamoto_restore@127.0.0.1:<porta>/rotamoto_disposable_<id> <diretorio-de-midia-descartavel>`.
   O comando recusa `rotamoto` e `rotamoto_e2e`, verifica as referências de
   mídia e não cria ou apaga databases.
6. Compare o ledger com o código local, confira RLS/FORCE, índices, constraints,
   roles e readiness. O dump não restaura roles globais nem ACL (`--no-owner`,
   `--no-acl`). Reconstrua grants conforme as migrations e runbooks, sem copiar
   `BYPASSRLS`. Não ligue API nem tráfego operacional até essa revisão.
7. Pare o cluster temporário após o ensaio. Preserve evidências sanitizadas; não
   registre conteúdo de negócio, passphrases, tokens, hashes privados ou
   credenciais.

O PostgreSQL descartável da Campanha 0235, já parado, está preservado em
`~/rotamoto-data/maintenance/campanha-0235/restore-cluster/` para referência
local. A campanha não o restaura novamente.

## Arquivos de serviço e Nginx

No Termux, compare e reinstale somente cópias revisadas de:

- `deploy/runit/rotamoto-api-official/` em `$PREFIX/var/service/`;
- `deploy/termux/nginx/rotamoto-*.conf` em `$PREFIX/etc/nginx/`;
- `deploy/termux/official-api.env.example` renderizado localmente em arquivo
  privado mode 0600, mantendo `.pgpass` mode 0600.

Guarde uma cópia privada antes de qualquer troca, rode `nginx -t`, reinicie com
`sv restart nginx` e confira `/api/health/live` e `/api/health/ready` nos dois
sites. A configuração atual escuta em loopback e a API oficial usa `rotamoto`;
E2E não é upstream operacional. Nenhum bind LAN/público é autorizado por este
documento.

## Cópia externa manual

O staging Campanha 0236 contém apenas o recovery set PostgreSQL já cifrado e
instruções. Está incompleto até o operador validar e disponibilizar
separadamente uma cópia recuperável da chave de backup. Os envelopes de
identidade não devem ser colocados no mesmo destino da chave que os abre sem
proteção adicional. A transferência ao Google Drive ou outro destino é manual,
na interface do provedor, após validação local; não há OAuth, rclone ou destino
externo configurado pelo Codex.
