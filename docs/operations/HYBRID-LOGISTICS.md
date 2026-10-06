# Operação logística híbrida

## Modelo e limites atuais

`Order.source` identifica a origem comercial. `LogisticsProvider` identifica quem executa a entrega. `Delivery` continua sendo o agregado compartilhado; `Route` planeja somente a frota própria. Uma alocação externa não recebe `driverId` e não aparece como tarefa do Motoboy.

O provider `internal_fleet` e providers externos cadastrados operam em **modo manual**. `manual_assignment` é a única capability persistida/habilitada pelo serviço atual. A tela deixa explícito que registrar um despacho manual não chama a plataforma. Não selecione um provider externo como API ativa com base apenas no cadastro.

## Estado por plataforma

| Plataforma | Pedidos comerciais | Logística externa | Situação nesta versão |
|---|---|---|---|
| iFood | Laboratório local legado; protocolo comercial não habilitado | Documentação oficial cobre disponibilidade/cotação, solicitação assíncrona de entregador para pedido iFood existente, cancelamento antes da aceitação, tracking e eventos | Adapter de transporte isolado e testes de contrato locais. Ainda não conectado ao serviço/outbox, não habilitado no catálogo operacional e sem teste com credencial ou homologação. API **não configurada**. |
| 99Food | Boundary local bloqueado | Nenhuma documentação oficial de logística foi encontrada nesta auditoria | **Bloqueado por documentação** para capacidades logísticas; sem chamadas inventadas. |
| Keeta | APIs oficiais de pedidos e eventos existem | Merchant SelfDelivery informa despacho/entrega/atualização do courier do próprio comerciante. Não foi encontrada API oficial para contratar courier Keeta/3PL de fora do fluxo de pedidos | Capacidades de logística contratada **não documentadas**. Não tratar API comercial ou autoentrega como contratação logística externa. |

O catálogo comercial de `integrations` permanece independente do catálogo `logistics_providers`. Ser uma origem suportada comercialmente não ativa cotação, despacho, tracking nem webhook logístico.

## Adapter iFood

Código: `backend/logistics/providers/ifood.js`. As operações aceitam IDs de pedido iFood já existentes, representados no modelo interno pelo `Order.externalId`; não transformam pedido próprio em pedido On-Demand fora da plataforma. O adapter normaliza a cotação para minor units BRL, preserva expiração e não inventa ETA a partir do tempo de preparação. `requestDriver` e cancelamento retornam apenas `requested/pending` após HTTP 202; confirmação depende de evento posterior.

Credenciais chegam por `credentialResolver(companyId, 'ifood')`, uma fronteira injetada do backend. O adapter não lê banco nem `secret_ref`, não recebe credenciais pelo frontend e não persiste token. A integração ainda precisa de um resolver administrativo autorizado ligado ao secret provider, configuração/homologação comercial e worker transacional antes de qualquer capacidade poder ser ligada.

Timeout, erro de rede, 401, 403, 429, 5xx, respostas JSON inválidas e schemas inesperados produzem erros de código/classes sanitizados. Nenhum corpo de erro, endereço, telefone, nome, header Authorization ou token é retornado nos erros. O adapter não repete despacho/cancelamento: depois de timeout o resultado remoto é ambíguo e exige reconciliação. As operações GET podem ser reexecutadas pelo chamador com limite/backoff operacional.

Os dados de tracking do iFood são snapshots do provider, não `LocationPoint` do Motoboy. Courier externo não vira `Driver`. HMAC-SHA256 do webhook iFood é validável sobre o corpo bruto via `verifyWebhookSignature`; ainda falta endpoint público dedicado, persistência/idempotência do evento e fila de processamento. Não há webhook operacional ativo nesta versão.

## Quote e lifecycle

O adapter aceita somente quote ainda válida no instante da resposta, identifica a referência externa e registra moeda explícita BRL. Uma ausência de preço nunca vira zero. Cotação, seleção persistida com expiração, fila outbox, worker de despacho, retry durável e reconciliação ainda não estão ligados ao fluxo operacional; não use esse módulo diretamente em operação de restaurante. A seleção manual e o fallback manual/frota própria seguem disponíveis conforme o lifecycle de Delivery.

### Fundação persistente 0020–0022 (campanha 0083)

A migration `0020_provider_integration_runtime` acrescenta `provider_quotes`, `provider_command_outbox`, `provider_event_inbox` e `provider_tracking_snapshots`. As quatro tabelas são tenant-scoped, usam RLS e FORCE RLS. O outbox de provider é separado de `sync_outbox`, porque comandos remotos têm retry, lease e resultado ambíguo próprios. O claim usa `FOR UPDATE SKIP LOCKED` e só entrega comandos de providers explicitamente habilitados em modo API. `api_enabled` começa falso; nesta versão nenhum provider logístico tem API habilitada no fluxo operacional.

