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

O vínculo de execução é mantido somente no servidor: cada Membership pode apontar para zero ou um `Driver` canônico da mesma Company, e cada Driver pode estar associado a no máximo uma Membership. A associação exige uma operação administrativa autorizada; não é inferida por email, perfil local, `source.app` ou `actor`. A sessão retorna o `driverId` resolvido pelo servidor; ele não é autoridade quando enviado pelo cliente.

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

## Fatos de execução e projeção de Delivery

O Motoboy emite `DELIVERY_ACCEPTED`, `DELIVERY_PICKED_UP`, `DELIVERY_STARTED`, `DELIVERY_ARRIVED`, `DELIVERY_COMPLETED`, `DELIVERY_FAILED` e `DELIVERY_RETURNED`. O servidor valida cada transição contra o estado canônico e atualiza a projeção de Delivery na mesma transação do fato. `acceptedAt`, `pickedUpAt`, `arrivedAt` e `completedAt` registram o instante de cada fato; `DELIVERY_STARTED` só preenche `pickedUpAt` como compatibilidade para execuções legadas sem evento de coleta. Repetir o mesmo eventId/fato é idempotente.

## Revisões e ACK de operações
- `source.app` é metadado declarativo e nunca autentica nem autoriza um aplicativo. A API vincula uma instalação a tenant, usuário autenticado e chave de aplicativo em registro server-side; cada push/pull precisa usar essa instalação.
- O envelope v1 permanece compatível. A resposta de push inclui `operationResults`, um resultado por operação, com `status` (`accepted`, `duplicate`, `rejected` ou `conflict`), `entity`, `localId`, `canonicalId` quando conhecido, `canonicalVersion` quando conhecido e `error.code` estável quando não aceita. HTTP 200 confirma apenas o processamento do pacote; não implica aceite de todas as operações.
- `packetId` repetido com o mesmo digest devolve o mesmo resultado idempotente; conteúdo diferente com o mesmo `packetId` é conflito. `eventId` repetido com o mesmo fato é `duplicate`; reutilizado com fato diferente é conflito.
- Revisões canônicas são controladas pelo servidor. Atualização concorrente ou baseada em revisão obsoleta retorna `conflict` com a revisão canônica. Não há last-write-wins genérico. Nenhuma operação rejeitada apaga/atualiza a cópia local pendente.
- Pull usa cursor keyset estável; aplicar a mesma página/eventos mais de uma vez deve ser idempotente. O cliente só avança cursor e remove outbox após ACK inequívoco, preservando operações em conflito ou sem rede.
- Pull e leituras de domínio do Motoboy são limitados ao `Driver` da sessão server-side e às Deliveries atualmente atribuídas a ele; filtros `driverId` enviados pelo cliente não ampliam acesso. Push de DeliveryEvent, LocationPoint e DeliveryProof verifica a atribuição atual sob lock da Delivery. Após reatribuição, fatos pendentes do motorista anterior são rejeitados como `DRIVER_NOT_ASSIGNED` sem apagar fatos já aceitos; o servidor envia a ele somente uma notificação mínima `CANONICAL_ASSIGNMENT_REVOKED`, que encerra a projeção local sem tombstonar nem apagar o histórico.

## Relações e payloads canônicos (schema v1 aditivo)

- Todo registro canônico tem id, companyId, createdAt, updatedAt e revisão inteira positiva version. IDs locais são aceitos somente como referências de operação; o servidor grava UUID canônico e devolve o alias.
- Order: identidade e dados comerciais do pedido pertencem ao Restaurante. Campos conhecidos incluem number, customer, phone, address, notes, items, payments, source e externalId; montantes canônicos usam amountMinor inteiro e currency ISO 4217. Campos legados continuam locais/compatíveis até serem mapeados sem perda.
- Driver: cadastro administrativo do Restaurante/servidor; campos contratuais comuns são name, phone, email e status. Autenticação/User/Membership não se duplicam em Driver.
- Route: autoridade de planejamento do Restaurante. deliveryIds é uma lista de 0..500 IDs canônicos das entregas atualmente planejadas. A relação só existe neste campo; não existe Delivery.routeId inverso. Uma Delivery aparece em no máximo uma lista de Route não tombstonada. O serviço resolve os IDs, verifica tenant/existência, serializa mudanças concorrentes e rejeita duplicidade com ROUTE_DELIVERY_ALREADY_ACTIVE. Remoções/adições são preservadas em audit_log, sem apagar fatos/eventos.
- Delivery: liga orderId e opcionalmente driverId; estados, transições, atribuição/cancelamento e campos de execução continuam sujeitos às autoridades já descritas acima. Tombstone é revisão canônica e não apaga fatos.
- DeliveryEvent: eventId, entity, entityId, type, occurredAt, actor, payload e protocolVersion; append-only. Correção gera outro fato.
- LocationPoint: id, deliveryId, latitude, longitude, recordedAt e, quando disponível, accuracyM/eventId. Latitude/longitude devem estar em [-90,90]/[-180,180].
- DeliveryProof: metadados (id, deliveryId, kind, createdAt, revisão) e media com MIME permitido (image/png ou image/jpeg), tamanho até 8 MiB, SHA-256 e storageRef (provider + objectKey). O backend não aceita Data URL canônica enquanto não houver storage de blobs configurado; Data URLs PNG/JPEG legadas permanecem locais e podem constar em backup sensível, limitadas a 8 MiB.
- Earning: somente Restaurante calcula/escreve. amountMinor é inteiro seguro na unidade monetária mínima, currency é explícita, components é lista tipada de code + valores inteiros assinados, e rule/ruleVersion são opcionais. Não existe fórmula rígida no schema. Payload legado decimal recebe adaptação determinística a centavos BRL na entrada; a representação persistida é amountMinor + moeda.
- Extensibilidade: campos adicionais canônicos devem usar x_<namespace>_<field> ou o objeto extensions; campos desconhecidos sem namespace são inválidos no validador compartilhado. Entidades legadas preservadas fora do payload canônico não são descartadas por essa regra.

## Backup Local-First v1

O envelope format=rotamoto-local-backup, version=1 contém app, exportedAt, databaseSchemaVersion e snapshots de todas as stores IndexedDB. Export remove campos de senha/hash, sessão/cookie, CSRF, MFA, tokens e secrets. Mídia inline legada é mantida somente para PNG/JPEG até 8 MiB por arquivo. O envelope indica contentProtection=plaintext-sensitive: export não é cifrado e deve ser protegido pelo operador; não existe chave/UX aprovada para criptografia.

Restauração v1 oferece merge não destrutivo: acrescenta apenas chaves ausentes; colisões preservam o registro atual, incluindo settings, dados e operações de sync pendentes/conflitos. A transação abrange as stores e é atômica no IndexedDB. Backups legados versão 8 continuam aceitos pelo adaptador. Replace de dados atuais, import de credenciais e export cifrado não são oferecidos.
