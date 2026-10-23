# Campanha 0302 — Matriz funcional de Pedidos e entregas V2

Cada linha reflete execução na interface autenticada ou está explicitamente limitada. Capturas usam dados sintéticos; não incluem dados reais do proprietário.

| Área/campo | Mecanismo | Teste UI / request / ACK | Readback / reload | Evidência | Estado |
|---|---|---|---|---|---|
| Busca de pedidos | Filtro local sobre projeção canônica | Busca por cliente/identificador retornou um resultado | Limpar e trocar filtros atualizou a lista | `capturas/orders-390x844-dark.png`, `capturas/browser-report.json` | PASS_SCOPE |
| Filtros rápidos | Filtro local com contagens derivadas de pedidos | Todos/Aguardando e busca composta exercitados | Resultado atualizado sem recarga da página | report: `filterResults` | PASS_SCOPE |
| Filtros avançados | Selects de status, motoboy e tipo existentes, recolhíveis | UI renderizada; combinação geral não foi coberta pelo runner | Não exercitado por reload | `capturas/` | PARTIAL |
| Criar corrida/pedido | Formulário operacional já existente | Criado pela interface; API canônica respondeu HTTP 200 | Order permaneceu após F5; CompanyId correspondeu à sessão | `capturas/browser-report.json` | PASS_SCOPE |
| Selecionar pedido e detalhes | Painel adaptativo e fluxo existente de detalhes | Seleção no cartão/tabela; detalhe aberto | Edição pelo formulário existente gerou confirmação canônica | `capturas/orders-768x1024-dark.png`, report | PASS_SCOPE |
| Editar cliente | Salvamento explícito existente | Alteração pela UI confirmada no servidor | GET canônico retornou “Cliente sintético campanha 0302 editado”; reload preservou | report | PASS_SCOPE |
| Impressão | Prévia/comprovante existente | Botão da linha abriu prévia; número e conteúdo coincidiram com a corrida criada | Fluxo do navegador é comprovado; impressão física não testada | report | PASS_SCOPE_BROWSER |
| QR seguro elegível | Serviço de assinatura existente; UI fail-closed | Fixture elegível abriu mensagem de capacidade ausente; endpoint retornou 404 | QR não emitido nem fabricado | `capturas/qr-blocked-390x844-dark.png`, report | BLOCKED_BY_CAPABILITY |
| QR inelegível | Ação omitida para corrida não elegível | Pedido sintético não atribuído não apresentou ação QR | N/A | report | PASS_SCOPE |
| Navegação celular | Navegação compartilhada existente | Browser em 320, 360, 390 e 430 px, claro/escuro | Document width igual ao viewport; ação não coberta | capturas por viewport | PASS_SCOPE |
| Tablet lista/detalhe | Lista + painel contextual com fallback estreito | Browser em 600, 768 e 1024 px, claro/escuro | Painel de detalhes visível no cenário 768; sem overflow do documento | capturas por viewport | PASS_SCOPE |
| Tabela desktop | Tabela semântica de pedidos com scroll contido | Browser em 1280, 1440 e 1920 px, claro/escuro | Sem overflow do documento; largura menor exige rolagem horizontal interna para manter as colunas | capturas por viewport | PARTIAL |
| Cancelar/devolver/atribuir/conflito | Handlers e contratos operacionais existentes preservados; fora da mudança estrutural | Nenhum cenário de mutação executado nesta campanha | Não exercitado | Não aplicável | PARTIAL |
| RBAC e tenant | Sessão E2E emitida pelo backend e MFA verificada | Criação/edição sob a empresa da sessão; CompanyId canônico comparado | Reload preservou pedido da mesma Company | report + manifest | PASS_SCOPE no cenário |
| Nova sessão, troca de empresa e isolamento adversarial | Contratos existentes | Não executados nesta matriz | Não exercitado | — | PARTIAL |

## Mapeamento visual → componente → código → teste → captura