`backend/logistics/provider-integration.js` contém criação idempotente de comandos, validação de payload minimizado, persistência normalizada de quote, seleção com optimistic version/expiração e inbox com digest e deduplicação. `backend/logistics/provider-worker.js` contém o loop de worker, lease, resolução de adapter injetada, retries limitados com jitter determinístico e tratamento de timeout de dispatch/cancel como `UNKNOWN_OUTCOME`. As migrations 0021–0022 tornam o claim tenant-scoped e transformam lease expirada de despacho/cancelamento em estado ambíguo, sem repetição cega. O worker não é iniciado pelo servidor HTTP nesta campanha. Uma conexão de serviço isolada e um resolver de segredo de produção continuam necessários antes de processar tráfego externo; não conceda SELECT de `secret_ref` ao runtime para contornar esse limite.

O helper de adapter fake existe somente em `tests/helpers` e não é importado pelo servidor. Ele é exclusivo de testes. O outbox entrega at-least-once; chaves locais estáveis evitam duplicação local, enquanto resultado remoto ambíguo exige reconciliação. Não há promessa exactly-once.

As tabelas e serviços persistentes ainda não estão ligados aos endpoints de operação, projeção de eventos/webhook ou UI/analytics do Restaurante. Para a campanha 0083, portanto, quotes e comandos API não estão disponíveis aos operadores. A migration prepara armazenamento e worker, mas não deve ser interpretada como ativação end-to-end do provider.

## Credenciais e dados

Não colocar segredo em configuração JSON, IndexedDB, localStorage, fixtures de Git ou log. O runtime não pode ler `logistics_providers.secret_ref` diretamente por privilégio PostgreSQL. A credential resolver precisa obter a referência por uma camada backend autorizada e ler o segredo pelo keystore. O adapter limita tamanho de resposta externa, valida schemas e não guarda conteúdo bruto.

## Pesquisa oficial consultada em 2026-10-06

- iFood Shipping: [orders iFood](https://developer.ifood.com.br/en-US/docs/food/guides/modules/shipping/inside), [orders externos / On-Demand](https://developer.ifood.com.br/en-US/docs/food/guides/modules/shipping/outside), [endpoints](https://developer.ifood.com.br/en-US/docs/food/guides/modules/shipping/endpoints), [introdução e requisitos de contrato/eligibilidade](https://developer.ifood.com.br/en-US/docs/food/guides/modules/shipping/intro).
- iFood auth centralizada: [OAuth client_credentials](https://developer.ifood.com.br/en-US/docs/food/guides/modules/authentication/centralized). A documentação requer credenciais do Developer Portal; as capabilities dependem de permissões concedidas e contratação/eligibilidade.
- iFood eventos: [webhook e polling](https://developer.ifood.com.br/en-US/docs/food/guides/modules/events/webhook-overview), [assinatura HMAC](https://developer.ifood.com.br/en-US/docs/food/guides/modules/events/webhook-signature), [requisitos de homologação](https://developer.ifood.com.br/en-US/docs/food/guides/modules/events/homologation). Webhook é at-least-once e sem ACK; polling pode ser usado para reconciliação.
- iFood rate limit: [limites publicados por endpoint](https://developer.ifood.com.br/en-US/docs/getting-started/documentation/rate-limit/). Os valores podem mudar; o adapter não faz polling nem define scheduler.
- Keeta: [Open Delivery API](https://api-docs.mykeeta.com/apis/opendelivery/section/introduction-to-test-store-management), [Keeta Merchant SelfDelivery/order API](https://api-docs.mykeeta.com/apis/standard/order). Há autenticação e autorização por portal/loja, homologação/test store e eventos; a documentação localizada não comprova serviço de courier contratado externo para esse domínio.
- 99Food: pesquisa restrita a portal/documentação oficial não localizou documentação de developer/logística acessível/publicada. Estado `NOT_DOCUMENTED`, não prova de que o serviço não exista em contrato privado.

## Capacidades e classificação

- **IMPLEMENTADO:** boundary iFood de quote, dispatch request, cancel request, tracking, normalização de eventos e validação HMAC; apenas testável por mocks locais.
- **SIMULADO PARA TESTE:** fixtures determinísticas de responses e eventos no teste de contrato; não são respostas de plataforma.
- **BLOQUEADO POR CREDENCIAL:** chamadas reais iFood, até credencial/tenant authorization e resolver de keystore existirem.
- **BLOQUEADO POR CONTRATO COMERCIAL:** contratação/eligibilidade, certificação e homologação iFood.
- **BLOQUEADO POR DOCUMENTAÇÃO:** 99Food logística; API logística de Keeta para contratar terceiros.
- **NÃO SUPORTADO:** prova de entrega logística iFood no fluxo documentado consultado; courier externo como Driver interno; atribuir ao Motoboy localização de fornecedor.
- **OPEN:** ligar adapter ao quote service/outbox/retry worker, persistir quotes com TTL, integrar webhook iFood com assinatura + idempotência/tenant resolution, desenhar configuração de secret_ref por keystore e entregar operação UI/analytics de API após testes homologados.
