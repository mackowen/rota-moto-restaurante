# RotaMoto — Contrato de Domínio e Sincronização v1

## Princípios
- IndexedDB é a persistência local de cada aplicativo.
- O contrato é compartilhado; os schemas internos podem ser diferentes.
- `Order` representa o pedido comercial.
- `Delivery` representa a execução logística.
- Eventos representam fatos ocorridos; estados são projeções derivadas.
- RotaMoto Restaurante é proprietário da operação comercial e do cálculo financeiro.
- RotaMoto é proprietário da execução do motoboy, GPS e prova de entrega.

## Identidade
Todo dado compartilhável usa `id` global, `companyId`, `createdAt`, `updatedAt` e `version`.

## Entidades
`Company`, `Driver`, `Order`, `Delivery`, `Route`, `DeliveryEvent`, `LocationPoint`, `DeliveryProof`, `Earning`.

## Estados de Delivery
`CREATED → ASSIGNED → ACCEPTED → PICKED_UP → OUT_FOR_DELIVERY → ARRIVED → DELIVERED`.
Alternativos: `CANCELLED`, `FAILED`, `RETURNED`, `REDELIVERY`.

Transições inválidas devem ser rejeitadas. Eventos não devem ser apagados para corrigir histórico.

## Propriedade
- Restaurante: Order, regras de cobrança, atribuição e planejamento.
- Motoboy: LocationPoint, DeliveryProof e eventos de execução.
- Delivery é compartilhada, mas cada aplicativo altera somente os campos permitidos pelo domínio.

## Sincronização
Pacotes usam `protocol='rotamoto-sync'`, `protocolVersion=1`, `schemaVersion=1`, `packetId` único e `deviceId`.
Cada aplicativo mantém `outbox`, `inbox`, `tombstones` e `syncState`.
Eventos devem ser idempotentes por `eventId` e pacotes por `packetId`.

## Exclusão
Dados sincronizáveis usam tombstone (`deletedAt`) em vez de remoção física imediata.

## Compatibilidade
`appVersion`, `protocolVersion` e `schemaVersion` são independentes. Alterações incompatíveis exigem incremento de protocolo/schema e migração explícita.
