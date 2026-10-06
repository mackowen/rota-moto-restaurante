# Operação logística híbrida

## Modelo e estado atual

`Order.source` identifica a origem comercial. `LogisticsProvider` identifica quem executa a entrega. `Delivery` continua sendo o agregado compartilhado; `Route` planeja somente a frota própria. Entregador externo nunca é `Driver`, e snapshot externo nunca é `LocationPoint` do Motoboy.

O Restaurante tem endpoints autenticados e tenant-scoped para configuração não secreta do provider, solicitação/listagem/seleção de quote, dispatch, cancelamento, refresh de tracking, reconciliação e leitura de comandos. Escritas exigem `company.manage`, sessão, CSRF/origin e MFA conforme a política existente. API não é habilitada pelo endpoint administrativo; `api_enabled` permanece false até existir credencial por boundary autorizada e todos os requisitos comerciais.

No fluxo visual, a operação MANUAL segue disponível. Modo API exibe quote/dispatch/cancel/tracking/reconcile apenas habilitados quando o banco informa provider API ativo. Sem configuração, os controles ficam desativados e explicam o estado. O registro manual não chama qualquer plataforma.

## Providers

| Provider | Comercial/pedidos | Logística externa | Estado |
|---|---|---|---|
| iFood | Pedidos existentes permanecem sob `Order.source`; o adapter exige referência externa UUID compatível com o contrato já auditado. | Adapter registrado para quote, requestDriver, cancel e tracking. `202` permanece `requested/pending`. | Preparado com registry/worker/outbox; tráfego fail-closed. Credencial resolver, merchant authorization, elegibilidade/contrato e homologação ausentes. Webhook ingress ainda não está conectado ao servidor. |
| 99Food | Boundary comercial separado. | Nenhuma documentação oficial logística comprovada no Registro 0082. | Sem adapter e sem capability. `NOT_DOCUMENTED / BLOCKED`. |
| Keeta | APIs de pedidos/self-delivery não comprovam courier contratado. | Nenhuma API oficial comprovada para contratar courier externo no domínio deste fluxo. | Sem adapter. `NOT_DOCUMENTED / BLOCKED`. |

## API e semântica do worker

Rotas em `/api/logistics/` usam a identidade e transação tenant autenticadas. O outbox de provider é separado de `sync_outbox` porque side effects remotos têm retry e resultado ambíguo próprios. Seleção de quote e criação do fulfillment ocorrem na mesma transação. O dispatch grava `DispatchAttempt` e command outbox juntos; o worker só chama adapter depois do commit.

`scripts/provider-worker.js` é processo server-side separado. Ele exige `ROTAMOTO_PROVIDER_WORKER_ENABLED=true`, uma allowlist explícita `ROTAMOTO_PROVIDER_WORKER_TENANTS`, role `rotamoto_provider_worker`, role `rotamoto_provider_resolver`, senha resolvida pelo keystore e pool/TLS configurados. O worker não usa migrator. A role worker não recebe `secret_ref`; a role resolver lê só a coluna necessária e é tenant-scoped por RLS. Migration 0023 revoga de `rotamoto_app` o claim SECURITY DEFINER que poderia devolver comandos de outro tenant.

As roles dedicadas não existem no PostgreSQL oficial deste host. O worker e o ingress não devem ser iniciados até um DBA provisioná-las conforme `backend/postgres/admin/provider-runtime-roles.md` e gravar as respectivas referências no secret store. A ausência de role/segredo mantém chamadas bloqueadas. Mesmo após provisionadas, configuração iFood, `api_enabled` e capabilities não são promovidas automaticamente.

Entrega é at-least-once com chave local estável. Não existe exactly-once. Backoff limitado/jitter é persistido para falhas transitórias e rate limit. Falha AUTH/permanente/conflito não repete automaticamente. Timeout de dispatch/cancel e lease expirada viram `unknown_outcome`/revisão humana; nunca há retry cego. HTTP 202 confirma somente que a requisição foi aceita para processamento, não que courier foi alocado nem que cancelamento foi concluído.

## Quote, dispatch, tracking e cancelamento

Quote persiste provider, ID externo, moeda, valor em minor units, ETA somente quando fornecido, validade, timestamps e versão. Expirada não pode ser selecionada. Valores permanecem na moeda nativa; preço ausente não vira zero.

Dispatch usa quote selecionada, cria `DispatchAttempt` e command no mesmo commit. Estado `requested`/`pending` não promove a Delivery para execução confirmada. Tracking persiste somente snapshot mínimo e timestamp de proveniência; coordenadas externas não são armazenadas nem encaminhadas ao Motoboy. Cancelamento é command assíncrono; resposta 202 não marca fulfillment como cancelado.

