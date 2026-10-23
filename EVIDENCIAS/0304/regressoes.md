# Regressões e testes — checkpoint 0304

## PASS

- `node tests/test-routes-v2.js`
- `node tests/test-dashboard-width-contract.js`
- `node tests/test-dashboard-semantics.js`
- `node tests/test-dashboard-v2.js`
- `node --check app.js`
- `node --check dashboard-v2.js`
- `node tests/test-planned-route-geometry.js`
- `node tests/test-map-runtime-lifecycle.js`
- `node tests/test-route-origin-settings.js`
- `node tests/test-logistics-domain.js`
- `node tests/test-logistics-http.js`
- `node tests/test-sync-contract.js`
- `node tests/test-cross-app-contract-parity.js`
- `git diff --check`
- `npm test` (suíte completa encadeada pelo package script; concluída com saída zero)
- Browser/CDP: medição objetiva do cabeçalho Home nos offsets 0/1/5/10/20/50/100/300 px em 320×720, 360×800, 390×844 e 430×932, temas claro/escuro; posição top 0 em todos. Evidência em [`0303-A-sticky-diagnostico.md`](capturas/0303-A-sticky-diagnostico.md) e JSON/screen captures adjacentes.
- Browser/CDP: comparação dos cabeçalhos componentizados Início/Pedidos/Rotas/Motoboys em 320/360/390/430 px, claro/escuro, 32 combinações; diferenças pós correção de X/larguras/alturas/gaps/distância direita foram 0 px. O renderer operacional autenticado não foi carregado devido ao HTTP 403, conforme limite documentado no adendo.
- Evidência antes/depois do alinhamento está em [`0303-A-alinhamento-horizontal.md`](capturas/0303-A-alinhamento-horizontal.md), com JSON e capturas claro/escuro de 390×844.

Os dois testes de semântica/integração inicialmente falharam porque aguardavam texto/classe antigos de Rotas e nome de asset/cache antigos; expectativas foram atualizadas para a composição V2 atual. Não houve remoção de cobertura.

## FAIL/BLOCKED

- Browser autenticado via CDP: HTTP 403 em `/api/identity/login`; a captura após Home/Orders/Routes/Bikes mostra tela de identidade, não as abas. Não conta como regressão funcional PASS.
- Criação/edição/reordenação/readback após reload de rota: não executado no Browser.
- Testes pós-change de notificações, Conta, Nova corrida, pedidos/impressão, filtros Pedidos, navegação More, mapa e Motoboys: bloqueados pelo login.
- Comparação visual completa pós-correção: bloqueada pela ausência de tela autenticada. O renderer Home isolado só confirma geometria, não regressão global.
- Browser autenticado: os fluxos de rotas e as regressões interativas permanecem bloqueados apesar da suíte unitária completa passar.
- Chrome Android físico: proprietário deve avaliar.
