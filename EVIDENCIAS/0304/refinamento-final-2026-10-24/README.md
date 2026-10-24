# Refinamento final visual — 2026-10-24

Escopo cumulativo da Campanha 0304. Não encerra a campanha nem altera G14.

## Método e limites

- Chromium via CDP isolado na porta 9224; viewport e temas definidos por emulação.
- 102 cenários: Rotas em 9 larguras (320, 360, 390, 430, 768, 1024, 1280, 1440, 1920), claro/escuro e 0/1/5/20 entregas; Pedidos em 768/1024/1280/1440/1920, claro/escuro e 1/20 pedidos; Início em 1024/1280/1440/1920, claro/escuro.
- Início usou o renderer V2 de produção. Pedidos usou as funções de renderização da tabela, painel e ações extraídas do `app.js`. Rotas usou dados sintéticos controlados sem coordenadas; nenhuma rota, posição, distância ou ETA foi fabricada.
- O fixture não autentica, não consulta APIs, não grava IndexedDB ou PostgreSQL e não substitui E2E operacional. Não houve escrita em banco oficial.
- Referência PC original efetivamente aberta: [`rotas-pc.png`](../REFERENCIAS/rotas-pc.png). A captura aprovada apresenta controles superiores, planejamento à esquerda, mapa central e detalhes/paradas à direita. O fixture desta intervenção foi usado para examinar especificamente a lista de entregas à esquerda e mapa à direita, conforme a instrução vigente; ele não comprova equivalência visual com a composição completa da referência. **G14 continua FAIL**, sem aprovação do proprietário.

## Causas confirmadas e decisões

1. Em Pedidos, o endereço aparecia ao mesmo tempo na linha resumida e no painel completo. O painel lateral também começava sob o cabeçalho sticky em telas desktop. Em tablet estreito, a divisão em duas colunas comprimira a lista; agora 700–850 px usa fluxo vertical, e a seleção por teclado dá foco ao título do detalhe e leva o painel ao enquadramento após o `scrollend`.
2. Em Rotas desktop, a coluna da lista tem cerca de 225 px em 1280 px; cartão com texto e ação lado a lado deixava pouca largura útil ao texto e a ação ocupava uma largura desnecessária. Em 1024–1920 px, o cartão passa a empilhar conteúdo e usar botão de largura intrínseca. O mapa, filtros, cartões, legenda, tabs e estrutura geral foram preservados.
3. Início, renderizado com um conjunto controlado de quatro indicadores e um pedido, manteve os rótulos/valores legíveis. O espaço vazio restante decorre da amostra esparsa; nenhuma alteração foi justificada.
4. Não foi classificado como defeito o cabeçalho sticky, conteúdo passando por trás durante rolagem, controles fora do enquadramento ou espaço decorrente de poucos registros. Não houve alteração pelo círculo Uber.

## Capturas e medições

- [`orders-20-1280-light.png`](orders-20-1280-light.png) e [`orders-20-1280-dark.png`](orders-20-1280-dark.png): lista resumida, painel completo e detalhe selecionado com 20 itens.
- [`orders-selection-768-dark-scrollend.png`](orders-selection-768-dark-scrollend.png): seleção por teclado em tablet estreito; medição após evento de fim da rolagem: painel top 296,1 px, header bottom 76 px, foco no `H2`, painel visível.
- [`routes-20-1280-light.png`](routes-20-1280-light.png) e [`routes-20-1280-dark.png`](routes-20-1280-dark.png): lista longa rolável, mapa e controles preservados.
- [`routes-1-390-light.png`](routes-1-390-light.png) e [`routes-1-390-dark.png`](routes-1-390-dark.png): mapa e filtros mobile com uma entrega.
- [`home-1280-light.png`](home-1280-light.png) e [`home-1280-dark.png`](home-1280-dark.png): hierarquia e leitura do renderer Início sem preenchimento artificial.
- [`sticky-document-scroll.json`](sticky-document-scroll.json): scroll real de documento em fixture mobile 390×844, cabeçalho sticky medido em 0/1/5/10/20/50/100/300 px e no fim da página; posição vertical constante em 0 px, z-index 1500. É teste geométrico, sem validação de safe area física ou hardware.
- [`visual-measurements-before.json`](visual-measurements-before.json), [`visual-measurements-intermediate.json`](visual-measurements-intermediate.json) e [`visual-measurements.json`](visual-measurements.json): capturas e medidas anteriores/intermediárias/finais preservadas. O registro final contém 102 combinações.

## Resultados

- Testes unitários/contratuais direcionados: `test-navigation-shell-renderer.js`, `test-visual-shell-cache.js`, `test-routes-v2.js`, `test-dashboard-v2.js` e `test-dispatch-assignment.js`.
- Browser CDP fixture: dimensões, painéis, lista com 0/1/5/20 e rolagem interna verificados; 5/5 filtros presentes e com largura não-zero. A seleção do detalhe em tablet foi medida após `scrollend`, sem considerar a animação interrompida como falha.
- `npm test`: PASS, suíte completa terminou com exit code 0 após atualizar as expectativas de versão do shell. Testes dirigidos de navegação, cache, dashboard, despacho e Rotas também passaram.
- E2E autenticado: BLOCKED nesta rodada; a aplicação disponível abre a tela de login e não havia tenant/sessão MFA sintéticos com limpeza verificável. Nenhum bypass.
- Chrome Android físico e aprovação visual: pendentes do proprietário.

## Gates desta intervenção

| Área | Estado | Limite |
|---|---|---|
| Início desktop | PARTIAL | Renderer e dados sintéticos; fluxos autenticados não exercitados. |
| Pedidos desktop/tablet | PARTIAL | Resumo sem endereço duplicado, painel sticky e layout estreito medidos em fixture. |
| Rotas celular | PARTIAL | Nenhuma alteração mobile; filtros, mapa, legenda, cards e área segura preservados em CDP. |
| Rotas desktop | PARTIAL | Ação compacta e texto empilhado; comparação completa de referência e dados autenticados pendentes. |
| Scroll/teclado | PASS (fixture) | Scroll de lista, tecla/clique sintético, foco heading e painel enquadrado após evento `scrollend`; browser físico pendente. |
| Testes automatizados | PASS | `npm test`, cinco testes dirigidos, verificações de sintaxe e `git diff --check`. |
| E2E operacional | BLOCKED | Sem tenant e sessão MFA sintéticos autorizados nesta rodada. |
| G14 fidelidade/aprovação | **FAIL** | Reprovação anterior do proprietário mantida; aprovação somente pelo proprietário. |

Não houve alteração em Motoboy, Browser QA, contratos, sincronização, autenticação, MFA, RBAC, infraestrutura ou banco.
