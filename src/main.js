import { signInWithGoogle, signOutUser, watchAuth, watchCities, addCity, removeCity } from './firebase.js';
import { searchCities, reverseCity, flagUrl } from './geo.js';
import {
  initMap,
  addMapButton,
  renderCities,
  flyToCity,
  fitToCities,
  openPopup,
  closePopup,
  setInteractive,
  getZoom,
  zoomInAt,
} from './map.js';
// Imported after map.js so these styles override MapLibre's defaults.
import './style.css';

const WORLD_COUNTRIES = 195;
const MOBILE_QUERY = window.matchMedia('(max-width: 720px)');

const $ = (sel) => document.querySelector(sel);
const els = {
  boot: $('#boot'),
  auth: $('#auth-screen'),
  authError: $('#auth-error'),
  signIn: $('#google-signin-btn'),
  panel: $('#panel'),
  handle: $('#sheet-handle'),
  userBtn: $('#user-btn'),
  avatar: $('#user-avatar'),
  initial: $('#user-initial'),
  dropdown: $('#user-dropdown'),
  userName: $('#user-name'),
  userEmail: $('#user-email'),
  signOut: $('#signout-btn'),
  search: $('#city-search'),
  spinner: $('#search-spinner'),
  results: $('#search-results'),
  statCities: $('#stat-cities'),
  statCountries: $('#stat-countries'),
  statWorld: $('#stat-world'),
  empty: $('#empty-state'),
  list: $('#city-list'),
  toasts: $('#toast-region'),
};

const state = {
  user: null,
  cities: [],
  byId: new Map(),
  unsubscribe: null,
  freshId: null,
  firstLoad: true,
  searchResults: [],
  activeIndex: -1,
};

/* ---------------- Utilities ---------------- */

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });

/** Region label, skipped when it just repeats the city name (e.g. Tokyo, Tokyo). */
const regionOf = (c) => (c.region && c.region !== c.name ? c.region : '');

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function flagImg(cc, cls = 'flag') {
  const url = flagUrl(cc);
  return url ? `<img class="${cls}" src="${url}" alt="" loading="lazy" />` : `<span class="${cls}"></span>`;
}

function toast(message, { action, onAction, timeout = 4500 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action;
    btn.addEventListener('click', () => {
      onAction?.();
      dismiss();
    });
    el.appendChild(btn);
  }
  els.toasts.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--in'));
  const dismiss = () => {
    el.classList.remove('toast--in');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  setTimeout(dismiss, timeout);
}

function friendlyError(err) {
  const code = err?.code || '';
  const messages = {
    'auth/popup-blocked': 'Your browser blocked the sign-in popup. Allow popups and try again.',
    'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/network-request-failed': 'Network error — check your connection and try again.',
    'auth/operation-not-allowed': 'Google sign-in is not enabled for this project.',
    'auth/configuration-not-found': 'Google sign-in is not enabled for this project.',
    'auth/unauthorized-domain': 'This domain is not authorized for sign-in in Firebase.',
    'permission-denied': "You don't have permission to do that.",
    unavailable: "You're offline — changes will sync when you reconnect.",
  };
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;
  return messages[code] || err?.message || 'Something went wrong.';
}

/** Space the floating panel takes up, so the map can center around it. */
function panelObstruction() {
  if (els.panel.hidden) return { left: 0, bottom: 0 };
  const r = els.panel.getBoundingClientRect();
  return MOBILE_QUERY.matches ? { left: 0, bottom: window.innerHeight - r.top } : { left: r.right, bottom: 0 };
}

/** Expose the mobile sheet height to CSS so map controls can sit above it. */
function syncSheetHeight() {
  const h = MOBILE_QUERY.matches && !els.panel.hidden ? els.panel.offsetHeight : 0;
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
}
new ResizeObserver(syncSheetHeight).observe(els.panel);
MOBILE_QUERY.addEventListener('change', syncSheetHeight);

/* ---------------- Map ---------------- */

const MIN_PICK_ZOOM = 4;

initMap(document.getElementById('map'), {
  onMapClick: handleMapClick,
  obstruction: panelObstruction,
});

addMapButton({
  id: 'fit-btn',
  title: 'Show all my cities',
  svg: `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  onClick: () => fitToCities(state.cities),
});

let reverseController;
let zoomHintShown = false;
async function handleMapClick(latlng) {
  if (!state.user) return;
  hideResults();

  // From far out a tap could land on any of dozens of towns — zoom in first.
  if (getZoom() < MIN_PICK_ZOOM) {
    zoomInAt(latlng, 5.5);
    if (!zoomHintShown) {
      zoomHintShown = true;
      toast('Zoomed in — now tap the city you visited');
    }
    return;
  }
  const lat = latlng.lat;
  const lng = ((latlng.lng + 540) % 360) - 180; // wrap longitude into [-180, 180)

  const box = document.createElement('div');
  box.className = 'popup';
  box.innerHTML = `<div class="popup-loading"><span class="spinner"></span>Finding city…</div>`;
  openPopup(latlng, box);

  reverseController?.abort();
  reverseController = new AbortController();
  try {
    const city = await reverseCity(lat, lng, reverseController.signal);
    if (!city) {
      box.innerHTML = `<div class="popup-empty">No city here — try tapping closer to a town.</div>`;
      return;
    }
    renderPopup(box, city);
  } catch (err) {
    if (err.name === 'AbortError') return;
    box.innerHTML = `<div class="popup-empty">Couldn't look up this spot. Please try again.</div>`;
  }
}

function renderPopup(box, city) {
  const visited = state.byId.get(city.id);
  const place = [regionOf(city), city.country].filter(Boolean).join(', ');
  box.innerHTML = `
    <div class="popup-head">
      ${flagImg(city.countryCode, 'flag flag--lg')}
      <div>
        <div class="popup-title">${esc(city.name)}</div>
        <div class="popup-sub">${esc(place)}</div>
      </div>
    </div>
    ${
      visited
        ? `<div class="popup-meta">Visited · added ${esc(monthFmt.format(visited.addedAt))}</div>
           <button type="button" class="btn btn--ghost" data-action="remove">Remove from my map</button>`
        : `<button type="button" class="btn btn--primary" data-action="add">
             <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
             I've been here
           </button>`
    }`;
  box.querySelector('[data-action="add"]')?.addEventListener('click', async () => {
    closePopup();
    await markVisited(city, { fly: false });
  });
  box.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
    closePopup();
    unmark(visited);
  });
}

