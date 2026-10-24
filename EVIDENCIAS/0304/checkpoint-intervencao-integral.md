# Campanha 0304 — checkpoint da intervenção corretiva integral

Data: 2026-10-24. Estado inicial preservado antes das alterações corretivas desta intervenção.

## Estado dos repositórios

| Repositório | Branch / HEAD | Estado local | Remoto / divergência | Baseline |
|---|---|---|---|---|
| Restaurante | `codex/campaign-0304-rotas-v2` / `19f60fc494378c934210e6a74cc6d3c341cde566` | Limpo | `origin/main` `8fcd9f0ffffe37047a79834161cc1f791f20d76f`; branch local 283 commits à frente, nenhum atrás. Sem autorização para publicar aplicação. | `v5.50-ui-mobile-fix5` em `9ebb7098…` |
| Motoboy | `codex/campaign-0295-backup-team-dispatch` / `64d2e13d8e455f48b20b32b396e9c49ba7553e0b` | Limpo | `origin/main` `aad1c6c07499e4fdf5c931ce5ce9e92cde3f7478`; branch local 107 commits à frente, nenhum atrás. Sem mudanças planejadas. | `v39.6-ui-mobile-fix2` em `d5b8f463…` |
| Browser QA | `codex/campaign-0294-admin-settings` / `6f63660700150934efb3f8157022caaa489a8cd1` | 739 exclusões pré-existentes e 250 arquivos não rastreados; nenhum modificado. Preservar integralmente. | Sem remoto configurado. | Não aplicável |
| Histórico | `codex/campaign-0303-ui-refinements` / `3b988fee29f051458cfa3e2999e865d7b275401b` | Limpo | Igual à branch remota publicada. `origin/main` `fe1e4e25dcf2937e8eb904edbe32e40a7640152b`. | Campanhas e registros anteriores preservados |

Os HEADs locais e o estado dos worktrees foram registrados antes de editar código. Não foram usados reset, clean, rebase ou force push. `19f60fc` é um commit local Restaurante não publicado; `3b988fe` está publicado no Histórico. O baseline Restaurante e a tag Motoboy permanecem intactos.

## Servidor e cache

`127.0.0.1:8083` responde HTTP 200 e serve `/` com os mesmos SHA-256 que os arquivos locais no HEAD. Os assets incluem as chaves `routes-v2.css?v=0304.4`, `dashboard-v2.css?v=0304.5`, `dashboard-v2.js?v=0304.3`, `app.js?v=0304.2` e service worker `v101`. Não há evidência de CSS/JS antigo servido pelo nginx. Os cabeçalhos de assets não declaram `Cache-Control`; o service worker pode manter respostas antigas no dispositivo até a atualização normal. O contexto CDP disponível começou em `about:blank`, sem sessão autenticada da aplicação; o cache do Chrome Android do proprietário não é acessível nesta sessão. Nenhum dado local/operacional foi apagado.

## Referências

As cópias de trabalho em `EVIDENCIAS/0304/REFERENCIAS/` foram comparadas com os originais em Downloads por SHA-256, dimensões 1536×1024 e inspeção visual. Celular (`rotas-celular.png`, `3a7ce349bd189acbbcd80204c934abcae7a4ce25c0061a342147348ebae1e257`), tablet (`rotas-tablet.png`, `3f1c6ec3cfdde2b4d00aad1a242c2130551d232fde6927422be2eda01c567e8e`) e PC (`rotas-pc.png`, `4b6cdb21b8890f1e5b18fca0805ecaa898af18366a7e5fd89e27cd2a3f4f8f88`) foram abertos nesta intervenção. Originais preservados.

## Causas-raiz confirmadas no código

