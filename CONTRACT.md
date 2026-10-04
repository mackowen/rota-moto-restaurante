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

## Autoridade de escrita e leitura
- `Company`: identidade e servidor; nenhum cliente altera tenant, memberships ou identificadores canônicos.
- `Order`: Restaurante escreve; Motoboy somente consome.
- `Earning`: Restaurante calcula e escreve o valor canônico. Motoboy somente consulta. O Motoboy não publica Earnings; fatos logísticos necessários ao cálculo são sincronizados como execução da entrega.
- `Delivery`: entidade compartilhada. Restaurante cria, atribui, planeja e pode cancelar administrativamente; Motoboy grava somente fatos/estados de execução autorizados pelo servidor. Campos comerciais e de planejamento não podem ser sobrescritos pelo Motoboy; campos de execução não podem ser reescritos pelo Restaurante.
- `DeliveryEvent`: fato append-only, imutável e idempotente por `eventId`.
- `LocationPoint` e `DeliveryProof`: Motoboy escreve; Restaurante lê.
- `Route`: Restaurante planeja e escreve; Motoboy consome o planejamento e reporta execução em eventos/dados logísticos, sem reescrever a rota canônica.
- `Driver`: cadastro/identidade e vínculo administrativo são controlados pelo Restaurante/servidor; o Motoboy não sincroniza alterações de cadastro. Dados próprios da execução do motorista permanecem eventos/dados logísticos.
- Preferências, ajustes e projeções de tela (incluindo `races`) são locais e não viram entidades canônicas sem definição explícita no contrato.

## Revisões e ACK de operações
- `source.app` é metadado declarativo e nunca autentica nem autoriza um aplicativo. A API vincula uma instalação a tenant, usuário autenticado e chave de aplicativo em registro server-side; cada push/pull precisa usar essa instalação.
- O envelope v1 permanece compatível. A resposta de push inclui `operationResults`, um resultado por operação, com `status` (`accepted`, `duplicate`, `rejected` ou `conflict`), `entity`, `localId`, `canonicalId` quando conhecido, `canonicalVersion` quando conhecido e `error.code` estável quando não aceita. HTTP 200 confirma apenas o processamento do pacote; não implica aceite de todas as operações.
- `packetId` repetido com o mesmo digest devolve o mesmo resultado idempotente; conteúdo diferente com o mesmo `packetId` é conflito. `eventId` repetido com o mesmo fato é `duplicate`; reutilizado com fato diferente é conflito.
- Revisões canônicas são controladas pelo servidor. Atualização concorrente ou baseada em revisão obsoleta retorna `conflict` com a revisão canônica. Não há last-write-wins genérico. Nenhuma operação rejeitada apaga/atualiza a cópia local pendente.
- Pull usa cursor keyset estável; aplicar a mesma página/eventos mais de uma vez deve ser idempotente. O cliente só avança cursor e remove outbox após ACK inequívoco, preservando operações em conflito ou sem rede.
