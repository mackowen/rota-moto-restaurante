# REGISTRO 0303 — Refinamentos finais de Início e Pedidos V2

**Data:** 2026-10-23  
**Estado:** PARTIAL; correções funcionais do cabeçalho, busca/filtros e apresentação do QR foram exercitadas no Chromium autenticado. Avaliação física no Chrome Android permanece com o proprietário.  
**Repositórios:** Restaurante `codex/campaign-0303-ui-refinements`, ponto de partida `3f6910dceb4634ef63601489d2ffe45a14a5b328`; histórico `codex/campaign-0303-ui-refinements`. Motoboy e browser-tests preservados sem alterações. Baseline Restaurante `v5.50-ui-mobile-fix5` preservada.

## Reprodução e causas

Antes da alteração, a sessão sintética emitida pelo backend confirmou MFA e Company ativa. Na Home, `.dv2-header` era `static` e sua borda superior foi de `8px` para `-433px` após rolagem. A página Pedidos usava outro cabeçalho. No formulário mobile, a busca ocupava a linha inteira e “Limpar” ficava em posição absoluta sobre o texto; o acionador de filtros ficava na mesma linha sem um grupo de campo explícito. O `<details class="orders-advanced-filters">` não fechava por interação externa. O `design-system.css` adicionava `border-top:1px solid` e padding antes do acionador; essa regra era a linha fina observada.

O QR é elegível somente para status canônico em andamento, portanto uma entrega sem motoboy não deve mostrar a ação. Para a entrega sintética elegível, a solicitação existente `GET /api/delivery-qr/deliveries/{id}` respondeu 404 no harness; o UI recebeu o código de indisponibilidade de assinatura e exibiu “A assinatura segura de QR não está configurada nesta instalação.” O controle foi mantido seguro, sem QR local/fictício, nem alteração de regra. Capacidade de backend permanece pendente.

## Correções

- Unificado o HTML dos cabeçalhos via `RotaMotoDashboardV2.renderHeader`; Home e cabeçalho operacional usam o mesmo renderer e classe `.rm-global-header` sticky, opaca, com safe-area superior. A rolagem continua no fluxo normal, sem spacer duplicado.
- Reconstruída a busca como uma linha Grid: controle de busca com ícone, input e Limpar em colunas próprias; acionador de filtros em 44px. Removido posicionamento absoluto sobre o input.
- Removida na origem a borda superior herdada de `.orders-advanced-filters`.
- Adicionado fechamento do painel por interação externa, acionador nativo, Escape e navegação. Clique dentro permanece aberto; Escape restaura foco; listeners de documento são registrados uma vez.
- As linhas sem QR usam duas colunas de ações; linhas elegíveis usam três. A ação QR permanece omitida quando inelegível.
- Cache do shell avançado para v96 e versionamento dos assets alterados para garantir carregamento da composição atual.

## Testes e evidências

Browser Chromium/CDP autenticado, cookie de sessão emitido pelo backend, MFA verificada, `rotamoto_e2e` tenant-scoped. A segunda rodada confirmou Home e Pedidos com `position:sticky`, `top:0` após rolagem de 500/300px. Busca, Limpar e filtro não se sobrepõem (geometrias distintas); detalhes sem borda/padding/pseudo-elementos superiores. Testados painel aberto, interação interna, toque externo, acionador, Escape/foco e navegação. Criação/edição sintética, GET/readback, reload e preview de impressão também foram repetidos como regressões; QR inelegível não foi exposto e o QR elegível permaneceu indisponível pelo endpoint 404. Nenhuma exceção JavaScript. Um 401 observado foi somente a verificação inicial antes de instalar o cookie; sessão seguinte confirmou MFA.

Foram geradas 20 capturas de Pedidos (10 larguras × tema claro/escuro): 320×720, 360×800, 390×844, 430×932, 600×960, 768×1024, 1024×768, 1280×800, 1440×900 e 1920×1080. Sem overflow horizontal do documento. Capturas antes/depois em 390×844 e Home após rolagem estão no diretório de evidências. A barra fina que permanece sob os filtros rápidos é a barra de rolagem horizontal intencional dos chips; a linha antes do acionador foi removida.

Fixture E2E `c7a8b2ac-05ec-4157-8b3e-53f0c91234f2`: `rotamoto_e2e`, status `COMPLETED`, `databaseCommitted=false`, cleanup concluído, contagens tenant-scoped zeradas. Banco oficial, serviços, Motoboy e browser-tests não foram alterados.

`npm test` Restaurante, testes direcionados, `node --check` e `git diff --check` passaram; resultados em [testes](../EVIDENCIAS/0303/testes.md). O navegador servido em `127.0.0.1:8083` não foi reiniciado. Emulação Chromium não equivale a aparelho Android físico.

## Gates

| Gate | Estado | Evidência/limite |
|---|---|---|
| G1 — Cabeçalho fixo e padronizado | PASS_SCOPE | Mesmo renderer; Home e Pedidos sticky, verificação por rolagem. Safe-area foi implementada; aparelho físico/orientação não validados. |
| G2 — Busca e filtros alinhados | PASS_SCOPE | DOM medido em 390px; capturas até 320px e sem overflow; componentes em colunas distintas. |
| G3 — Linha indevida | PASS_SCOPE | Fonte comprovada no border-top de `details`, removida; computed style 0px none e screenshot depois. |
| G4 — Fechamento do painel | PASS_SCOPE | Interno, externo, acionador, Escape/foco e navegação testados. |
| G5 — QR seguro | PARTIAL | Elegibilidade e feedback fail-closed corretos; endpoint do E2E 404/signature unavailable, emissão real bloqueada por capacidade. |
| G6 — Responsividade | PASS_SCOPE | 10 larguras × claro/escuro sem overflow; emulação Chromium, não Android físico. Orientação física não executada. |
| G7 — Integração e regressões | PASS_SCOPE | Browser autenticado/MFA: filtro, navegação, criação/edição/readback/reload, print preview; npm test resultado em evidências. QR backend permanece bloqueado. |
| G8 — Fidelidade visual preservada | PARTIAL | Paleta e composição V2 preservadas; screenshots automatizados disponíveis. Conferência final do proprietário no Chrome Android pendente. |

## Reversão e pendências

Reversão local segura: `git revert <SHA-do-commit-local-0303>` no Restaurante; isso preserva histórico e não toca a tag baseline. O commit será indicado na atualização pós-commit. Não houve push do app. Não executar 0304 automaticamente.

Pendências: endpoint/capacidade de QR no ambiente E2E; conferência no Chrome Android físico pelo proprietário; orientação/viewport com safe-area real; sem alteração dos estados globais históricos RM-AUD19-01..19, RM-AUD22-20..22, RM-AUD26-01/02 ou aliases. 0258 segue `BLOCKED_AUTHORIZATION`; ORS segue `PENDING_EXTERNAL_CREDENTIAL`.

Ver [matriz funcional](../EVIDENCIAS/0303/matriz-funcional.md), [diagnóstico antes](../EVIDENCIAS/0303/diagnostico-antes.json), [Browser report](../EVIDENCIAS/0303/capturas/browser-report.json) e [capturas](../EVIDENCIAS/0303/capturas/).
