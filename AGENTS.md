# AGENTS.md — RotaMoto Restaurante

## Identidade do projeto

Painel web de controle do restaurante do ecossistema RotaMoto.

O projeto possui lógica de integrações com plataformas de delivery e deve manter uma arquitetura preparada para evolução e futura sincronização com backend.

## Baseline estável

A versão estável protegida deste repositório é:

- `v5.50-ui-mobile-fix5`

A tag `v5.50-ui-mobile-fix5` representa o baseline original e NÃO deve ser alterada, reescrita ou sobrescrita.

Antes de qualquer alteração:
- trabalhar em uma branch própria;
- preservar a tag do baseline;
- nunca reescrever histórico publicado sem autorização explícita;
- não remover funcionalidades existentes sem autorização.

## Regras de desenvolvimento

- Corrigir a causa raiz do problema.
- Não criar "camadas de correção", hacks ou workarounds quando a causa puder ser corrigida diretamente.
- Não fazer alterações não relacionadas à tarefa.
- Preservar funcionalidades existentes que não fazem parte da alteração solicitada.
- Manter código modular, legível e de fácil manutenção.
- Aplicar SOLID e DRY quando apropriado.
- Evitar duplicação de lógica.
- Separar apresentação, lógica de negócio, integrações e acesso a dados sempre que possível.

## Frontend

- Garantir funcionamento em desktop, tablet e mobile.
- Preservar comportamento responsivo existente.
- Corrigir problemas de HTML, CSS e JavaScript na origem.
- Não empilhar overrides CSS para mascarar problemas estruturais.
- Evitar overflow horizontal acidental.
- Garantir que tabelas, cards, mapas, modais, menus e controles se adaptem corretamente ao viewport.
- Manter navegação e ações utilizáveis em telas pequenas.
- Preservar acessibilidade básica de botões, formulários, navegação e mensagens.

## Dados e persistência

O projeto deve permanecer compatível com uma estratégia local-first.

- Respeitar as limitações do IndexedDB.
- Validar dados antes de persistir.
- Tratar erros de leitura, escrita e migração.
- Evitar perda de dados durante alterações de estrutura.
- Manter os modelos de dados compatíveis com futura sincronização com backend.
- Não criar dependências desnecessárias de armazenamento externo.

## Contratos e normalização

O contrato definido em `CONTRACT.md` deve ser tratado como referência para a comunicação e estrutura dos dados.

Ao alterar entidades ou payloads:
- verificar o contrato existente;
- manter compatibilidade quando possível;
- atualizar o contrato quando a mudança realmente exigir alteração estrutural;
- evitar formatos diferentes para representar a mesma entidade.

## Integrações

As integrações devem permanecer desacopladas do núcleo do painel.

Integrações existentes/relevantes incluem:
- iFood;
- 99 Food;
- Keeta.

Ao modificar uma integração:
- manter cada plataforma isolada em seu módulo/serviço;
- não duplicar regras comuns desnecessariamente;
- validar entradas e respostas externas;
- tratar timeout, falhas de rede, respostas inválidas e erros de autenticação;
- não expor tokens ou credenciais;
- não assumir que APIs externas sempre retornarão dados válidos;
- preservar o funcionamento das demais integrações.

Quando houver documentação oficial da plataforma disponível, utilizá-la como referência antes de implementar comportamento específico da API.

## Segurança

- Nunca adicionar credenciais, tokens, senhas ou chaves privadas ao Git.
- Nunca colocar secrets em código-fonte.
- Manter arquivos `.env` reais fora do repositório.
- Usar `.env.example` para documentar configurações necessárias.
- Validar e sanitizar entradas externas.
- Não confiar em dados provenientes do cliente ou de plataformas externas.
- Evitar exposição de informações sensíveis em logs.
- Tratar respostas externas como dados não confiáveis.

## Backend e serviços

Quando houver alteração em servidores ou serviços:

- separar responsabilidades;
- validar parâmetros;
- tratar exceções;
- retornar erros claros;
- evitar vazamento de stack traces ou informações internas para o usuário;
- manter configuração separada da lógica de negócio;
- não introduzir dependências desnecessárias.

