# Intervenção complementar — visual e responsividade (2026-10-24)

Campanha 0304 permanece aberta e PARTIAL. G14 permanece FAIL pela reprovação expressa do proprietário. As imagens de referência originais não foram alteradas.

## Capturas e método

- `0304-intervencao-visual-comparison.json`: 26 medições do renderer `routes()` de produção, estado vazio e pedido de fixture sintética controlada; fases `before` usam o HEAD inicial 2000b18 e `after` o worktree. Viewports 320, 360, 390, 430, 600, 768, 1024, 1280, 1440 e 1920 px; claro/escuro. Os estados com pedido usam texto sintético e não escrevem em IndexedDB/API/banco.
- `0304-rotas-*.png`: capturas antes/depois do renderer e cartões sintéticos. A fixture não monta Leaflet; portanto, não representa a captura cartográfica abaixo.
- `0304-shell-before-visual-report.json` e `0304-shell-visual-report.json`: Início/Pedidos no renderer CDP isolado, 1024, 1280, 1440 e 1920 px, dois temas, sidebar expandida/recolhida; antes usa os estilos de `HEAD` para `dashboard-v2.css` e `orders-v2.css`, depois usa os estilos corrigidos.
- `0304-shell-before-*.png` e `0304-shell-*.png`: capturas correspondentes antes/depois. Os pedidos são fixtures; não são sessões operacionais.
- `map-runtime-diagnostic.json` e `map-real-cartography-1280x800-dark.png`: execução isolada do runtime Leaflet real com Chromium sem GPU, vista neutra padrão, sem entregas, motoboys, marcadores ou coordenadas operacionais.

CDP usou Chromium headless com emulação de viewport. Não equivale ao Chrome Android físico. Não houve autenticação nesta rodada. As quatro capturas recentes mencionadas pelo proprietário não estavam disponíveis no diretório Download consultado; não foram presumidas nem substituídas.

## Matriz de comparação desta intervenção

| Elemento | Estado de referência/antes | Ajuste realizado | Evidência/resultado | Pendência |
|---|---|---|---|---|
| Filtros Rotas mobile | “Ajustar” ficava isolado em outra linha; barra fragmentada. | Cinco controles em cinco colunas compactas no celular/tablet retrato. | 5/5 controles dentro da viewport em 320–430 px, claro/escuro; nenhum corte/overlap medido. | Conferência tátil no Chrome Android. |
| Resumo e abas Rotas/Entregas | Contagens repetidas nos indicadores e nas abas. | Valores permanecem no resumo semântico; removidos badges redundantes das abas. | `test-routes-v2.js` e 26 medições. | Proprietário conferir hierarquia contra a referência. |
| Vazio de planejamento | Superfície e espaçamento fragmentados. | Estado compacto com borda tracejada e explicação curta. | Capturas mobile/tablet/PC em dois temas. | Comparação humana final. |
| Navegação inferior | Regra route-scoped reduzia o padding inferior a 18 px. | Reservados 100 px + `safe-area-inset-bottom`. | No scroll inferior, conteúdo visível ficou 27,6–27,8 px acima da navegação em 320–390 px; sem overlap medido. | Android físico para safe-area real. |
| Início desktop | Saudação tinha padding superior excessivo em larguras até 1199 px; hierarquia já usa header compartilhado. | Padding superior reduzido de 32 para 14 px somente nesse breakpoint. | 32 linhas comparativas Home/Pedidos; sem overflow documental nem rótulo duplicado. | Conteúdo/dados e Chrome Android em modo computador reais. |
| Pedidos desktop | Em 1024 px não havia painel lateral; em telas largas o painel tinha 285 px e a lista repetia colunas/ações. | Lista resumida; detalhes/ações no painel; painel mínimo 320 px e máximo 380 px. | Painel medido: 320 px em 1024/1280, 329,3 px em 1440 e 380 px em 1920; antes 0 px em 1024 e 285 px em 1280+. | Seleção e ações com sessão autenticada. |
| Mapa escuro | Fallback Carto retornava imagem HTTP 200 com “API KEY REQUIRED”; a validação por `naturalWidth` aceitava a imagem como cartografia. | Fallback dark passou a tiles OSM sem chave e filtro escuro CSS aplicado somente à camada raster. | Vinte respostas de tile OSM 200 no teste isolado; captura exibe cartografia real no fallback. | Teste de rede/tiles em Chrome Android e validação de atribuição no dispositivo. |
| Rotas PC | Sem seleção não havia necessidade de coluna de detalhes; com seleção a composição usa lista/mapa/detalhes. | Mantido comportamento responsivo existente; mapa central permanece dominante; ajustes desta rodada focaram filtros e fallback. | Capturas 1024–1920; mapa isolado carregou OSM após falha do renderer vetorial induzida por `--disable-gpu`. | E2E autenticado com seleção real e comparação final pelo proprietário. |

## Testes

- `npm test` Restaurante: PASS nesta execução completa.
- Testes direcionados: `test-cartography-contract.js`, `test-map-runtime-lifecycle.js`, `test-routes-v2.js`, `test-navigation-shell-renderer.js`, `test-dashboard-v2.js`, `test-dispatch-assignment.js`, `test-printing-offline.js`, `test-visual-shell-cache.js`: PASS.
- `node --input-type=module --check < map-runtime.js`, `node --check app.js`, `node --check sw.js`, `node --check vendor/maplibre/rotamoto-map-runtime.js`, `git diff --check`: PASS.
- CDP visual: 26 linhas de Rotas e 32 combinações Home/Pedidos; sem overflow documental/labels duplicados. Medições são de fixture e não comprovam fluxos autenticados.
- E2E operacional autenticado pós-patch: BLOCKED nesta rodada; sem usuário/tenant sintético com fluxo MFA e limpeza verificável disponível. Nenhum bypass foi tentado.

## Limites e gates

G3, G4, G5, G6 e G15 permanecem PARTIAL. G7 continua PARTIAL. G8 PASS somente para persistência local-first; G9–G13 conservam os escopos e limitações do checkpoint cross-app durável anterior. G14 continua **FAIL / PENDING_USER_APPROVAL**. Banco oficial não foi acessado para escrita; Motoboy e Browser QA não foram modificados. Não há PASS global.
