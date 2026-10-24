# Campanha 0304 — checkpoint visual do shell e do adendo desktop

Data: 2026-10-24. Este checkpoint adiciona a auditoria da navegação desktop e corrige defeitos confirmados. Não substitui os registros ou pendências anteriores da Campanha 0304. A campanha continua aberta; G14 permanece FAIL por decisão do proprietário.

## Causas encontradas e correções

| Defeito | Causa na origem | Correção/evidência |
|---|---|---|
| Rótulos duplicados na sidebar | O renderer da navegação emitia o nome completo em mais de uma região do item. | `navButton()` passa a emitir um único rótulo visual; no menu lateral usa o nome completo, no inferior usa o rótulo curto aprovado e conserva `aria-label`/tooltip. Teste de renderer e capturas verificam nomes únicos. |
| Sidebar recolhida sem geometria de layout própria | Havia estado/toggle, mas faltavam regras coerentes para coluna estreita, centralização dos ícones e ocultação efetiva dos grupos textuais. | Estado colapsado usa trilha estreita, rótulos/grupos textuais são removidos do fluxo e ícones ficam centralizados. Botão de expansão expõe `aria-expanded`, tooltip e preferência local persistida. |
| Cabeçalho Início distinto e sem contexto | O renderer Dashboard produzia estrutura de cabeçalho própria e a saudação repetia o mesmo conteúdo. | Início usa o renderer compartilhado com título, descrição, marca e ações; saudação permanece específica sem repetir título/descrição. |
| Início mobile sem o ícone “+” | A regra mobile que recorta spans de texto também recortava o span externo que envolvia o ícone “+”. | O ícone `dv2-icon` passou a ser irmão direto do rótulo. No CDP 390×844, o botão mede 44×44 px e o ícone 19×19 px em tema claro/escuro. A verificação falha se o ícone perder dimensão. |
| Ações e cabeçalhos visualmente não equivalentes | Ações de criação e notificações tinham composições diferentes entre Home e renderer genérico. | Estrutura compartilhada e classes/tokens operacionais conservados. No fixture de Home os três controles têm 44×44 px e espaçamento de 4 px. O fixture não executa a ação autenticada. |
| Detalhes do pedido ocultos em largura desktop | Uma regra responsiva posterior escondia `.orders-v2-selection` a partir do breakpoint desktop largo, apesar de haver coluna lateral reservada. | A seleção/detalhes é exibida no painel direito em >=1180 px; métricas ficam abaixo. No fixture, painel lateral = 285 px em 1280, 1440 e 1920 px, em temas claro/escuro. |

## Execução de browser

Chromium via CDP com emulação de viewport, sem Playwright. Foram 72 combinações de Início, Pedidos e Rotas, temas claro/escuro, sidebar expandida/recolhida e viewports 360×800, 390×844, 768×1024, 1024×768, 1280×800, 1440×900 e 1920×1080. Resultado: 72 linhas, 0 falhas de overflow documental/labels duplicados e, em Home até 430 px, 0 ícones “+” ausentes. A simulação é de shell/renderers reais com corpo controlado; o conteúdo de pedido é sintético, e rotas não contém dados do domínio. Não é uma sessão autenticada nem Chrome Android físico.

Na área desktop de Pedidos, o detalhe ficou visível (`display:block`) em 1280, 1440 e 1920 px nos dois temas e nos dois estados da sidebar. A geometria de 1024 px mantém o breakpoint tablet e não afirma que o painel lateral desktop esteja aberto nessa largura.

Arquivo de medidas DOM (72 linhas): [`0304-shell-visual-report.json`](0304-shell-visual-report.json). Capturas representativas incluem:

- Início mobile, com “+” visível: [`0304-shell-inicio-390x844-dark-expanded.png`](0304-shell-inicio-390x844-dark-expanded.png) e variante clara correspondente.
- Início desktop: capturas 1280/1440/1920 em claro/escuro, sidebar expandida e recolhida quando aplicável.
- Pedidos desktop: capturas 1280/1440/1920 em ambos os temas; detalhe de pedido permanece no painel.
- Rotas desktop e mobile: shell e controle de navegação, sem substituir as referências aprovadas nem alegar aprovação visual.

Comparação de Rotas com o fixture do renderer de produção e as medidas atualizadas: [`../intervencao-integral/0304-intervencao-visual-comparison.json`](../intervencao-integral/0304-intervencao-visual-comparison.json). Referências aprovadas, medidas e hashes permanecem em `../REFERENCIAS/` e na matriz. Capturas não autenticadas são evidência geométrica, não prova de funcionamento de tiles, posições, planejamento ou sincronização.

## Limites e pendências preservadas

- A referência aprovada continua sendo a referência visual; esta intervenção não substitui nem encerra a reprovação anterior.
- G14 / aprovação visual do proprietário: **FAIL / pendente de decisão expressa**.
- Teste real no Chrome Android e modo computador físico: pendente; CDP é emulação Chromium.
- E2E autenticado: a resposta inicial `403 MFA_REQUIRED` iniciou o desafio MFA; após o desafio, a sessão caiu ao recarregar e `#app` ficou oculto. Persistência, conflito, RBAC e sync continuam sem prova de interface; não houve contorno de autenticação.
- Rotas ainda requer comparação autenticada com dados legítimos/tiles, operações reais de planejar/salvar/reabrir e validação visual do proprietário.
- Pendências de campanhas anteriores não foram fechadas neste adendo.

## Testes e histórico

`npm test` concluiu com exit code 0 após a correção final do ícone e atualização do shell/cache. Os runners CDP do shell (72 combinações) e de Rotas (26 linhas) concluíram com zero falhas em suas verificações geométricas, conforme o [registro](../../REGISTROS/0304.md). Isso não substitui os E2E autenticados nem a comparação visual pelo proprietário. Evidência não inclui credenciais, banco oficial, respostas operacionais nem dados pessoais.
