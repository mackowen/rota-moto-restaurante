import L from 'leaflet';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl } from 'maplibre-gl';

const styles = {
  light: 'https://tiles.openfreemap.org/styles/bright',
  dark: 'https://tiles.openfreemap.org/styles/dark'
};
const raster = {
  light: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png',
  dark: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png'
};
const rasterAttribution = '© <a href="https://stadiamaps.com/attribution/">Stadia Maps</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const vectorAttribution = '© <a href="https://openfreemap.org">OpenFreeMap</a> · © <a href="https://openmaptiles.org">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const layers = new Map();
let activeTheme = document.documentElement.dataset.resolvedTheme === 'dark' ? 'dark' : 'light';
const probe = document.createElement('canvas');
const supportsVectorStyle = Boolean(probe.getContext('webgl2'));

setWorkerUrl(new URL('vendor/maplibre/maplibre-gl-worker.js?v=0139.1', document.baseURI).href);
window.L = L;

function report(map, code, message) {
  window.dispatchEvent(new CustomEvent('rotamoto:map-diagnostic', { detail: { code } }));
  const container = map.getContainer();
  let status = container.nextElementSibling?.classList.contains('rm-map-runtime-status') ? container.nextElementSibling : null;
  if (!status) {
    status = document.createElement('div');
    status.className = 'rm-map-runtime-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    container.insertAdjacentElement('afterend', status);
  }
  status.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  status.append(text);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Tentar novamente';
  retry.addEventListener('click', () => retryVector(map), { once: true });
  status.append(retry);
  status.hidden = false;
}

function clearStatus(map) {
  const container = map.getContainer();
  const status = container.nextElementSibling?.classList.contains('rm-map-runtime-status') ? container.nextElementSibling : null;
  if (status) status.hidden = true;
}

function addRaster(map, entry, reason) {
  if (entry.mode === 'vector') map.attributionControl?.removeAttribution(vectorAttribution);
  if (entry.layer) map.removeLayer(entry.layer);
  const layer = L.tileLayer(raster[activeTheme], {
    maxZoom: 20,
    attribution: rasterAttribution,
    crossOrigin: true,
    updateWhenIdle: true
  });
  entry.layer = layer;
  entry.theme = activeTheme;
  entry.mode = 'raster';
  entry.errors = 0;
  layer.on('tileerror', () => {
    entry.errors += 1;
    window.dispatchEvent(new CustomEvent('rotamoto:map-diagnostic', { detail: { code: 'raster-tile-error' } }));
    if (entry.errors >= 3) report(map, 'raster-tiles-unavailable', 'Não foi possível carregar o mapa. Verifique a conexão e tente novamente.');
  });
  layer.on('tileload', () => {
    entry.errors = 0;
  });
  layer.addTo(map);
  entry.reason = reason;
  if (reason === 'webgl-unavailable') {
    report(map, 'vector-rendering-unavailable', 'Mapa simplificado neste navegador. As ruas continuam disponíveis.');
  } else {
    report(map, 'vector-style-failed', 'O mapa detalhado falhou; exibindo o mapa simplificado.');
  }
  return layer;
}

function failVector(map, entry, code, message) {
  if (entry.mode !== 'vector' || entry.recovered) return;
  entry.recovered = true;
  if (entry.loadTimer) clearTimeout(entry.loadTimer);
  window.dispatchEvent(new CustomEvent('rotamoto:map-diagnostic', { detail: { code } }));
  addRaster(map, entry, code);
  if (message) report(map, code, message);
}

function addVector(map, entry) {
  if (entry.mode === 'raster') map.attributionControl?.removeAttribution(rasterAttribution);
  const layer = maplibreGL({ style: styles[activeTheme], interactive: false, attributionControl: false, fadeDuration: 0 });
  entry.layer = layer;
  entry.mode = 'vector';
  entry.theme = activeTheme;
  entry.errors = 0;
  entry.recovered = false;
  layer.addTo(map);
  map.attributionControl?.addAttribution(vectorAttribution);
  const renderer = layer.getMaplibreMap();
  if (!renderer) {
    failVector(map, entry, 'vector-renderer-unavailable');
    return layer;
  }
  entry.loadTimer = setTimeout(() => failVector(map, entry, 'vector-style-timeout'), 15000);
  renderer.on('load', () => {
    if (entry.loadTimer) clearTimeout(entry.loadTimer);
    entry.loadTimer = null;
    entry.errors = 0;
    clearStatus(map);
  });
  renderer.on('error', event => {
    entry.errors += 1;
    window.dispatchEvent(new CustomEvent('rotamoto:map-diagnostic', { detail: { code: 'vector-style-or-tile-error' } }));
    if (entry.errors >= 3) failVector(map, entry, 'vector-load-failed');
  });
  return layer;
}

function addBaseLayer(map) {
  const entry = { layer: null, mode: null, theme: activeTheme, errors: 0, recovered: false, loadTimer: null, reason: null };
  layers.set(map, entry);
  if (!supportsVectorStyle) {
    addRaster(map, entry, 'webgl-unavailable');
    return entry.layer;
  }
  return addVector(map, entry);
}

function retryVector(map) {
  const entry = layers.get(map);
  if (!entry) return;
  if (entry.layer) map.removeLayer(entry.layer);
  entry.recovered = false;
  entry.errors = 0;
  if (supportsVectorStyle) addVector(map, entry);
  else addRaster(map, entry, 'webgl-unavailable');
}

function setTheme(theme) {
  activeTheme = theme === 'dark' ? 'dark' : 'light';
  for (const [map, entry] of layers) {
    if (entry.theme === activeTheme) continue;
    if (entry.mode === 'raster') {
      entry.layer.setUrl(raster[activeTheme]);
      entry.theme = activeTheme;
      continue;
    }
    const renderer = entry.layer?.getMaplibreMap();
    if (renderer) {
      renderer.setStyle(styles[activeTheme], { diff: false });
      entry.theme = activeTheme;
      if (entry.loadTimer) clearTimeout(entry.loadTimer);
      entry.loadTimer = setTimeout(() => failVector(map, entry, 'vector-theme-timeout'), 15000);
    }
  }
}

window.addEventListener('error', event => {
  const source = String(event.filename || '');
  const message = String(event.message || '');
  if (!/worker|maplibre/iu.test(`${source} ${message}`)) return;
  for (const [map, entry] of layers) failVector(map, entry, 'map-worker-failed');
});

window.RotaMotoMapTheme = Object.freeze({ addBaseLayer, setTheme, styles, raster, supportsVectorStyle });
