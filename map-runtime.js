import L from 'leaflet';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl } from 'maplibre-gl';

const styles = {
  light: 'https://tiles.openfreemap.org/styles/bright',
  dark: 'https://tiles.openfreemap.org/styles/dark'
};
const raster = {
  light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  dark: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
};
const rasterAttribution = {
  light: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  dark: '© <a href="https://carto.com/attributions">CARTO</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
};
const vectorAttribution = '© <a href="https://openfreemap.org">OpenFreeMap</a> · © <a href="https://openmaptiles.org">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const layers = new Map();
const statusElements = new WeakMap();
let activeTheme = document.documentElement.dataset.resolvedTheme === 'dark' ? 'dark' : 'light';
const probe = document.createElement('canvas');
const supportsVectorStyle = Boolean(probe.getContext('webgl2'));

setWorkerUrl(new URL('vendor/maplibre/maplibre-gl-worker.js?v=0139.1', document.baseURI).href);
window.L = L;

function diagnose(code, context = {}) {
  window.dispatchEvent(new CustomEvent('rotamoto:map-diagnostic', { detail: { code, ...context } }));
  console.warn('[RotaMoto mapas]', code, context);
}

function statusFor(map, create = false) {
  let status = statusElements.get(map);
  if (status && (status.isConnected !== false || !create)) return status;
  const anchor = anchorFor(map);
  status = document.createElement('div');
  status.className = 'rm-map-runtime-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  anchor.insertAdjacentElement('afterend', status);
  statusElements.set(map, status);
  return status;
}

function anchorFor(map) {
  const container = map.getContainer();
  return container.closest('.mapStage') || container.closest('.mapWrap') || container;
}

function setStatus(map, { state, message, retry = false }) {
  const status = statusFor(map, true);
  status.dataset.state = state;
  status.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  status.append(text);
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Tentar novamente';
    button.addEventListener('click', () => retryMap(map), { once: true });
    status.append(button);
  }
  status.hidden = false;
}

function clearStatus(map) {
  const status = statusFor(map);
  if (status) status.hidden = true;
}

function clearTimer(pending) {
  if (pending?.timer) clearTimeout(pending.timer);
  if (pending) pending.timer = null;
}

function rasterTileState(map, layer) {
  const container = map?.getContainer?.();
  const mapRect = container?.getBoundingClientRect?.();
  if (!mapRect || !layer?._tiles) return { visible: 0, loaded: 0, hasCartography: false, complete: false };
  const visibleTiles = Object.values(layer._tiles).map(tile => tile?.el).filter(tile => {
    if (!tile?.getBoundingClientRect) return false;
    const rect = tile.getBoundingClientRect();
    const style = window.getComputedStyle?.(tile);
    return rect.right > mapRect.left && rect.left < mapRect.right && rect.bottom > mapRect.top && rect.top < mapRect.bottom
      && style?.display !== 'none' && style?.visibility !== 'hidden';
  });
  const loaded = visibleTiles.filter(tile => tile.classList?.contains('leaflet-tile-loaded') && tile.complete === true && Number(tile.naturalWidth) > 0);
  return { visible: visibleTiles.length, loaded: loaded.length, hasCartography: loaded.length > 0, complete: visibleTiles.length > 0 && loaded.length === visibleTiles.length };
}

function scheduleActiveRasterStatus(map, entry, layer, attempt, loadingTimedOut = false) {
  if (entry.activeStatusTimer) clearTimeout(entry.activeStatusTimer);
  entry.activeStatusTimer = null;
  if (entry.layer !== layer || entry.activeAttempt !== attempt) return;
  entry.activeStatusTimer = setTimeout(() => {
    entry.activeStatusTimer = null;
    if (entry.layer !== layer || entry.activeAttempt !== attempt) return;
    const tiles = rasterTileState(map, layer);
    entry.cartographyVisible = tiles.hasCartography;
    entry.ready = tiles.hasCartography;
    if (!tiles.hasCartography) {
      if (!loadingTimedOut && layer.isLoading?.()) {
        setStatus(map, { state: 'loading', message: 'Atualizando as ruas do mapa…' });
        entry.activeStatusTimer = setTimeout(() => scheduleActiveRasterStatus(map, entry, layer, attempt, true), 15000);
        return;
      }
      setStatus(map, { state: 'error', message: 'As ruas do mapa não estão visíveis. Verifique a conexão e tente novamente.', retry: true });
    } else if (tiles.complete) clearStatus(map);
    else setStatus(map, { state: 'fallback', message: 'Algumas ruas não carregaram. Você pode tentar atualizar o mapa.', retry: true });
  }, 300);
}

