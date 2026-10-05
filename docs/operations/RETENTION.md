# Retenção e dados operacionais

Esta matriz descreve dados e decisões pendentes; ela não define prazo jurídico
ou política de exclusão automática.

| Categoria | Sensibilidade e localização | Retenção/limpeza |
|---|---|---|
| GPS/LocationPoint | PII/localização; IndexedDB e PostgreSQL canônico | Prazo, finalidade e consentimento precisam de decisão legal/operacional. Não purgar fatos necessários a disputa/execução sem política. |
| DeliveryProof/foto/assinatura | dado pessoal sensível; legado pode conter Data URL local, referência/hash canônica no servidor | Política de retenção permanece decisão legal/operacional. O GC de filesystem remove somente objeto antigo sem referência canônica nem intent de upload, com grace mínimo 45d; intents pendentes protegem offline/retry sem expiração automática. |
| Orders/endereço/telefone | PII operacional em DB local e domain records | Política legal/operacional por tenant ainda não aprovada. |
| audit_log | trilha de segurança/admin append-only no PostgreSQL | Integridade permanente no desenho atual; prazo/arquivamento precisa de decisão. Nunca atualizar/apagar pela role runtime. |
| logs HTTP | request ID, rota, status, duração e código sanitizado; sem body/credenciais | Rotação/capacidade e prazo devem ser definidos pelo operador; não incluir payload. |
| sync inbox/outbox | recibos, IDs, status, conflito e payload operacional tenant-scoped | Manter pendente, conflito, tombstone e idempotência; política de compactação já documentada no produto é aplicável apenas ao que for seguro. Retenção server-side depende de política. |
| LocalIdMap/aliases | IDs necessários para retry/reconciliação | Não remover enquanto outbox, eventos ou tombstones puderem referenciá-los; horizonte de reinstalação/recovery precisa definição. |
| backups | podem conter todos os dados locais/PG e PII | Cópias plaintext sensíveis com acesso/retention controlados; prazo, cifragem, localização e destruição dependem de decisão operacional/legal. |

GC manual: `npm run storage:gc` é dry-run; `npm run storage:gc -- --apply`
efetiva exclusão após conferir referência/intent dentro de RLS tenant-scoped e
advisory lock compartilhado pelo upload/sync. Limites e logs não incluem
conteúdo, path, tenant ID, prova, token ou secret. Dados sintéticos de testes
precisam ser revertidos/removidos no escopo do próprio teste.