Fallback para manual/frota própria continua disponível quando a lifecycle da Delivery permite. A interface não cria Driver externo e respeita rota ativa e reconciliação necessária antes da reatribuição.

## Webhook, inbox e reconciliação

O adapter iFood tem verificação HMAC-SHA256 e normalização estrita, mas ainda não existe endpoint HTTP de webhook ligado ao servidor nem resolução autenticada de tenant/provider por rota externa. `provider_event_inbox` persiste somente eventos normalizados/digest, sem body bruto. A ingestão genérica exige company/provider resolvidos por boundary confiável; ela não deve ser exposta como endpoint aceitando `companyId` do payload.

O contrato consultado não fornece mecanismo anti-replay por timestamp para este adapter. Não invente header de timestamp. Quando endpoint ingress for ativado com rota/provider secret configurados, usar HMAC sobre bytes brutos e unicidade de ID de evento/digest; evento fora de ordem precisa comparar timestamp fornecido pelo evento e jamais retroceder projeção. No estado atual, webhook é `OPEN`, sem recebimento externo.

Reconciliação está exposta na API como command, mas polling externo e projeção assíncrona de eventos ainda dependem de endpoint/capabilities documentados e worker habilitado. Divergência deve ser registrada para operador, não sobrescrita silenciosamente.

## Configuração e credenciais

Admin pode editar nome, modo manual/API não ativado e configuração não secreta. A listagem informa `apiEnabled`, credencial configurada (derivada apenas do gate persistido), webhook e último teste sem retornar segredo ou `secret_ref`. A tela nunca recebe token/segredo.

`rotamoto_app` não tem SELECT/UPDATE de `logistics_providers.secret_ref` nem `external_accounts.secret_ref`. `external_accounts` oferece somente SELECT por coluna nos metadados exibidos no painel; `secret_ref` não está nessa projeção. Não use role migrator em worker/runtime. O adapter recebe credenciais somente da camada de keystore. O fake provider está sob `tests/` e não é incluído no registry de produção nem no script operacional.

## Analytics e retenção

Analytics informa volume manual/própria/provider e contagens persistidas de quotes, seleção/expiração, dispatch confirmado/falho/desconhecido, cancelamentos desconhecidos, retries, reconciliação e revisão humana. Dispatch confirmado conta tentativa API vinculada confirmada; `202` não entra como confirmação. Os totais são acumulados por provider; não se calcula lucro/margem e não há conversão de moeda.

Quotes, commands, eventos e snapshots têm retenção operacional; ainda não há cleanup automático. Remoção deve aguardar definição operacional e preservar trilha de auditoria/idempotência/reconciliação. A inbox guarda apenas schema normalizado e digest, não payload bruto/PII.

## Inteligência econômica assistida v1

O endpoint autenticado `GET /api/logistics/deliveries/:id/comparison` compara a frota própria, quotes externas API válidas e operações externas manuais aplicáveis. `GET/PUT /api/logistics/intelligence/settings` mantém por tenant o custo fixo por entrega, a taxa variável por quilômetro, a moeda e a política padrão. Alterações exigem `company.manage`, CSRF/origin, versão esperada e auditoria.

A estimativa marginal da frota própria é `fixo configurado por entrega + ceil(taxa variável configurada × distância estimada em metros / 1000)`, arredondada para a próxima unidade monetária mínima. Ela só é conhecida quando o perfil inteiro está configurado e a distância existe para taxa variável positiva. Distância pode vir de `Delivery.estimatedDistanceM` ou do legado `Order.km`, identificada como estimada. Não inclui automaticamente combustível, manutenção, depreciação, salários, taxas, receita de `Order.value` ou `Earning`.

A política `lowest_cost` recomenda somente se houver pelo menos duas alternativas elegíveis, todos os valores forem conhecidos e estiverem na mesma moeda; empate e moeda incompatível não selecionam vencedor. `earliest_eta` exige ETA explícito para todas as alternativas elegíveis. `prefer_internal` exige custo interno conhecido, mas não confirma capacidade. Quotes vencidas são excluídas e mostradas como inelegíveis. Toda recomendação inclui alternativas, diferenças conhecidas de custo/ETA, evidências e limitações; não executa dispatch. A decisão e confirmação de disponibilidade permanecem humanas.

### Capacidade e agrupamento em rota

A comparação conta Drivers ativos por status operacional conhecido e entregas atribuídas/em andamento por seus vínculos canônicos. Um Driver cadastrado ou ativo não é considerado disponível. Disponibilidade só aparece como conhecida quando o status é explicitamente `AVAILABLE` e não há entrega atribuída no retrato consultado; status offline/inativo explícito pode ser considerado indisponível. O domínio ainda não define limite simultâneo de carga, por isso slots restantes e capacidade esgotada permanecem desconhecidos mesmo quando o workload é contado.