function removeLayerAfterTileCycle(map, layer) {
  if (!layer || !map.hasLayer(layer)) return;
  if (typeof layer.setOpacity === 'function') layer.setOpacity(0);
  const remove = () => setTimeout(() => {
    if (map.hasLayer(layer)) map.removeLayer(layer);
  }, 0);
  if (typeof layer.isLoading === 'function' && layer.isLoading()) layer.once('load', remove);
  else remove();
}

function isPending(entry, attempt, layer) {
  return entry.pending?.attempt === attempt && entry.pending.layer === layer && entry.generation === attempt;
}

function beginAttempt(map, entry, mode, reason) {
  if (entry.pending) {
    const old = entry.pending;
    clearTimer(old);
    if (old.layer && old.layer !== entry.layer) removeLayerAfterTileCycle(map, old.layer);
  }
  const attempt = ++entry.generation;
  const pending = { attempt, mode, layer: null, theme: activeTheme, errors: 0, loadedTiles: 0, timer: null, reason };
  entry.pending = pending;
  return pending;
}

function publishAttribution(map, previousMode, previousTheme, mode, theme) {
  if (previousMode === 'vector' && mode !== 'vector') map.attributionControl?.removeAttribution(vectorAttribution);
  if (previousMode === 'raster' && (mode !== 'raster' || previousTheme !== theme)) {
    map.attributionControl?.removeAttribution(rasterAttribution[previousTheme]);
  }
  if (mode === 'vector') map.attributionControl?.addAttribution(vectorAttribution);
  else map.attributionControl?.addAttribution(rasterAttribution[theme]);
}

function commitAttempt(map, entry, pending, message = null) {
  if (!isPending(entry, pending.attempt, pending.layer)) return false;
  clearTimer(pending);
  const previousLayer = entry.layer;
  const previousMode = entry.mode;
  const previousTheme = entry.theme;
  entry.layer = pending.layer;
  entry.mode = pending.mode;
  entry.theme = pending.theme;
  entry.ready = true;
  entry.cartographyVisible = pending.mode === 'raster' ? rasterTileState(map, pending.layer).hasCartography : true;
  entry.activeAttempt = pending.attempt;
  if (entry.activeStatusTimer) clearTimeout(entry.activeStatusTimer);
  entry.activeStatusTimer = null;
  entry.activeContextLost = false;
  entry.pending = null;
  if (previousLayer && previousLayer !== entry.layer) removeLayerAfterTileCycle(map, previousLayer);
  publishAttribution(map, previousMode, previousTheme, entry.mode, entry.theme);
  if (message) setStatus(map, { state: 'fallback', message, retry: pending.errors > 0 });
  else clearStatus(map);
  return true;
}

function rejectAttempt(map, entry, pending, { code, autoFallback = false, message = null } = {}) {
  if (!isPending(entry, pending.attempt, pending.layer)) return false;
  clearTimer(pending);
  if (pending.layer) removeLayerAfterTileCycle(map, pending.layer);
  entry.pending = null;
  if (code) diagnose(code, { attempt: pending.attempt, mode: pending.mode, loadedTiles: pending.loadedTiles, tileErrors: pending.errors });
  if (entry.layer && entry.ready) {
    const previousTiles = entry.mode === 'raster' ? rasterTileState(map, entry.layer) : null;
    if (previousTiles && !previousTiles.hasCartography) entry.ready = false;
  }
  if (entry.layer && entry.ready) {
    setStatus(map, {
      state: entry.activeContextLost ? 'error' : 'fallback',
      message: message || 'A atualização do mapa não foi concluída. Tente novamente.',
      retry: true
    });
    return true;
  }
  if (autoFallback && pending.mode === 'vector') {
    addRaster(map, entry, code || 'vector-load-failed');
    return true;
  }
  setStatus(map, { state: 'error', message: message || 'Não foi possível carregar o mapa. Verifique a conexão e tente novamente.', retry: true });
  return true;
}

