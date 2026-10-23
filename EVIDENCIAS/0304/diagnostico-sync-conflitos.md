# Diagnóstico de sync e concorrência — checkpoint 0304

O contrato continua `rotamoto-sync v1`. A rota mantém revisões esperadas e lista ordenada canônica; o serviço de sincronização serializa mutações e rejeita entrega já associada a uma rota ativa. Identificadores canônicos, `eventId`, `packetId`, outbox/inbox e tombstones não foram alterados.

## Cenários

| Cenário solicitado | Resultado nesta campanha |
|---|---|
| Duas sessões planejam a mesma entrega | Não executado; Browser E2E não autenticou (HTTP 403). Regra server-side permanece fail-closed e unit/HTTP tests direcionados passaram. |
| Estado operacional muda enquanto editor está aberto | Não executado. |
| Reload durante edição | Não executado. |
| Falha após salvar / ACK perdido / retry idempotente | Não executado. |
| Reenvio duplicado de evento | Sem alteração do protocolo; cenário desta campanha não executado. |
| Edição com revisão antiga | Regra contratual de conflito identificada; UI de resolução/readback não exercitada. |
| Reconexão e offline | Não executado pós-change. |
| Tenant/RBAC adversarial | Não executado em Browser; não se inferiu PASS do isolamento apenas da inspeção de código. |

As tentativas do harness Browser no banco de E2E ficaram com `databaseCommitted=false`, mas duas tiveram status INTERRUPTED/FAILED. Não se atribui `cleanup PASS` sem auditar manifests e contagens residuais. Banco oficial e Motoboy não foram escritos.
