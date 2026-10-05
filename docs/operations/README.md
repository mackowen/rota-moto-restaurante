# Operação RotaMoto

Documentação F8 preparada para implantação futura. O checkout Termux/PostgreSQL
local não é produção e nenhum serviço real foi alterado.

- [Deploy, configuração e rollback](DEPLOY-ROLLBACK.md)
- [Backup/restore PostgreSQL e IndexedDB](BACKUP-RESTORE.md)
- [Provisionamento DBA das roles de backup](POSTGRES-BACKUP-ROLES.md)
- [Dados e retenção](RETENTION.md)
- [Exemplo nginx, não instalado](nginx-api.conf.example)
- [PostgreSQL/migrations/role split](../../backend/postgres/README.md)

O role split de backup/restore e o rehearsal real coordenado PostgreSQL+mídia,
incluindo uma DeliveryProof não vazia, foram aprovados em alvos descartáveis no
Registro 0068. Cada deployment on-premises ainda precisa configurar os volumes e
chaves, instalar/monitorar o scheduler, validar domínio/TLS/CA e medir/decidir
retenção/RPO/RTO. S3/KMS/Vault não são necessários para instalação local; cloud
exige validar deployment/providers remotos e cópia offsite.
