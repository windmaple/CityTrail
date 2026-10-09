import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// MapLibre v6 locates its worker relative to its own module URL, which breaks
// once bundled — point it at the emitted asset explicitly.
maplibregl.setWorkerUrl(workerUrl);

// OpenFreeMap: free vector tiles, no API key or usage limits.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const WORLD_VIEW = { center: [12, 28], zoom: 1.4 };

// Warm the neutral Positron basemap to match the app palette.
const PAPER = '#f3eee6';
const WATER = '#cfdde3';

let map;
let currentPopup = null;
const markers = new Map(); // cityId -> maplibregl.Marker
let getObstruction = () => ({ left: 0, bottom: 0 });

function padding(extra = 0) {
  const { left, bottom } = getObstruction();
  return { top: 24 + extra, right: 24 + extra, bottom: bottom + 24 + extra, left: left + 24 + extra };
}

export function initMap(el, { onMapClick, obstruction } = {}) {
  if (obstruction) getObstruction = obstruction;

  map = new maplibregl.Map({
    container: el,
    style: STYLE_URL,
    ...WORLD_VIEW,
    minZoom: 0.8,
    maxZoom: 17,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  map.on('style.load', () => {
    for (const layer of map.getStyle().layers) {
      try {
        if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', PAPER);
        else if (layer.type === 'fill' && /water/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', WATER);
        else if (layer.type === 'symbol' && layer.layout?.['text-field'] && !/shield|housenumber/.test(layer.id)) {
          // Prefer English place names, fall back to the local name.
          map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']]);
        }
      } catch {
        /* layer may not support the property — ignore */
      }
    }
  });

  if (onMapClick) map.on('click', (e) => onMapClick({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
  return map;
}

export function addMapButton({ id, title, svg, onClick }) {
  map.addControl(
    {
      onAdd() {
        const wrap = document.createElement('div');
        wrap.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        const btn = document.createElement('button');
        btn.id = id;
        btn.type = 'button';
        btn.className = 'map-btn';
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.innerHTML = svg;
        btn.addEventListener('click', onClick);
        wrap.appendChild(btn);
        return wrap;
      },
      onRemove() {},
    },
    'top-right',
  );
}

function pinElement(city, fresh, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'pin-icon';
  el.title = city.name;
  el.setAttribute('aria-label', `${city.name}, ${city.country}`);
  el.innerHTML = `<span class="pin${fresh ? ' pin--fresh' : ''}"><span class="pin-core"></span></span>`;
  el.addEventListener('click', (e) => {
    e.stopPropagation(); // don't trigger a map-click lookup
    onClick?.();
  });
  return el;
}

/** Sync markers with the current list of visited cities. */
export function renderCities(cities, { onMarkerClick, freshId } = {}) {
  const ids = new Set(cities.map((c) => c.id));
  for (const [id, marker] of markers) {
    if (!ids.has(id)) {
      marker.remove();
      markers.delete(id);
    }
  }
  for (const city of cities) {
    if (markers.has(city.id)) continue;
    const el = pinElement(city, city.id === freshId, () => onMarkerClick?.(city));
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([city.lng, city.lat]).addTo(map);
    markers.set(city.id, marker);
  }
}

export function flyToCity(city, zoom = Math.max(map.getZoom(), 8.5)) {
  map.flyTo({ center: [city.lng, city.lat], zoom, padding: padding(), duration: 1400, essential: true });
}

export function getZoom() {
  return map.getZoom();
}

export function zoomInAt({ lat, lng }, zoom) {
  map.flyTo({ center: [lng, lat], zoom, padding: padding(), duration: 1000, essential: true });
}

export function fitToCities(cities) {
  if (!cities.length) {
    map.flyTo({ ...WORLD_VIEW, padding: padding(), duration: 900 });
    return;
  }
  if (cities.length === 1) {
    flyToCity(cities[0], 7);
    return;
  }
  const bounds = new maplibregl.LngLatBounds();
  cities.forEach((c) => bounds.extend([c.lng, c.lat]));
  map.fitBounds(bounds, { padding: padding(40), maxZoom: 7, duration: 1400 });
}

export function openPopup({ lat, lng }, content) {
  closePopup();
  // Clicks inside the popup must not bubble to the map (which would start a new lookup).
  content.addEventListener('click', (e) => e.stopPropagation());
  currentPopup = new maplibregl.Popup({
    className: 'ct-popup',
    maxWidth: '290px',
    offset: 14,
    focusAfterOpen: false,
  })
    .setLngLat([lng, lat])
    .setDOMContent(content)
    .addTo(map);
  currentPopup.on('close', () => (currentPopup = null));
  return currentPopup;
}

export function closePopup() {
  currentPopup?.remove();
  currentPopup = null;
}

export function setInteractive(enabled) {
  ['dragPan', 'scrollZoom', 'doubleClickZoom', 'touchZoomRotate', 'boxZoom', 'keyboard'].forEach((h) =>
    enabled ? map[h]?.enable() : map[h]?.disable(),
  );
}
