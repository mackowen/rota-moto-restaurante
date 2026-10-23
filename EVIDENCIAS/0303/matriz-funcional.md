# Matriz funcional — Campanha 0303

| Área/campo | Antes | Causa raiz | Correção | Browser após | Persistência/ação | Estado |
|---|---|---|---|---|---|---|
| Home — cabeçalho | `static`, saiu da viewport após rolagem | Dashboard usava `.dv2-header` próprio sem sticky | Renderer compartilhado `renderHeader`; `.rm-global-header` sticky/opaco/safe area | `position:sticky`, top 0 antes/depois de scrollY 500; captura depois | Sem dados mutáveis | PASS_SCOPE |
| Pedidos — cabeçalho | Renderer distinto | `app.js` gerava `.topbar` separadamente | `header()` delega ao mesmo renderer da Home | `position:sticky`, top 0 com scroll 300px | Navegação Orders/Home testada | PASS_SCOPE |
| Pedidos — busca/input | Input cobria espaço inteiro; texto limitado pelo botão sobreposto | Limpar era `position:absolute`; grid colocava trigger na linha | Controle de busca separado em colunas: ícone/input/Limpar + trigger fixo 44px | Boxes sem interseção em 390px; 320/360/390/430 em capturas; sem overflow | Busca/filtro de pedido sintético funcionou | PASS_SCOPE |
| Pedidos — linha antes de filtros | Linha fina acima do trigger | `design-system.css` aplicava `border-top`/padding ao details | Regra de origem removida e details sem borda/pseudo | computed `0px none`, screenshot após | Não aplicável | PASS_SCOPE |
| Filtros avançados — abertura/fecho | Toque externo não fechava | `<details>` nativo sem política de dismiss | Delegação de ponteiro/teclado idempotente; toggle nativo; fechamento em `goTab` | Aberto, clique interno mantém; externo fecha; trigger fecha; Escape fecha e devolve foco; navegação fecha | Valores aplicados preservados em controles até reset explícito | PASS_SCOPE |
| Pedidos — ação QR inelegível | Ação omitida por regra de status; coluna CSS reservava espaço | Grid fixo de três tracks no celular/tablet | Classe `--without-qr` com 2 colunas, elegível com 3; elegibilidade original intacta | Pedido aguardando sem motoboy não expõe botão QR | Não emite QR | PASS_SCOPE |
| Pedidos — QR elegível | Controle abre modal, emissão falha na instalação E2E | GET de assinatura retorna HTTP 404/`DELIVERY_QR_UNAVAILABLE` | Mensagem existente informa assinatura não configurada; fail-closed preservado | Modal/falha observados, sem canvas token | API canônica não disponível | BLOCKED |
| Pedidos — preview de impressão | Regressão correlata | Sem defeito novo reproduzido | Handler existente mantido | Preview contém número do pedido sintético | Order E2E recebeu HTTP 200/readback e reload | PASS_SCOPE |
| Responsividade/temas | Search-row sobrepunha controles em mobile | Estilos mobile de posição absoluta | Grid estrutural, targets 44px, versões de cache atualizadas | 320×720, 360×800, 390×844, 430×932, 600×960, 768×1024, 1024×768, 1280×800, 1440×900, 1920×1080; claro/escuro; sem overflow | E2E Browser, sem emulação física Android | PASS_SCOPE |
| App em aparelho Android | Não executado nesta campanha | Sem dispositivo físico validado | Sem mudança em serviços Android/Termux | Aguardar conferência do proprietário | Servidor 8083 não reiniciado | PARTIAL |

## Arquivos/capturas

Mapa de capturas e métricas completo: [browser-report.json](capturas/browser-report.json). Antes: [Home](capturas/before-home-390x844-dark.png), [Pedidos](capturas/before-orders-390x844-dark.png). Depois: [Pedidos](capturas/after-orders-390x844-dark.png), [Home após rolagem](capturas/after-home-scrolled-390x844-dark.png); demais pares por viewport/tema em `capturas/orders-*`.

A linha sob os filtros rápidos ainda visível nas capturas é a rolagem horizontal controlada dos chips, não o separador removido.
