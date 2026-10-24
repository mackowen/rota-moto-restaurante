# Matriz visual — intervenção consolidada 0304

**Estado:** comparação técnica PARTIAL; G14 permanece **FAIL** por reprovação anterior e aguarda avaliação expressa do proprietário. Esta matriz acrescenta evidência e não substitui decisões ou pendências anteriores.

## Matriz de divergências

| Elemento | Referência aprovada | Antes desta intervenção | Alteração/medida após | Resultado e limite |
|---|---|---|---|---|
| Sidebar expandida | Um ícone e um nome completo por item | O checkpoint anterior apontava correção já integrada, mas a duplicação ainda era objeto de verificação | `navButton()` continua produzindo exatamente um `.nav-label`; teste percorre Operação, Gestão, Administração e Suporte | PASS técnico do renderer; estados de RBAC autenticados não reexecutados |
| Sidebar recolhida | Ícones centrados, tooltip e nome acessível | Já coberto pelo renderer compartilhado | Testes verificam `title`, `aria-label`, `aria-expanded`, expandir/recolher e persistência local | PASS unitário; reload autenticado não reexecutado |
| Cabeçalho desktop | Conteúdo alinhado com gutter consistente; título e ações na mesma estrutura | Shell compartilhado já padronizado; sem divergência estrutural demonstrada na origem atual | Mantido o componente global; gutter desktop semântico de até 32 px. Capturas anteriores de Início/Pedidos/Rotas mostram a mesma estrutura | Sem mudança isolada de CSS. Regressão coberta por testes e capturas existentes; aprovação humana pendente |
| Cabeçalho mobile / botão `+` | Logo, ações e ícones visíveis e funcionais | Correção do shell e do ícone `+` já estava em `main` | Capturas anteriores e testes de dashboard confirmam `+` visível. As novas capturas mostram logo, sino e botão compacto, mas não testam clique autenticado | PASS de layout fixture; ação funcional permanece apoiada pelos testes anteriores, sem nova sessão autenticada |
| Hierarquia celular | Filtros antes do mapa; mapa proeminente; legenda, resumo e listas depois | Três indicadores precediam mapa; y=212,8 px em 390×844 no renderer vazio | Filtros y=67, mapa y=157; o resumo real vem abaixo do mapa. Redução de 55,8 px no início do mapa em 390×844 | PARTIAL: alinhamento hierárquico melhor; referência tem filtros de estado distintos e a comparação final do proprietário continua pendente |
| Abas Rotas/Entregas | Alternância compacta abaixo do mapa, integrada à lista | Duas faixas grandes ocupavam toda a largura | Botões content-sized, 36 px de altura, em uma barra; contadores separados e derivados do estado | PASS técnico de composição; clique operacional não repetido nesta sessão |
| Mapa e estados | Mapa dominante; legenda e avisos sem sobreposição | Layout já mapa-primeiro, mas com informação fragmentada | Canvas e controles preservados. Nos estados sem coordenadas, avisos, legenda e texto seguem fluxo separado; 5/5 filtros visíveis | PASS de visibilidade/overlap na fixture; sem tiles ou coordenadas reais, fidelidade cartográfica PARTIAL |
| Cartão de entrega | Pedido/status, cliente/endereço e ação bem alinhados, conforme Pedidos V2 | Card tinha apenas divisor superior e ação neutra | Superfície única com status, texto quebrável e botão primário “Abrir pedido”; conteúdo de teste exclusivamente sintético | PASS visual fixture. `#1234` não aparece no código de produto |
| Vazio de planejamento | Estado compacto integrado à lista | Texto isolado, sem contexto | “Nenhuma rota planejada” com explicação em linha curta, sem cartão aninhado ou CTA decorativo | PASS estrutural para empty-state |
| Tablet retrato | Mapa dominante, composição própria | Retrato já tinha fluxo vertical | Regra de retrato em coluna única preservada; captura 768×1024 mantém mapa com 628,5 px | PARTIAL: fixture vazia, sem navegação autenticada |
| Tablet paisagem | Duas áreas quando a largura é limitada; detalhes abaixo | Três colunas apertadas em larguras 760–1023 | Lista/mapa em duas áreas e detalhes abaixo; sem reserva de terceira coluna vazia | PASS de composição no renderer; validação física pendente |
| PC sem rota selecionada | Lista lateral e mapa central dominante, sem painel vazio ornamental | Coluna de detalhes reservava espaço sem conteúdo e limitava o mapa | Grid colapsa para lista + mapa se não houver rota selecionada; 1280×800 mede 678,2 px de mapa no estado sem seleção | PASS estrutural; visual fixture não representa conteúdo operacional real |
| PC com rota selecionada | Lista à esquerda, mapa central, detalhes à direita | 1280×800 tinha cerca de 434 px no mapa, conforme checkpoint prévio | 1280: mapa 460×512 e detalhes 245 px; 1440: mapa 597,2×576, detalhe 254,1 px; 1920: mapa 835,8×650, detalhe 355,7 px | PARTIAL: distribuição conforme referência; rota e paradas são sintéticas e sem cartografia |

