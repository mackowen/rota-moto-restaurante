# Campanha 0304 — matriz de fidelidade visual (checkpoint)

Data: 2026-10-23. Estado geral de fidelidade: **FAIL**, conforme reprovação do proprietário. Esta matriz documenta a intervenção estrutural posterior; não constitui aprovação do proprietário.

## Referências originais verificadas

Os arquivos abaixo são cópias de trabalho preservadas em `EVIDENCIAS/0304/REFERENCIAS/`. As originais em Downloads não foram substituídas.

| Perfil | Arquivo | Dimensões | SHA-256 | Layout observado |
|---|---|---:|---|---|
| Celular claro/escuro | `REFERENCIAS/rotas-celular.png` | 1536×1024 | `3a7ce349bd189acbbcd80204c934abcae7a4ce25c0061a342147348ebae1e257` | Navegação compacta, filtros de estado, mapa amplo e cartões de rota/paradas abaixo. |
| Tablet claro/escuro | `REFERENCIAS/rotas-tablet.png` | 1536×1024 | `3f1c6ec3cfdde2b4d00aad1a242c2130551d232fde6927422be2eda01c567e8e` | Sidebar e áreas simultâneas para rotas, mapa e detalhes; retrato admite reorganização. |
| PC claro/escuro | `REFERENCIAS/rotas-pc.png` | 1536×1024 | `4b6cdb21b8890f1e5b18fca0805ecaa898af18366a7e5fd89e27cd2a3f4f8f88` | Sidebar, barra operacional, lista à esquerda, mapa central e detalhes/paradas à direita. |

Todas as três imagens foram abertas e inspecionadas visualmente. A referência celular contém duas variações de tema; tablet e PC também mostram claro/escuro lado a lado.

## Comparação estrutural

| Elemento | Referência | Antes da intervenção | Correção nesta intervenção | Estado/divergência remanescente |
|---|---|---|---|---|
| Hierarquia celular | Filtros operacionais, mapa proeminente, listas/cartões após o mapa. | Três cartões KPI antes do mapa. | Removidos os KPI pré-mapa; mapa vem após controles compactos; painéis ficam abaixo. | Estrutura melhorou; conteúdo de exemplo visual da referência não pode ser copiado sem dados reais. |
| Mapa celular | Amplo, com controles sobre o mapa e legenda discreta. | Mapa vinha depois dos KPIs e sua toolbar sofria corte. | Canvas ocupa largura útil; fullscreen e legenda sobre o canvas; altura `clamp(300px,45dvh,430px)`. | Tiles/markers reais não foram confirmados em sessão autenticada. Renderer isolado não demonstra o mapa vivo. |
| Filtros | Controles totalmente visíveis, com organização conforme largura. | Filtros parcialmente cortados. | Quatro filtros em grade e Ajustar em linha própria em telas pequenas; todos 5 ficam dentro da viewport. | Distribuição não é idêntica ao desenho em todas as larguras; permanece validação do proprietário. |
| Superfícies e vazios | Cartões operacionais compactos, uma composição coerente. | Containers aninhados e vários estados vazios fragmentados. | Removido contorno externo redundante; estado único compacto em celular sem dados; vazios laterais concisos em tablet/PC. | A situação real com rotas, entregas e paradas exige sessão/dados válidos e ainda não foi comparada. |
| Tablet retrato | Mapa dominante, com painéis recolhíveis ou reorganizados verticalmente. | Três colunas comprimiam o mapa para largura insuficiente. | Em 600–850px retrato, sidebar compacta e fluxo em uma coluna; mapa largo antes do estado/listas. | Visual não é comparação autenticada; confirmar rolagem e painéis no Chrome Android/tablet. |
| Tablet paisagem | Lista, mapa e detalhes operacionais coexistem. | A composição variava sem preservar o peso visual do mapa. | Breakpoint paisagem reservado a três áreas em 760–1023px; de 1024 a 1179px usa lista+mapa com detalhes abaixo. | Os dados de exemplo do desenho não foram fabricados; proporções podem diferir quando painéis estiverem preenchidos. |
| PC | Sidebar; barra superior; três áreas com mapa central dominante e detalhes/paradas. | KPI pré-mapa, estados vazios espalhados e map/panels fora da hierarquia. | Em >=1180px, grade com lista à esquerda, mapa ao centro e detalhes à direita; painéis vazios persistem sem dados. | A barra de busca, filtros operacionais e tabela da referência ainda não estão reproduzidos como conjunto equivalente; fidelidade permanece FAIL. |
| Tipografia, cor e bordas | Design System V2, superfícies e contraste por tema. | Excesso de bordas e cartões repetidos. | Tokens semânticos existentes; eliminadas molduras externas duplicadas e mantidos temas. | Comparação pixel a pixel com conteúdo real não foi validada. |
| Comportamento | Mapa e painéis refletem rotas/paradas reais; ações operacionais. | Botões cortados e mapa abaixo da hierarquia prevista. | Filtros atualizam camadas, Ajustar chama fit do mapa, fullscreen real, views Rotas/Entregas acionam estado. | Não foi possível testar a aplicação autenticada, persistência/sync ou tiles reais nesta sessão. |

