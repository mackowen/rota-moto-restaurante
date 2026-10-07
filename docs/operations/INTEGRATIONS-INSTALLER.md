# Requisitos do installer de integrações (Linux e Windows)

Este documento descreve pré-requisitos para quando os adapters oficiais forem ligados ao runtime comercial. Instalar este pacote não autoriza nem ativa conta de provider. Não guardar credenciais no frontend, em log, argumento de processo ou arquivo de configuração versionado.

## Rede e callback HTTPS

- O processo HTTP do Restaurante deve ficar atrás de proxy reverso local. Publicar somente HTTPS em TLS 1.2 ou superior; redirecionar HTTP para HTTPS e usar certificado cuja cadeia seja confiável.
- Publicar callback HTTPS estável, sem autenticação de sessão do usuário. Verificar a assinatura oficial sobre o corpo bruto antes de parsear ou persistir. O callback identifica provider e conta autorizada; resolver `external_account_id → company_id` na base, nunca por `companyId` recebido do corpo.
- DNS público A/AAAA/CNAME precisa resolver para o proxy, com portas 80/443 permitidas conforme o desafio/renovação do certificado. O proxy não deve alterar corpo, assinatura, caminho ou encoding. Limitar corpo e taxa, desabilitar redirects e encaminhar origem/Host permitidos.
- iFood exige validar `X-IFood-Signature` sobre o corpo bruto conforme a documentação oficial. O webhook Keeta envia `X-App-Signature` (HMAC-SHA256/Base64 do corpo bruto) junto a `X-App-Id` e `X-App-MerchantId`; isso é distinto da assinatura de requests API, que cobre URL, query e body. Para 99Food usar exclusivamente o mecanismo confirmado no contrato do app certificado.

## Processos e secrets

- Instalar serviços separados para HTTP, provider worker e credential resolver. Worker precisa de reinício supervisionado, shutdown gracioso, health/status, logs estruturados sanitizados e política de concorrência por tenant.
- Scheduler executa polling com intervalo conforme limite oficial, backoff para 429/5xx e recuperação de leases vencidos. Polling, webhook e replay compartilham inbox idempotente; não executar HTTP externo dentro de transação PostgreSQL.
- Installer cria diretório de secrets com ACL somente para a conta de serviço, registra referências no keystore do host e não solicita credencial real como pré-requisito de instalação. Segredos de provider ficam por app/tenant conforme escopo emitido pelo provider; rotação/revogação devem ser operáveis sem reinstalar.
- Linux: unit systemd dedicada; Windows: serviço SCM dedicado. Executar sem privilégios administrativos, diretório de trabalho e mídia com permissões mínimas, rotação de logs e shutdown por sinal/controle de serviço.

## Conectividade

- Saída TCP 443 para domínios oficiais de token/API e endpoints de webhook de cada plataforma; egress DNS/NTP; sem chamadas para hosts definidos pelo cliente. TLS com validação de hostname e cadeia, relógio sincronizado para OAuth e assinaturas.
- Suportar proxy HTTPS corporativo por configuração explícita; manter validação TLS e nunca aceitar `NODE_TLS_REJECT_UNAUTHORIZED=0`. O proxy precisa permitir CONNECT/POST/GET e retornar `Retry-After`/status sem reescrita.
- Entrada somente 443 ao reverse proxy. PostgreSQL e portas do worker não ficam públicas. Callback deve ter DNS/TLS verificáveis a partir da plataforma externa para homologação.

## PostgreSQL e recovery

- Banco `rotamoto` gerenciado separadamente, com TLS `verify-full`, CA confiável e sem senha embutida na URL. Migrator usado apenas por operação administrativa; app, worker, resolver e backup usam roles distintas e grants mínimos já definidos no diretório `backend/postgres/admin`.
- Instalação não deve rodar migration silenciosamente. Antes de qualquer versão com migration: checar branch/tag alvo, status e checksum oficial/E2E; criar e verificar recovery set oficial conforme `BACKUP-RESTORE.md`; aplicar migrations oficiais e E2E na mesma ordem; revalidar ledger/security parity e zero fixtures no oficial.
- Worker opera com tenant allowlist mínima, não recebe credenciais SQL em argumentos e não tem SELECT geral de `secret_ref`. Resolver obtém somente credencial associada ao provider e tenant solicitados.

## Estado observável

- UI mostra conta/vínculo, recursos disponíveis, conexão verificada, última sincronização, última falha sanitizada e estado de reconciliação. “Conta autorizada” e “conectividade testada” são fatos distintos.
- Logs nunca incluem token, secret, corpo webhook, endereço, telefone, nome de cliente ou credencial. Métricas identificam provider/conta por ID interno opaco e classe de erro.
