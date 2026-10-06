# Analytics territorial e proteção geográfica

## Fonte e proveniência

O heatmap usa somente `delivery_geo_snapshots`, ligado por tenant e Delivery à
Order canônica. A superfície atual grava `provenance=manual` após confirmação
explícita de um administrador da Company com MFA, sessão e CSRF válidos. O
operador confirma latitude/longitude como destino; o backend não geocodifica,
não consulta endereço e não aceita GPS de `LocationPoint` como destino. A
proveniência `geocoded_address` permanece reservada para um fluxo futuro
controlado. Coordenadas antigas em Order ou em cache de mapas não são
promovidas automaticamente.

`accuracy_m` pode ser desconhecida. Coordenadas com precisão registrada acima
de 1.500 m não entram no mapa nem na cobertura com localização utilizável; são
contadas em `lowPrecision`. Endereços e coordenadas não são copiados para a
resposta do relatório.

## Agregação

- `geohash5-v1` agrupa destinos em células de aproximadamente 5 km, com
  variação física conforme latitude.
- Células com menos de cinco entregas são suprimidas. Métricas de uma célula
  também são ocultadas quando tiverem menos de cinco amostras válidas.
- Volume usa bandas `5–9`, `10–24` e `25+`. Resultados não devolvem IDs de
  Delivery, nomes, endereços, telefone, conteúdo de Order ou LocationPoints.
- Conclusão/falha/cancelamento, própria/terceiro e provider são minimizados por
  limiar; provider só é mostrado com pelo menos cinco entregas na célula.
- Métricas de distância real e estimada são separadas. Taxa só é agregada com
  moeda BRL explicitamente conhecida. Tempo é `assignedAt → completedAt` para
  entregas concluídas; não equivale a SLA.
- O período usa datas civis do timezone IANA da Company quando configurado;
  sem timezone, usa janela móvel em UTC. Não consulta o timezone do aparelho.
- A área de consulta é tenant-scoped por sessão e RLS/FORCE RLS. Janelas são
  limitadas a 365 dias e a 10.000 entregas candidatas.

## Risco residual de reidentificação

O tamanho da célula e o limiar mínimo reduzem exposição, mas não constituem
privacidade diferencial. Um operador autorizado que faça muitas consultas com
filtros correlacionados pode tentar inferir diferenças entre populações. A API
limita taxa, enumera somente filtros de domínio, limita período e suprime
amostras pequenas; os dados devem continuar disponíveis somente a papéis com
`orders.read`. Para usos que exijam garantias formais, seria necessário
acrescentar orçamento de consultas/privacidade diferencial antes de ampliar
exportação ou acesso a usuários mais amplos.

## Uso offline e operação

O relatório territorial é server-side e não está disponível offline. O cliente
não soma coordenadas locais, não geocodifica durante a renderização e não
guarda snapshot geográfico em IndexedDB. Instalações precisam aplicar a
migration `0018_delivery_geo_snapshots` antes do readiness aceitar esta API.
Não há backfill: cobertura cresce somente após confirmação manual de destinos.
