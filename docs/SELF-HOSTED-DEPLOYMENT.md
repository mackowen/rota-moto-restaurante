# Deployment self-hosted

O mesmo backend e os mesmos contratos funcionam em servidor local, VPS ou cloud privada. Docker e Kubernetes são opcionais, não requisitos.

```text
reverse proxy com TLS e headers confiáveis
  → API RotaMoto em loopback
  → PostgreSQL com usuário runtime de privilégio mínimo
  → volume local privado para mídias
  → SMTP configurado pelo operador (opcional até habilitar convites/recovery)
  → volume local privado de backup cifrado; cópia offsite é opcional
```

## Provisionamento on-premises/VPS

Execute a API com usuário de sistema dedicado, sem shell interativo, e mantenha
`HOST=127.0.0.1`; o nginx termina TLS e encaminha apenas para loopback. Configure
firewall para expor somente 443/80 (redirecionado), nunca PostgreSQL nem os
volumes. PostgreSQL deve aceitar conexões locais/API com TLS verificado quando
remoto; use CA privada em arquivo somente leitura pelo serviço. Não encaminhe
headers de proxy de peers fora da allowlist.

Crie volumes separados, fora do checkout e do webroot: mídia e backup em
diretórios `0700` próprios do serviço; arquivos de objeto, manifesto, dump e
keystore em `0600`. Não monte mídia como conteúdo estático no nginx. Backup e
keystore devem ter cópia protegida em host/offline diferente, com acesso de
operadores restrito. Não use `chmod -R` em volume já existente sem revisar
owners e symlinks.

```sh
ROTAMOTO_MEDIA_DIRECTORY=/var/lib/rotamoto/media
ROTAMOTO_BACKUP_DIRECTORY=/var/backups/rotamoto
ROTAMOTO_BACKUP_KEY_FILE=/etc/rotamoto/backup.key
ROTAMOTO_SECRET_STORE_DIRECTORY=/var/lib/rotamoto/keystore
ROTAMOTO_SECRET_MASTER_KEY_FILE=/etc/rotamoto/master.key
ROTAMOTO_DATABASE_PASSWORD_REF=local-v1:<referencia-opaca>
ROTAMOTO_OPERATOR_AUDIT_LOG=/var/log/rotamoto/operator-audit.jsonl
ROTAMOTO_OPERATOR_ACTOR_REF=operator:deployment-team
PUBLIC_BASE_URL=https://rota.example.invalid
```

Use o mecanismo de configuração do serviço para instalar os parâmetros globais;
arquivos de ambiente devem pertencer a root/operador, modo `0600`, e não devem
conter senhas PostgreSQL. Paths e providers são globais à instalação. Não existe
configuração operacional de instalação através das permissões do administrador
tenant. Consulte `npm run operator` para status sanitizado; `secret-put` lê o
secret por stdin e devolve somente a referência. `smtp-verify` confirma conexão
TLS sem enviar mensagem. External secret providers são configurados pelo CLI
próprio do provider, nunca por configuração tenant. Comandos que alteram
keystore/backup exigem `ROTAMOTO_OPERATOR_ACTOR_REF` e arquivo JSONL privado de
auditoria `0600`; provisionar o arquivo antes da primeira operação.

Provisionamento de identidade/e-mail requer SMTP verificado e `PUBLIC_BASE_URL`
HTTPS. Use `node scripts/rotamoto-operator.js smtp-verify`. Configure alertas de disco para
mídia, keystore e backups; planeje RPO/RTO com base na frequência do job de
backup, tempo medido de restore e janela de sincronização dos celulares. O
produto não fixa um prazo legal de retenção de PII/GPS/provas: defina retenção
com responsável operacional e legal antes de purgar mídia ou backups.

## Segredos e configuração da instalação

Em produção, configure exatamente um `ROTAMOTO_SECRET_PROVIDER_MODULE` externo ou o par absoluto `ROTAMOTO_SECRET_STORE_DIRECTORY` e `ROTAMOTO_SECRET_MASTER_KEY_FILE`. O keystore local usa AES-256-GCM, arquivos 0600, diretório 0700 e exige ownership do usuário de serviço; a master key precisa ser provisionada por canal operacional separado, fora do PostgreSQL, ambiente web e repositório. `ROTAMOTO_DATABASE_PASSWORD_REF` aponta ao secret `database/rotamoto_app` no escopo `installation`. A inicialização automática da master key não é fornecida: gerar/guardar a chave é uma ação operacional que precisa preservar uma cópia offline protegida.

SMTP é configurado somente pelo operador via `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD_REF`, `SMTP_FROM` e `PUBLIC_BASE_URL`. A senha vive no keystore com nome `smtp/password`, escopo `installation`. TLS de saída valida certificado e exige TLS quando não usa TLS imediato. Tenant admins não recebem nem podem definir estas opções. Se o SMTP não estiver configurado, convite e recovery falham fechados.

O provider local de mídia usa `ROTAMOTO_MEDIA_DIRECTORY`, limita provas PNG/JPEG a 8 MiB, grava conteúdo fora do PostgreSQL e exige volume privado, ownership do serviço, sem symlink e permissões 0700/0600. `POST /api/domain/deliveries/{id}/proofs/media` exige sessão, CSRF, tenant e Driver atualmente atribuído; o Motoboy preserva assinatura local e tenta novamente o upload. O sync persiste referência, tamanho e SHA-256 no registro canônico. A leitura usa `GET /api/domain/deliveries/{id}/proofs/{proofId}/media` com autorização da sessão; o volume não deve ser publicado pelo nginx.

