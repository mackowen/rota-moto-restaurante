# Cartografia, mapas e navegação

## Responsabilidades

- **Dados cartográficos:** OpenStreetMap (OSM) é o projeto/conjunto de dados; os mapas embutidos usam tiles raster do servidor público `tile.openstreetmap.org` com Leaflet 1.9.4 como renderer comum. OsmAnd é um aplicativo Android separado, não um renderer web nem sinônimo de OSM.
- **Renderer web:** Leaflet é carregado via CDN (`unpkg.com`) nos dois aplicativos. Tiles OSM são carregados pela rede; a atribuição visível aponta para os contribuidores. Nenhum tile ou biblioteca Leaflet é precacheado pelo service worker.
- **Geocoding:** buscas de endereço usam Nominatim público em certos fluxos, inclusive seleção/localização do estabelecimento e consultas de endereço. Isso pode transmitir texto de endereço a um terceiro; não é geocoder self-hosted nem fonte canônica de coordenadas. A localização confirmada do estabelecimento permanece em Company; alterações sem confirmação não viram coordenadas canônicas.
- **Routing econômico/operacional:** o cálculo viário do Restaurante é uma boundary backend OSRM configurável e fail-closed. Não usa duração como ETA/SLA automaticamente. O Motoboy não chama serviços públicos de routing nem atualiza distância/tempo de Route; esses dados operacionais vêm do Restaurante/sync.
- **Navegação:** o Motoboy abre Google Maps, Waze ou OsmAnd por escolha do usuário/preferência persistida no aparelho. As URLs/intents enviam somente coordenadas validadas do destino; nunca nome, telefone, endereço textual ou observações. Navegação não é autoridade para Route, distância econômica, ETA, tracking ou LocationPoint.
- **Localização/tracking:** GPS do aparelho pode ser lido pelo navegador mediante permissão. Localização de Driver e tracking interno mantêm proveniência própria; tracking externo de provider não é convertido em LocationPoint/Driver.

## Superfícies auditadas

| Aplicativo | Superfícies | Fonte e comportamento |
|---|---|---|
| Restaurante | Mapa de pedidos/relatórios; localização e confirmação do estabelecimento; preview de Route/entregas; agrupamento operacional | Leaflet + tiles OSM. Geocoding Nominatim em fluxos explícitos. Coordenadas confirmadas do estabelecimento são Company; origem logística custom é separada. Falha de tile não grava nem altera domínio. |
| Motoboy | Mapa de Route e trabalho; formulário/seleção de destino; GPS; foco e acompanhamento de entregas; links de navegação | Leaflet + tiles OSM; geocoding Nominatim em busca explícita. OSRM público removido: Route/distâncias são consumidas do Restaurante. OsmAnd é opção de navegação externa, com Google Maps/Waze preservados. |

A baseline do Motoboy fazia chamadas a endpoints públicos de roteamento OSRM/openstreetmap.de. HEAD remove essas chamadas do cliente. Ambas baselines já usavam Leaflet/OSM; a consolidação conserva uma única stack web em vez de introduzir outra biblioteca sem necessidade.

## Offline, fallback e privacidade

- Local-first, IndexedDB e telas operacionais já persistidas podem continuar sem rede; tiles e Leaflet CDN não são armazenados offline. Um mapa web pode aparecer vazio/incompleto quando os tiles ou CDN falham. Não declarar mapas web offline.
- GPS depende de permissão e disponibilidade do dispositivo; sincronização pode ficar pendente offline. O motor OSRM depende do serviço configurado e retorna indisponível quando ausente/falha, sem haversine silencioso.
- OsmAnd pode navegar offline somente se o app estiver instalado e o usuário tiver baixado os mapas adequados. Isso não habilita mapas web offline. Intents Android e funcionamento físico não foram exercitados pelo Chromium.
- Tile OSM público tem política de uso, atribuição, endpoint e cache específicos; não é serviço de tiles offline. Para escala de produção, avaliar tiles self-hosted. Nominatim público tem política de taxa/identificação e não deve ser tratado como geocoder de alto volume. Preferir geocoder próprio/contratado e aprovado antes de escalar.

## Referências oficiais

- [OSM Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)
- [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/)
- [OpenStreetMap License/ODbL](https://osmfoundation.org/wiki/Licence)
- [OsmAnd intents (documentação oficial)](https://www.osmand.net/docs/technical/algorithms/osmand-intents/)

## Limitações

Os tiles e Nominatim são serviços públicos de terceiros. A política e atribuição são documentadas; não se alegou garantia de disponibilidade nem de offline. Não instalar OSRM nem baixar dataset faz parte do escopo atual. Revisão legal/privacidade do envio de endereço a Nominatim permanece aberta.
