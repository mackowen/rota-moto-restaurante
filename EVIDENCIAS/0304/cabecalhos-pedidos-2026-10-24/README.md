# Evidências — cabeçalho compartilhado e cartões de Pedidos (2026-10-24)

Esta evidência continua a Campanha 0304 e foi gerada com Chromium 155 via CDP. Os registros usam exclusivamente pedidos sintéticos. Não houve autenticação operacional, escrita em banco ou alteração de dados reais.

## Cabeçalhos

`header-four-edge-before-after.json` contém 130 casos antes e 130 depois, em nove larguras (320–1920 px), cinco módulos, temas claro/escuro e sidebar expandida/recolhida nas larguras desktop. O baseline usa `design-system.css` do HEAD de entrada `6c5eeb3b2e99f3b66ce46507c1f6d980e6530a8c`; a captura posterior usa o CSS alterado. Cada linha mede o cabeçalho e o retângulo de união dos filhos visíveis com `getBoundingClientRect()`, incluindo insets nos quatro lados, dimensões/posições dos botões, sobreposição e largura documental. Wrapper `#app` e classe de conta inline estão presentes.

Principais gutters horizontais computados (esquerda/direita): 390 px 10/10 px antes e depois; 768 px 0/16,13 px antes e 16,13/16,13 px depois; 1024 px 20,47/20,47 px antes e 24/24 px depois; 1280 px 25,59/25,59 px antes e 28,16/28,16 px depois; 1440 px 28/28 px antes e 31,67/31,67 px depois; 1920 px 28/28 px antes e 32/32 px depois. A 320–430 px o gutter mobile aprovado foi mantido em 10 px. Após a correção: zero sobreposições de botões e zero overflow documental nos 130 casos.

## Pedidos

`orders-card-measurements.json` registra 72 verificações em larguras 320, 360, 390, 430, 768, 1024, 1280, 1440 e 1920 px, claro/escuro e 0/1/5/20 pedidos. Resultado: quantidade de artigos igual à quantidade de pedidos; sem painel lateral duplicado; ação Abrir visível; imprimir disponível; documento sem overflow. Cliques sintéticos acionaram os handlers existentes `openDetail` e `openPrintPreview`. O teste unitário `tests/test-orders-v2-cards.js` valida renderização e a integração dos handlers.

Capturas verificadas: `orders-verified-390-light-1.png`, `orders-verified-1280-light-1.png`, `orders-verified-1280-dark-20.png` e `orders-verified-1440-light-5.png`. A captura desktop escura teve estado e cor de fundo verificados antes da gravação. As capturas são fixtures visuais sintéticas, não substituem sessão autenticada nem validação física no Chrome Android.

## Limites

As capturas exploratórias anteriores nesta pasta histórica que não tinham o wrapper `#app` ou ainda mostravam ponteiro sobre o botão Conta foram preservadas como histórico, mas substituídas para fins de comparação pelas medições e imagens verificadas deste README. Não há nova sessão sintética com limpeza autorizada nesta rodada; E2E autenticado fica BLOCKED. G14 continua FAIL até aprovação explícita do proprietário.

O arquivo `served-assets-sha256.json` preserva o status HTTP e os SHA-256 source/servido dos quatro assets.
