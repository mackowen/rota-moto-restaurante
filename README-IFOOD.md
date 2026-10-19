# Integrações e laboratório local

A administração de iFood, 99Food e Keeta fica em Ajustes → Integrações. A API autentica por sessão, tenant, permissão `integrations.manage` e CSRF nas mutações; os segredos ficam no backend e o catálogo administrativo não os retorna.

O estado diferencia capacidades de adaptador/runtime, conta autorizada e conexão verificada. Uma conta autorizada não prova conectividade, recebimento operacional, sandbox ou homologação comercial. A disponibilidade de OAuth, vínculo e desativação varia por marketplace; não iniciar ações com contas reais sem autorização do proprietário. Rotas legadas genéricas permanecem fail-closed.

Ajustes → Origens de pedidos controla apenas rótulos e disponibilidade local. Isso não conecta marketplaces nem altera despacho ou propriedade do pedido. O Laboratório avançado é uma única área técnica autorizada; os simuladores são sintéticos, em memória e não escrevem em `orders`, `events` ou `outbox`, nem enviam dados a provedores.

## Capacidades e limites atuais

- **iFood:** runtime e fluxos administrativos de autorização estão implementados; conexão, sandbox e homologação reais permanecem não verificados.
- **99Food:** adaptador de protocolo, webhook/runtime local e worker estão implementados; onboarding, whitelist/certificação e aceite comercial são dependências externas. O simulador da UI não representa o protocolo real.
- **Keeta:** OAuth, assinatura, polling, acknowledgement e lifecycle de pedidos têm testes locais; autorização/conta real e conectividade externa permanecem não verificadas.

Nenhum teste desta campanha usa credenciais comerciais ou envia tráfego para marketplaces.
