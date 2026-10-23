# Testes e integridade — Campanha 0302

## Browser autenticado

- Runner temporário fora dos repositórios: `/data/data/com.termux/files/usr/tmp/campaign-0302-orders-browser.cjs`.
- Sessão emitida pelo backend, MFA verificada.
- Executado em `rotamoto_e2e`; manifest final `330a51d8-c3bb-4745-9abb-aa06f5b5b3d0`, `COMPLETED`, `databaseCommitted=false`; zero residual tenant-scoped nas tabelas verificadas.
- Order criada pela UI: ACK HTTP 200 e CompanyId idêntico ao tenant autenticado; edição confirmou readback; após reload o pedido continuou visível.
- Pesquisa/filtro, detalhe e prévia de impressão passaram. Prévia contém o identificador do pedido criado.
- QR elegível bloqueado corretamente porque o serviço de assinatura retornou HTTP 404; UI informa que a assinatura segura não está configurada. Não houve geração fictícia.
- 20 screenshots cobrem 10 viewports × claro/escuro; captura 21 documenta QR indisponível. Viewports: 320×720, 360×800, 390×844, 430×932, 600×960, 768×1024, 1024×768, 1280×800, 1440×900 e 1920×1080.
- `documentWidth === viewportWidth` em todos os cenários; zero exceções JS. Cada alvo de ação medido no celular tem pelo menos 44 px.
- 401 inicial em `/api/identity/session` foi a checagem antes do cookie. Após autenticação, não houve 401/403 funcional. QR 404 permanece bloqueio de capacidade.
- Apenas Chromium por CDP; não houve validação física em Chrome Android nem impressão física.

## Testes automatizados

- `npm test`: exit 0 em execução final.
- Regressões direcionadas: `test-orders-quick-filters.js`, `test-dashboard-v2.js`, `test-visual-shell-cache.js`, `test-printing-offline.js`, `test-identity-ui.js`, `test-dispatch-assignment.js` — passaram.
- `node --check app.js`, `node --check sw.js`, `git diff --check` — passaram.
- Os contratos antigos de shell em `test-dashboard-v2.js`, `test-dispatch-assignment.js`, `test-printing-offline.js` e `test-visual-shell-cache.js` esperavam cache keys/labels anteriores; expectativas foram alinhadas ao `index.html`/service worker atual, sem enfraquecer asserções de comportamento.

## Versão servida localmente

GET read-only a `http://127.0.0.1:8083/` retornou o HTML que referencia `orders-v2.css?v=0302.3` e `app.js?v=0302.3`. SHA-256 local e servido coincide:

| Arquivo | SHA-256 |
|---|---|
| `index.html` | `f09d7f86f0b4649baf0db6bf7c3f2e58590e5152e1bfa5f086f7da8a9f40264e` |
| `app.js` | `8499cfb6cf8832e9f5b52e8370c794e0fcfc4a98a5b265f031d3bbeffa828105` |
| `orders-v2.css` | `a39a6eda4bec53ac0bd82b7b16e835161faf9ad53cfdb676586003eb83180a17` |
| `sw.js` | `6ae68275bfb38ce8e7bba69c5c55127b175c54372ec1eeb5438d2f8de3491c4c` |

Nenhum processo/serviço foi reiniciado. A igualdade confirma os arquivos lidos via HTTP local; não confirma cache de aparelho nem atualização física Android.