function showCityPopup(city) {
  const box = document.createElement('div');
  box.className = 'popup';
  renderPopup(box, city);
  openPopup({ lat: city.lat, lng: city.lng }, box);
}

/* ---------------- Data actions ---------------- */

async function markVisited(city, { fly = true } = {}) {
  if (state.byId.has(city.id)) {
    const existing = state.byId.get(city.id);
    flyToCity(existing);
    highlightListItem(existing.id);
    toast(`${existing.name} is already on your map`);
    return;
  }
  state.freshId = city.id;
  if (fly) flyToCity(city);
  try {
    // Don't await the server round-trip — the local snapshot updates instantly.
    addCity(state.user.uid, city).catch((err) => toast(friendlyError(err) || 'Could not save city'));
    toast(`Added ${city.name}`);
  } catch (err) {
    toast(friendlyError(err) || 'Could not save city');
  }
}

function unmark(city) {
  if (!city) return;
  removeCity(state.user.uid, city.id).catch((err) => toast(friendlyError(err) || 'Could not remove city'));
  toast(`Removed ${city.name}`, {
    action: 'Undo',
    onAction: () => {
      state.freshId = city.id;
      addCity(state.user.uid, city).catch((err) => toast(friendlyError(err)));
    },
  });
}

/* ---------------- Rendering ---------------- */

