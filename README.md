# RotaMoto Restaurante

Aplicação Local-First do Restaurante e API interna de identidade, administração,
consulta canônica e sync. O frontend continua operável localmente; o backend
Node usa PostgreSQL como autoridade canônica quando a sessão e a rede estão
disponíveis.

## Integrações externas

iFood, 99Food e Keeta **não estão conectados nem homologados**. Rotas externas
legadas retornam `503 PROVIDER_BLOCKED_EXTERNAL`. A interface mantém somente a
identificação local da origem e um laboratório sintético iFood isolado em
memória; isso não cria pedido comercial, não comprova protocolo e não confirma
ACK externo. Consulte [README-IFOOD.md](README-IFOOD.md) e
[docs/API-v1.md](docs/API-v1.md).

## Desenvolvimento local

Use Node 26.4.0 para reproduzir a validação deste checkout (`.node-version`). O
`engines.node` registra o piso 18; isso não certifica uma versão/host de
produção. Instale dependências a partir do lockfile e configure `DATABASE_URL`
sem senha, para `rotamoto_app` em `rotamoto`; a credencial local deve vir do
credential store aprovado. O HTTP escuta somente em loopback. Migrations são
CLI separada e usam `MIGRATOR_DATABASE_URL`/`rotamoto_migrator`; nunca execute
migrations no startup HTTP.

```sh
npm ci
npm test
```

## Operação

O Termux/PostgreSQL/nginx local é desenvolvimento/homologação, **não produção**.
Produção exige configuração explícita, HTTPS/proxy revisado, TLS PostgreSQL,
provider externo de secrets, backup/restore ensaiado, operadores e monitoramento.
O startup `NODE_ENV=production` falha fechado sem esses pré-requisitos. Não
exponha diretamente a porta do Node nem use `.env.example` como configuração de
produção.

Runbooks versionados: [Deploy/rollback](docs/operations/DEPLOY-ROLLBACK.md),
[Backup/restore](docs/operations/BACKUP-RESTORE.md),
[Retenção](docs/operations/RETENTION.md) e o [exemplo nginx](docs/operations/nginx-api.conf.example),
que não é aplicado automaticamente.
