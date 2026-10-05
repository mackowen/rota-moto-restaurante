# Runbook — deploy e rollback do RotaMoto API

Este procedimento é um contrato operacional para ambiente futuro. O Termux,
PostgreSQL e nginx locais são desenvolvimento/homologação, não produção. Este
runbook não instala nem altera serviços, firewall, PostgreSQL ou nginx.

## Bloqueios antes de produção

- Domínio e certificado TLS geridos por operador; `nginx-api.conf.example` é
  somente exemplo e precisa revisão para domínio, cadeia de certificado,
  limites e política de HSTS.
- Keystore de instalação configurado fora do repositório: provider local em
  arquivos privados ou módulo externo por `ROTAMOTO_SECRET_PROVIDER_MODULE`,
  que implementa `getDatabasePassword({host,port,database,user})`; seu caminho
  deve ser absoluto. O processo nunca recebe `MIGRATOR_DATABASE_URL`. A CA e
  credenciais do deployment precisam ser provisionadas pelo operador.
- PostgreSQL de produção, credenciais rotacionáveis, política de backup,
  operadores/on-call, RPO/RTO, retenção e canal de distribuição aprovados.
- MFA TOTP nativo e transporte SMTP estão implementados; enrollment/convite/
  recovery permanecem fail-closed até o operador configurar keystore, SMTP e
  `PUBLIC_BASE_URL` válidos no deployment.

## Configuração de produção

Defina no gerenciador de processo, sem gravar valores secretos em arquivos de
deploy versionados:

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
DATABASE_URL=postgresql://rotamoto_app@db.example.invalid:5432/rotamoto?sslmode=verify-full
DATABASE_TLS_CA_FILE=/etc/rotamoto/secrets/postgres-ca.pem
ROTAMOTO_SECRET_PROVIDER_MODULE=/opt/rotamoto/secrets/provider.js
ALLOWED_ORIGINS=https://restaurante.example.invalid,https://motoboy.example.invalid
ALLOWED_HOSTS=api.example.invalid
TRUSTED_PROXY_ADDRESSES=127.0.0.1
```

O backend continua preso a loopback, verifica Host/origins, TLS PostgreSQL,
role runtime e schema compatível; forwarded IP só é usado quando o peer é um IP
exato da allowlist. O proxy deve sobrescrever `X-Forwarded-For` com `$remote_addr`.
Não confiar em `X-Forwarded-Proto` para tomar decisões de segurança. O cookie
`__Host-rotamoto_session` sempre é Secure, HttpOnly e SameSite=Lax. HSTS é
emitido somente em `production`; habilite `includeSubDomains` no proxy apenas
quando todos os subdomínios suportarem HTTPS.

O arquivo `.node-version` fixa a versão usada nesta validação local (Node
26.4.0); `engines.node` continua declarando o piso de compatibilidade (18+).
Antes de produção, qualifique e fixe a versão mantida pela plataforma-alvo e
repita testes de Argon2 nativo, API e pool. O Node 26 do Termux não demonstra
suporte de produção.

## Sequência de deploy

1. Aprovar release/artefato imutável, dependências lockadas e checksum. Confirmar
   branch/tag e migrations `up` existentes; não editar migration aplicada.
2. Verificar capacidade do PostgreSQL, janela, backup recente e procedimento de
   restore. Um backup não validado não autoriza deploy.
3. Rodar `node backend/postgres/migrate.js status` no processo administrativo
   separado, com `MIGRATOR_DATABASE_URL` resolvida por mecanismo local seguro.
   Revisar migrations pendentes e down scripts; não executar `down` como rollback
   automático.
4. Aplicar migrations aprovadas como `rotamoto_migrator`, fora do processo HTTP,
   com checkpoint/restore validado. Uma migration irreversível exige plano
   forward-fix aprovado antes da mudança.
5. Iniciar o backend com o serviço HTTP contendo apenas `DATABASE_URL` de
   `rotamoto_app`. O startup deve recusar configuração incompleta, identidade
   de role errada ou schema incompatível. Confirmar `/health/live` e
   `/health/ready`; readiness não substitui teste funcional autenticado.
6. Ativar o proxy TLS revisado, validar Host, HTTPS, HSTS, CSP, CORS, limites e
   rate limit. Backend não deve ouvir interface pública.
7. Publicar shell dos clientes. O Motoboy ativa o novo service worker após as
   abas antigas fecharem; IndexedDB não é apagado. Confirmar versão de scripts,
   `indexeddb-schema.js` e assets como conjunto. O Restaurante não tem service
   worker próprio no estado auditado.
8. Executar smoke operacional autenticado com conta de staging autorizada,
   sync e leitura/escrita permitidas; inspecionar logs sanitizados e erros.

## Rollback

- Parar rollout do cliente/backend e voltar ao artefato anterior somente se o
  schema continuar compatível com ambos. Upgrades IndexedDB são aditivos e não
  se deve apagar a base local para voltar código; atualizar novamente se o
  código antigo não abrir a versão nova.
- Não executar migration `down` automaticamente. Rollback de schema somente
  quando o down declara preconditions, não remove dados e foi ensaiado em cópia
  isolada; caso contrário, preferir forward-fix.
- Restore de backup é último recurso, requer janela, alvo isolado, aprovação do
  operador e validação de tenant/RLS/roles; não restaurar sobre a única cópia de
  produção sem checkpoint atual e plano de reconciliação.
- Registrar release, migration IDs, checksums, readiness, decisão e operador.

## Limites atuais

Nenhum deploy, TLS ou rollback foi executado. Rate limiter em memória do Node é
por processo; nginx acrescenta limite por IP, mas alta disponibilidade exige
desenho distribuído. Health readiness valida objetos estruturais essenciais,
enquanto o operador confirma o ledger exato pelo CLI migrator antes do deploy.
