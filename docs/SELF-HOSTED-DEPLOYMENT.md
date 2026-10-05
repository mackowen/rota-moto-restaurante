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

### QR seguro de Delivery

Para emitir QR de Delivery, configure uma chave Ed25519 de instalação no secret provider. Com keystore filesystem, execute `npm run delivery-qr:key-init` no ambiente de operador já configurado; o comando guarda a chave privada cifrada no keystore e imprime somente `kid`, referência e chave pública. Não copie a chave privada para o navegador ou Motoboy. Configure `ROTAMOTO_DELIVERY_QR_SIGNING_KEY_REF` com a referência emitida e `ROTAMOTO_DELIVERY_QR_KEY_ID` com o `kid`, então reinicie a API. O status do operador mostra apenas configured/not configured. Sem a configuração, a API falha fechada para emissão.

`GET /api/delivery-qr/keys` entrega a chave pública somente a uma sessão autenticada com `sync.pull`; o Motoboy a conserva localmente para validar offline. O token assinado contém somente versão, IDs opacos de Delivery/tenant, revisão, emissão, expiração e `kid`; expira em 12 horas. A assinatura não concede autorização: online o Motoboy confere novamente a Delivery pelo endpoint tenant/Driver-scoped; offline só pode abrir uma Delivery já presente no snapshot e mostra estado possivelmente desatualizado. Ações continuam sujeitas ao outbox/ACK e à validação de atribuição no servidor. O scanner usa `BarcodeDetector` quando disponível e fallback jsQR vendorizado; nenhuma imagem é enviada a serviço externo.

Para rotação, gere uma nova chave/`kid`, atualize as duas variáveis de ambiente e reinicie a API. Dispositivos que receberam a chave pública antiga mantêm-na em cache local; os tokens antigos expiram em até 12 horas. Dispositivos que ainda não conhecem a chave antiga falham fechados e precisam se reconectar para receber a chave ativa. Remova a referência antiga do keystore conforme a política do operador após a janela de expiração e a verificação dos clientes.

SMTP é configurado somente pelo operador via `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD_REF`, `SMTP_FROM` e `PUBLIC_BASE_URL`. A senha vive no keystore com nome `smtp/password`, escopo `installation`. TLS de saída valida certificado e exige TLS quando não usa TLS imediato. Tenant admins não recebem nem podem definir estas opções. Se o SMTP não estiver configurado, convite e recovery falham fechados.

O provider local de mídia usa `ROTAMOTO_MEDIA_DIRECTORY`, limita provas PNG/JPEG a 8 MiB, grava conteúdo fora do PostgreSQL e exige volume privado, ownership do serviço, sem symlink e permissões 0700/0600. `POST /api/domain/deliveries/{id}/proofs/media` exige sessão, CSRF, tenant e Driver atualmente atribuído; o Motoboy preserva assinatura local e tenta novamente o upload. O sync persiste referência, tamanho e SHA-256 no registro canônico. A leitura usa `GET /api/domain/deliveries/{id}/proofs/{proofId}/media` com autorização da sessão; o volume não deve ser publicado pelo nginx.

Upload cria intent tenant-scoped ligada ao ID local da prova e Delivery; o sync a consome na mesma transação da referência canônica. Isso protege resposta perdida, sync offline e corrida do coletor. Execute `npm run storage:gc` para dry-run ou `npm run storage:gc -- --apply` para remover candidatos; o grace period mínimo é 45 dias e pode aumentar via `ROTAMOTO_MEDIA_GC_GRACE_DAYS`. Intents não sincronizadas não expiram automaticamente para preservar provas offline; isso pode reter mídia de uploads abandonados.

MFA TOTP nativo usa o keystore de instalação. Enrollment retorna segredo apenas antes da confirmação; PostgreSQL guarda a referência opaca, o replay counter e somente digests dos recovery codes. Confirmação, login e códigos de recuperação são auditados, limitados e protegidos contra replay. A rotação é CLI server-side com manifesto de referências/contextos; parar a API, fazer backup offline do diretório/key, executar a troca, verificar status e só então reiniciar. Falha antes/durante a troca restaura a cópia anterior; após queda abrupta, use a cópia `*.rotation-backup-*` (master key e arquivos `.enc`) para restaurar ambos como par antes de iniciar a API. Nunca combine master key de uma geração com o diretório de outra.

