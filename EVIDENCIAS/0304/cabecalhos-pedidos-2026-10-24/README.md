# Evidências — cabeçalho compartilhado e cartões de Pedidos (2026-10-24)

Esta evidência continua a Campanha 0304 e foi gerada com Chromium 155 via CDP. Os registros usam exclusivamente pedidos sintéticos. Não houve autenticação operacional, escrita em banco ou alteração de dados reais.

## Cabeçalhos

`header-four-edge-before-after.json` contém 130 casos antes e 130 depois, em nove larguras (320–1920 px), cinco módulos, temas claro/escuro e sidebar expandida/recolhida nas larguras desktop. O baseline usa `design-system.css` do HEAD de entrada `6c5eeb3b2e99f3b66ce46507c1f6d980e6530a8c`; a captura posterior usa o CSS alterado. Cada linha mede o cabeçalho e o retângulo de união dos filhos visíveis com `getBoundingClientRect()`, incluindo insets nos quatro lados, dimensões/posições dos botões, sobreposição e largura documental. Wrapper `#app` e classe de conta inline estão presentes.

Principais gutters horizontais computados (esquerda/direita): 390 px 10/10 px antes e depois; 768 px 0/16,13 px antes e 16,13/16,13 px depois; 1024 px 20,47/20,47 px antes e 24/24 px depois; 1280 px 25,59/25,59 px antes e 28,16/28,16 px depois; 1440 px 28/28 px antes e 31,67/31,67 px depois; 1920 px 28/28 px antes e 32/32 px depois. A 320–430 px o gutter mobile aprovado foi mantido em 10 px. Após a correção: zero sobreposições de botões e zero overflow documental nos 130 casos.

## Pedidos

`orders-card-measurements.json` registra 72 verificações em larguras 320, 360, 390, 430, 768, 1024, 1280, 1440 e 1920 px, claro/escuro e 0/1/5/20 pedidos. Resultado: quantidade de artigos igual à quantidade de pedidos; sem painel lateral duplicado; ação Abrir visível; imprimir disponível; documento sem overflow. Cliques sintéticos acionaram os handlers existentes `openDetail` e `openPrintPreview`. O teste unitário `tests/test-orders-v2-cards.js` valida renderização e a integração dos handlers.

Capturas verificadas: `orders-verified-390-light-1.png`, `orders-verified-1280-light-1.png`, `orders-verified-1280-dark-20.png` e `orders-verified-1440-light-5.png` e `orders-verified-768-light-5.png` (tablet). A captura desktop escura teve estado e cor de fundo verificados antes da gravação. As capturas são fixtures visuais sintéticas, não substituem sessão autenticada nem validação física no Chrome Android.

## Limites

As capturas exploratórias desta rodada que não tinham o wrapper `#app` ou ainda mostravam o ponteiro sobre o botão Conta foram preservadas como histórico, mas substituídas para fins de comparação pelas medições e imagens verificadas deste README. Não há nova sessão sintética com limpeza autorizada nesta rodada; E2E autenticado fica BLOCKED. G14 continua FAIL até aprovação explícita do proprietário.

O arquivo `served-assets-sha256.json` preserva o status HTTP e os SHA-256 source/servido dos quatro assets.

## Controlled header screenshot comparison

`header-controlled-before-1280-pedidos.png` and `header-controlled-after-1280-pedidos.png` use the same production `renderHeader()` markup and static shell fixture at 1280×800. Only the Design System stylesheet changes: committed baseline `6c5eeb3` versus the current stylesheet. Insets and button positions are recorded in `header-controlled-geometries.json`. This is a header-focused CDP fixture, not a complete authenticated application screenshot or owner approval.

## Artefatos exploratórios preservados

Os arquivos gerados antes da montagem correta do wrapper `#app` ou antes de estabilizar a pintura permanecem preservados, mas não sustentam os resultados desta intervenção: `header-measurements-before.json` (sem viewport meta, portanto linhas mobile inválidas), `header-measurements-after.json` e `header-before/after-pedidos-*` (fixtures anteriores sem contexto completo de identidade), e as capturas `orders-after-*`, `orders-final-*`, `orders-final-ui-*` e `orders-reviewed-*` (gerações exploratórias substituídas). Os resultados válidos desta rodada estão limitados aos nomes citados acima: `header-four-edge-before-after.json`, `header-controlled-*.png`, `header-controlled-geometries.json`, `orders-card-measurements.json`, `orders-verified-*.png` e `served-assets-sha256.json`. Não houve exclusão de evidência.

## Referências aprovadas consultadas

As capturas históricas de Pedidos foram abertas e comparadas com as capturas CDP desta rodada:

- [Desktop claro 1280×800](../../0303/capturas/orders-1280x800-light.png), SHA-256 `50656e55ca65727bab7a9e57f2d7f58def509810336427b4fdfa05775ef6d4c2`: sidebar, cabeçalho alinhado, filtros e tabela única; a correção atual troca a tabela pela apresentação em cartões porque a solicitação 0304 exige cartão operacional único por pedido e retirada do painel lateral redundante. Essa divergência estrutural foi solicitada, não é declarada como aprovação visual; G14 permanece FAIL.
- [Tablet claro 768×1024](../../0303/capturas/orders-768x1024-light.png), SHA-256 `03ee3209ba48267bf7a1db85f9168b95f04815bb4fac80323975c2892049e5b7`: lista e detalhe selecionado lado a lado; nesta correção a ação Abrir segue para o detalhe existente sem duplicação persistente.
- [Mobile claro 390×844](../../0303/capturas/orders-390x844-light.png), SHA-256 `6dcf1049ad81a70167e17ee9ac281ea5d5b2a36e291b8905b55acf19da9d23e6`: cartões únicos, cabeçalho compacto e navegação inferior; comparação correspondente após está em `orders-verified-390-light-1.png`.

As referências originais foram preservadas sem alteração. As capturas novas são sintéticas; os dados reais e a aprovação visual humana continuam pendentes.
