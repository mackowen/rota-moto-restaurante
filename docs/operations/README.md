# Operação RotaMoto

Documentação F8 preparada para implantação futura. O checkout Termux/PostgreSQL
local não é produção e nenhum serviço real foi alterado.

- [Deploy, configuração e rollback](DEPLOY-ROLLBACK.md)
- [Backup/restore PostgreSQL e IndexedDB](BACKUP-RESTORE.md)
- [Provisionamento DBA das roles de backup](POSTGRES-BACKUP-ROLES.md)
- [Dados e retenção](RETENTION.md)
- [Exemplo nginx, não instalado](nginx-api.conf.example)
- [PostgreSQL/migrations/role split](../../backend/postgres/README.md)

Produção on-premises ainda depende da role DBA dedicada e rehearsal real de
backup/restore, snapshot de mídia junto ao backup, domínio/TLS/CA e definição
operacional de retenção/RPO/RTO. S3/KMS/Vault não são necessários para instalação
local; cloud exige validar deployment/providers remotos e cópia offsite.
