# Complemento 0303-A — botão Notificações/Eventos

**Data:** 2026-10-23. **Estado:** PARTIAL; sem aprovação visual do proprietário e sem navegação autenticada disponível no browser.

## Causa e correção

Pedidos possuía botão de sino e regra CSS próprios; Início possuía outro botão, e os cabeçalhos operacionais de Rotas/Motoboys não incluíam a ação comum. A causa do ícone quase invisível no celular foi a regra do cabeçalho compacto que recortava todo `span` dos botões com `clip: rect(0,0,0,0)`, incluindo o wrapper `span.dv2-icon` do SVG. Cor isolada não corrigia esse recorte.

O helper compartilhado `renderNotificationAction()` agora fornece o mesmo botão `.btn.rm-notifications-action` a Início e aos cabeçalhos operacionais; Pedidos deixou de criar seu sino particular. O acesso dos cabeçalhos operacionais continua condicionado a `canModule('events')`; Início conserva o estado desabilitado com rótulo acessível quando não autorizado. O alvo segue `data-tab="events"`, tratado pelo listener existente que chama `goTab()` e valida novamente a permissão. O CSS restaura o wrapper do SVG ao fluxo visível, aplica `text-primary` e contorno semântico, e reforça o traço para 2.2 px. Botões de corrida e perfil não foram redimensionados para compensar o problema.

## Medições CDP

Fixtures usaram o renderer de Início e renderer global de cabeçalhos operacionais, com CSS de produção. Cada aba foi medida em quatro larguras e dois temas. As geometrias equivalentes tiveram diferença máxima de 0 px entre abas. Y=6 px / centro Y=28 px em todas as medidas.

| Viewport | Sino X / tamanho | Nova corrida X / tamanho | Perfil X / tamanho | Gaps | Perfil até borda | Diferença entre abas | Overflow |
|---:|---:|---:|---:|---:|---:|---:|---|
| 320 | 168 / 44×44 | 216 / 44×44 | 264 / 44×44 | 4, 4 px | 12 px | 0 px | Não |
| 360 | 208 / 44×44 | 256 / 44×44 | 304 / 44×44 | 4, 4 px | 12 px | 0 px | Não |
| 390 | 238 / 44×44 | 286 / 44×44 | 334 / 44×44 | 4, 4 px | 12 px | 0 px | Não |
| 430 | 278 / 44×44 | 326 / 44×44 | 374 / 44×44 | 4, 4 px | 12 px | 0 px | Não |

Valores iguais para Início, Pedidos, Rotas e Motoboys, em claro e escuro. Cor computada do SVG: `rgb(23,32,51)` sobre branco (16.27:1) em claro; `rgb(244,247,251)` sobre `rgb(38,52,67)` (11.81:1) em escuro. Opacidade 1, display `block`, stroke 2.2 px. O report completo com `getBoundingClientRect()`, cores, overflow, click fixture e sticky está em [`0303-A-notifications-shared.json`](0303-A-notifications-shared.json).

O sticky do renderer Início permaneceu com `headerTop=0` nas rolagens 0, 1, 5, 10, 20, 50, 100 e 300 px. O click fixture detectou o destino `events` através do atributo do componente. Isso não equivale a clicar a navegação autenticada: o gate de login do Browser QA retornou HTTP 403. Portanto, a abertura efetiva da aba Eventos pela aplicação aguarda sessão de teste válida.

Capturas corrigidas em 390×844, claro/escuro, para cada renderer: `0303-A-notifications-shared-390x844-{theme}-{dashboard|orders|routes|bikes}.png`.

As capturas/medições anteriores chamadas `0303-A-header-alignment-*` usavam um `.iconbtn` sintético de 40×40 e não representam o botão real de Pedidos. Permanecem preservadas como evidência histórica intermediária, mas estão **supersedidas** por este report.

## Testes e gates

- PASS: `node tests/test-dashboard-v2.js`, `node tests/test-dashboard-width-contract.js`, `node tests/test-visual-shell-cache.js`, `node tests/test-printing-offline.js`, `node tests/test-routes-v2.js`, `node --check app.js`, `node --check dashboard-v2.js`, `node --check sw.js`, `git diff --check`.
- PASS técnico: geometria CDP das quatro abas em 8 combinações de viewport/tema; sticky estável nos oito offsets; click fixture apresenta `events` como destino.
- BLOCKED: teste autenticado clicando sino para abrir Eventos (login 403); inspeção física no Chrome Android e aprovação visual final do proprietário.

**Gate de implementação visual:** TECHNICAL_PASS / PENDING_USER_APPROVAL. **Gate funcional de navegação real:** BLOCKED. Sem PASS global do adendo.