Uma Route ativa com vínculo canônico a um Driver interno ativo e inequívoco é apenas uma candidata estrutural. A UI não chama isso de rota geograficamente compatível. Sem modelo de distância viária canônico, nenhuma distância incremental ou custo marginal por rota é calculado; coordenadas confirmadas indicam cobertura de destino, não distância de estrada. Não usamos haversine/linha reta, trânsito ou ETA para essa decisão. Para a comparação econômica, uma alternativa própria em cenário sem Route ativa observada pode usar o custo isolado configurado como custo de planejamento de uma nova rota, com essa premissa explícita; havendo rota ativa, scan incompleto ou custo incremental indeterminado, a recomendação por menor custo abstém em vez de comparar o valor isolado como marginal. Nenhuma sugestão altera Route, Driver, fulfillment ou despacho automaticamente.

O relatório agrupa custos estimados e custos finais explicitamente reconciliados por modo (própria/externa), sem somar moedas, e mostra cobertura/denominador. `Earning` é exibido separadamente como repasse registrado, não como custo total ou comprovante de pagamento. A diferença entre cenários não é anunciada como economia gerada pelo produto: não há baseline contrafactual defensável.

## Pesquisa oficial consultada em 2026-10-06

- iFood Shipping: [orders iFood](https://developer.ifood.com.br/en-US/docs/food/guides/modules/shipping/inside), [orders externos / On-Demand](https://developer.ifood.com.br/en-US/docs/food/guides/modules/shipping/outside), [endpoints](https://developer.ifood.com.br/en-US/docs/food/guides/modules/shipping/endpoints), [requisitos de contrato/eligibilidade](https://developer.ifood.com.br/en-US/docs/food/guides/modules/shipping/intro).
- OAuth centralizado: [client_credentials](https://developer.ifood.com.br/en-US/docs/food/guides/modules/authentication/centralized). Credenciais são emitidas pelo portal; autorização/permissões dependem de app e merchant.
- Eventos: [webhook/polling](https://developer.ifood.com.br/en-US/docs/food/guides/modules/events/webhook-overview), [HMAC](https://developer.ifood.com.br/en-US/docs/food/guides/modules/events/webhook-signature), [homologação](https://developer.ifood.com.br/en-US/docs/food/guides/modules/events/homologation). Webhook é at-least-once; polling aparece como caminho de reconciliação na documentação consultada.
- [Rate limits iFood](https://developer.ifood.com.br/en-US/docs/getting-started/documentation/rate-limit/); valores precisam ser revalidados antes de ativação.
- Keeta: [Open Delivery](https://api-docs.mykeeta.com/apis/opendelivery/section/introduction-to-test-store-management), [Merchant SelfDelivery/order API](https://api-docs.mykeeta.com/apis/standard/order). A fonte localizada não comprova contratação de courier externo.
- 99Food: portal/documentação oficial de logística não acessível/localizada no Registro 0082; isso não prova inexistência de oferta em contrato privado.

## Classificação

- **IMPLEMENTADO:** endpoints autenticados de integração, persistência canônica (0020–0022), criação de commands no outbox, registry iFood, worker separado com pool least-privilege, retry/unknown outcome, quote/dispatch/cancel/tracking/reconcile UI, métricas agregadas, audit seguro, proteção do claim em 0023, comparação econômica determinística assistida, analytics com cobertura e grants de `external_accounts.secret_ref` corrigidos em 0028.
- **SIMULADO PARA TESTE:** adapter fake apenas em `tests/helpers`; registry e adapters são testados sem tráfego externo.
- **BLOQUEADO POR CREDENCIAL/INFRA:** ativar worker requer roles `rotamoto_provider_worker`/`rotamoto_provider_resolver` e referências de senha/keystore ainda ausentes neste host.
- **BLOQUEADO POR CONTRATO COMERCIAL:** elegibilidade, autorização merchant e homologação iFood.
- **BLOQUEADO POR DOCUMENTAÇÃO:** logística 99Food e courier externo Keeta.
- **OPEN:** ingress HMAC HTTP público com resolução segura de tenant/provider; provisionar roles dedicadas do worker e validar sua operação em ambiente isolado; preencher custos operacionais adicionais somente após política contábil/operacional confiável. Browser QA autenticado e fluxo Fake interno passaram na campanha 0088.
- **NÃO SUPORTADO:** proof logístico iFood no fluxo documentado; transformar courier externo em Driver; misturar localização externa com Motoboy.