| Elemento | Componente/localização | Teste | Captura |
|---|---|---|---|
| Filtros rápidos e pesquisa | `orders()` / `bindOrdersV2Filters()` em `app.js`; `.orders-v2-filters` em `orders-v2.css` | filtro + busca Browser e regressão `test-orders-quick-filters.js` | 390×844 dark/light |
| Cartões mobile | `ordersV2Table()` como semântica tabular com linhas responsivas; `orders-v2.css` | 320/360/390/430 dark/light; alvos de toque ≥44 px | `orders-{320,360,390,430}x*-*.png` |
| Tablet lista e detalhe | `ordersV2DetailPanel()` e `.orders-v2-workspace` | 600/768/1024 dark/light; painel selecionado observado | `orders-768x1024-*.png` |
| Tabela PC | `ordersV2Table()` e `.orders-v2-table-scroll` | 1280/1440/1920 dark/light | `orders-{1280,1440,1920}x*-*.png` |
| Imprimir | `bindOrdersV2Actions()` delega a `openPrintPreview()` | Conteúdo da prévia conferido | `browser-report.json` |
| QR | `ordersV2QrEligible()` + `openQrPreview()` canônico | inelegibilidade escondida; elegível falha com mensagem clara no endpoint ausente | `qr-blocked-390x844-dark.png` |

## Referências aprovadas

Originais em `/storage/emulated/0/Download/` preservados. Cópias locais incluídas nesta evidência:

| Arquivo original | Dimensões | SHA-256 |
|---|---:|---|
| `entregs-celular.png` | 1536×1024 | `808027d53f180b2d55916ff5d960656b95ac06f552df8dc197ac286b775fec94` |
| `entregas-tablet.png` | 1536×1024 | `04d1c5ee8e15f0cb0d46d5d8a3eacf1ef3b436a2027086bfdaa8c5967e51ddad` |
| `entregas-pc.png` | 1536×1024 | `73c2e52ea89599731c64d39df2da15c27759be90e5928c5a9eea4b6e045f5e5a` |

## Divergências da primeira comparação e correções

1. IDs longos ocupavam demasiadas linhas/colunas; a tabela agora os trunca em desktop e quebra em cartões mobile/tablet.
2. O painel lateral e a tabela comprimiam a grade em larguras intermediárias; o painel recolhe antes da compressão e o tablet usa cartões com detalhes selecionados.
3. Em 1280 px a tabela de oito colunas ultrapassou a área útil e chegou a sobrepor conteúdo. A distribuição automática das colunas eliminou a sobreposição; permanece rolagem horizontal interna nessa largura para preservar todas as colunas e ações.
4. A captura 768×1024 usa painel de detalhe contextual, mas texto de identificadores canônicos longos ainda aumenta a altura de cartão. Não há texto verticalizado ou overflow do documento.

Comparação final: composição celular segue a sequência aprovada (cabeçalho, título, filtros, busca, cartões); tablet apresenta lista/detalhe; PC apresenta tabela operacional. Densidade, nomes e valores ilustrativos das referências não são copiados como dados. **Fidelidade técnica pendente de aprovação visual humana.**

## Ambiente e integridade dos dados

- Browser Chromium/CDP autenticado: `mfaVerified=true`.
- Fixture final: run `330a51d8-c3bb-4745-9abb-aa06f5b5b3d0`, status `COMPLETED`, `databaseCommitted=false`; tabela de contagens do tenant E2E ficou zero para companies, users, auth_records, memberships, sessions, domain_records, sync_inbox, sync_outbox e audit_log.
- Pedido criado pela UI teve ACK HTTP 200 e `companyId` igual ao tenant autenticado; readback da edição e reload passaram.
- Sem erros JavaScript. Um HTTP 401 ocorreu no probe de sessão pré-cookie; o login E2E subsequente foi autenticado com MFA. QR retornou 404 por capacidade de assinatura não configurada.
- 20 capturas em 10 viewports × dois temas; 21ª captura documenta QR bloqueado. Emulação Chromium, não teste físico Android.
- Suite completa `npm test` passou integralmente depois de atualizar expectativas antigas de versão de assets e label acessível. Testes direcionados de pedidos, cache offline, impressão, Dashboard e identidade passaram.
- `127.0.0.1:8083` foi consultado somente por GET. `index.html` servido declarou `orders-v2.css?v=0302.3` e `app.js?v=0302.3`; nenhum serviço foi reiniciado.
