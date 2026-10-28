# Contrato local de Relatórios operacionais e financeiros

Este documento descreve uma API e uma apresentação exclusivas do aplicativo Restaurante. Não integra o contrato interoperável de sincronização definido em `../CONTRACT.md`.

- `GET /api/logistics/analytics` lê o PostgreSQL no escopo da empresa autenticada e representa o histórico empresarial. Não aplica período, status, origem, modalidade ou filtro de motoboy; `scope.filtersApplied: false` deixa isso explícito.
- `scope.basis` usa `company-history`. `coverage` separa entregas canônicas, entregas concluídas, entregas sem alocação e pedidos sem entrega canônica. Contadores de integração representam solicitações/cotações e podem ser zero mesmo quando existem entregas.
- `integrations[].code` e `providerId` são identificadores internos estáveis. `integrations[].displayName` é o nome apresentado ao usuário; a interface não exibe valores internos, como `internal_fleet`.
- `financial.diagnostics` contém somente contagens dos motivos e dos campos ausentes/inválidos de `Order.money` nos pedidos não cancelados. Não contém valores por pedido, não altera `financial.coverage` nem completa valores ausentes. Uma composição comercial só é completa quando campos canônicos, moeda e proveniência são válidos; isso não comprova recebimento ou liquidação bancária.
