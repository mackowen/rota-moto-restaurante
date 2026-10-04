# Operação RotaMoto

Documentação F8 preparada para implantação futura. O checkout Termux/PostgreSQL
local não é produção e nenhum serviço real foi alterado.

- [Deploy, configuração e rollback](DEPLOY-ROLLBACK.md)
- [Backup/restore PostgreSQL e IndexedDB](BACKUP-RESTORE.md)
- [Dados e retenção](RETENTION.md)
- [Exemplo nginx, não instalado](nginx-api.conf.example)
- [PostgreSQL/migrations/role split](../../backend/postgres/README.md)

Produção permanece bloqueada sem domínio/TLS, secret provider/KMS, CA e banco
operacional, MFA/email reais, operadores, política de retenção, distribuição de
clientes e ensaio restore/RPO/RTO.