function animateNumber(el, to, suffix = '') {
  const from = Number(el.dataset.value || 0);
  el.dataset.value = to;
  if (from === to) {
    el.textContent = `${to}${suffix}`;
    return;
  }
  const decimals = suffix === '%' ? 1 : 0;
  const start = performance.now();
  const dur = 500;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    const v = from + (to - from) * eased;
    el.textContent = `${v.toFixed(t === 1 && Number.isInteger(to) ? 0 : decimals)}${suffix}`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderStats() {
  const countries = new Set(state.cities.map((c) => c.countryCode));
  animateNumber(els.statCities, state.cities.length);
  animateNumber(els.statCountries, countries.size);
  const pct = Math.round((countries.size / WORLD_COUNTRIES) * 1000) / 10;
  animateNumber(els.statWorld, pct, '%');
}

function renderList() {
  const groups = new Map();
  for (const c of state.cities) {
    const key = c.countryCode || c.country;
    if (!groups.has(key)) groups.set(key, { country: c.country, cc: c.countryCode, cities: [] });
    groups.get(key).cities.push(c);
  }
  const sorted = [...groups.values()].sort(
    (a, b) => b.cities.length - a.cities.length || a.country.localeCompare(b.country),
  );

  els.empty.hidden = state.cities.length > 0;
  els.list.innerHTML = sorted
    .map(
      (g) => `
      <section class="country-group">
        <h3 class="country-head">
          ${flagImg(g.cc)}
          <span class="country-name">${esc(g.country)}</span>
          <span class="country-count">${g.cities.length}</span>
        </h3>
        <ul class="city-items">
          ${g.cities
            .map(
              (c) => `
            <li class="city-item${c.id === state.freshId ? ' city-item--fresh' : ''}" data-id="${esc(c.id)}">
              <button type="button" class="city-main" data-action="fly" id="city-${esc(c.id)}">
                <span class="city-name">${esc(c.name)}</span>
                <span class="city-meta">${esc([regionOf(c), monthFmt.format(c.addedAt)].filter(Boolean).join(' · '))}</span>
              </button>
              <button type="button" class="icon-btn" data-action="remove" aria-label="Remove ${esc(c.name)}" title="Remove">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
            </li>`,
            )
            .join('')}
        </ul>
      </section>`,
    )
    .join('');
}

function highlightListItem(id) {
  const item = els.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!item) return;
  item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  item.classList.remove('city-item--flash');
  void item.offsetWidth;
  item.classList.add('city-item--flash');
}

els.list.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const city = state.byId.get(btn.closest('.city-item').dataset.id);
  if (!city) return;
  if (btn.dataset.action === 'fly') {
    flyToCity(city);
    if (MOBILE_QUERY.matches) setSheetExpanded(false);
    setTimeout(() => showCityPopup(city), 600);
  } else if (btn.dataset.action === 'remove') {
    unmark(city);
  }
});

function onCities(cities) {
  state.cities = cities;
  state.byId = new Map(cities.map((c) => [c.id, c]));
  renderCities(cities, {
    freshId: state.freshId,
    onMarkerClick: (city) => {
      showCityPopup(state.byId.get(city.id) || city);
      highlightListItem(city.id);
    },
  });
  renderStats();
  renderList();
  if (state.firstLoad) {
    state.firstLoad = false;
    if (cities.length) setTimeout(() => fitToCities(cities), 250);
  }
  // Clear the "fresh" flag after its animation has played.
  if (state.freshId) setTimeout(() => (state.freshId = null), 1500);
}

/* ---------------- Search ---------------- */

let searchController;
const runSearch = debounce(async (text) => {
  searchController?.abort();
  if (text.length < 2) {
    hideResults();
    return;
  }
  searchController = new AbortController();
  els.spinner.hidden = false;
  try {
    state.searchResults = await searchCities(text, searchController.signal);
    state.activeIndex = state.searchResults.length ? 0 : -1;
    renderResults(text);
  } catch (err) {
    if (err.name !== 'AbortError') {
      state.searchResults = [];
      renderResults(text, 'Search is unavailable right now.');
    }
  } finally {
    els.spinner.hidden = true;
  }
}, 220);

function renderResults(text, errorMsg) {
  const items = state.searchResults;
  if (errorMsg || !items.length) {
    els.results.innerHTML = `<li class="result-empty">${esc(errorMsg || `No cities match “${text}”`)}</li>`;
  } else {
    els.results.innerHTML = items
      .map((c, i) => {
        const visited = state.byId.has(c.id);
        return `
        <li class="result${i === state.activeIndex ? ' result--active' : ''}" role="option" id="result-${i}"
            data-index="${i}" aria-selected="${i === state.activeIndex}">
          ${flagImg(c.countryCode)}
          <span class="result-text">
            <span class="result-name">${esc(c.name)}</span>
            <span class="result-sub">${esc([regionOf(c), c.country].filter(Boolean).join(', '))}</span>
          </span>
          ${visited ? '<span class="result-tag">Visited</span>' : '<span class="result-add" aria-hidden="true">+</span>'}
        </li>`;
      })
      .join('');
  }
  els.results.hidden = false;
  els.search.setAttribute('aria-expanded', 'true');
  els.search.setAttribute('aria-activedescendant', state.activeIndex >= 0 ? `result-${state.activeIndex}` : '');
}

