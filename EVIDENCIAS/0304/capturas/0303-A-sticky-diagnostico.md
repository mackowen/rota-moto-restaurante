# Campanha 0303-A — cabeçalho sticky

## Diagnóstico

O DOM do renderizador da Início mostra que a rolagem pertence a `document.scrollingElement` (`HTML`), sem container interno. No celular, `#main` e `.dashboard-v2` têm `padding-top: 0`; o cabeçalho é o primeiro elemento da dashboard e computa `position: sticky; top: 0`. A cadeia entre cabeçalho e documento computa `overflow: visible`, `transform: none`, `contain: none` e `filter: none`. Não há elemento anterior ao cabeçalho nem safe area superior ativa na fixture Chromium.

A estrutura anterior combinava padding superior na `.dashboard-v2` com `margin-top: -8px` específico no cabeçalho. Essa compensação estrutural alterava a posição normal do item sticky e criava o espaço/limiar de entrada observado. A correção já presente nesta branch remove ambos os offsets no celular e transfere o espaçamento visual preservado para o conteúdo da saudação (`padding-top`), abaixo do cabeçalho. O cabeçalho da Início agora utiliza as mesmas classes `.topbar.rm-page-header.rm-global-header` das abas operacionais.

## Medição automatizada

Chrome/Chromium via CDP, fixture isolada do renderizador da Início, sem autenticação e sem dados operacionais. Medido `getBoundingClientRect().top` após `window.scrollTo`, com espera de renderização. Em todos os quatro tamanhos de celular e nos temas claro/escuro, os oito valores foram `0, 0, 0, 0, 0, 0, 0, 0` para scroll efetivo `0, 1, 5, 10, 20, 50, 100, 300` px.

| Viewport | Tema | Top do cabeçalho nos offsets 0/1/5/10/20/50/100/300 px |
|---|---|---|
| 320×720 | claro/escuro | 0, 0, 0, 0, 0, 0, 0, 0 |
| 360×800 | claro/escuro | 0, 0, 0, 0, 0, 0, 0, 0 |
| 390×844 | claro/escuro | 0, 0, 0, 0, 0, 0, 0, 0 |
| 430×932 | claro/escuro | 0, 0, 0, 0, 0, 0, 0, 0 |

O relatório JSON inclui cadeia de ancestrais, estilos computados, scroll efetivo e medições. Capturas nos offsets 0, 5, 50 e 300 px foram produzidas para os quatro tamanhos móveis e ambos os temas. Em 768×1024 o fixture não tem altura suficiente para rolar; em 1280×800 a dashboard mantém os offsets próprios da composição desktop, fora do requisito de sticky imediato celular.

## Comparação e limites

Pedidos e Rotas usam o mesmo contrato de classe do cabeçalho e o mesmo `top: 0` do `.topbar` no breakpoint móvel. A comparação de conteúdo autenticado entre abas ficou bloqueada: `/api/identity/login` respondeu HTTP 403 no ambiente de browser compartilhado, portanto as medições são da estrutura/CSS real com o renderizador isolado, não de uma sessão operacional. A safe area real do Chrome Android e a barra do navegador não são emuladas fielmente por esta fixture. Validação física no Chrome Android permanece pendente do proprietário.

## Arquivos relacionados

- `dashboard-v2.css`: remoção do espaço superior/compensação negativa e preservação do espaçamento da saudação.
- `dashboard-v2.js`: cabeçalho da Início usa a classe global compartilhada.
- `capturas/0303-A-sticky-diagnostic.json`: medições detalhadas.
- `capturas/0303-A-sticky-*.png`: capturas nos quatro offsets por viewport móvel e tema.

## Gates do complemento sticky

- G1 — causa identificada: PASS (estrutura CSS e DOM identificados; confirmação física Android pendente).
- G2 — espaçamento superior artificial removido: PASS na fixture; comparar versão Android real pendente.
- G3 — estabilidade desde 0 px: PASS técnico na fixture móvel, 8 offsets × 4 viewports × 2 temas.
- G4 — responsividade: PARTIAL (medições e capturas celulares; tablet/desktop sem comparação autenticada completa).
- G5 — sem regressões: PARTIAL (testes do código; fluxo autenticado não acessível pelo 403).
- G6 — evidências: PASS para captura/medição automatizada; validação física Android pendente.
