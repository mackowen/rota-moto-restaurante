# Rota Moto — Painel Restaurante v5.41

Reorganização de pedidos e integrações:
- Configurações → Pedidos e integrações define somente as origens habilitadas.
- Manual permanece sempre ativo.
- iFood, Keeta, 99 e outros provedores podem ser ativados/desativados.
- Novo provedor pode ser cadastrado.
- O menu Laboratório de integrações aparece quando existe provedor externo habilitado e o perfil possui a permissão correspondente.
- Laboratório iFood abre em modal e mantém o fluxo local de simulação, JSON, eventos, ACK, deduplicação, fila e status.
- Permissões separadas: configurar origens/integrações, visualizar laboratório e operar laboratório.
- Ícones visuais próprios por provedor (iFood, Keeta, 99 e genérico).

## Integrações 99Food e Keeta

O Laboratório de Integrações possui fluxo local-first para 99Food e Keeta, com normalização, deduplicação, eventos locais e `outbox`. As credenciais e tokens não são armazenados no navegador.

- 99Food: adaptador servidor configurável (`99food-service.js`) para sandbox/certificação e endpoints de pedidos; URLs/caminhos devem ser preenchidos conforme as credenciais e o contrato disponibilizados à aplicação no portal de desenvolvedores.
- Keeta: adaptador Open Delivery (`keeta-service.js`) com OAuth, assinatura HMAC-SHA256/Base64 no servidor, polling, ACK, consulta e ações de pedido.
- O navegador chama somente `/api/99food/*` e `/api/keeta/*`.
