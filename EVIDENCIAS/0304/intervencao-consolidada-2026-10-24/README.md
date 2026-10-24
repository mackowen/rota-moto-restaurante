# Intervenção visual consolidada — 2026-10-24

Escopo: layout de Rotas, confirmação da sidebar/header compartilhados e regressões visuais em renderer Chromium isolado. A aprovação visual do proprietário continua pendente.

## Referências conferidas

As três imagens originais de Downloads foram abertas e comparadas com as cópias arquivadas. SHA-256 e dimensões permaneceram idênticos:

| Referência | Dimensões | SHA-256 |
|---|---:|---|
| `rotas-celular.png` — claro e escuro | 1536×1024 | `3a7ce349bd189acbbcd80204c934abcae7a4ce25c0061a342147348ebae1e257` |
| `rotas-tablet.png` — claro e escuro | 1536×1024 | `3f1c6ec3cfdde2b4d00aad1a242c2130551d232fde6927422be2eda01c567e8e` |
| `rotas-pc.png` — claro e escuro | 1536×1024 | `4b6cdb21b8890f1e5b18fca0805ecaa898af18366a7e5fd89e27cd2a3f4f8f88` |

## Fixture e limites

- 26 capturas/medições: 320, 360, 390, 430, 600, 768, 1024, 1280, 1440 e 1920 px; temas claro/escuro; conteúdo vazio e um pedido sintético controlado (`#1234`).
- 8 linhas adicionais com uma rota sintética selecionada em 1280, 1440 e 1920 px, em ambos os temas.
- O renderer `routes()` e os estilos de produção foram montados em Chromium/CDP headless isolado. A fixture é visual e não autenticada; não é E2E operacional.
- O mapa está intencionalmente vazio por falta de coordenadas sintéticas confirmadas. Nenhum tile, marcador, trajeto, distância ou ETA foi fabricado.
- O logotipo SVG nesta fixture foi fornecido como data URI derivado do asset local para evitar falha de carregamento de sub-recurso no documento `about:blank`.
- Não houve autenticação/MFA nesta execução, escrita em banco, acesso a dados operacionais ou alteração de Browser QA.

Consulte [matriz de fidelidade e gates](matriz-fidelidade-visual.md), [comparação do estado sem seleção](0304-intervencao-consolidada-comparison.json) e [composição com rota selecionada](../intervencao-consolidada-selected-2026-10-24/0304-intervencao-selected-comparison.json).

Capturas `before` usam os estilos de `HEAD` inicial; `after` usa o worktree corrigido. As imagens originais de referência permanecem em `../REFERENCIAS/` sem alteração.
