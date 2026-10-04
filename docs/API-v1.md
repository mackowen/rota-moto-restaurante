# RotaMoto HTTP API v1

Este documento descreve a API local do backend do Restaurante. O servidor deve permanecer em loopback. As rotas de domínio e administração usam sessão do RotaMoto, tenant da sessão e permissões versionadas; nenhuma rota aceita `companyId`/`tenantId` como autoridade.

## Convenções

- JSON UTF-8; endpoints autenticados retornam `Cache-Control: no-store` e `X-Request-ID`.
- Erro: `{ "error": { "code": "STABLE_CODE", "message": "mensagem segura" }, "requestId": "uuid" }`.
- Códigos usados: `INVALID_INPUT` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `METHOD_NOT_ALLOWED` (405), `CONFLICT`/`REVISION_CONFLICT` (409), `PAYLOAD_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `RATE_LIMITED` (429), `DEPENDENCY_UNAVAILABLE` (503), `INTERNAL_ERROR` (500). O ACK do sync tem códigos de rejeição/conflito por operação, independentemente do status HTTP do pacote.
- Erros internos não retornam SQL, stack, path, token ou secret. Logs usam request ID, método, path, status, duração e código sanitizado.
- Mutação de sessão exige CSRF e validação de origem conforme a rota. Cookies de sessão são `__Host-rotamoto_session`, `Secure`, `HttpOnly` e `SameSite=Lax`.
- Para frontend em outra origem, configure `ALLOWED_ORIGINS` com uma lista separada por vírgulas de origens exatas (sem curingas); `ALLOWED_ORIGIN` legado continua aceito. Preflight envia credenciais e permite `Content-Type`, `X-CSRF-Token` e `PATCH`. POST/PATCH autenticados validam origem e CSRF.
- Os clientes usam `/api` por padrão. Em uma implantação com frontend e API em origens distintas, injete `window.ROTA_MOTO_API_BASE` (incluindo `/api`) antes de `app.js` e `identity-ui.js`; configure a origem exata em `ALLOWED_ORIGINS`. Como a sessão usa cookie `SameSite=Lax` com prefixo `__Host-`, mantenha frontend e API no mesmo site e use HTTPS fora do ambiente local. Não configure a URL da API a partir de payload ou dado sincronizado.
- Leituras administrativas são paginadas quando podem crescer. Cursores são opacos/keyset; IDs são UUID canônicos.
- Escritas do domínio passam pelo protocolo Local-First `POST /api/sync/push`; esta API não introduz CRUD paralelo.

## Health

| Método/path | Auth/permissão | Entrada | Saída | Observações |
|---|---|---|---|---|
| `GET /health` | Nenhuma (loopback) | — | `{ok,status:"live",service,time,requestId}` | Alias de liveness. |
| `GET /health/live` | Nenhuma (loopback) | — | Mesmo formato, `status:"live"` | Não testa o banco. |
| `GET /health/ready` | Nenhuma (loopback) | — | `status:"ready"` e dependências, ou 503 `not_ready` | Testa conexão e objeto essencial usando `rotamoto_app`, com timeout limitado. Não revela erro interno. |

## Identidade e sessão

| Método/path | Auth/permissão | Entrada | Saída/efeito | Idempotência/erros |
|---|---|---|---|---|
| `POST /api/identity/login` | Anônima; rate limit | `email,password,companyId`; `mfaCode` quando solicitado | Define cookie de sessão; retorna `userId,companyId,csrfToken` | Não enumera conta; 401/400/429. Roles com permissão administrativa e contas marcadas exigem provider MFA; sem provider, falha fechado. |
| `GET /api/identity/session` | Cookie de sessão | — | usuário, empresa ativa, permissões, indicador `mfaVerified` e CSRF renovado | 401 se sessão inválida/expirada. |
| `POST /api/identity/logout` | Sessão + CSRF | — | Revoga a sessão e limpa cookie; 204 | Repetição permanece segura. |
| `POST /api/identity/tenant` | Sessão + CSRF | `companyId` como seleção | Atualiza empresa ativa somente após validar membership ativo; retorna `activeCompanyId` | A entrada seleciona; nunca concede acesso. Tenant administrativo também exige que a sessão já tenha MFA verificado. |
| `POST /api/identity/recovery` | Anônima; rate limit | `email` | 202 `{accepted:true}` | Resposta não enumera usuários. Entrega depende de provider configurado. |
| `POST /api/identity/recovery/consume` | Token de uso único | `token,password` | 204 | Não ecoa token; token inválido/expirado/consumido falha fechado. |
| `POST /api/identity/invitations/accept` | Token de owner-invitation | `token,password` | Aceita o provisionamento inicial existente | Não é convite público genérico para memberships. |
| `POST /api/identity/membership-invitations/accept` | Token de uso único | `token,password` | Cria credencial, verifica email e ativa nova associação; retorna IDs canônicos | Token nunca aparece na resposta; conta existente deve aceitar autenticada. Convite administrativo exige MFA antes de criar sessão. |
| `POST /api/identity/membership-invitations/accept-authenticated` | Sessão + CSRF; usuário deve ser o destinatário | `token` | Ativa associação convidada para conta já existente | Consumo transacional e único; mudança para empresa exige seleção validada posterior. |
| `POST /api/admin/tenants/provision` | Adapter de operador privilegiado + rate limit | `companyName,email,idempotencyKey` | 202 com IDs e status de entrega | Sem adapter operacional retorna indisponibilidade; não existe signup público nem bypass. |
| `POST /api/admin/invitations` | `members.invite` + MFA verificado + CSRF | `email,roleId` | 202 `{membershipId,delivery}`; token só é entregue ao provider | Sem provider retorna 503 antes de gravar; role acima do nível do ator é rejeitada. |

## Sync Local-First

| Método/path | Auth/permissão | Entrada | Saída | Idempotência/erros |
|---|---|---|---|---|
| `POST /api/sync/installations/restaurante` | Sessão + CSRF + `sync.push` | `{deviceId}` | Identidade da instalação | Repetir para a mesma instalação é idempotente; outra associação é negada. |
| `POST /api/sync/installations/motoboy` | Sessão + CSRF + `sync.push` | `{deviceId}` | Identidade da instalação | Mesmo comportamento. |
| `POST /api/sync/push` | Sessão + CSRF + `sync.push` | Envelope `rotamoto-sync` v1/schema v1 | Resultado do pacote e `operationResults` por operação | `accepted`, `duplicate`, `rejected` ou `conflict`; HTTP 200 não significa aceite universal. `packetId` e `eventId` idempotentes. |
| `GET /api/sync/pull?deviceId=…&limit=…&cursor=…` | Sessão + `sync.pull` | Instalação registrada; cursor keyset | Eventos/snapshots do tenant e próximo cursor | Retry seguro; instalação/tenant validados server-side. |

Operações de negócio autorizadas devem continuar no fluxo outbox/inbox/reconciliação do cliente. O servidor deriva tenant e actor da sessão/instalação registrada; `source.app` não é identidade confiável.

## Consulta do domínio

Base: `GET /api/domain/{collection}` ou `GET /api/domain/{collection}/{canonicalId}`. Cookie de sessão obrigatório; sem CSRF por ser somente leitura; rate limit por IP/endpoint. Query aceita somente filtros declarados abaixo, `limit` (1–100, padrão 50), `cursor` e, para lista, `includeDeleted=true|false`.

| Collection | Permissão | Filtros |
|---|---|---|
| `orders` | `orders.read` | `status` |
| `deliveries` | `sync.pull` | `status`, `driverId`, `orderId` |
| `routes` | `sync.pull` | `status` |
| `drivers` | `sync.pull` | `status` |
| `delivery-events` | `sync.pull` | `relatedId` |
| `locations` | `sync.pull` | `relatedId` |
| `proofs` | `sync.pull` | `relatedId` |
| `earnings` | `sync.pull` | `driverId`, `relatedId` |

Lista retorna `{records:[{id,record,version,createdAt,updatedAt,deletedAt}],nextCursor,hasMore,requestId}`. Busca por ID retorna o mesmo envelope singular sem expor se UUID de outro tenant existe. Registros tombstoned são omitidos por padrão. `includeDeleted` exige a mesma permissão de leitura. Filtros são allowlisted, parametrizados e sempre combinados com o tenant da sessão. Esta API não oferece mutação de Order/Delivery/Route/Event/Earning; autoridade continua no sync.

## Administração, memberships e RBAC

| Método/path | Permissão | Entrada | Saída |
|---|---|---|---|
| `GET /api/admin/company` | `company.manage` | — | ID, nome, status e timestamps da empresa ativa. |
| `GET /api/admin/memberships?limit=…&cursor=…` | `members.read` | `limit` (1–100) e cursor | Memberships da empresa ativa com identificadores, email, estado, role e permissions. Não retorna credenciais/sessões. |
| `GET /api/admin/roles` | `company.manage` | — | Roles da empresa e permission keys. |
| `GET /api/admin/permissions` | `company.manage` | — | Catálogo versionado e descrições de permission keys. |
| `GET /api/admin/integrations` | `integrations.manage` | — | Provider, status e metadados de external account; nunca `secret_ref`, tokens ou credentials. |
| `POST /api/admin/roles` | `company.manage` + MFA verificado + CSRF | `{key,name,permissions[]}` | 201 com role criada | Permissões devem existir e ser subconjunto das permissões efetivas do ator; keys `owner`/`admin` são reservadas. |
| `PATCH /api/admin/roles/{roleId}` | `company.manage` + MFA verificado + CSRF | `{name,permissions[]}` | Atualiza role custom e auditoria | Role owner/system e perfil atualmente usado pelo ator são imutáveis; usuários afetados têm sessões revogadas e MFA marcado quando ganha permissão administrativa. |
| `PATCH /api/admin/memberships/{membershipId}` | `company.manage` + MFA verificado + CSRF | `{roleId?}` e/ou `{status:active\|suspended\|revoked}` | Atualiza associação e revoga sessões dela | Não permite autoalteração; role acima do ator, ativação sem credencial verificada e remoção do último owner válido retornam erro estável. |

O tenant e o ator vêm da sessão verificada e RLS; nenhum endpoint recebe `companyId` para autorizar acesso. Mutações escrevem `audit_log` sem senha, token ou PII desnecessária. Roles não são apagadas; memberships revogadas permanecem como histórico. `active` só pode ser restaurado a uma associação suspensa com conta habilitada, senha e email verificados; convite é ativado pelo token de uso único. O último owner válido (associação ativa, conta habilitada/verificada, credencial habilitada para sessão MFA) não pode ser removido/rebaixado. As mudanças críticas usam lock transacional por tenant.

## Providers legados / internos

Rotas `/api/ifood/*`, `/api/99food/*` e `/api/keeta/*` existentes são interfaces internas legadas do servidor local e não fazem parte da API multi-tenant autenticada. Não devem ser expostas fora de loopback/proxy autenticado. Algumas ações ainda usam estado em memória; polling/webhooks persistentes, gestão de credenciais e isolamento por tenant pertencem à F4 e não são declarados prontos por este documento.

## Não exposto intencionalmente

- Signup público; CRUD genérico; escrita direta de domínio fora do sync; download/upload de blob sem provider; consulta global de usuários; alteração arbitrária de roles; acesso ao ledger de migrations.
- MFA de produção segue bloqueado até provider de verificação e armazenamento protegido (KMS/secret manager) estarem configurados. O adapter recebe somente user ID e código; segredos MFA nunca passam pelo cliente. Provisionamento do owner continua fechado sem adapter de operador privilegiado.
- Email real para recovery/convites depende de provider configurado. Nenhum token bruto é retornado ou persistido.
- Seleção de empresa valida membership e ID informado, mas a descoberta de outras empresas não é globalmente exposta por causa do RLS; a interface usa IDs entregues pelo fluxo de convite/provisionamento.
