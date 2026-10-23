# Campanha 0304 — auditoria inicial e checkpoint

Data: 2026-10-23. Restaurante branch `codex/campaign-0304-rotas-v2`, ponto inicial `f80ffd423425fc26f59b70536a152ff33a775d97`; baseline tag `v5.50-ui-mobile-fix5` preservada em `9ebb7098725200bdec82e79be1e9ea622fe20120`. Motoboy branch/HEAD registrados antes do trabalho: `codex/campaign-0295-backup-team-dispatch` / `64d2e13d8e455f48b20b32b396e9c49ba7553e0b`, limpo. Histórico: `codex/campaign-0303-ui-refinements` / `fe1e4e25dcf2937e8eb904edbe32e40a7640152b`, limpo. Browser QA: `codex/campaign-0294-admin-settings` / `6f63660700150934efb3f8157022caaa489a8cd1`, com 989 alterações locais preexistentes (deletions); preservadas.

Arquivos inicialmente previstos: `app.js`, `index.html`, CSS da composição Rotas, testes direcionados e evidências. Addendum 0303-A afetou também `dashboard-v2.js`, `dashboard-v2.css` e `tests/test-dashboard-width-contract.js`. Nenhuma migration, banco oficial, serviço ou configuração foi modificada. Reversão: `git revert <commit-local-da-implementação>`; tags e históricos publicados não são reescritos.

## Referências G0

Originais localizados em `/storage/emulated/0/Download/`; cópias de trabalho preservadas em `REFERENCIAS/`.

| Arquivo | Medida | SHA-256 |
|---|---:|---|
| `rotas-celular.png` | 1536×1024 | `3a7ce349bd189acbbcd80204c934abcae7a4ce25c0061a342147348ebae1e257` |
| `rotas-tablet.png` | 1536×1024 | `3f1c6ec3cfdde2b4d00aad1a242c2130551d232fde6927422be2eda01c567e8e` |
| `rotas-pc.png` | 1536×1024 | `4b6cdb21b8890f1e5b18fca0805ecaa898af18366a7e5fd89e27cd2a3f4f8f88` |

As três referências foram abertas e identificadas: celular mapa-primeiro com tema claro/escuro; tablet sidebar e painéis de mapa/detalhe; PC sidebar, lista, mapa dominante e painel de sequência. Os desenhos foram analisados, sem atribuir-lhes uma nota de fidelidade final.

## Matriz de contratos e capacidades

| Área | Contrato/implementação auditada | Situação / limite |
|---|---|---|
| Contrato entre apps | `CONTRACT.md`, `contract.js` em ambos | Paridade existente; `rotamoto-sync v1`. |
| Rota/paradas | `Route.deliveryIds` é a lista canônica ordenada; rota não tem `driverId` canônico | Implementado; não inferir associação de motoboy na entidade Route. |
| Associação duplicada | Uma entrega em no máximo uma rota não tombstoned; serviço serializa e responde `ROUTE_DELIVERY_ALREADY_ACTIVE` | Implementado no backend; E2E Browser da campanha ainda não verificou. |
| Concorrência | Revisões esperadas; sem last-write-wins | Implementado no contrato/serviço; cenário concorrente não executado nesta campanha. |
| Persistência local | IndexedDB `routes`, `orders`, `deliveries`, `bikes`, `locations`, filas e tombstones | Serviços disponíveis; fluxos da campanha pendentes de confirmação E2E. |
| Geometria | `/api/logistics/routes/:id/geometry`, providers OSRM/ORS, fail-closed sem origem/coordenadas | Disponível no código; provedor/credencial e Browser geometry por validar. |
| Mapa | Leaflet, `map-runtime.js`, tema, clustering e camadas existentes | Implementado; integração pós-redesenho ainda sem captura Browser autenticada. |
| Dono operacional | Restaurante planeja; Motoboy executa e registra localização/comprovante | Limites contratuais preservados; não houve escrita no aplicativo Motoboy. |
| RBAC/tenant | Sessão/empresa e permissões existentes | Lógica preservada; isolamento não foi testado nesta rodada de Browser. |
| Offline/sync | Outbox/inbox, revisões, IDs canônicos, conflitos e sync v1 | Código existente; resiliência cross-app não exercitada. |
| Coordenadas ausentes | Endereço permanece disponível; sem marcador ou rota fabricados | No mapa de Rotas foi removida geocodificação implícita por Nominatim; apenas coordenadas válidas são marcadas. |

## Matriz de componentes e funções tocadas

| Arquivo | Responsabilidade | Verificação |
|---|---|---|
| `app.js` | Composição V2 de Rotas, contagens reais, seleção/detalhes, limites de coordenadas e carregamento do mapa | `node --check`; testes de logística e geometria. |
| `routes-v2.css` | Grid responsivo da aba, painel e mapa primeiro no celular | Smoke test source/breakpoints; comparação visual real pendente. |
| `dashboard-v2.js` | Cabeçalho da Home usando classes compartilhadas com abas operacionais (adendo 0303-A) | Teste de contrato de cabeçalho; renderer isolado capturado. |
| `dashboard-v2.css` | Retirada do gutter duplicado até 1199 px e composição do header V2 compartilhado | Medições 390 px before/after no relatório do adendo; viewport físico/autenticado pendente. |
| `index.html` | Inclusão e versão do CSS V2 de Rotas | Checagem estática. |
| `tests/test-routes-v2.js` | Coordenadas válidas, ausência de geocode tácito, mapa-primeiro e dados não fabricados | PASS. |
| `tests/test-dashboard-width-contract.js` | Gutter, classes do header e proibição de compensações posicionais | PASS. |

## Browser/DB

Chromium/CDP chegou à tela de identidade; `/api/identity/login` respondeu HTTP 403. A sessão autenticada e a jornada de rota não foram concluídas. Tentativas E2E no banco exclusivo `rotamoto_e2e` encerraram com manifests FAILED/INTERRUPTED, `databaseCommitted=false`; não se declara cleanup PASS sem prova legível de cada manifest. Banco oficial foi apenas protegido como read-only, sem query de escrita.

Capturas 0303-A do gate de login não são capturas de comparação dos painéis. Capturas Home do renderer isolado estão marcadas como sintéticas e não comprovam autorização, funcionalidades nem aprovação visual. Ver `capturas/0303-A-home-render-report.json` e `capturas/0303-A-visual-report.json`.

## Checkpoint e rollback

Checkpoint auditado: referências identificadas, contratos mapeados, bug de geocoding tácito removido, mapa Rotas e seletor/detalhes implementados, gutter e header da Home corrigidos na fonte. Ainda não há gates globais PASS. Para reverter commits locais de aplicação, usar `git revert` sobre o SHA do commit final; não tocar em `v5.50-ui-mobile-fix5`, bancos ou processos. O histórico somente recebe atualização fast-forward autorizada; aplicação e Browser QA não recebem push.