function hideResults() {
  els.results.hidden = true;
  els.search.setAttribute('aria-expanded', 'false');
  els.search.removeAttribute('aria-activedescendant');
}

function chooseResult(index) {
  const city = state.searchResults[index];
  if (!city) return;
  hideResults();
  els.search.value = '';
  els.search.blur();
  if (MOBILE_QUERY.matches) setSheetExpanded(false);
  markVisited(city);
}

els.search.addEventListener('input', (e) => runSearch(e.target.value.trim()));
els.search.addEventListener('focus', () => {
  if (els.search.value.trim().length >= 2 && state.searchResults.length) renderResults(els.search.value.trim());
});
els.search.addEventListener('keydown', (e) => {
  const n = state.searchResults.length;
  if (e.key === 'ArrowDown' && n) {
    e.preventDefault();
    state.activeIndex = (state.activeIndex + 1) % n;
    renderResults(els.search.value.trim());
  } else if (e.key === 'ArrowUp' && n) {
    e.preventDefault();
    state.activeIndex = (state.activeIndex - 1 + n) % n;
    renderResults(els.search.value.trim());
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (state.activeIndex >= 0) chooseResult(state.activeIndex);
  } else if (e.key === 'Escape') {
    hideResults();
    els.search.blur();
  }
});
els.results.addEventListener('mousedown', (e) => {
  const li = e.target.closest('.result');
  if (!li) return;
  e.preventDefault(); // keep focus until we handle it
  chooseResult(Number(li.dataset.index));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search')) hideResults();
  if (!e.target.closest('.user-menu')) setDropdown(false);
});

/* ---------------- User menu & mobile sheet ---------------- */

function setDropdown(open) {
  els.dropdown.hidden = !open;
  els.userBtn.setAttribute('aria-expanded', String(open));
}
els.userBtn.addEventListener('click', () => setDropdown(els.dropdown.hidden));
els.signOut.addEventListener('click', async () => {
  setDropdown(false);
  await signOutUser();
});

function setSheetExpanded(expanded) {
  els.panel.classList.toggle('panel--expanded', expanded);
  els.handle.setAttribute('aria-expanded', String(expanded));
  els.handle.setAttribute('aria-label', expanded ? 'Collapse city list' : 'Expand city list');
}
els.handle.addEventListener('click', () => setSheetExpanded(!els.panel.classList.contains('panel--expanded')));

/* ---------------- Auth flow ---------------- */

function showAuthError(message) {
  els.authError.textContent = message || '';
  els.authError.hidden = !message;
}

els.signIn.addEventListener('click', async () => {
  showAuthError('');
  els.signIn.disabled = true;
  els.signIn.classList.add('is-loading');
  try {
    await signInWithGoogle();
  } catch (err) {
    const msg = friendlyError(err);
    if (msg) showAuthError(msg);
  } finally {
    els.signIn.disabled = false;
    els.signIn.classList.remove('is-loading');
  }
});

function renderUser(user) {
  if (!user) return;
  const name = user.displayName || user.email || 'Traveler';
  els.userName.textContent = name;
  els.userEmail.textContent = user.displayName ? user.email || '' : '';
  els.initial.textContent = name.trim().charAt(0).toUpperCase();
  if (user.photoURL) {
    els.avatar.src = user.photoURL;
    els.avatar.hidden = false;
    els.avatar.onerror = () => (els.avatar.hidden = true);
  } else {
    els.avatar.hidden = true;
  }
}

watchAuth((user) => {
  els.boot.classList.add('boot--done');
  state.unsubscribe?.();
  state.unsubscribe = null;
  closePopup();

  if (!user) {
    state.user = null;
    state.firstLoad = true;
    onCities([]);
    state.firstLoad = true;
    els.panel.hidden = true;
    els.auth.hidden = false;
    document.body.classList.add('signed-out');
    setInteractive(false);
    return;
  }

  state.user = user;
  els.auth.hidden = true;
  els.panel.hidden = false;
  document.body.classList.remove('signed-out');
  setInteractive(true);
  syncSheetHeight();
  renderUser(user);

  state.unsubscribe = watchCities(user.uid, onCities, (err) => toast(friendlyError(err), { timeout: 6000 }));
});
