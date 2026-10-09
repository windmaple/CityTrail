// Geocoding via free OpenStreetMap services (no API key required).
//  - Photon (komoot) is built for search-as-you-type autocomplete.
//  - Nominatim reverse lookup (zoom=10 → city level) resolves map clicks.

const PHOTON_URL = 'https://photon.komoot.io/api/';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';

const PLACE_TAGS = ['city', 'town', 'village', 'municipality'];

function slug(value = '') {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Stable ID so the same city found via search or via map click maps to one
 * document. Region is included to tell apart e.g. Paris, FR vs Paris, Texas.
 */
export function cityId({ name, region, countryCode }) {
  return [slug(countryCode), slug(region), slug(name)].filter(Boolean).join('--').slice(0, 200);
}

function makeCity({ name, region, country, countryCode, lat, lng }) {
  const city = {
    name: name.trim(),
    region: (region || '').trim(),
    country: (country || '').trim(),
    countryCode: (countryCode || '').toLowerCase(),
    lat: Math.round(Number(lat) * 1e5) / 1e5,
    lng: Math.round(Number(lng) * 1e5) / 1e5,
  };
  city.id = cityId(city);
  return city;
}

export async function searchCities(text, signal) {
  const params = new URLSearchParams({ q: text, limit: '15', lang: 'en' });
  PLACE_TAGS.forEach((tag) => params.append('osm_tag', `place:${tag}`));

  const res = await fetch(`${PHOTON_URL}?${params}`, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = await res.json();

  const seen = new Set();
  const results = [];
  for (const f of data.features || []) {
    const p = f.properties || {};
    if (!p.name || !p.countrycode || !f.geometry?.coordinates) continue;
    const [lng, lat] = f.geometry.coordinates;
    const city = makeCity({
      name: p.name,
      region: p.state || p.county || '',
      country: p.country,
      countryCode: p.countrycode,
      lat,
      lng,
    });
    if (seen.has(city.id)) continue;
    seen.add(city.id);
    city.rank = PLACE_TAGS.indexOf(p.osm_value) * 3 + results.length;
    results.push(city);
  }
  // Bigger places first, so "barce" suggests Barcelona before tiny villages.
  return results.sort((a, b) => a.rank - b.rank).slice(0, 6);
}

export async function reverseCity(lat, lng, signal) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: String(lat),
    lon: String(lng),
    zoom: '10',
    addressdetails: '1',
    'accept-language': 'en',
  });
  const res = await fetch(`${NOMINATIM_REVERSE_URL}?${params}`, { signal });
  if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
  const data = await res.json();
  if (data.error || !data.address) return null;

  const a = data.address;
  const name = a.city || a.town || a.village || a.municipality || a.county || data.name;
  if (!name || !a.country_code) return null;

  return makeCity({
    name,
    region: a.state || a.province || a.region || (a.county !== name ? a.county : '') || '',
    country: a.country,
    countryCode: a.country_code,
    lat: data.lat ?? lat,
    lng: data.lon ?? lng,
  });
}

export function flagUrl(countryCode) {
  return countryCode ? `https://flagcdn.com/${countryCode.toLowerCase()}.svg` : '';
}
