import L from 'leaflet';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl } from 'maplibre-gl';

const styles = {
  light: 'https://tiles.openfreemap.org/styles/bright',
  dark: 'https://tiles.openfreemap.org/styles/dark'
};
const raster = {
  light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  dark: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
};
const rasterAttribution = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const vectorAttribution = '© <a href="https://openfreemap.org">OpenFreeMap</a> · © <a href="https://openmaptiles.org">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const layers = new Map();
let activeTheme = document.documentElement.dataset.resolvedTheme === 'dark' ? 'dark' : 'light';
const probe = document.createElement('canvas');
const supportsVectorStyle = Boolean(probe.getContext('webgl2'));

setWorkerUrl(new URL('vendor/maplibre/maplibre-gl-worker.js?v=0139.1', document.baseURI).href);
window.L = L;

function diagnose(code, context = {}) {
  window.dispatchEvent(new CustomEvent('rotamoto:map-diagnostic', { detail: { code, ...context } }));
  console.warn('[RotaMoto mapas]', code, context);
}

function setStatus(map, { state, message, retry = false }) {
  const container = map.getContainer();
  let status = container.nextElementSibling?.classList.contains('rm-map-runtime-status') ? container.nextElementSibling : null;
  if (!status) {
    status = document.createElement('div');
    status.className = 'rm-map-runtime-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    container.insertAdjacentElement('afterend', status);
  }
  status.dataset.state = state;
  status.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  status.append(text);
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Tentar novamente';
    button.addEventListener('click', () => retryVector(map), { once: true });
    status.append(button);
  }
  status.hidden = false;
}

function clearStatus(map) {
  const container = map.getContainer();
  const status = container.nextElementSibling?.classList.contains('rm-map-runtime-status') ? container.nextElementSibling : null;
  if (status) status.hidden = true;
}

function addRaster(map, entry, reason) {
  if (entry.loadTimer) clearTimeout(entry.loadTimer);
  entry.loadTimer = null;
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
  entry.loadedTiles = 0;
  entry.reason = reason;
  setStatus(map, { state: 'loading', message: 'Carregando mapa básico…' });
  layer.on('tileerror', () => {
    entry.errors += 1;
    diagnose('raster-tile-error');
    if (entry.errors >= 3 && entry.loadedTiles === 0) {
      diagnose('raster-tiles-unavailable');
      setStatus(map, { state: 'error', message: 'Não foi possível carregar o mapa. Verifique a conexão e tente novamente.', retry: true });
    }
  });
  layer.on('tileload', () => {
    entry.loadedTiles += 1;
    entry.errors = 0;
    setStatus(map, { state: 'fallback', message: 'Mapa básico carregado.' });
  });
  layer.addTo(map);
  return layer;
}

function failVector(map, entry, code, extra = {}) {
  if (entry.mode !== 'vector' || entry.recovered) return;
  entry.recovered = true;
  const state = inspectLayer(entry);
  diagnose(code, { styleLoaded: state.styleLoaded, tilesLoaded: state.tilesLoaded, rendererLoaded: state.rendererLoaded, contextLost: state.contextLost, styleLayerCount: state.styleLayerCount, ...extra });
  addRaster(map, entry, code);
}

function addVector(map, entry) {
  if (entry.mode === 'raster') map.attributionControl?.removeAttribution(rasterAttribution);
  try {
    const layer = maplibreGL({ style: styles[activeTheme], interactive: false, attributionControl: false, fadeDuration: 0 });
    entry.layer = layer;
    entry.mode = 'vector';
    entry.theme = activeTheme;
    entry.errors = 0;
    entry.recovered = false;
    setStatus(map, { state: 'loading', message: 'Carregando mapa detalhado…' });
    layer.addTo(map);
    map.attributionControl?.addAttribution(vectorAttribution);
    const renderer = layer.getMaplibreMap();
    if (!renderer) {
      failVector(map, entry, 'vector-renderer-unavailable');
      return layer;
    }
    const canvas = renderer.getCanvas();
    canvas.addEventListener('webglcontextcreationerror', event => {
      failVector(map, entry, 'webgl-context-creation-failed', { reason: String(event.statusMessage || 'contexto não criado').slice(0, 160) });
    }, { once: true });
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      failVector(map, entry, 'webgl-context-lost', { reason: String(event.statusMessage || 'contexto perdido').slice(0, 160) });
    }, { once: true });
    entry.rendererEvents = { styledata: 0, sourcedata: 0, idle: 0, load: 0 };
    renderer.on('styledata', () => { entry.rendererEvents.styledata += 1; });
    renderer.on('sourcedata', () => { entry.rendererEvents.sourcedata += 1; });
    renderer.on('idle', () => { entry.rendererEvents.idle += 1; });
    entry.loadTimer = setTimeout(() => failVector(map, entry, 'vector-style-timeout'), 15000);
    renderer.on('load', () => {
      entry.rendererEvents.load += 1;
      if (entry.loadTimer) clearTimeout(entry.loadTimer);
      entry.loadTimer = null;
      entry.errors = 0;
      clearStatus(map);
    });
    renderer.on('error', event => {
      entry.errors += 1;
      if (entry.errors === 1) {
        diagnose('vector-style-or-tile-error');
        const error = event?.error;
        console.warn('[RotaMoto mapas] vector-render-error', error?.name || 'Error', error?.message || 'detalhe indisponível');
      }
      if (entry.errors >= 3) failVector(map, entry, 'vector-load-failed');
    });
    return layer;
  } catch (error) {
    console.error('[RotaMoto mapas] vector-initialization-failed', error);
    entry.mode = 'vector';
    failVector(map, entry, 'vector-initialization-failed');
    return entry.layer;
  }
}

function addBaseLayer(map) {
  const entry = { layer: null, mode: null, theme: activeTheme, errors: 0, loadedTiles: 0, recovered: false, loadTimer: null, reason: null };
  layers.set(map, entry);
  if (!supportsVectorStyle) {
    diagnose('webgl2-unavailable');
    addRaster(map, entry, 'webgl2-unavailable');
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
  else addRaster(map, entry, 'webgl2-unavailable');
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

window.RotaMotoMapTheme = Object.freeze({ addBaseLayer, setTheme, styles, raster, supportsVectorStyle, inspect: map => inspectLayer(layers.get(map)), inspectAll: () => [...layers.values()].map(inspectLayer) });

function inspectLayer(entry) {
  const renderer = entry?.layer?.getMaplibreMap();
  const safe = (read, fallback = null) => { try { return read(); } catch { return fallback; } };
  const canvas = safe(() => renderer?.getCanvas?.());
  const style = safe(() => renderer?.getStyle?.());
  return {
    mode: entry?.mode || null,
    styleLoaded: safe(() => renderer?.isStyleLoaded?.(), false),
    tilesLoaded: safe(() => renderer?.areTilesLoaded?.(), false),
    rendererLoaded: safe(() => renderer?.loaded?.(), false),
    internalStyleLoaded: safe(() => renderer?._style?._loaded, false),
    styleLayerCount: style?.layers?.length ?? 0,
    sourceIds: Object.keys(style?.sources || {}),
    rendererEvents: entry?.rendererEvents || null,
    contextLost: safe(() => canvas?.getContext?.('webgl2')?.isContextLost?.())
  };
}
