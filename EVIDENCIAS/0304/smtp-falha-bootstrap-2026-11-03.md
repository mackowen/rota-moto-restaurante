# Falha do teste SMTP Gmail no Bootstrap — 2026-11-03

## Classificação

**PARTIAL.** Causa raiz comprovada após SMTP aceitar o envio: falha de auditoria local interrompia o fluxo antes da persistência e era apresentada como rejeição SMTP. O operador reportou recebimento das duas mensagens reais na caixa Gmail. Nenhum novo e-mail foi enviado nesta investigação.

## Evidências consultadas

- `scripts/official-api-runtime.js`: o serviço recebe ambiente filtrado por `env -i`; antes da correção, `applyOfficialOperatorConfig()` recebia `config.operatorAudit` mas não repassava caminho/ator ao processo HTTP. A auditoria confirmou que o processo anterior não tinha `ROTAMOTO_OPERATOR_AUDIT_LOG` nem `ROTAMOTO_OPERATOR_ACTOR_REF`.
- `backend/identity/smtp-configuration.js`: sequência confirmada: `verify()` → `sendMail()` → auditoria obrigatória → ler configuração anterior → `secretProvider.put()` (se necessário) → `saveStored()`. Portanto, `OPERATOR_AUDIT_CONFIGURATION_REQUIRED` ocorria depois da aceitação e antes de qualquer persistência Bootstrap. O `catch` original convertia a exceção local desconhecida para `SMTP_TEST_FAILED`.
- `backend/runtime/operator-audit.js` e diretório local protegido: zero eventos SMTP na auditoria; diretório modo 0700 existe.
- `node scripts/rotamoto-operator.js status`: SMTP legado `transportConfigured=true`, keystore `verified`; configuração completa de convite não pronta.
- Consulta local protegida `smtpConfiguration.status()` (somente whitelist de campos): configuração Bootstrap não configurada, sem status/horário de teste, sem referência de credencial própria persistida.
- PostgreSQL `rotamoto`: papel auditor recebeu `permission denied` para SELECT na tabela de tentativas. Transação separada `BEGIN READ ONLY` com papel migrador consultou somente `attempted_at`: 7 tentativas Bootstrap acumuladas, 0 administrativas. A tabela não registra resultado/aceitação; não há request IDs no relatório e não é possível identificar quais linhas correspondem às duas mensagens recebidas. Nenhum token ou digest foi selecionado.
- Gmail compatível com os parâmetros validados pelo app: `smtp.gmail.com`, porta 465, TLS implícito, usuário/senha SMTP; senha de app funciona como credencial desse mecanismo. Credencial protegida não foi lida, impressa, trocada ou rotacionada.

## Correção

O runtime oficial agora exporta os campos de auditoria do contexto de operador e um arquivo distinto de diagnóstico SMTP privado. Detalhes técnicos brutos ficam apenas nesse arquivo, com validação de symlink, proprietário, hardlink e permissões; HTTP e auditoria sanitizada não recebem esses detalhes.

Após `sendMail()` confirmar aceitação, falha de auditoria e falha de persistência agora retornam códigos específicos com `submission=accepted_by_smtp`, `delivery=unconfirmed`, `configurationSaved=false`; a mensagem não afirma rejeição do Gmail. Antes da aceitação, DNS, TCP, timeout, STARTTLS, certificado, autenticação, remetente, destinatário e rejeição da mensagem têm códigos distintos. Interrupção durante `DATA` sem resposta SMTP conclusiva é `SMTP_SUBMISSION_UNKNOWN`. Timeout/erro de rede no browser mantém o resultado como desconhecido e exige confirmação explícita antes de outro envio. O estado temporário do pedido fica apenas em sessionStorage; clique simultâneo é bloqueado. Replay/concorrência no servidor continua com a barreira de request ID.

## Regressão isolada

- `npm run test:smtp-bootstrap` — PASS: SMTP aceito; falhas pré-envio; auditoria e keystore falhando após aceitação; timeout, DNS e destinatário; replay e concorrência; configuração oficial de auditoria.
- Chromium/CDP real em `/bootstrap.html`: 390×844, 768×1024, 1440×900, claro/escuro; 6/6 sem overflow ou exceções JS. SMTP test foi interceptado e simulado como aceitação seguida de falha de auditoria; resposta segura exibida sem conteúdo sensível. Clique duplicado imediato causou uma única requisição; segunda requisição só ocorreu após confirmação modal explícita. Os dois requests mockados retornaram 503 e não atingiram transporte SMTP.
- O controle Continuar permaneceu desabilitado para setup externo sem SMTP/link persistido; seleção explicitamente local-only habilitou o avanço local.
- `node --check` nos módulos alterados, assets check e `git diff --check` — PASS.

O recebimento das duas mensagens é evidência informada pelo operador; o aplicativo não tem confirmação independente de entrega. A causa não é configuração Gmail nem conectividade do Termux: o Gmail aceitou e entregou segundo o operador; o defeito comprovado é o runtime/auditoria da implementação RotaMoto. Os dois testes não deixaram configuração Bootstrap validada/persistida. Após ativação da correção, o proprietário deve autorizar explicitamente um novo teste (que enviará novo e-mail); para convites externos, também informar URL pública HTTPS. Nenhuma autorização oficial foi criada e a instalação não foi concluída.

Aplicação: `rotamoto-api-official` foi reiniciado após os commits; `sv status` confirmou serviço ativo e `/health/ready` voltou `ready`. Não houve POST SMTP nesse reinício.