function addRaster(map, entry, reason) {
  const pending = beginAttempt(map, entry, 'raster', reason);
  const layer = L.tileLayer(raster[activeTheme], {
    maxZoom: 20,
    attribution: rasterAttribution[activeTheme],
    crossOrigin: true,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 3
  });
  pending.layer = layer;
  pending.theme = activeTheme;
  setStatus(map, { state: 'loading', message: entry.ready ? 'Atualizando o mapa…' : 'Carregando mapa básico…' });
  const finishLoad = () => {
    if (!isPending(entry, pending.attempt, layer)) return;
    if (pending.loadedTiles > 0 && rasterTileState(map, layer).hasCartography) {
      const text = pending.errors > 0
        ? 'Mapa básico atualizado. Algumas áreas não carregaram.'
        : 'Mapa básico carregado.';
      commitAttempt(map, entry, pending, pending.errors > 0 ? text : null);
      return;
    }
    rejectAttempt(map, entry, pending, {
      code: 'raster-tiles-unavailable',
      message: 'Não foi possível carregar as ruas do mapa. Verifique a conexão e tente novamente.'
    });
  };
  const activeAttempt = pending.attempt;
  layer.on('tileerror', () => {
    if (isPending(entry, pending.attempt, layer)) {
      pending.errors += 1;
      diagnose('raster-tile-error', { attempt: pending.attempt });
      return;
    }
    if (entry.layer !== layer || entry.activeAttempt !== pending.attempt) return;
    diagnose('active-raster-tile-error', { attempt: activeAttempt });
    scheduleActiveRasterStatus(map, entry, layer, activeAttempt);
  });
  layer.on('loading', () => {
    if (entry.layer === layer && entry.activeAttempt === activeAttempt) scheduleActiveRasterStatus(map, entry, layer, activeAttempt);
  });
  layer.on('tileloadstart', () => {
    if (entry.layer === layer && entry.activeAttempt === activeAttempt) scheduleActiveRasterStatus(map, entry, layer, activeAttempt);
  });
  layer.on('tileload', () => {
    if (isPending(entry, pending.attempt, layer)) pending.loadedTiles += 1;
    else if (entry.layer === layer && entry.activeAttempt === activeAttempt) scheduleActiveRasterStatus(map, entry, layer, activeAttempt);
  });
  layer.on('load', () => {
    if (entry.layer === layer && entry.activeAttempt === activeAttempt) scheduleActiveRasterStatus(map, entry, layer, activeAttempt);
  });
  layer.once('load', finishLoad);
  pending.timer = setTimeout(finishLoad, 15000);
  layer.addTo(map);
  return layer;
}

function inspectRenderer(renderer) {
  const safe = (read, fallback = null) => { try { return read(); } catch { return fallback; } };
  const canvas = safe(() => renderer?.getCanvas?.());
  const style = safe(() => renderer?.getStyle?.());
  const sourceIds = Object.keys(style?.sources || {});
  const sourcesLoaded = sourceIds.length > 0 && sourceIds.every(id => safe(() => renderer.isSourceLoaded(id), false));
  return {
    styleLoaded: safe(() => renderer?.isStyleLoaded?.(), false),
    tilesLoaded: safe(() => renderer?.areTilesLoaded?.(), false),
    rendererLoaded: safe(() => renderer?.loaded?.(), false),
    styleLayerCount: style?.layers?.length ?? 0,
    sourceIds,
    sourcesLoaded,
    contextLost: safe(() => canvas?.getContext?.('webgl2')?.isContextLost?.(), false)
  };
}

