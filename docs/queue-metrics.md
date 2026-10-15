# Métricas locais de filas

`GET /api/ops/queues` retorna um snapshot JSON para o tenant da sessão autenticada. Exige permissão `company.manage`; não aceita tenant por parâmetro. Respostas sem sessão recebem 401 e usuários sem a permissão recebem 403. Resposta usa `Cache-Control: no-store` e não contém IDs de tenant, pedidos, comandos, contas ou chaves idempotentes.

## Campos

As filas `provider_commands` e `marketplace_commands` expõem contagens agregadas de `pending`, `leased`, `succeeded`, `failed` e `unknown`, idade do item pendente mais antigo, comandos com mais de uma tentativa, leases vencidos e p95 de duração dos comandos concluídos. Rótulos de fila são constantes.

`workerAvailability: "unknown"` é deliberado: não existe heartbeat durável compartilhado entre os processos worker e o runtime HTTP. Uma lease ativa não prova que um worker ainda está vivo. A exportação também não atribui resolução a uma tentativa; recuperação observável aparece como novo estado da fila e redução dos pendentes após o próximo snapshot.

## Critérios operacionais de triagem

Os workers configuram polling de 1 segundo e lease de 45 segundos. Como regra inicial para o ambiente de desenvolvimento, investigar idade de pendentes acima de 3 segundos em duas coletas consecutivas; revisar imediatamente qualquer lease vencida, falha persistente ou resultado desconhecido. Resultado desconhecido exige reconciliação antes de repetir operação externa. Readiness PostgreSQL 503 requer restaurar a dependência e verificar a fila depois da recuperação.

Esses critérios derivam dos intervalos atuais de polling/lease e servem como alertas de diagnóstico no desenvolvimento. Não são SLO de produção; o limiar de fila e a disponibilidade real do worker precisam de coleta sustentada e heartbeat durável antes de operação comercial. Nenhum monitoramento externo é configurado.
