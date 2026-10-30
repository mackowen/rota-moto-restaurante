# Política de dados de desenvolvimento RotaMoto

Esta política aplica-se ao Restaurante e aos contratos compartilhados com o Motoboy.

- Os únicos bancos persistentes permitidos são `rotamoto` (oficial de desenvolvimento) e `rotamoto_e2e` (testes). Scripts e testes não criam bancos automaticamente.
- `rotamoto_e2e` usa exclusivamente a empresa canônica Chico Restaurante. Fixtures devem ser isoladas por transação, revertidas ao final e limpas dentro dessa empresa; não criar empresas adicionais.
- Cenários que exijam múltiplas empresas devem ser reescritos para testar isolamento sem novos tenants quando isso preservar o objetivo. Se não for possível, marcar o cenário como não executado e explicar a limitação; não enfraquecer RLS/RBAC.
- Testes funcionais e escrita usam `rotamoto_e2e`; não usar dados do banco oficial como fixture. Preservar identidade fundadora, MFA, founder latch, grants e auditoria.
- Aplicar migrations aprovadas ao banco de desenvolvimento oficial somente depois de validar checksums, ordem, compatibilidade e recuperação, usando o runner oficial. Não reaplicar migrations aplicadas.
- Executar testes direcionados durante o desenvolvimento e suítes completas nos marcos de integração. Remover somente artefatos temporários identificados após a execução; preservar evidências e documentação histórica.
- Mecanismos sintéticos de autenticação são permitidos somente no E2E isolado. O código mantém MFA, CSRF, RLS, RBAC e isolamento empresarial ativos.

Estado conhecido em 2026-10-30: `rotamoto` está em 0064 e sem registros operacionais; `rotamoto_e2e` está em 0061. A limpeza/contagem autoritativa do E2E requer backup e leitura administrativa aprovados; não presumir que RLS sem contexto representa ausência de dados.