## Medidas da implementação isolada

Capturas e medidas são do renderer `routes()` de produção com estado de domínio vazio. Nenhuma rota, coordenada, distância ou ETA foi criada. Posição do canvas em pixels CSS, relativa à viewport. Todos os cinco controles de filtro ficaram totalmente visíveis; largura documental não ultrapassou a viewport nas linhas avaliadas.

| Viewport | Tema | Mapa x/y | Mapa L×A | Filtros visíveis | Comparação estrutural |
|---:|---|---:|---:|---:|---|
| 320×720 | Claro/escuro | 12 / 157 | 296×324 | 5/5 | Mapa full-width útil; Ajustar quebra para linha seguinte. |
| 360×800 | Claro/escuro | 12 / 157 | 336×360 | 5/5 | Mapa ocupa a coluna útil antes das listas. |
| 390×844 | Claro/escuro | 12 / 157 | 366×380 | 5/5 | Capturas before/after disponíveis; sem os 3 KPI anteriores. |
| 430×932 | Claro/escuro | 12 / 157 | 406×419 | 5/5 | Mapa cresce com viewport até o limite definido. |
| 600×960 | Claro/escuro | 82 / 208 | 504×499 | 5/5 | Sidebar compacta; mapa ocupa a maior largura. |
| 768×1024 | Claro/escuro | 104 / 163 | 629×533 | 5/5 | Retrato em coluna única; largura integral de conteúdo. |
| 1024×768 | Claro/escuro | 521 / 190 | 457×445 | 5/5 | Painel esquerdo, mapa e detalhes; detalhes vazios abaixo por limite de largura. |
| 1280×800 | Claro/escuro | 568 / 195 | 360×512 | 5/5 | Lista/mapa/detalhes; mapa central limitado pela área útil e sidebar. |
| 1440×900 | Claro/escuro | 583 / 199 | 470×576 | 5/5 | Lista 270px, mapa central 470px, painel de detalhes 330px. |
| 1920×1080 | Claro/escuro | 620 / 201 | 876×650 | 5/5 | Mapa central amplo, lista e detalhes em colunas laterais. |

As medidas acima não provam fidelidade final. O resultado do browser fixture avalia layout, visibilidade dos controles e overflow, mas não conteúdo operacional, mapas carregados, posição real da rota ou semelhança pixel a pixel.

## Artefatos comparativos

- Antes/depois: `capturas/0304-rotas-before-390x844-light.png`, `capturas/0304-rotas-before-390x844-dark.png`, `capturas/0304-rotas-after-<largura>x<altura>-<tema>.png`.
- Comparação geométrica: `capturas/0304-rotas-visual-comparison.json`.
- Referências aprovadas: `REFERENCIAS/rotas-celular.png`, `REFERENCIAS/rotas-tablet.png`, `REFERENCIAS/rotas-pc.png`.

## G-VIS

| Gate | Estado | Evidência/limite |
|---|---|---|
| G-VIS-01 — Referências corretas identificadas | PASS | Originais abertas, dimensões e hashes registrados. |
| G-VIS-02 — Hierarquia reproduzida | PARTIAL | KPIs pré-mapa removidos e mapa antecipado; toolbar desktop e conteúdo populado ainda divergem. |
| G-VIS-03 — Mapa em destaque | PARTIAL | Mapa amplo no celular e centro nos layouts largos; tiles/rotas reais não demonstrados. |
| G-VIS-04 — Controles integralmente acessíveis | PASS (fixture) | 5/5 filtros visíveis nos 10 viewports; ação Ajustar funcional no código real. |
| G-VIS-05 — Painéis/listas conforme referência | PARTIAL | Painéis distribuídos por classe de dispositivo; sem dados não há validação do conteúdo e ordem de paradas reais. |
| G-VIS-06 — Celular escuro | PARTIAL | Capturas comparativas e geometria; render autenticado/markers reais pendentes. |
| G-VIS-07 — Celular claro | PARTIAL | Capturas comparativas e geometria; render autenticado/markers reais pendentes. |
| G-VIS-08 — Tablet | PARTIAL | Retrato e paisagem capturados; correspondência final com interação autenticada pendente. |
| G-VIS-09 — PC | PARTIAL | Três painéis estruturais capturados; toolbar operacional e conteúdo de referência ainda diferem. |
| G-VIS-10 — Sem regressão funcional | PARTIAL | Regressões automatizadas direcionadas passam; E2E autenticado continua bloqueado por HTTP 403. |

**Decisão:** G14 e G-VIS-02 permanecem FAIL/PARTIAL conforme tabela de gates de `gates.md`. Nenhuma aprovação visual foi declarada; cabe ao proprietário avaliar a versão corrigida no Chrome Android.

## Revalidação acumulativa — correções de shell e adendo desktop (2026-10-24)