`npm run backup:create` cria um conjunto PostgreSQL + DeliveryProof/filesystem com `rotamoto-recovery-set-v1`, AES-256-GCM por componente, checksum, HMAC e manifesto final. Upload, confirmação de sync da prova e GC compartilham um advisory lock de snapshot, estabelecendo uma janela consistente sem alegar transação distribuída. Restore exige database `rotamoto_disposable_*` e diretório de mídia descartável sob diretório temporário privado, distinto de `ROTAMOTO_MEDIA_DIRECTORY`; staging é validado contra referências canônicas antes da promoção. Ver `docs/operations/BACKUP-RESTORE.md` para limites, agendamento, retenção, restore, failure recovery e operação cron/timer. O ensaio real do conjunto completo deve ser registrado antes de declarar produção pronta.

O status do operador mostra configuração sanitizada e último resultado do job. Automatize cron/systemd timer/runit sob usuário dedicado; use pgpass 0600, ambiente privado, journal restrito e alertas de falha/idade/espaço. Frequência, retenção, RPO/RTO e cópia offsite são decisões operacionais, não obrigações legais presumidas.

## Configuração por empresa

Opções de negócio tenant-scoped permanecem sob RBAC e RLS. Paths, keystore, master key, SMTP, PostgreSQL, storage global e backup são configuração da instalação. APIs administrativas não devem retornar material secreto; apenas estado sanitizado como configurado/não configurado/verificado.

## Threat model e controles

- Path traversal: keys são UUIDs gerados no servidor e referências aceitas por gramática fixa.
- Symlink/hardlink e permissões: diretórios/arquivos verificados com lstat, NOFOLLOW na criação, owner do serviço, 0700/0600; volume deve ser privado e sem usuários concorrentes com o serviço.
- Upload malicioso: streaming limitado a 8 MiB, PNG/JPEG por assinatura inicial, SHA-256, escrita temporária/atômica e integridade revalidada na leitura. A inspeção de assinatura não substitui antivírus nem sanitização de metadados EXIF.
- Tenant crossing: a key inclui tenant/delivery, mas a autorização do endpoint deve derivar tenant e Driver da sessão e conferir atribuição atual. O object store sozinho não autoriza requests.
- Segredos: AEAD com escopo/name/ref autenticados; nunca listar/retornar valores; não logar conteúdo. Perda da master key perde acesso aos secrets. A rotação transacional está disponível por CLI do operador; pare a API, mantenha cópia offline protegida do par keystore/master key e siga o runbook de rotação antes de reiniciar.
- SMTP SSRF: host/porta são configuração local do operador; tenant não os controla. TLS valida certificado. Não habilitar configuração SMTP pela UI tenant.
- MFA: enrollment, anti-replay persistente, rate limit, auditoria e ativação nativa TOTP estão integrados. Manter sessão de enrollment limitada até confirmação.
- Backup: snapshots incluem PII/GPS/provas; restringir filesystem/contas, criptografar cópias externas, documentar retenção e testar restore em ambiente descartável.
- Logs: registrar status/códigos/request id, nunca token, senha, segredo, prova ou payload completo.

## Estado da implementação

Keystore, SMTP via configuração do operador, DeliveryProof filesystem autenticado e MFA TOTP nativo já operam nos fluxos cobertos pelo harness local/E2E. A superfície de operador é CLI local com status sanitizado e escrita de secret stdin; configuração de instalação permanece sob owner do serviço. Garbage collection é dry-run por padrão, com 45 dias mínimos e confirmação canônica + intent tenant-scoped. O gate de recovery PostgreSQL+mídia, inclusive com prova não vazia, foi ensaiado em alvo descartável no Registro 0068; cada deployment ainda precisa configurar volumes/chaves/scheduler e executar seu smoke operacional antes de habilitar o timer.
