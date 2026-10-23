# Testes Campanha 0301 — checkpoint Lote 1

- Restaurante: npm test — PASS, exit 0 na execução final (full suite).
- Direcionados: test-orders-quick-filters.js, test-dashboard-v2.js, test-visual-shell-cache.js, test-dispatch-assignment.js — PASS.
- Browser/CDP: sessão backend-issued, MFA verificada; pedido sintético criado pela UI; filtro Aguardando ativo, registro visível, ação Imprimir habilitada na lista filtrada e prévia com o mesmo pedido. Limpar executado.
- Home V2: regressão em 20 viewports/temas, console sem erros JS, menu Mais fecha e restaura foco.
- Ativos por Browser 200: app.js?v=0301.2, styles.css?v=0301.3, design-system.css?v=0301.2.
- Leitura HTTP read-only em 127.0.0.1:8083: /, index.html, app.js, styles.css, design-system.css e sw.js 200 e SHA-256 igual ao workspace. Nenhum serviço reiniciado.
- Fixture rotamoto_e2e: databaseCommitted=false, cleanup COMPLETED, resíduos tenant-scoped zero.
- Observados 404 nas APIs de fila/logística/analytics listadas no browser-report.json; os módulos dependentes não são declarados PASS. Probe inicial 401 ocorreu antes de instalar o cookie; depois MFA/session autenticada confirmou.
- Não executado: teste Android físico, screenshot de Pedidos nos demais viewports/tema claro, regressão Motoboy, fluxos completos de CRUD/settings/rotas/frota/logística/admin e negativos específicos que não pertencem ao filtro.
