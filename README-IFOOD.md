# Laboratório local de integração — iFood

Este módulo é um simulador local. Ele gera dados sintéticos para inspecionar estados locais e não comprova conexão, protocolo, autenticação, payload ou transição oficial do iFood.

O backend bloqueia todas as rotas legadas `/api/ifood/*` com `503 PROVIDER_BLOCKED_EXTERNAL`. Não há OAuth, polling, ACK, webhook ou ações externas habilitadas. O gerador local de pedidos não deve ser usado como fixture de contrato do fornecedor nem como pedido canônico de produção.

As opções de origem em Configurações controlam somente a identificação local dos pedidos. Nenhuma tela pede segredo. A administração autenticada mostra a integração como não conectada enquanto o protocolo e a homologação não estiverem verificados.

Permissões locais antigas `integrationSettings`, `integrationLab` e `integrationLabOperate` controlam apenas preferências e simulação local; não concedem autoridade de provider no servidor.

Para habilitar integração real ainda são necessários material oficial atual, credenciais/conta de parceiro, homologação e um secret manager operacional. Só então será implementado e testado um adapter separado e tenant-scoped.
