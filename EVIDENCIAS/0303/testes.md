# Testes — Campanha 0303

- Browser autenticado via Chromium/CDP, sessão backend-issued, `mfaVerified=true`, Company E2E conferida.
- Home sticky antes/depois da rolagem; Orders header sticky antes/depois da rolagem.
- Busca/clear/filtro alinhados; DOM details border/padding/pseudo-elementos verificados.
- Filtros: trigger, interação interna, toque externo, Escape/foco, navegação entre abas.
- E2E Order sintética: criação via UI, readback canônico, filtro/busca, preview de impressão, edição/readback, reload.
- QR: pedido sem atribuição não tem ação; pedido elegível abriu modal, mas endpoint devolveu 404 e UI informou assinatura indisponível.
- Browser: 10 viewports × claro/escuro; sem overflow horizontal do documento, sem exceções JavaScript.
- Resposta 401 na lista de rede corresponde ao primeiro probe sem cookie antes de instalar a sessão; sessão autenticada posterior foi validada. GET QR 404 é bloqueio de capacidade observado.
- Teste unitário direcionado `node tests/test-dashboard-v2.js`: PASS.
- Suíte integral `npm test` Restaurante: exit 0 (suíte completa). Testes direcionados `test-dashboard-v2`, `test-mobile-more-navigation`, `test-visual-shell-cache`, `test-printing-offline` e `test-dispatch-assignment`: PASS.
- `node --check app.js`, `node --check dashboard-v2.js`, `node --check sw.js`; `git diff --check` após revisão.
- `GET http://127.0.0.1:8083` somente leitura: SHA-256 de `index.html`, `app.js`, `dashboard-v2.js`, `dashboard-v2.css`, `orders-v2.css`, `design-system.css` e `sw.js` igual ao workspace; servidor não reiniciado. Hashes em `servidor-8083-sha256.json`.
- Não executados: Chrome Android físico, orientação/safe-area física; teste com QR assinado real; injeção de timeout/401/403/409/500 para QR (endpoint ausente). Banco oficial somente leitura/não utilizado.

Fixture `c7a8b2ac-05ec-4157-8b3e-53f0c91234f2`: `rotamoto_e2e`, COMPLETED, `databaseCommitted=false`, resíduos zero em empresas/usuários/sessões/registros/inbox/outbox/auditoria. Sem dados persistentes após rollback.
