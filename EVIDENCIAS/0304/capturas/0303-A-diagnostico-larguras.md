# Adendo 0303-A — medições disponíveis

Viewports usados para comparação inicial: 390×844 CSS px, Chromium emulado. Os valores vêm de `getBoundingClientRect()` e `getComputedStyle()` capturados antes da correção em `browser-report.json`; a tentativa que capturou esses números estava sem sessão autenticada (POST login HTTP 403), mas o DOM das três abas estava visível naquela navegação local. São medições de layout, não prova de fluxo autenticado.

| Elemento | Antes: left/right | Largura | Padding horizontal | Margens horizontais |
|---|---:|---:|---:|---:|
| `#main` nas três abas | 0 / 390 | 390 | 12 / 12 | 0 / 0 |
| Home `.dashboard-v2` | 12 / 378 | 366 | 12 / 12 | 0 / 0 |
| Home `.dv2-header` | 24 / 366 | 342 | 0 / 0 | 0 / 0 |
| Pedidos `.orders-v2` | 12 / 378 | 366 | 0 / 0 | 0 / 0 |
| Pedidos `.topbar` | 2 / 388 | 386 | 10 / 10 | -10 / -10 |
| Rotas `.routes-v2` | 12 / 378 | 366 | 0 / 0 | 0 / 0 |
| Rotas `.topbar` | 2 / 388 | 386 | 10 / 10 | -10 / -10 |

Causa raiz: padding duplicado no wrapper Home, e cabeçalho V2 Home não usando o seletor compartilhado que faz o controle de perfil receber o estilo compacto inline. Não havia max-width adicional no mobile; `box-sizing:border-box`; documento 390px sem overflow; shell 390px sem gutters. A versão após a correção foi medida no renderer real com fixture visual sintética: em 390px, `.dashboard-v2` left/right=12/378, width=366, padding 0/0; header left/right=2/388, width=386, position sticky; documentWidth=390. O renderer sintético não substitui a aplicação autenticada nem valida botão Conta no estado efetivo.

| Tamanho / temas | Status pós-correção |
|---|---|
| 320×720, 360×800, 390×844, 430×932, 600×960, 768×1024, 1024×768, 1280×800, 1440×900, 1920×1080 | DOM/screenshot do renderer isolado, claro e escuro; sem overflow no documento; comparar apenas estrutura/gutters; o estado Conta não é uma sessão autenticada |

Em 390px, pós: Home wrapper 366px (x=12…378), header 386px (x=2…388), `top=0`, `position:sticky`; documentWidth 390px. Em 320px, wrapper 296px (x=12…308), header 316px (x=2…318), `top=0`; documentWidth 320px. Renderer Home foi medido isolado, sem dado operacional ou autorização. Ver imagens `0303-A-before-home-390x844-light.png`, `0303-A-before-orders-390x844-light.png`, `0303-A-home-after-390x844-light.png` e `0303-A-home-render-report.json`. Para o estado autenticado e fiel aos dados do proprietário, a confirmação no Chrome Android permanece pendente.