1. O ícone do sino é um `<span class="dv2-icon">` dentro do botão. Em `styles.css`, a regra mobile `.top-actions .btn>span` aplica `position:absolute`, `width/height:1px`, `overflow:hidden` e `clip`, escondendo também o SVG. A exceção de estilo para `.dv2-icon` não neutraliza integralmente a regra em todas as combinações/ordens CSS. Um seletor antigo adicional para “Abrir eventos” também escondia um controle por rótulo.
2. O resumo numérico que o proprietário espera foi omitido do markup `routes()`, deixando as contagens como textos auxiliares sem hierarquia de rótulos/valores.
3. `#routeMapEmpty` e `.map-legend` eram filhos posicionados absolutamente sobre o Leaflet; uma mensagem vazia alta cobria os filtros de mapa e a legenda podia competir com controles/explicação.
4. A ausência de localização do restaurante era adicionada como controle Leaflet no canto superior direito, sobreposto ao botão fullscreen e aos controles cartográficos.
5. O cartão elegível reutilizava `.route-row`, cujo grid põe ação e status na mesma terceira coluna/linha; isso sobrepunha status e “Abrir pedido”. A regra global `white-space:nowrap` ainda truncava endereços longos.

## Arquivos previstos nesta intervenção

- `dashboard-v2.js`: manter o SVG do sino independente do wrapper que recebe a regra de ocultação responsiva.
- `styles.css`: remover a regra legada que ocultava o sino e restringir ocultação responsiva aos rótulos textuais específicos.
- `app.js`: KPI semânticos com dados reais; estados do mapa em fluxo; aviso sem controle Leaflet sobreposto; cartão semântico próprio para entregas.
- `routes-v2.css`: hierarquia, área exclusiva de legenda/estados e grid responsivo de cartão.
- referências, matriz, captura e registro 0304: anexar resultados sem substituir evidências/reprovações existentes.

## Reversão

As alterações serão commits locais em branch de campanha, sem reescrita de histórico. Reversão por `git revert <commit-corretivo>` no Restaurante e no Histórico; não usar reset/clean. Nenhum push de Restaurante, Motoboy ou Browser QA está autorizado. Publicação no Histórico fica condicionada a revisão de conteúdo/segredos e fast-forward.

## Estado

G01 — PARTIAL até checkpoint da intervenção ser commitado. A reprovação visual continua registrada como FAIL. Nenhum resultado desta etapa aprova visualmente a interface.

## Checkpoint aditivo — adendo shell desktop e Nova corrida mobile (2026-10-24)

Os valores acima são o estado registrado antes da intervenção; não os substituem nem apagam. Depois daquele checkpoint, foi concluído o renderer CDP de 72 combinações, e os defeitos do shell descritos no registro 0304 foram corrigidos. Novos arquivos/capturas estão no diretório `adendo-desktop/`.

- Causas confirmadas: duplicação do label na saída do navigation renderer; Home com renderer de cabeçalho diferente; regras media em Pedidos ocultavam o painel de seleção >=1024/1341px; regra mobile de clipping de rótulos recortava o span que envolvia o glyph “+”.
- Correções fonte: um único label por item e textos alternativos por área; toggle colapsado/expandido acessível com preferência local; Home usa `renderHeader()` compartilhado; detalhe de Pedidos visível nas larguras >=1180; ícone plus passa a ser irmão do rótulo.
- Evidência CDP: 72 linhas em 360/390/768/1024/1280/1440/1920, claro/escuro e sidebar alternada conforme largura. Zero duplicação/overflow documental. Home 390px: controles 44×44, “+” 19×19; Pedidos desktop painel 285px.
- `npm test` foi reexecutado após a correção final com exit code zero. Testes focados de dashboard, cache, impressão, dispatch, navegação e Rotas também passam. Os scripts CDP são fixtures; não testam APIs, sessão ou domínio autenticado.
- E2E: `403 MFA_REQUIRED` foi desafio esperado, completado; após reload não apareceu o shell e `#app` ficou oculto. Persistência/sync/RBAC/jornada funcional seguem BLOCKED. Chrome Android físico pendente.
- G14/G-VIS 02 permanecem FAIL/PARTIAL conforme gates; a reprovação visual não é revertida. As referências originais permanecem imutáveis. Pendências antigas continuam abertas.
- Nenhum dado de banco oficial, serviço, contrato ou Motoboy foi alterado. Nenhum app/browser push será feito; somente Histórico será publicado em fast-forward.
- Atualização após commits: checkpoint de preservação G01 agora PASS para os arquivos e estados registrados, sem autorizar descarte de alterações preexistentes do Browser QA. A verificação final registrou somente push fast-forward no Histórico; não houve push dos apps/Browser. Este estado não altera G14 FAIL nem fecha pendências funcionais/visuais.
