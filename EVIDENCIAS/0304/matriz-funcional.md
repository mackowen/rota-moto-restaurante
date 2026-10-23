# Matriz de funcionalidades — Rotas V2

| Funcionalidade | Fonte/implementação | Estado auditado no checkpoint |
|---|---|---|
| Lista de planos | `state.routes`, sem tombstones | Implementada em UI; Browser render autenticado pendente. |
| Entregas elegíveis | projeção atual dos pedidos/entregas e regras da aplicação | Contagem e lista usam dados existentes; fluxo de seleção E2E pendente. |
| Motoboys | `state.bikes` / dados do tenant | Contagem de cadastros; atualização online/presença não inferida. |
| Seleção do plano | `data-route-select`, ID canônico | Seleção acessível e atualização de detalhe implementadas; Browser E2E pendente. |
| Ordem das paradas | `Route.deliveryIds` e posição de entrega existente | Detalhe mostra sequência persistida; novo salvamento/reordenação não foi testado nesta campanha. |
| Persistência local | store IndexedDB `routes` | Rotina existente reutilizada; reload/readback E2E desta campanha não concluído. |
| Sincronização | outbox/revisões/protocolo v1 | Código legado preservado; conflito e confirmação server-side não demonstrados. |
| Marcadores | coordenadas válidas de pedidos/localizações | Não desenhar marcador sem coordenada validada; endereços continuam listados. |
| Geometria da rota | endpoint e serviço existentes | Não fabricar reta, distância ou ETA; resultado depende do serviço de geometria válido. |
| Tema | mapa Leaflet e runtime de tema existente | Suporte preservado; captura pós-change autenticada não executada. |
| Filtros do mapa | controlos com camada de dados do mapa | Elementos conectados ao estado da camada; comportamento Browser ainda não testado. |
| Centralizar/ajustar/fullscreen/atualizar | controles existentes no módulo | Preservados no markup/handlers existentes; verificação de interação pós-change pendente. |
| Abrir pedido | ação contextual `data-detail` já existente | Ligação preservada; clique não exercitado na sessão autenticada. |
| Conta/tenant/RBAC | identity session guard, contrato e middleware existentes | Não bypassado; validação Browser desta campanha bloqueada no login 403. |
| Offline | estado local-first e indicadores existentes | Sem confirmação remota inventada; reconexão/reload do fluxo pós-change pendente. |

Não declarar funções como verificadas só por existirem no DOM ou passarem testes estáticos.
