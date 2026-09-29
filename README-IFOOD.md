# Laboratório iFood — v5.41

O laboratório é acessado pelo menu **Laboratório de integrações** quando o iFood está habilitado em Configurações → Pedidos e integrações.

A tela de configurações não contém mais o laboratório. Ela somente define origens/provedores.

O laboratório abre em modal e permite:
- configurar parâmetros locais do conector;
- preparar a estrutura OAuth;
- simular pedido;
- colar evento JSON;
- processar evento/pedido localmente;
- visualizar eventos, ACK, deduplicação e fila;
- testar transições de status.

Permissões:
- `integrationSettings`: alterar origens/provedores;
- `integrationLab` (módulo): visualizar/abrir o laboratório;
- `integrationLabOperate`: executar testes/configurações no laboratório.

Nenhum segredo OAuth ou token é armazenado no navegador.