## Medições representativas

Medidas CSS extraídas por `getBoundingClientRect()` no renderer isolado; todas as 26 medições da fixture sem rota selecionada registraram 5/5 filtros dentro da viewport, sem overflow horizontal documental e sem interseções entre filtros, vazio, legenda, texto cartográfico e estado.

| Viewport | Tema | Canvas do mapa | Observação |
|---:|---|---:|---|
| 320×720 | claro/escuro | largura útil; altura adaptável | sem corte documental; `Ajustar` fica na segunda linha |
| 390×844 | claro/escuro | 366×303,8; y=157 | antes: y=212,8; resumo após o mapa |
| 600×960 | claro/escuro | 504 px de largura | sidebar compacta |
| 768×1024 | claro/escuro | 628,5×532,5 | retrato, uma coluna |
| 1024×768 | claro/escuro | 457,4×445,4 | duas áreas; detalhes após os painéis |
| 1280×800, vazio | claro/escuro | 678,2×512 | grade adaptada a lista + mapa |
| 1280×800, selecionada | claro/escuro | 460×512 | painel de detalhes de 245 px |
| 1440×900, selecionada | claro/escuro | 597,2×576 | painel de detalhes de 254,1 px |
| 1920×1080, selecionada | claro/escuro | 835,8×650 | painel de detalhes de 355,7 px |

As capturas `before/after`, estados com entrega sintética e rota selecionada ficam nos diretórios desta evidência. O fixture de apresentação não usa autenticação nem grava dados.

## Gates da intervenção

| Gate | Estado | Evidência |
|---|---|---|
| Sidebar: rótulo único e recolhimento acessível | PASS técnico | `test-navigation-shell-renderer.js`; sem E2E RBAC nesta sessão |
| Header compartilhado e gutter desktop | PARTIAL | shell já compartilhado; geometria anterior preservada; sem mudança necessária no componente |
| Rotas mobile: hierarquia/mapa/controles | PARTIAL | Capturas 320–430, ambos temas; 5/5 filtros e sem overlaps na fixture |
| Cartões e estado vazio | PASS fixture | card sintético controlado e vazio conciso; sem pedido fixo no código |
| Tablet | PARTIAL | retrato e paisagem em fixture, sem navegação física |
| PC e largura cartográfica | PARTIAL | medições vazio/selecionado; tiles e localização real não validados |
| Regressão automatizada Restaurante | PASS | `npm test`, `test-routes-v2.js`, `test-navigation-shell-renderer.js`, `node --check`, `git diff --check` |
| E2E autenticado pós-correção | BLOCKED | Nenhuma sessão MFA/tenant sintético limpa preparada nesta execução; fixture CDP não é autenticação |
| Aprovação visual final G14 | FAIL | Reprovação anterior permanece até aprovação expressa do proprietário |

**Sem PASS global.** A campanha permanece PARTIAL e aberta; G8/G9/G10/G11/G12/G13 e demais pendências mantêm o escopo comprovado no gate matrix principal.