Upload cria intent tenant-scoped ligada ao ID local da prova e Delivery; o sync a consome na mesma transação da referência canônica. Isso protege resposta perdida, sync offline e corrida do coletor. Execute `npm run storage:gc` para dry-run ou `npm run storage:gc -- --apply` para remover candidatos; o grace period mínimo é 45 dias e pode aumentar via `ROTAMOTO_MEDIA_GC_GRACE_DAYS`. Intents não sincronizadas não expiram automaticamente para preservar provas offline; isso pode reter mídia de uploads abandonados.

MFA TOTP nativo usa o keystore de instalação. Enrollment retorna segredo apenas antes da confirmação; PostgreSQL guarda a referência opaca, o replay counter e somente digests dos recovery codes. Confirmação, login e códigos de recuperação são auditados, limitados e protegidos contra replay. A rotação é CLI server-side com manifesto de referências/contextos; parar a API, fazer backup offline do diretório/key, executar a troca, verificar status e só então reiniciar. Falha antes/durante a troca restaura a cópia anterior; após queda abrupta, use a cópia `*.rotation-backup-*` (master key e arquivos `.enc`) para restaurar ambos como par antes de iniciar a API. Nunca combine master key de uma geração com o diretório de outra.

`npm run backup:create` executa `pg_dump` custom por role administrativo separado `rotamoto_backup`, cifra o stream com AES-256-GCM usando chave fora do PostgreSQL e grava artefato/manifesto com checksum e HMAC. `npm run backup:verify -- <id>` verifica manifesto, HMAC e checksum. Retenção em dias é controlada por `ROTAMOTO_BACKUP_RETENTION_DAYS`; só pares manifesto/dump expirados e privados são removidos. A chave é criada uma vez por `node scripts/rotamoto-operator.js backup-key-init`; guarde-a fora do host. Não execute backup com `rotamoto_app` nem altere RLS/FORCE. A role de backup/restore exige provisioning DBA controlado e não é criada pelo runtime. O ensaio real com credencial/role separada ainda deve ocorrer em alvo descartável; o teste automatizado valida o formato e os guards com executáveis PostgreSQL fake.

`npm run backup:restore -- <id> <URL-alvo>` exige database com prefixo `rotamoto_disposable_` e recusa explicitamente `rotamoto`/`rotamoto_e2e`. O comando valida manifest/checksum/HMAC/tag GCM, grava dump temporário `0600`, exige `pg_restore --list` e somente então invoca restore destrutivo. Cópia de mídia no backup ainda não é implementada; preserve o volume de objetos por snapshot cifrado independente e correlacione manifesto antes de depender dessa capacidade.

## Configuração por empresa

Opções de negócio tenant-scoped permanecem sob RBAC e RLS. Paths, keystore, master key, SMTP, PostgreSQL, storage global e backup são configuração da instalação. APIs administrativas não devem retornar material secreto; apenas estado sanitizado como configurado/não configurado/verificado.

## Threat model e controles

- Path traversal: keys são UUIDs gerados no servidor e referências aceitas por gramática fixa.
- Symlink/hardlink e permissões: diretórios/arquivos verificados com lstat, NOFOLLOW na criação, owner do serviço, 0700/0600; volume deve ser privado e sem usuários concorrentes com o serviço.
- Upload malicioso: streaming limitado a 8 MiB, PNG/JPEG por assinatura inicial, SHA-256, escrita temporária/atômica e integridade revalidada na leitura. A inspeção de assinatura não substitui antivírus nem sanitização de metadados EXIF.
- Tenant crossing: a key inclui tenant/delivery, mas a autorização do endpoint deve derivar tenant e Driver da sessão e conferir atribuição atual. O object store sozinho não autoriza requests.
- Segredos: AEAD com escopo/name/ref autenticados; nunca listar/retornar valores; não logar conteúdo. Perda da master key perde acesso aos secrets. A rotação ainda não tem ferramenta transacional; reconfigure secrets sob janela operacional antes de trocar chave.
- SMTP SSRF: host/porta são configuração local do operador; tenant não os controla. TLS valida certificado. Não habilitar configuração SMTP pela UI tenant.
- MFA: enrollment, anti-replay persistente, rate limit, auditoria e ativação nativa TOTP estão integrados. Manter sessão de enrollment limitada até confirmação.
- Backup: snapshots incluem PII/GPS/provas; restringir filesystem/contas, criptografar cópias externas, documentar retenção e testar restore em ambiente descartável.
- Logs: registrar status/códigos/request id, nunca token, senha, segredo, prova ou payload completo.

## Estado da implementação

Keystore, SMTP via configuração do operador, DeliveryProof filesystem autenticado e MFA TOTP nativo já operam nos fluxos cobertos pelo harness local/E2E. A superfície de operador é CLI local com status sanitizado e escrita de secret stdin; configuração de instalação permanece sob owner do serviço. Garbage collection é dry-run por padrão, com 45 dias mínimos e confirmação canônica + intent tenant-scoped. Restore real depende da role administrativa ainda não provisionada; backup de objetos e rehearsal PostgreSQL permanecem pendentes.
