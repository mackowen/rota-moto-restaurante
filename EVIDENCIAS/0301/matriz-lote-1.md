# Matriz funcional — checkpoint Campanha 0301

Estado após o lote 1, branch codex/campaign-0301-global-design-system. A campanha permanece PARTIAL; linhas sem execução explícita ficam PARTIAL/BLOCKED, nunca PASS por presença estática.

| Área/campo | Alteração | Browser/UI | persistência/reload | regressão | estado |
|---|---|---|---|---|---|
| Pedidos — busca textual | Campo organizado com ação Limpar | Browser autenticado, 390×844 dark; pedido sintético encontrado em combinação com filtro rápido | Read-only; filtro é transitório | Unit + E2E; limpar repõe estado e lista | PASS_SCOPE |
| Pedidos — filtros rápidos | Todos/Aguardando/Atribuídas/Em rota/Concluídas/Canceladas; aria-pressed sincronizado | Browser autenticado; Aguardando filtrou corrida sintética e indicou ativo | Estado transitório da tela | Unit cobre os seis grupos | PASS_SCOPE |
| Pedidos — filtros avançados | Status reseta grupo rápido incompatível; motoboy/tipo compõem a busca | Renderizados; combinações além da busca não exercitadas no Browser | Não persistente por desenho | Combinações restantes pendentes | PARTIAL |
| Pedidos — ações na lista filtrada | Rebinding Abrir/Imprimir/QR após substituir HTML da tabela | Browser autenticado; Imprimir abriu modal após filtrar; Abrir e QR não exercitados na tabela filtrada | Sem escrita canônica | Unit verifica handlers dos três tipos | PARTIAL |
| Pedidos — visual celular/desktop | Busca, filtros rápidos e detalhes agrupados com CSS scoped | Browser Home cobriu 20 combinações; Orders exercitado só em 390×844, sem captura específica | N/A | Detalhes visuais da área ainda precisam revisão | PARTIAL |
| Todos os demais módulos (Rotas, Motoboys, gestão logística, relatórios, eventos, configurações/administração/integrações/backup/laboratório/ajuda) | Sem alteração funcional neste checkpoint | Navegação smoke do baseline 0300; não equivale à integração de cada módulo | Sem novo teste | O fixture reportou 404 em APIs de fila/logística/analytics previamente identificadas | PARTIAL; dependências de capacidade permanecem abertas |

## Segurança / ambiente

- Sessão backend-issued, MFA verificada; fixture tenant-scoped em rotamoto_e2e.
- databaseCommitted=false; cleanup=COMPLETED; tenantScopedResiduals=0.
- Banco oficial, Motoboy e browser-tests não foram modificados.
- Browser foi Chromium com emulação de viewport; não houve teste em aparelho Android físico.