Esta seção acrescenta medidas e causas encontradas; os dados de comparação acima são preservados como checkpoints anteriores, não substituídos. A reprovação e as pendências visuais de Rotas continuam abertas.

| Componente | Causa/estado anterior | Evidência após correção | Limite |
|---|---|---|---|
| Sidebar expandida | Labels da renderização redundantes. | `navButton()` gera um label completo por item; teste enumera labels e fixture roda Operação/Gestão/Administração/Suporte. | Ainda falta validar permissões/navegação na sessão autenticada real. |
| Sidebar recolhida | Layout não tinha regra completa para trilha, centralização e conteúdo dos grupos. | Toggle via renderer real; `aria-expanded`, tooltip e chave local `rotamoto.sidebar.collapsed`; testes de abrir/fechar e CSS de grid. | Persistência em reload autenticado não testada. |
| Cabeçalho Início | Estrutura própria e faixa superior sem a mesma identificação da página. | Renderer compartilhado com título Início, contexto e ações; saudação ajustada para evitar repetição. | Cabeçalho funcional e conta exigem sessão real. |
| Ações Início mobile | Ícone “+” era descendente do texto recortado. | CDP 390×844: botão Nova corrida 44×44 px, centro (308, 28), ícone 19×19 px em tema claro/escuro; Notificações x238, Nova corrida x286, Conta x334, gaps de 4 px e margem final até viewport de 12 px. | Fixture de shell, não avaliação física do Chrome Android; sem clique autenticado. |
| Pedidos desktop | `.orders-v2-selection` era escondido por regra responsiva apesar de haver painel lateral. | Detalhes visíveis em >=1180 px; painel com 285 px em 1280, 1440 e 1920 nos dois temas. | Conteúdo de pedido e ação são sintéticos no fixture. |
| Rotas | Referências e divergências anteriores permanecem. | Capturas do shell e renderer e matriz geométrica atualizada em `intervencao-integral/`; filtro 5/5 e sem overflow no fixture. | Continua **FAIL** na avaliação do proprietário; nenhum dado de rota ou tile real na comparação de shell. |

### Medidas complementares de shell

O fixture CDP gerou 72 combinações: 3 módulos × 2 temas × 7 viewports (360×800, 390×844, 768×1024, 1024×768, 1280×800, 1440×900, 1920×1080), com sidebar expandida/recolhida em tablet/desktop. Resultado: zero labels duplicados e zero overflow do documento. A tabela JSON registra DOM/boxes; capturas estão em `adendo-desktop/`. Essas métricas verificam geometria e estrutura, não aprovação visual.

Na Início mobile, três botões do cabeçalho medem 44×44 px; distribuição em 390 px: x=238, 286, 334 e right do último=378, portanto 12 px até a viewport. O ícone “+” mede 19×19 px, sem clipping. O arranjo geométrico não encerra a avaliação do proprietário.

Ver [`adendo-desktop/README.md`](adendo-desktop/README.md), [`adendo-desktop/0304-shell-visual-report.json`](adendo-desktop/0304-shell-visual-report.json) e [`adendo-desktop/0304-shell-inicio-390x844-dark-expanded.png`](adendo-desktop/0304-shell-inicio-390x844-dark-expanded.png). G14 permanece FAIL; nenhuma pendência anterior é encerrada por este acréscimo.

### Medidas correntes do mapa no fixture Rotas (10 viewports × 2 temas)

Coordenadas CSS do canvas `.map-canvas`, obtidas após a última execução do renderer `routes()` de produção. Tabela compacta do tema escuro; os valores geométricos claro/escuro coincidem no fixture. Todas as linhas têm 5/5 filtros e largura documental igual à viewport até 1024px; de 1280px em diante a sidebar/layout deixa a viewport de conteúdo 15px menor, sem overflow lateral do documento.

| Viewport | Mapa x/y | Canvas L×A | Filtros |
|---:|---:|---:|---:|
| 320×720 | 12 / 224.1 | 296×259.2 | 5/5 |
| 360×800 | 12 / 224.1 | 336×288 | 5/5 |
| 390×844 | 12 / 212.8 | 366×303.8 | 5/5 |
| 430×932 | 12 / 212.8 | 406×335.5 | 5/5 |
| 600×960 | 82 / 290.5 | 504×499.2 | 5/5 |
| 768×1024 | 103.8 / 226.6 | 628.5×532.5 | 5/5 |
| 1024×768 | 520.9 / 319 | 457.4×445.4 | 5/5 |
| 1280×800 | 518.4 / 324 | 434.2×512 | 5/5 |
| 1440×900 | 535.2 / 327.9 | 555.1×576 | 5/5 |
| 1920×1080 | 653.2 / 330.5 | 776.8×650 | 5/5 |

Essa medida torna visível uma limitação que permanece: o mapa no fixture de 1280px só mede 434.2px de largura, enquanto o desenho aprovado prioriza a área cartográfica. A correção do shell desktop não resolve a pendência estrutural da composição Rotas; G14 continua FAIL. Origem completa: `intervencao-integral/0304-intervencao-visual-comparison.json`.
