# Plano de reversão 0301

1. A alteração do Restaurante está em branch local própria codex/campaign-0301-global-design-system. Checkpoint imediatamente anterior: 7bf29b787f6df5188a044591ebb7d4ae9545beec.
2. Commits da campanha: f183f6f10930220dba0ae53914436e618e20703b (código/testes/evidências) e f328dfd (sanitização do report). Para desfazer sem reescrever histórico, usar git revert dos commits nesta branch em ordem inversa. Não usar reset e não alterar a tag protegida.
3. O app não foi publicado remotamente. 127.0.0.1:8083 leu o workspace e retornou os mesmos hashes; nenhuma ação de serviço foi executada.
4. O rollback da fixture Browser terminou automaticamente: databaseCommitted=false, cleanup COMPLETED, resíduos tenant-scoped zero. Banco oficial e infraestrutura não foram tocados.
5. Histórico desta campanha será publicado separadamente em codex-historico por fast-forward.