function addVector(map, entry) {
  const pending = beginAttempt(map, entry, 'vector', 'style-or-theme-change');
  try {
    const layer = maplibreGL({ style: styles[activeTheme], interactive: false, attributionControl: false, fadeDuration: 0 });
    pending.layer = layer;
    pending.theme = activeTheme;
    setStatus(map, { state: 'loading', message: 'Carregando mapa detalhado…' });
    layer.addTo(map);
    const renderer = layer.getMaplibreMap();
    if (!renderer) {
      rejectAttempt(map, entry, pending, { code: 'vector-renderer-unavailable', autoFallback: true });
      return layer;
    }
    const canvas = renderer.getCanvas();
    const onContextLost = event => {
      event.preventDefault();
      if (isPending(entry, pending.attempt, layer)) {
        rejectAttempt(map, entry, pending, { code: 'webgl-context-lost', autoFallback: true });
        return;
      }
      if (entry.layer !== layer || entry.activeAttempt !== pending.attempt) return;
      entry.activeContextLost = true;
      diagnose('webgl-context-lost', { attempt: pending.attempt });
      addRaster(map, entry, 'webgl-context-lost');
    };
    canvas.addEventListener('webglcontextcreationerror', event => {
      if (!isPending(entry, pending.attempt, layer)) return;
      rejectAttempt(map, entry, pending, { code: 'webgl-context-creation-failed', autoFallback: true, message: 'O mapa detalhado não pôde ser iniciado; tentando o mapa básico.' });
      diagnose('webgl-context-creation-detail', { reason: String(event.statusMessage || 'contexto não criado').slice(0, 120) });
    }, { once: true });
    canvas.addEventListener('webglcontextlost', onContextLost, { once: true });
    const ready = () => {
      if (!isPending(entry, pending.attempt, layer)) return;
      const state = inspectRenderer(renderer);
      if (!state.styleLoaded || !state.tilesLoaded || !state.sourcesLoaded || state.styleLayerCount < 1 || state.contextLost) return;
      commitAttempt(map, entry, pending, pending.errors > 0 ? 'Mapa detalhado carregado. Algumas áreas podem não aparecer.' : null);
      entry.activeContextLost = false;
    };
    pending.timer = setTimeout(() => rejectAttempt(map, entry, pending, { code: 'vector-style-timeout', autoFallback: true }), 15000);
    renderer.on('load', ready);
    renderer.on('idle', ready);
    renderer.on('error', event => {
      if (!isPending(entry, pending.attempt, layer)) {
        if (entry.layer === layer && entry.activeAttempt === pending.attempt) {
          diagnose('active-vector-resource-error', { attempt: pending.attempt });
          setStatus(map, { state: 'fallback', message: 'Alguns detalhes do mapa não foram atualizados. Tente novamente.', retry: true });
        }
        return;
      }
      pending.errors += 1;
      if (pending.errors === 1) {
        diagnose('vector-style-or-tile-error', { attempt: pending.attempt });
        const error = event?.error;
        console.warn('[RotaMoto mapas] vector-render-error', error?.name || 'Error', error?.message || 'detalhe indisponível');
      }
      if (pending.errors >= 3) rejectAttempt(map, entry, pending, { code: 'vector-load-failed', autoFallback: true });
    });
    return layer;
  } catch (error) {
    console.error('[RotaMoto mapas] vector-initialization-failed', error?.name || 'Error');
    rejectAttempt(map, entry, pending, { code: 'vector-initialization-failed', autoFallback: true });
    return pending.layer;
  }
}

function addBaseLayer(map) {
  const entry = { layer: null, mode: null, theme: activeTheme, errors: 0, loadedTiles: 0, ready: false, cartographyVisible: false, recovered: false, generation: 0, activeAttempt: 0, pending: null, activeContextLost: false, activeStatusTimer: null, mapEventsBound: false };
  layers.set(map, entry);
  if (!entry.mapEventsBound && typeof map.on === 'function') {
    entry.mapEventsBound = true;
    map.on('moveend zoomend resize', () => {
      if (entry.layer && entry.mode === 'raster') scheduleActiveRasterStatus(map, entry, entry.layer, entry.activeAttempt);
    });
  }
  if (!supportsVectorStyle) {
    diagnose('webgl2-unavailable');
    return addRaster(map, entry, 'webgl2-unavailable');
  }
  return addVector(map, entry);
}

function retryMap(map) {
  const entry = layers.get(map);
  if (!entry) return;
  if (supportsVectorStyle) addVector(map, entry);
  else addRaster(map, entry, 'user-retry');
}

function setTheme(theme) {
  activeTheme = theme === 'dark' ? 'dark' : 'light';
  for (const [map, entry] of layers) {
    if (entry.mode === 'raster' || entry.pending?.mode === 'raster') {
      addRaster(map, entry, 'theme-change');
      continue;
    }
    if (supportsVectorStyle && (entry.mode === 'vector' || entry.pending?.mode === 'vector')) addVector(map, entry);
  }
}

window.RotaMotoMapTheme = Object.freeze({
  addBaseLayer,
  setTheme,
  styles,
  raster,
  supportsVectorStyle,
  retry: retryMap,
  inspect: map => inspectLayer(layers.get(map), map),
  inspectAll: () => [...layers.entries()].map(([map, entry]) => inspectLayer(entry, map))
});

function inspectLayer(entry, map) {
  const rendererLayer = entry?.pending?.mode === 'vector' ? entry.pending.layer : entry?.layer;
  const renderer = rendererLayer?.getMaplibreMap?.();
  const state = inspectRenderer(renderer);
  return {
    mode: entry?.pending?.mode || entry?.mode || null,
    ready: entry?.mode === 'raster' ? rasterTileState(map, entry.layer).hasCartography : Boolean(entry?.ready),
    cartographyVisible: entry?.mode === 'raster' ? rasterTileState(map, entry.layer).hasCartography : Boolean(entry?.ready),
    generation: entry?.generation || 0,
    pending: Boolean(entry?.pending),
    styleLoaded: state.styleLoaded,
    tilesLoaded: state.tilesLoaded,
    rendererLoaded: state.rendererLoaded,
    sourcesLoaded: state.sourcesLoaded,
    styleLayerCount: state.styleLayerCount,
    sourceIds: state.sourceIds,
    contextLost: state.contextLost
  };
}
