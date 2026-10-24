# Gates — campanha 0304 (checkpoint atual)

| Gate | Estado | Evidência/limite |
|---|---|---|
| G0 — Referências | PASS | Três referências abertas, medidas, identificadas e SHA-256 registrados. |
| G1 — Auditoria | PARTIAL | Contratos e serviços centrais inventariados; testes operacionais e conflitos não executados. |
| G2 — Design System | PARTIAL | Tokens/regras V2 reaproveitados; fidelidade visual comparativa Rotas pendente. |
| G3 — Celular | PARTIAL | Renderer production fixture capturado em 320/360/390/430, claro/escuro; 5 filtros visíveis e mapa antes das listas. Sessão real/tiles/rotas autenticadas pendentes. |
| G4 — Tablet | PARTIAL | Capturas 600/768 retrato e 1024 paisagem claro/escuro; retrato vertical e paisagem em painéis; validação autenticada e comparação final pendentes. |
| G5 — PC | PARTIAL | Capturas 1280/1440/1920 claro/escuro; lista/mapa/detalhes mantidos sem dados. Barra operacional e conteúdo populado ainda divergem da referência. |
| G6 — Mapa/cartografia | PARTIAL | Leaflet e serviços existentes preservados; geocode tácito removido; falha/resize/tiles E2E pendentes. |
| G7 — Planejamento | PARTIAL | UI reutiliza regras/persistência existentes; sequência e save Browser não testados. |
| G8 — Persistência | BLOCKED | No E2E mais recente, desafio MFA foi concluído após `403 MFA_REQUIRED`, mas reload deixou `#app` oculto; não se comprovou persistência/reabertura da rota. |
| G9 — Integração | PARTIAL | Contratos e responsabilidades preservados; jornada cross-app não executada. |
| G10 — Sync/concorrência | BLOCKED | A sessão Browser não permaneceu utilizável após reload do desafio MFA; cenários de sincronização/concorrência não foram exercitados. |
| G11 — Segurança/RBAC | PARTIAL | Validadores atuais preservados; tenant adversarial/RBAC de rotas não testados. |
| G12 — Offline/resiliência | PARTIAL | Não foi demonstrada confirmação remota falsa; falhas/reconexão ainda não testadas nesta UI. |
| G13 — E2E | BLOCKED | Login inicial respondeu `403 MFA_REQUIRED`; após completar o desafio, reload ocultou `#app` e não havia `#main`/`#routeMap`. O fluxo autenticado não concluiu; não houve bypass. |
| G14 — Fidelidade visual | FAIL | Reprovação explícita do proprietário. Intervenção estrutural e comparações fixture registradas; diferenças desktop/toolbar e validação com aplicação autenticada/dados reais permanecem. Aprovação exclusiva do proprietário pendente. |
| G15 — Sem regressões | PARTIAL | Testes direcionados de mapas/logística/contrato passaram; regression Browser Início/Pedidos/Motoboys autenticado bloqueado. |

## Adendo 0304 — shell desktop/mobile, 2026-10-24

Esta tabela complementa os gates originais. Nenhuma linha fecha pendência anterior ou altera o G14 reprovado pelo proprietário.

| Área/gate deste adendo | Estado | Evidência/limite |
|---|---|---|
| Navegação lateral — rótulos e estado | PASS (renderer/fixture) | Um rótulo visual por item; abreviação mobile; aria-label/tooltip; expandir/recolher e persistência local cobertos por `tests/test-navigation-shell-renderer.js`. Sem validação autenticada de permissões nesta execução. |
| Cabeçalho compartilhado | PARTIAL | Início passa pelo renderer comum, com título/descrição/contexto e ações. CDP mediu 72 combinações; login real, ação Conta e nova corrida autenticada pendentes. |
| Ícone “+” da Início mobile | PASS (layout fixture) | Causa corrigida; 390×844 claro/escuro mede o botão em 44×44 e glyph em 19×19; teste inclui falha se o glyph ficar menor que 10 px/oculto. A ação funcional depende da sessão e não foi clicada. |
| Responsividade desktop / painel de Pedidos | PARTIAL | Painel selecionado visível a >=1180 px; 285 px em 1280/1440/1920, ambos temas e estados de sidebar. Fixture controlado, sem pedido autenticado. |
| Sidebar expandida/recolhida | PASS (DOM/CSS fixture) | Alternância, atributos acessíveis, grid recolhido e labels testados; avaliações nas viewports especificadas não acharam duplicação nem overflow documental. Persistência real entre reloads não foi exercitada no app autenticado. |
| Preservação mobile | PARTIAL | 360/390 px nos dois temas; shell e ícones geométricos medidos. Conteúdo/ações reais sem sessão e Chrome Android físico continuam pendentes. |
| Fidelidade visual de Rotas | FAIL | Reprovação expressa do proprietário mantida. A captura fixture e ajustes não substituem referência nem revisão do proprietário; tiles/dados reais e composição final continuam pendentes. |
| Testes funcionais/E2E | PARTIAL | `npm test` e CDP isolado só serão reportados conforme execução final; fluxo autenticado de rotas, filtros com dados, Eventos e persistência não provados. |
| Segurança e integridade | PARTIAL | Nenhum banco oficial escrito, autenticação/MFA não contornada; isolamento/RBAC concorrente da UI ainda sem E2E válido. |

O browser foi Chromium/CDP com emulação de viewport, não Chrome Android físico nem modo computador físico. O `403` inicial foi uma resposta de desafio MFA e não prova de senha/permissão recusada; a falha subsequente ocorreu após reload, quando o shell autenticado não apareceu.

## G15–G17 — integridade e publicação do histórico

