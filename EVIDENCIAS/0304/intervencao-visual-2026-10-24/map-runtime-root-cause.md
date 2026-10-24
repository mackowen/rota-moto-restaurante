# Diagnóstico do mapa escuro e fallback cartográfico

Data: 2026-10-24. Campanha 0304, checkpoint complementar.

## Causa

O fallback escuro anterior solicitava tiles `dark_all` de CARTO sem chave autorizada. A resposta HTTP era 200 e produzia uma imagem de 256 px, mas o conteúdo da imagem mostrava `API KEY REQUIRED`. Como a prontidão considerava tiles carregados e `naturalWidth > 0`, essa resposta podia ser aceita como cartografia; o usuário via um mapa escuro inválido/preto. No teste com `--disable-gpu`, o renderer vetorial também falhou, mantendo por algum tempo o estado “Carregando mapa detalhado…” até o timeout/fallback.

## Correção

O fallback escuro usa agora o endpoint raster OSM já usado pelo tema claro, sem chave. A classe `rm-map-dark-raster` aplica um filtro escuro apenas à camada Leaflet correspondente. Atribuição continua vinculada ao OpenStreetMap. A camada vetorial OpenFreeMap e o fluxo de timeout/retry existentes foram preservados.

## Verificação

O runtime Leaflet real foi exercitado em Chromium headless sem GPU, na vista neutra padrão do app, sem dados ou marcadores operacionais. A rede mostrou respostas HTTP 200 para 20 tiles `tile.openstreetmap.org`; a captura `map-real-cartography-1280x800-dark.png` mostra as tiles renderizadas com o tratamento dark. O diagnóstico JSON conserva as respostas e dois erros genéricos de renderer induzidos no cenário sem GPU. Esse teste prova o fallback raster no navegador, não a disponibilidade dos tiles em rede móvel/Chrome Android nem uma jornada autenticada de Rotas.

Nenhuma coordenada de entrega/motoboy, rota, distância ou ETA foi criada. Referências e dados operacionais não foram alterados.
