# Política de dados de desenvolvimento RotaMoto

Esta política aplica-se ao Restaurante e aos contratos compartilhados com o Motoboy.

- Os únicos bancos persistentes permitidos são `rotamoto` (oficial de desenvolvimento) e `rotamoto_e2e` (testes). Scripts e testes não criam bancos automaticamente.
- `rotamoto_e2e` usa exclusivamente a empresa canônica Chico Restaurante. Fixtures devem ser isoladas por transação, revertidas ao final e limpas dentro dessa empresa; não criar empresas adicionais.
- Cenários que exijam múltiplas empresas devem ser reescritos para testar isolamento sem novos tenants quando isso preservar o objetivo. Se não for possível, marcar o cenário como não executado e explicar a limitação; não enfraquecer RLS/RBAC.
- Testes funcionais e escrita usam `rotamoto_e2e`; não usar dados do banco oficial como fixture. Preservar identidade fundadora, MFA, founder latch, grants e auditoria.
- Aplicar migrations aprovadas ao banco de desenvolvimento oficial somente depois de validar checksums, ordem, compatibilidade e recuperação, usando o runner oficial. Não reaplicar migrations aplicadas.
- Executar testes direcionados durante o desenvolvimento e suítes completas nos marcos de integração. Remover somente artefatos temporários identificados após a execução; preservar evidências e documentação histórica.
- Mecanismos sintéticos de autenticação são permitidos somente no E2E isolado. O código mantém MFA, CSRF, RLS, RBAC e isolamento empresarial ativos.

Estado verificado em 2026-10-31: `rotamoto` e `rotamoto_e2e` estão em 0064, com os mesmos 64 checksums. `rotamoto` não possui empresas nem registros de domínio. `rotamoto_e2e` contém exclusivamente Chico Restaurante (ID canônico `01a14b34-2f79-7b57-a29d-9535574e3806`); testes e fixtures reutilizam essa empresa. O fundador E2E, o latch e o grant global foram preservados. Não inferir ausência de dados a partir de consultas bloqueadas por RLS.