| Gate | Estado | Evidência/limite |
|---|---|---|
| G15 — Integridade dos repositórios | PARTIAL | Branches, HEADs, remotos e baselines verificadas; tag baseline intacta. Não foi feita operação destrutiva. Browser QA conservou alterações preexistentes, com somente o runner da campanha em commit local. Busca de credenciais em arquivos do adendo/histórico não encontrou marcadores conhecidos. A auditoria ampla de todo o conteúdo remoto permanece limitada pelas alterações históricas e não autoriza limpeza/rewrite. |
| G16 — Histórico e evidências | PASS (registro desta intervenção) | Registro 0304-A, resumo, índice, estado, inventário, pendências, gates/matriz/regressões e capturas foram organizados; links relativos do conjunto atualizado validados. Não encerra pendências anteriores. |
| G17 — Política de publicação | PASS | Push fast-forward apenas de `codex-historico` (`3b988fe` → `b1a0093` → `07f080b` → `d7456f9`). Nenhum push de Restaurante, Motoboy ou Browser QA. |

Nota: a linha G15 da tabela original desta campanha refere-se a “sem regressões”. Para manter os identificadores da matriz inicial, ela continua preservada como avaliação de regressões; nesta intervenção de auditoria, G15 usa a definição de integridade dos repositórios definida pelo proprietário. As duas avaliações não encerram uma à outra.

## Intervenção do proprietário — reprovação visual (checkpoint)

Estado atualizado em 2026-10-23: **G-VIS-01–G-VIS-10 em avaliação; G14 FAIL por decisão do proprietário.** A campanha permanece aberta, sem aprovação visual ou PASS global.

As referências originais da pasta Download continuam preservadas e foram reabertas para esta intervenção:

| Arquivo de trabalho | Dimensões | SHA-256 | Composição observada |
|---|---:|---|---|
| `REFERENCIAS/rotas-celular.png` | 1536×1024 | `3a7ce349bd189acbbcd80204c934abcae7a4ce25c0061a342147348ebae1e257` | Composição de celular escura e clara lado a lado. |
| `REFERENCIAS/rotas-tablet.png` | 1536×1024 | `3f1c6ec3cfdde2b4d00aad1a242c2130551d232fde6927422be2eda01c567e8e` | Composição tablet escura/clara. |
| `REFERENCIAS/rotas-pc.png` | 1536×1024 | `4b6cdb21b8890f1e5b18fca0805ecaa898af18366a7e5fd89e27cd2a3f4f8f88` | Composição PC escura/clara. |

Diferenças estruturais confirmadas pelo proprietário: resumo em três cartões antes do mapa; excesso de superfícies/cartões e estados vazios; barra de filtros parcialmente cortada; proporções e distribuição de mapa, painéis, planejamentos e entregas distintas da referência. A implementação atual permanece preservada para comparação antes/depois; as referências não serão substituídas por screenshots do produto.

Checkpoint de trabalho neste momento: branch Restaurante `codex/campaign-0304-rotas-v2`, último commit `f4d3dcb564fa37ad645350135ff70da4072f775c`, com alterações locais em curso do complemento 0303-A de notificações e arquivos de capturas sticky regravados pela execução CDP. Nenhuma alteração será descartada. Reorganização visual de Rotas ainda pendente. Autenticação de Browser QA previamente retornou HTTP 403, portanto persistência/RBAC/sync e nova comparação autenticada seguem com bloqueio conhecido.

Não há PASS global. A tela de login e render isolado do renderer não são aceites como comparação final de aplicação.

## Intervenção visual — checkpoint pós-correção estrutural

Em 2026-10-23, os controles cortados foram substituídos por grade responsiva, o mapa passou a preceder os conteúdos secundários no celular, KPIs foram removidos do topo e os estados vazios foram condensados. Em 600–850px retrato, a tela usa uma coluna com mapa largo; tablet paisagem e PC mantêm painel de rotas, mapa e detalhes conforme a largura. Nos layouts largos, os painéis laterais continuam visíveis sem dados, sem criar conteúdo sintético.

O renderer `routes()` de produção foi capturado por CDP em 10 viewports, dois temas. Não é a aplicação autenticada e não carrega dados de rota nem tiles reais. Medidas e matriz: `matriz-fidelidade-visual.md`; capturas/JSON: `capturas/0304-rotas-*`. Os 5 controles ficaram integralmente na viewport e a largura documental não excedeu o viewport nas linhas atuais. Esta evidência não reverte a reprovação do proprietário.

| Gate visual | Estado no checkpoint | Limite |
|---|---|---|
| G-VIS-01 | PASS | Referências reabertas, identificadas, medidas e hashes preservados. |
| G-VIS-02 | PARTIAL | Hierarquia celular corrigida; hierarquia PC/toolbar ainda diverge. |
| G-VIS-03 | PARTIAL | Canvas domina celular e centro do tablet/PC; tiles/markers reais não validados. |
| G-VIS-04 | PASS (fixture) | 5/5 filtros visíveis em 10 viewports; ação Ajustar ligada ao mapa. |
| G-VIS-05 | PARTIAL | Painéis presentes conforme larguras; conteúdo real e sequência de paradas não comparados. |
| G-VIS-06 | PARTIAL | Celular escuro capturado no fixture; aplicação autenticada pendente. |
| G-VIS-07 | PARTIAL | Celular claro capturado no fixture; aplicação autenticada pendente. |
| G-VIS-08 | PARTIAL | Tablet retrato/paisagem capturados; validação funcional final pendente. |
| G-VIS-09 | PARTIAL | PC capturado; toolbar e conteúdo de referência ainda diferem. |
| G-VIS-10 | PARTIAL | Regressões direcionadas passaram; E2E autenticado bloqueado por 403. |
