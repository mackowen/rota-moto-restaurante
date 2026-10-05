# Deployment self-hosted

O mesmo backend e os mesmos contratos funcionam em servidor local, VPS ou cloud privada. Docker e Kubernetes são opcionais, não requisitos.

```text
reverse proxy com TLS e headers confiáveis
  → API RotaMoto em loopback
  → PostgreSQL com usuário runtime de privilégio mínimo
  → volume local privado para mídias
  → SMTP configurado pelo operador (opcional até habilitar convites/recovery)
  → volume de backup local; cópia remota é política operacional futura
```

## Segredos e configuração da instalação

Em produção, configure exatamente um `ROTAMOTO_SECRET_PROVIDER_MODULE` externo ou o par absoluto `ROTAMOTO_SECRET_STORE_DIRECTORY` e `ROTAMOTO_SECRET_MASTER_KEY_FILE`. O keystore local usa AES-256-GCM, arquivos 0600, diretório 0700 e exige ownership do usuário de serviço; a master key precisa ser provisionada por canal operacional separado, fora do PostgreSQL, ambiente web e repositório. `ROTAMOTO_DATABASE_PASSWORD_REF` aponta ao secret `database/rotamoto_app` no escopo `installation`. A inicialização automática da master key não é fornecida: gerar/guardar a chave é uma ação operacional que precisa preservar uma cópia offline protegida.

SMTP é configurado somente pelo operador via `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD_REF`, `SMTP_FROM` e `PUBLIC_BASE_URL`. A senha vive no keystore com nome `smtp/password`, escopo `installation`. TLS de saída valida certificado e exige TLS quando não usa TLS imediato. Tenant admins não recebem nem podem definir estas opções. Se o SMTP não estiver configurado, convite e recovery falham fechados.

O provider local de mídia usa `ROTAMOTO_MEDIA_DIRECTORY` (ainda requer wiring no startup/API), limita provas de imagem a 8 MiB, gera a chave no servidor, grava conteúdo fora do PostgreSQL e exige armazenamento dedicado sem symlink, pertencente ao serviço e sem permissões para grupo/outros. O banco deve guardar apenas referência e metadata hash; endpoint autenticado de upload/leitura precisa ser habilitado antes de considerar DeliveryProof operacional.

Backup local grava stream em arquivo temporário, faz fsync e rename atômico, com arquivos 0600. Esta primitiva não agenda `pg_dump`, não define retenção, criptografia do conjunto, restore, nem cópia offsite. Essas rotinas ainda exigem runbook/validação operacional. Backups contêm PII, localização e provas: criptografar e limitar acesso antes de transportar ou reter.

## Configuração por empresa

Opções de negócio tenant-scoped permanecem sob RBAC e RLS. Paths, keystore, master key, SMTP, PostgreSQL, storage global e backup são configuração da instalação. APIs administrativas não devem retornar material secreto; apenas estado sanitizado como configurado/não configurado/verificado.

## Threat model e controles

- Path traversal: keys são UUIDs gerados no servidor e referências aceitas por gramática fixa.
- Symlink/hardlink e permissões: diretórios/arquivos verificados com lstat, NOFOLLOW na criação, owner do serviço, 0700/0600; volume deve ser privado e sem usuários concorrentes com o serviço.
- Upload malicioso: streaming limitado a 8 MiB, PNG/JPEG por assinatura inicial, SHA-256, escrita temporária/atômica e integridade revalidada na leitura. A inspeção de assinatura não substitui antivírus nem sanitização de metadados EXIF.
- Tenant crossing: a key inclui tenant/delivery, mas a autorização do endpoint deve derivar tenant e Driver da sessão e conferir atribuição atual. O object store sozinho não autoriza requests.
- Segredos: AEAD com escopo/name/ref autenticados; nunca listar/retornar valores; não logar conteúdo. Perda da master key perde acesso aos secrets. A rotação ainda não tem ferramenta transacional; reconfigure secrets sob janela operacional antes de trocar chave.
- SMTP SSRF: host/porta são configuração local do operador; tenant não os controla. TLS valida certificado. Não habilitar configuração SMTP pela UI tenant.
- MFA: TOTP RFC 6238 e digest de recovery codes estão implementados como primitives, mas enrollment, anti-replay persistente, rate limit/auditoria e ativação administrativa ainda não estão integrados; manter ações sensíveis fail-closed.
- Backup: snapshots incluem PII/GPS/provas; restringir filesystem/contas, criptografar cópias externas, documentar retenção e testar restore em ambiente descartável.
- Logs: registrar status/códigos/request id, nunca token, senha, segredo, prova ou payload completo.

## Estado da implementação

Keystore, adapter SMTP, store filesystem de provas, primitives TOTP e writer local de backup são implementações iniciais. Storage HTTP autenticado, metadata persistida no fluxo de upload, enrollment MFA completo, administração sanitizada, agendamento/restore de backup e provider remoto continuam pendentes; até então esses recursos não devem ser anunciados como operacionais.