## Tratamento de erros

- Usar tratamento defensivo de exceções.
- Não deixar falhas críticas silenciosas.
- Exibir mensagens compreensíveis ao usuário quando apropriado.
- Registrar informações técnicas úteis para diagnóstico sem expor dados sensíveis.
- Diferenciar erros de validação, rede, autenticação, integração e processamento quando possível.

## Testes

Antes de concluir uma alteração:

1. Verificar o `git diff`.
2. Executar os testes existentes relacionados à alteração.
3. Verificar erros de JavaScript.
4. Verificar referências quebradas.
5. Testar os fluxos afetados.
6. Para alterações de interface, verificar desktop, tablet e mobile.
7. Para integrações, testar respostas de sucesso e falha quando houver infraestrutura de teste disponível.

Não remover ou desativar testes apenas para fazer uma alteração passar.

## Git

- `main` representa a linha principal do projeto.
- Alterações devem ser feitas em branches específicas.
- Usar commits pequenos e descritivos.
- Não fazer force push.
- Não reescrever histórico publicado sem autorização explícita.
- Não alterar a tag `v5.50-ui-mobile-fix5`.

## Regra de escopo

Modificar somente o que for necessário para atender à tarefa.

Antes de editar:
- identificar a causa;
- localizar os arquivos envolvidos;
- entender as dependências;
- verificar o comportamento existente;
- verificar possíveis impactos nas integrações.

Depois de editar:
- revisar `git diff`;
- confirmar que não existem alterações acidentais;
- executar os testes aplicáveis.

## Regra principal

Preservar a estabilidade do projeto.

Quando uma mudança solicitada puder afetar outras funcionalidades, especialmente integrações ou persistência de dados, analisar o impacto antes de alterar o comportamento existente.

## Browser Testing automatizado

O ambiente de browser testing compartilhado está em:

`~/projetos/browser-tests`

Ele fornece infraestrutura para o Codex executar testes reais nos aplicativos usando:

- Chromium instalado em `$PREFIX/lib/chromium/chrome`;
- Chrome DevTools Protocol (CDP);
- `chrome-remote-interface`;
- servidores HTTP temporários;
- screenshots e logs fora dos repositórios.

### Regra para alterações de frontend e fluxos

Quando uma alteração puder afetar comportamento visual, navegação, interação, formulários ou fluxo de negócio:

1. O Codex deve analisar a alteração e criar os testes de browser necessários para validá-la.
2. Os testes devem ser orientados pelo comportamento esperado, não por uma suíte fixa previamente criada.
3. O Codex deve executar o aplicativo no Chromium via CDP.
4. Deve verificar, quando aplicável:
   - erros JavaScript;
   - respostas HTTP 4xx/5xx;
   - navegação;
   - elementos esperados;
   - comportamento do fluxo;
   - responsividade;
   - screenshots.
5. Após corrigir problemas, deve executar novamente os testes relevantes.
6. Testes de browser podem ser criados temporariamente fora do repositório, em `~/projetos/browser-tests`.

### Execução autônoma

O Codex deve executar os testes de browser diretamente quando tiver acesso ao ambiente.

Não é obrigatório utilizar scripts de testes previamente existentes. O Codex deve criar, adaptar ou remover seus próprios testes conforme a necessidade da alteração.

O fluxo preferencial é:

`iniciar aplicação → iniciar Chromium/CDP → executar teste → coletar evidências → corrigir causa raiz → executar novamente → validar resultado`

Se o Chromium for encerrado pelo Android/Termux durante a execução, tratar isso como falha de infraestrutura/runtime e não modificar o código da aplicação para contornar o problema.

### Infraestrutura x testes

`~/projetos/browser-tests` é a infraestrutura compartilhada de browser testing.

Os testes de browser não fazem parte da aplicação e não devem ser adicionados ao código de produção.

Testes unitários, de contrato e de lógica pertencentes ao projeto continuam dentro dos respectivos repositórios.

Não usar Playwright diretamente neste ambiente Termux Android. O mecanismo suportado para browser automation é CDP através de `chrome-remote-interface`.
