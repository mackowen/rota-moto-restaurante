# Campanha 0303-A — alinhamento horizontal do cabeçalho

## Causa identificada

No breakpoint de 320–430 px o cabeçalho V2 tem três tracks (`marca | flexível | ações`), mas a Início renderiza apenas dois filhos diretos (`marca | ações`). O wrapper das ações era auto-posicionado na track flexível; o terceiro track vazio e o gap do grid deixavam 6 px adicionais à direita. O `padding-right` do header já era igual (10 px) em todas as abas e o gap entre os botões era 4 px. Portanto a diferença vinha da colocação no grid, e não do padding. A notificação da Início também media 42×44 px, enquanto o controle operacional correspondente media 40×40 px.

## Correção

Em `dashboard-v2.css`, no breakpoint móvel, as ações da Início são colocadas explicitamente na terceira track do mesmo cabeçalho operacional; o botão de notificações passa a 40×40 px, com gap de 4 px. Nova corrida e Perfil seguem 44×44 px. Sem margens negativas ou transforms. O logo e o alinhamento vertical do cabeçalho não foram alterados. O cache da folha foi invalidado (`dashboard-v2.css?v=0304.4`, shell v99).

## Medidas antes e depois (390 px, claro)

| Estado/aba | Notificações (x, largura×altura) | Gap | Nova corrida (x, largura×altura) | Gap | Perfil (x, largura×altura) | Distância do perfil à borda |
|---|---:|---:|---:|---:|---:|---:|
| Antes, Home | 234, 42×44 | 4 | 280, 44×44 | 4 | 328, 44×44 | 18 px |
| Antes, Pedidos/Rotas/Motoboys | 242, 40×40 | 4 | 286, 44×44 | 4 | 334, 44×44 | 12 px |
| Depois, Início | 242, 40×40 | 4 | 286, 44×44 | 4 | 334, 44×44 | 12 px |
| Depois, Pedidos/Rotas/Motoboys | 242, 40×40 | 4 | 286, 44×44 | 4 | 334, 44×44 | 12 px |

X é relativo à borda esquerda do viewport. Antes da correção, a medição operacional não tinha um perfil no renderer isolado; os valores de referência do perfil foram obtidos com o componente de identidade compartilhado, cuja dimensão móvel é 44×44 px. O relatório pré-correção reproduz o posicionamento e tamanho computados anteriores, com esse componente presente. Pós-correção, os quatro cabeçalhos componentizados foram medidos diretamente no CDP com o gatilho de conta inserido usando a estrutura/classes de `identity-ui.js`.

## Tabela por viewport

Nos quatro viewports (320/360/390/430 px), a diferença pós-correção entre Início, Pedidos, Rotas e Motoboys foi 0 px em X, largura, gap, altura e borda direita. A diferença foi 0 px nos temas claro e escuro (32 medições: 4 abas × 4 larguras × 2 temas). Coordenadas Home pós (notificação / nova corrida / perfil):

| Viewport | X dos botões | Distância à borda direita | Gap |
|---|---|---:|---:|
| 320 | 172 / 216 / 264 px | 12 px | 4 / 4 px |
| 360 | 212 / 256 / 304 px | 12 px | 4 / 4 px |
| 390 | 242 / 286 / 334 px | 12 px | 4 / 4 px |
| 430 | 282 / 326 / 374 px | 12 px | 4 / 4 px |

Nos quatro tamanhos, larguras são 40 / 44 / 44 px e alturas 40 / 44 / 44 px. As posições verticais são idênticas entre as quatro abas: botão de notificação y=8 px, Nova corrida e Perfil y=6 px; a diferença de 2 px decorre do botão de notificação de 40 px centralizado junto aos botões de 44 px e também ocorre nos cabeçalhos operacionais.

## Evidências e limitações

- `0303-A-header-alignment-before.json` e `0303-A-header-alignment.json`: medidas prévias (DOM operacional original; faltava o perfil no fixture Home).
- `0303-A-header-alignment-before.json` (modo baseline) e `0303-A-header-alignment-after.json`: medições com três controles em todas as combinações de largura/tema/aba. O modo baseline reaplica no renderer os estilos computados anteriores.
- `0303-A-header-alignment-before-390x844-{light,dark}.png` e `...-after-390x844-{light,dark}.png`: comparação do renderer isolado em 390 px, com gatilho de conta da mesma estrutura visual. São evidências do componente; não equivalem a sessão autenticada.
- O login de browser compartilhado permanece HTTP 403. Assim, não foi possível medir as quatro abas renderizadas com conta autenticada nem validar cliques/autorização. A medição final é dos renderers de header reais e do componente compartilhado de conta, em fixture isolada.
- A rolagem sticky foi repetida após o ajuste: nos quatro tamanhos celulares e dois temas, header top permaneceu 0 nos offsets efetivos 0/1/5/10/20/50/100/300 px. A validação física no Chrome Android segue pendente do proprietário.

## Gate do adendo de alinhamento

- Causa identificada: PASS técnico.
- Alinhamento, dimensões e espaçamento: PASS técnico nos quatro viewports/temas; diferença medida 0 px entre renderers.
- Sem overflow e alinhamento vertical: PASS técnico na fixture.
- Comparação autenticada/funcional e aprovação visual: PARTIAL, sessão indisponível e aprovação pertencente ao proprietário.
