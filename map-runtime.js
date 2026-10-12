import L from 'leaflet';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl } from 'maplibre-gl';

const styles = {
  light: 'https://tiles.openfreemap.org/styles/bright',
  dark: 'https://tiles.openfreemap.org/styles/dark'
};
const layers = new Map();
let activeTheme = document.documentElement.dataset.resolvedTheme === 'dark' ? 'dark' : 'light';
const probe = document.createElement('canvas');
const supportsVectorStyle = Boolean(probe.getContext('webgl2'));

setWorkerUrl(new URL('vendor/maplibre/maplibre-gl-worker.js?v=0139.1', document.baseURI).href);
window.L = L;

function addBaseLayer(map) {
  if (!supportsVectorStyle) {
    const layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });
    layer.addTo(map);
    layers.set(map, { layer, theme: activeTheme, fallback: true });
    return layer;
  }
  const layer = maplibreGL({
    style: styles[activeTheme],
    interactive: false,
    attributionControl: false,
    fadeDuration: 0
  });
  layer.addTo(map);
  layers.set(map, { layer, theme: activeTheme });
  map.attributionControl?.addAttribution('© <a href="https://openfreemap.org">OpenFreeMap</a> · © <a href="https://openmaptiles.org">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors');
  return layer;
}

function setTheme(theme) {
  activeTheme = theme === 'dark' ? 'dark' : 'light';
  const style = styles[activeTheme];
  for (const entry of layers.values()) {
    if (entry.fallback) continue;
    const maplibreMap = entry.layer.getMaplibreMap();
    if (maplibreMap && entry.theme !== activeTheme) {
      maplibreMap.setStyle(style, { diff: false });
      entry.theme = activeTheme;
    }
  }
}

window.RotaMotoMapTheme = Object.freeze({ addBaseLayer, setTheme, styles, supportsVectorStyle });
