'use strict';

/* =========================================================
   Glass Weather — script.js
   Data: WeatherAPI.com (search.json + forecast.json)
   ========================================================= */

/* ---------- Config ---------- */
// Keys are tried in order; if one is invalid/disabled/over-limit, the next is used.
const API_KEYS = [
  '787947350c4c4eb89c9183933262110',
  'edff3850dec44eadade184156262110'
];
const API_BASE = 'https://api.weatherapi.com/v1';
const DEFAULT_CITY = 'London';   // shown on first visit, change to any city
const MIN_QUERY_LENGTH = 2;      // start suggesting after 2 letters
const DEBOUNCE_MS = 300;         // wait for the user to pause typing
const HOT_C = 30;                // "hot" threshold (°C) -> big sun + heat haze
const WIND_MIN_KPH = 20;         // "windy" threshold -> blowing air streaks
const STORAGE_KEYS = { query: 'glassWeather.query', unit: 'glassWeather.unit' };
const AQI_LABELS = ['Good', 'Moderate', 'Unhealthy for some', 'Unhealthy', 'Very unhealthy', 'Hazardous'];
const KEY_ERROR_CODES = [1002, 2006, 2007, 2008, 2009];
const DEFAULT_PALETTE = ['#1e3c72', '#2a5298', '#6dd5ed'];

/* WeatherAPI condition codes grouped by type */
const CODES = {
  rain:    [1063, 1150, 1153, 1168, 1171, 1180, 1183, 1186, 1189, 1192, 1195, 1198, 1201, 1240, 1243, 1246, 1273, 1276],
  thunder: [1087, 1273, 1276, 1279, 1282],
  snow:    [1066, 1114, 1117, 1210, 1213, 1216, 1219, 1222, 1225, 1237, 1255, 1258, 1261, 1264, 1279, 1282],
  sleet:   [1069, 1072, 1204, 1207, 1249, 1252],
  fog:     [1030, 1135, 1147],
  clear:   [1000],
  partly:  [1003],
  cloudy:  [1006, 1009]
};

/* ---------- DOM references ---------- */
const $ = (id) => document.getElementById(id);

const els = {
  bg: $('bg'),
  canvas: $('fx'),
  heat: $('heatHaze'),
  fog: $('fogLayer'),
  form: $('searchForm'),
  input: $('cityInput'),
  clear: $('clearBtn'),
  locate: $('locBtn'),
  list: $('suggestions'),
  status: $('status'),
  weather: $('weather'),
  unitButtons: document.querySelectorAll('#unitToggle button'),
  city: $('heroCity'),
  region: $('heroRegion'),
  date: $('heroDate'),
  time: $('heroTime'),
  icon: $('heroIcon'),
  emoji: $('heroEmoji'),
  temp: $('heroTemp'),
  unitLabel: $('heroUnit'),
  condition: $('heroCondition'),
  feels: $('heroFeels'),
  high: $('heroHigh'),
  low: $('heroLow'),
  tags: $('heroTags'),
  tiles: $('detailsGrid'),
  hourly: $('hourlyList'),
  daily: $('dailyList'),
  updated: $('updated')
};

/* ---------- State ---------- */
const state = {
  unit: loadPref(STORAGE_KEYS.unit, 'c') === 'f' ? 'f' : 'c',
  data: null,
  lastQuery: null,
  suggestions: [],
  active: -1,
  searchCtl: null,
  weatherCtl: null,
  debounce: null
};

/* ---------- Small helpers ---------- */
function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
}

// Create an element safely (textContent, never innerHTML, so API text can't inject HTML)
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function deg(c, f) {
  return Math.round(state.unit === 'c' ? c : f) + '°';
}

function iconUrl(path, size) {
  const url = path.startsWith('//') ? 'https:' + path : path;
  return size ? url.replace('64x64', size + 'x' + size) : url;
}

// "2026-10-28 14:30" -> Date (wall-clock time of the searched city)
function parseLocal(str) {
  const parts = String(str).split(' ');
  const [y, m, d] = parts[0].split('-').map(Number);
  const [hh, mm] = (parts[1] || '0:0').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0);
}

/* ---------- API ---------- */
async function apiGet(endpoint, params, signal) {
  let lastError = new Error('Unable to reach the weather service.');

  for (const key of API_KEYS) {
    const url = `${API_BASE}/${endpoint}?` + new URLSearchParams(Object.assign({ key }, params));
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new Error('Network error. Please check your internet connection.');
    }

    let body = null;
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

    if (res.ok && body) return body;

    const code = body && body.error ? body.error.code : 0;
    const message = body && body.error ? body.error.message : `Request failed (${res.status})`;

    if (KEY_ERROR_CODES.includes(code)) {   // bad key / quota -> try the next key
      lastError = new Error('API key problem: ' + message);
      continue;
    }
    throw new Error(code === 1006 ? 'City not found. Please try another name.' : message);
  }
  throw lastError;
}

/* =========================================================
   Search + auto-suggestion
   ========================================================= */
function cancelSearch() {
  clearTimeout(state.debounce);
  if (state.searchCtl) state.searchCtl.abort();
  state.searchCtl = null;
}

function showList() {
  els.list.hidden = false;
  els.input.setAttribute('aria-expanded', 'true');
}

function hideList() {
  els.list.hidden = true;
  els.input.setAttribute('aria-expanded', 'false');
  els.input.removeAttribute('aria-activedescendant');
  state.active = -1;
}

function showListMessage(message) {
  els.list.replaceChildren(h('li', 'msg', message));
  state.suggestions = [];
  state.active = -1;
  showList();
}

function renderSuggestions() {
  if (!state.suggestions.length) {
    showListMessage('No cities found. Try a different spelling.');
    return;
  }
  const items = state.suggestions.map((s, i) => {
    const li = h('li', 'item');
    li.id = 'sug-' + i;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');

    const meta = h('span', 'meta');
    meta.append(h('strong', '', s.name), h('small', '', [s.region, s.country].filter(Boolean).join(', ')));
    li.append(h('span', 'pin', '📍'), meta);

    // mousedown (not click) so the input doesn't lose focus first
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectSuggestion(i);
    });
    return li;
  });
  els.list.replaceChildren(...items);
  state.active = -1;
  showList();
}

function setActive(index) {
  const items = els.list.querySelectorAll('li.item');
  items.forEach((li, i) => {
    li.classList.toggle('active', i === index);
    li.setAttribute('aria-selected', String(i === index));
  });
  state.active = index;
  if (items[index]) {
    items[index].scrollIntoView({ block: 'nearest' });
    els.input.setAttribute('aria-activedescendant', items[index].id);
  } else {
    els.input.removeAttribute('aria-activedescendant');
  }
}

async function fetchSuggestions(query) {
  if (state.searchCtl) state.searchCtl.abort();
  const ctl = new AbortController();
  state.searchCtl = ctl;
  showListMessage('Searching…');

  try {
    const results = await apiGet('search.json', { q: query }, ctl.signal);
    if (ctl.signal.aborted || state.searchCtl !== ctl) return;
    state.suggestions = Array.isArray(results) ? results.slice(0, 8) : [];
    renderSuggestions();
  } catch (err) {
    if (err.name === 'AbortError') return;
    showListMessage('Could not load suggestions.');
  }
}

function selectSuggestion(index) {
  const s = state.suggestions[index];
  if (!s) return;
  cancelSearch();
  els.input.value = [s.name, s.country].filter(Boolean).join(', ');
  els.clear.hidden = false;
  hideList();
  els.input.blur();
  loadWeather(`${s.lat},${s.lon}`);
}

els.input.addEventListener('input', () => {
  const query = els.input.value.trim();
  els.clear.hidden = !els.input.value;
  clearTimeout(state.debounce);

  if (query.length < MIN_QUERY_LENGTH) {
    cancelSearch();
    hideList();
    return;
  }
  state.debounce = setTimeout(() => fetchSuggestions(query), DEBOUNCE_MS);
});

els.input.addEventListener('keydown', (e) => {
  const count = state.suggestions.length;
  const open = !els.list.hidden && count > 0;

  if (e.key === 'ArrowDown' && open) {
    e.preventDefault();
    setActive((state.active + 1) % count);
  } else if (e.key === 'ArrowUp' && open) {
    e.preventDefault();
    setActive(state.active <= 0 ? count - 1 : state.active - 1);
  } else if (e.key === 'Escape') {
    hideList();
  }
});

els.input.addEventListener('focus', () => {
  if (els.input.value.trim().length >= MIN_QUERY_LENGTH && state.suggestions.length) {
    renderSuggestions();
  }
});

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.active >= 0 && state.suggestions[state.active]) {
    selectSuggestion(state.active);
    return;
  }
  const query = els.input.value.trim();
  if (!query) return;
  cancelSearch();
  hideList();
  els.input.blur();
  loadWeather(query);
});

els.clear.addEventListener('click', () => {
  els.input.value = '';
  els.clear.hidden = true;
  cancelSearch();
  hideList();
  state.suggestions = [];
  els.input.focus();
});

// Close the list when clicking elsewhere
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) hideList();
});

els.locate.addEventListener('click', () => {
  if (!navigator.geolocation) {
    showStatus('error', 'Geolocation is not supported on this device.');
    return;
  }
  els.locate.classList.add('busy');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      els.locate.classList.remove('busy');
      loadWeather(`${pos.coords.latitude.toFixed(4)},${pos.coords.longitude.toFixed(4)}`);
    },
    () => {
      els.locate.classList.remove('busy');
      showStatus('error', 'Could not get your location. Allow location access or search for a city.');
    },
    { timeout: 10000, maximumAge: 300000 }
  );
});

els.unitButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.unit = btn.dataset.unit === 'f' ? 'f' : 'c';
    savePref(STORAGE_KEYS.unit, state.unit);
    syncUnitButtons();
    if (state.data) render();
  });
});

function syncUnitButtons() {
  els.unitButtons.forEach((btn) => {
    const on = btn.dataset.unit === state.unit;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

/* =========================================================
   Status + loading
   ========================================================= */
function showStatus(type, message, retry) {
  els.status.hidden = false;
  els.status.className = 'status glass ' + type;
  els.status.replaceChildren();
  if (type === 'loading') els.status.append(h('span', 'spinner'));
  els.status.append(h('span', 'status-msg', message));
  if (type === 'error' && retry) {
    const btn = h('button', 'retry-btn', 'Try again');
    btn.type = 'button';
    btn.addEventListener('click', retry);
    els.status.append(btn);
  }
}

function hideStatus() {
  els.status.hidden = true;
  els.status.replaceChildren();
}

function setLoading(on) {
  document.body.classList.toggle('loading', on);
  if (on && !state.data) showStatus('loading', 'Fetching live weather…');
}

/* =========================================================
   Load weather
   ========================================================= */
async function loadWeather(query) {
  if (state.weatherCtl) state.weatherCtl.abort();
  const ctl = new AbortController();
  state.weatherCtl = ctl;
  state.lastQuery = query;
  setLoading(true);

  try {
    const data = await apiGet('forecast.json', { q: query, days: 3, aqi: 'yes', alerts: 'no' }, ctl.signal);
    if (ctl.signal.aborted) return;

    state.data = data;
    savePref(STORAGE_KEYS.query, `${data.location.lat},${data.location.lon}`);
    hideStatus();
    els.weather.hidden = false;
    render();
    applyEnvironment();

    if (!els.input.value) {
      els.input.value = [data.location.name, data.location.country].filter(Boolean).join(', ');
      els.clear.hidden = false;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    showStatus('error', err.message || 'Something went wrong.', () => loadWeather(state.lastQuery));
  } finally {
    if (state.weatherCtl === ctl) setLoading(false);
  }
}

/* =========================================================
   Weather logic (type of weather, tags, palette)
   ========================================================= */
function classify(code) {
  const has = (k) => CODES[k].includes(code);
  const thunder = has('thunder');
  return {
    thunder,
    rain: has('rain') || has('sleet') || thunder,
    snow: has('snow') || has('sleet'),
    fog: has('fog'),
    clear: has('clear'),
    partly: has('partly'),
    cloudy: has('cloudy')
  };
}

function precipLevel(cur) {
  const text = cur.condition.text.toLowerCase();
  if (/heavy|torrential|violent/.test(text)) return 3;
  if (/moderate/.test(text)) return 2;
  if (/light|patchy|drizzle/.test(text)) return 1;
  if (cur.precip_mm >= 4) return 3;
  if (cur.precip_mm >= 1) return 2;
  return 2;
}

function emojiFor(kind, isDay) {
  if (kind.thunder) return '⛈️';
  if (kind.snow && kind.rain) return '🌨️';
  if (kind.snow) return '❄️';
  if (kind.rain) return '🌧️';
  if (kind.fog) return '🌫️';
  if (kind.cloudy) return '☁️';
  if (kind.partly) return isDay ? '⛅' : '☁️';
  return isDay ? '☀️' : '🌙';
}

function buildTags(cur, kind) {
  const tags = [cur.is_day ? ['🌞', 'Daytime'] : ['🌙', 'Night']];
  const t = cur.temp_c;
  if (t >= 38) tags.push(['🔥', 'Scorching']);
  else if (t >= HOT_C) tags.push(['☀️', 'Hot']);
  else if (t <= 0) tags.push(['🧊', 'Freezing']);
  else if (t <= 10) tags.push(['🥶', 'Cold']);
  if (kind.thunder) tags.push(['⚡', 'Stormy']);
  else if (kind.snow) tags.push(['❄️', 'Snowy']);
  else if (kind.rain) tags.push(['🌧️', 'Rainy']);
  if (kind.fog) tags.push(['🌫️', 'Foggy']);
  if (cur.wind_kph >= WIND_MIN_KPH) tags.push(['💨', 'Windy']);
  return tags;
}

// Background colors depend on temperature, condition and day/night
function pickPalette(tempC, isDay, kind) {
  if (kind.thunder) return isDay ? ['#2b3a4f', '#3e526b', '#5f7690'] : ['#070b14', '#141c2b', '#243247'];
  if (kind.snow)    return isDay ? ['#5b7c9d', '#86a5c4', '#b9d0e6'] : ['#10192b', '#25344f', '#44597a'];
  if (kind.rain)    return isDay ? ['#3a4f66', '#566f8a', '#7d95ad'] : ['#0a111d', '#18253a', '#2c3e57'];
  if (kind.fog)     return isDay ? ['#6c7b8b', '#8d9aa8', '#b4bec8'] : ['#1a212b', '#2e3946', '#4a5766'];
  if (kind.cloudy)  return isDay ? ['#52677f', '#7a8fa6', '#a7b8c9'] : ['#0e1522', '#1e2b3e', '#35465c'];

  if (isDay) {
    if (tempC >= 38) return ['#b71c1c', '#ef6c00', '#ffb300'];
    if (tempC >= HOT_C) return ['#d84315', '#f57c00', '#fbc02d'];
    if (tempC >= 22) return ['#1976d2', '#29a3d9', '#f6b44d'];
    if (tempC >= 12) return ['#1565c0', '#42a5f5', '#90caf9'];
    if (tempC >= 0)  return ['#2f5d8a', '#5b93c4', '#a5cbe8'];
    return ['#355c7d', '#6c8fb3', '#b6d0e6'];
  }
  if (tempC >= 28) return ['#2b1055', '#5b2a6e', '#b24a5a'];
  if (tempC >= 15) return ['#0b1030', '#1f2a63', '#47379b'];
  if (tempC >= 5)  return ['#0a1128', '#16254d', '#2e4a7d'];
  return ['#070d1c', '#13233f', '#2a4a6e'];
}

function setPalette(palette) {
  els.bg.style.setProperty('--c1', palette[0]);
  els.bg.style.setProperty('--c2', palette[1]);
  els.bg.style.setProperty('--c3', palette[2]);
}

/* Applies background colors + canvas effects for the current weather */
function applyEnvironment() {
  const cur = state.data.current;
  const kind = classify(cur.condition.code);
  const isDay = cur.is_day === 1;
  const windy = cur.wind_kph >= WIND_MIN_KPH;
  const sunVisible = isDay && (kind.clear || kind.partly);
  const hot = sunVisible && cur.temp_c >= HOT_C;
  const level = precipLevel(cur);

  setPalette(pickPalette(cur.temp_c, isDay, kind));
  document.body.classList.toggle('is-night', !isDay);
  els.heat.classList.toggle('on', hot);
  els.fog.classList.toggle('on', kind.fog);

  FX.configure({
    rain: kind.rain ? level : 0,
    snow: kind.snow ? level : 0,
    wind: windy ? Math.min(cur.wind_kph, 80) : 0,
    windKph: cur.wind_kph,
    sun: sunVisible ? (hot ? 2 : 1) : 0,
    moon: !isDay && (kind.clear || kind.partly),
    stars: !isDay && !kind.rain && !kind.snow && !kind.cloudy && !kind.fog,
    clouds: kind.cloudy ? 6 : (kind.rain || kind.snow || kind.fog) ? 5 : kind.partly ? 3 : kind.clear ? 1 : 0,
    darkClouds: kind.rain || kind.thunder,
    lightning: kind.thunder
  });
}

/* =========================================================
   Render the UI
   ========================================================= */
function tile(icon, label, value, sub) {
  const box = h('div', 'tile');
  box.append(h('span', 'tile-icon', icon), h('span', 'tile-label', label), h('strong', 'tile-value', value));
  if (sub) box.append(h('span', 'tile-sub', sub));
  return box;
}

function humidityLabel(v) {
  if (v < 30) return 'Dry';
  if (v <= 60) return 'Comfortable';
  if (v <= 80) return 'Humid';
  return 'Very humid';
}

function uvLabel(v) {
  if (v < 3) return 'Low';
  if (v < 6) return 'Moderate';
  if (v < 8) return 'High';
  if (v < 11) return 'Very high';
  return 'Extreme';
}

function render() {
  const { location: loc, current: cur, forecast } = state.data;
  const days = forecast.forecastday;
  const today = days[0];
  const metric = state.unit === 'c';
  const kind = classify(cur.condition.code);
  const isDay = cur.is_day === 1;
  const when = parseLocal(loc.localtime);

  /* Hero */
  els.city.textContent = loc.name;
  els.region.textContent = [loc.region, loc.country].filter(Boolean).join(', ');
  els.date.textContent = when.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  els.time.textContent = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  els.temp.textContent = deg(cur.temp_c, cur.temp_f);
  els.unitLabel.textContent = metric ? 'C' : 'F';
  els.condition.textContent = cur.condition.text;
  els.feels.textContent = 'Feels like ' + deg(cur.feelslike_c, cur.feelslike_f);
  els.high.textContent = deg(today.day.maxtemp_c, today.day.maxtemp_f);
  els.low.textContent = deg(today.day.mintemp_c, today.day.mintemp_f);

  // Icon from the API with an emoji fallback
  els.emoji.textContent = emojiFor(kind, isDay);
  els.emoji.hidden = true;
  els.icon.hidden = false;
  els.icon.alt = cur.condition.text;
  els.icon.src = iconUrl(cur.condition.icon, 128);

  els.tags.replaceChildren(...buildTags(cur, kind).map(([icon, label]) => h('span', 'chip', icon + ' ' + label)));

  /* Detail tiles */
  const aqi = cur.air_quality && cur.air_quality['us-epa-index'];
  const wind = tile(
    '💨', 'Wind',
    metric ? Math.round(cur.wind_kph) + ' km/h' : Math.round(cur.wind_mph) + ' mph',
    cur.wind_dir + ' · gusts ' + (metric ? Math.round(cur.gust_kph) + ' km/h' : Math.round(cur.gust_mph) + ' mph')
  );
  const arrow = h('span', 'wind-arrow', '➤');
  arrow.style.transform = `rotate(${(cur.wind_degree || 0) + 90}deg)`; // points where the wind blows to
  wind.querySelector('.tile-sub').prepend(arrow);

  els.tiles.replaceChildren(
    tile('💧', 'Humidity', cur.humidity + '%', humidityLabel(cur.humidity)),
    wind,
    tile('🌡️', 'Pressure', metric ? Math.round(cur.pressure_mb) + ' hPa' : cur.pressure_in.toFixed(2) + ' inHg'),
    tile('👁️', 'Visibility', metric ? cur.vis_km + ' km' : cur.vis_miles + ' mi'),
    tile('🔆', 'UV index', String(cur.uv), uvLabel(cur.uv)),
    tile('☁️', 'Cloud cover', cur.cloud + '%'),
    tile('🌧️', 'Precipitation', metric ? cur.precip_mm + ' mm' : cur.precip_in + ' in', today.day.daily_chance_of_rain + '% chance today'),
    tile('🍃', 'Air quality', aqi ? AQI_LABELS[aqi - 1] || 'N/A' : 'N/A'),
    tile('🌅', 'Sunrise', today.astro.sunrise),
    tile('🌇', 'Sunset', today.astro.sunset)
  );

  /* Hourly (next 24h from the city's current hour) */
  const startHour = new Date(when);
  startHour.setMinutes(0, 0, 0);
  const hours = days
    .flatMap((d) => d.hour)
    .filter((hr) => parseLocal(hr.time) >= startHour)
    .slice(0, 24);

  els.hourly.replaceChildren(...hours.map((hr, i) => {
    const item = h('div', 'hour' + (i === 0 ? ' now' : ''));
    const img = new Image();
    img.src = iconUrl(hr.condition.icon);
    img.alt = hr.condition.text;
    img.loading = 'lazy';
    item.append(
      h('span', 'h-time', i === 0 ? 'Now' : parseLocal(hr.time).toLocaleTimeString('en-US', { hour: 'numeric' })),
      img,
      h('span', 'h-temp', deg(hr.temp_c, hr.temp_f)),
      h('span', 'h-rain', '💧 ' + hr.chance_of_rain + '%')
    );
    return item;
  }));

  /* 3-day forecast */
  const lows = days.map((d) => d.day.mintemp_c);
  const highs = days.map((d) => d.day.maxtemp_c);
  const minAll = Math.min(...lows);
  const maxAll = Math.max(...highs);
  const span = maxAll - minAll || 1;

  els.daily.replaceChildren(...days.map((d, i) => {
    const row = h('div', 'day');
    const [y, m, dd] = d.date.split('-').map(Number);
    const label = i === 0 ? 'Today' : new Date(y, m - 1, dd).toLocaleDateString('en-US', { weekday: 'short' });

    const img = new Image();
    img.src = iconUrl(d.day.condition.icon);
    img.alt = d.day.condition.text;
    img.loading = 'lazy';

    const range = h('span', 'range');
    const bar = document.createElement('i');
    bar.style.left = ((d.day.mintemp_c - minAll) / span) * 100 + '%';
    bar.style.width = Math.max(((d.day.maxtemp_c - d.day.mintemp_c) / span) * 100, 8) + '%';
    range.append(bar);

    const rangeWrap = h('div', 'day-range');
    rangeWrap.append(h('span', 'lo', deg(d.day.mintemp_c, d.day.mintemp_f)), range, h('span', 'hi', deg(d.day.maxtemp_c, d.day.maxtemp_f)));

    row.append(
      h('span', 'day-name', label),
      img,
      h('span', 'day-cond', d.day.condition.text),
      h('span', 'day-rain', '💧 ' + d.day.daily_chance_of_rain + '%'),
      rangeWrap
    );
    return row;
  }));

  els.updated.textContent = '· Updated ' + cur.last_updated + ' (local time)';
  document.title = `${loc.name} ${deg(cur.temp_c, cur.temp_f)} · Glass Weather`;
}

// If the API icon fails to load, show an emoji instead
els.icon.addEventListener('error', () => {
  els.icon.hidden = true;
  els.emoji.hidden = false;
});

/* =========================================================
   FX — canvas weather effects
   (sun, moon, stars, clouds, rain, snow, wind streaks, lightning)
   ========================================================= */
const FX = (() => {
  const ctx = els.canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DEFAULT_CFG = {
    rain: 0, snow: 0, wind: 0, windKph: 0, sun: 0,
    moon: false, stars: false, clouds: 0, darkClouds: false, lightning: false
  };
  const PUFFS = [[0, 0, 62], [58, -16, 52], [112, 0, 60], [42, 14, 50], [88, 12, 54]];

  let cfg = Object.assign({}, DEFAULT_CFG);
  let W = 0, H = 0, dpr = 1;
  let rain = [], snow = [], streaks = [], stars = [], clouds = [];
  let flash = 0, bolt = null, echo = false, nextBolt = 0;
  let running = false, rafId = 0, last = 0;

  const rand = (a, b) => a + Math.random() * (b - a);
  const areaScale = () => Math.max(0.45, Math.min(1, (W * H) / (1280 * 720)));
  const windX = () => Math.min(cfg.windKph / 40, 1.5) * 6;

  /* --- particle factories --- */
  function makeDrop(init) {
    return { x: rand(-W * 0.2, W * 1.2), y: init ? rand(0, H) : rand(-80, -10), len: rand(12, 24), vy: rand(15, 24) + cfg.rain * 1.5 };
  }
  function makeFlake(init) {
    return { x: rand(0, W), y: init ? rand(0, H) : -10, r: rand(1, 3.4), vy: rand(0.6, 1.7), sw: rand(0, 6.28), ss: rand(0.01, 0.03) };
  }
  function makeStreak(init) {
    const len = rand(90, 260);
    return {
      x: init ? rand(-len, W) : -len - rand(0, 200), y: rand(0, H), len,
      vx: rand(6, 12) * (0.6 + cfg.wind / 40), amp: rand(4, 18), ph: rand(0, 6.28),
      a: rand(0.14, 0.38), w: rand(0.8, 1.8)
    };
  }
  function makeStar() {
    return { x: rand(0, W), y: rand(0, H * 0.8), r: rand(0.4, 1.6), ph: rand(0, 6.28), sp: rand(0.0008, 0.0025) };
  }
  function makeCloud(init) {
    return {
      x: init ? rand(-200, W) : -350, y: rand(H * 0.02, H * 0.42), s: rand(0.8, 1.8),
      vx: rand(0.08, 0.3) * (1 + cfg.windKph / 50), a: rand(0.14, 0.28) * (cfg.darkClouds ? 1.5 : 1)
    };
  }
  function makeBolt() {
    const pts = [];
    let x = rand(W * 0.2, W * 0.8);
    let y = 0;
    const end = H * rand(0.4, 0.65);
    pts.push([x, y]);
    while (y < end) {
      x += rand(-32, 32);
      y += rand(20, 44);
      pts.push([x, y]);
    }
    return pts;
  }

  function build() {
    const s = areaScale() * (reduceMotion ? 0.4 : 1);
    rain = Array.from({ length: Math.round([0, 90, 170, 280][cfg.rain] * s) }, () => makeDrop(true));
    snow = Array.from({ length: Math.round([0, 50, 90, 140][cfg.snow] * s) }, () => makeFlake(true));
    streaks = Array.from({ length: cfg.wind ? Math.round((8 + cfg.wind * 0.45) * s) : 0 }, () => makeStreak(true));
    stars = Array.from({ length: cfg.stars ? Math.round(120 * s) : 0 }, () => makeStar());
    clouds = Array.from({ length: cfg.clouds }, () => makeCloud(true));
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    els.canvas.width = Math.round(W * dpr);
    els.canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
  }

  /* --- drawing --- */
  function drawStars(t) {
    if (!stars.length) return;
    ctx.fillStyle = '#fff';
    for (const s of stars) {
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * s.sp + s.ph));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, 6.283);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawSun(t) {
    if (!cfg.sun) return;
    const hot = cfg.sun === 2;
    const cx = W < 640 ? W * 0.78 : W * 0.82;
    const cy = Math.min(H * 0.17, 170);
    const R = Math.min(W, H) * (hot ? 0.62 : 0.42) * (1 + 0.03 * Math.sin(t / 800));

    // rotating rays
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.00004);
    const rayGrad = ctx.createLinearGradient(0, 0, R * 1.3, 0);
    rayGrad.addColorStop(0, `rgba(255,236,160,${hot ? 0.26 : 0.16})`);
    rayGrad.addColorStop(1, 'rgba(255,236,160,0)');
    ctx.fillStyle = rayGrad;
    const rays = 16;
    for (let i = 0; i < rays; i++) {
      ctx.rotate((Math.PI * 2) / rays);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(R * 1.3, -R * 0.05);
      ctx.lineTo(R * 1.3, R * 0.05);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // glow
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    glow.addColorStop(0, 'rgba(255,248,214,0.95)');
    glow.addColorStop(0.12, 'rgba(255,220,120,0.6)');
    glow.addColorStop(0.45, 'rgba(255,180,70,0.18)');
    glow.addColorStop(1, 'rgba(255,160,40,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 6.283);
    ctx.fill();
    ctx.restore();

    // core
    ctx.save();
    ctx.shadowColor = 'rgba(255,220,120,0.9)';
    ctx.shadowBlur = 40;
    ctx.fillStyle = 'rgba(255,252,230,0.96)';
    ctx.beginPath();
    ctx.arc(cx, cy, hot ? 44 : 34, 0, 6.283);
    ctx.fill();
    ctx.restore();
  }

  function drawMoon() {
    if (!cfg.moon) return;
    const cx = W < 640 ? W * 0.78 : W * 0.82;
    const cy = Math.min(H * 0.17, 170);
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 170);
    glow.addColorStop(0, 'rgba(220,232,255,0.4)');
    glow.addColorStop(1, 'rgba(220,232,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, 170, 0, 6.283);
    ctx.fill();

    ctx.save();
    ctx.shadowColor = 'rgba(230,240,255,0.8)';
    ctx.shadowBlur = 30;
    ctx.fillStyle = '#f5f3e7';
    ctx.beginPath();
    ctx.arc(cx, cy, 30, 0, 6.283);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = 'rgba(170,170,160,0.35)';
    [[-9, -7, 6], [8, 6, 8], [-4, 12, 4]].forEach(([dx, dy, r]) => {
      ctx.beginPath();
      ctx.arc(cx + dx, cy + dy, r, 0, 6.283);
      ctx.fill();
    });
  }

  function drawClouds(k) {
    if (!clouds.length) return;
    const rgb = cfg.darkClouds ? '60,72,92' : '255,255,255';
    for (const c of clouds) {
      c.x += c.vx * k;
      if (c.x > W + 250) Object.assign(c, makeCloud(false));
      for (const [px, py, pr] of PUFFS) {
        const gx = c.x + px * c.s;
        const gy = c.y + py * c.s;
        const r = pr * c.s;
        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
        g.addColorStop(0, `rgba(${rgb},${c.a})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(gx, gy, r, 0, 6.283);
        ctx.fill();
      }
    }
  }

  function drawStreaks(k) {
    if (!streaks.length) return;
    ctx.lineCap = 'round';
    for (const s of streaks) {
      s.x += s.vx * k;
      s.ph += 0.02 * k;
      if (s.x > W + 40) Object.assign(s, makeStreak(false));
      const wob = s.amp * Math.sin(s.ph);
      const g = ctx.createLinearGradient(s.x, 0, s.x + s.len, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, `rgba(255,255,255,${s.a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.bezierCurveTo(s.x + s.len * 0.3, s.y - wob, s.x + s.len * 0.6, s.y + wob, s.x + s.len, s.y);
      ctx.stroke();
    }
  }

  function drawRain(k) {
    if (!rain.length) return;
    const wx = windX();
    ctx.strokeStyle = 'rgba(200,225,255,0.5)';
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const d of rain) {
      d.x += wx * k;
      d.y += d.vy * k;
      if (d.y > H + 30 || d.x > W + 80) Object.assign(d, makeDrop(false));
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - wx * (d.len / d.vy), d.y - d.len);
    }
    ctx.stroke();
  }

  function drawSnow(k) {
    if (!snow.length) return;
    const wx = windX();
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.beginPath();
    for (const f of snow) {
      f.sw += f.ss * k;
      f.x += (Math.sin(f.sw) * 0.6 + wx * 0.8) * k;
      f.y += f.vy * k;
      if (f.y > H + 10) Object.assign(f, makeFlake(false));
      if (f.x > W + 10) f.x = -10;
      if (f.x < -10) f.x = W + 10;
      ctx.moveTo(f.x + f.r, f.y);
      ctx.arc(f.x, f.y, f.r, 0, 6.283);
    }
    ctx.fill();
  }

  function drawLightning(t, k) {
    if (!cfg.lightning) return;
    if (t > nextBolt) {
      flash = 1;
      bolt = makeBolt();
      echo = Math.random() < 0.5;
      nextBolt = t + rand(2500, 7500);
    }
    if (flash > 0.01) {
      ctx.fillStyle = `rgba(210,225,255,${flash * 0.22})`;
      ctx.fillRect(0, 0, W, H);
      if (bolt) {
        ctx.save();
        ctx.strokeStyle = `rgba(255,255,255,${flash})`;
        ctx.lineWidth = 2.2;
        ctx.lineJoin = 'round';
        ctx.shadowColor = '#9ec5ff';
        ctx.shadowBlur = 18;
        ctx.beginPath();
        bolt.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
        ctx.restore();
      }
      flash *= Math.pow(0.9, k);
      if (echo && flash < 0.3) { flash = 0.85; echo = false; }
    } else {
      bolt = null;
    }
  }

  /* --- loop --- */
  function frame(now) {
    if (!running) return;
    const dt = Math.min(now - last, 50);
    last = now;
    const k = dt / 16.67;

    ctx.clearRect(0, 0, W, H);
    drawStars(now);
    drawSun(now);
    drawMoon();
    drawClouds(k);
    drawStreaks(k);
    drawRain(k);
    drawSnow(k);
    drawLightning(now, k);

    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  function configure(next) {
    cfg = Object.assign({}, DEFAULT_CFG, next);
    flash = 0;
    bolt = null;
    nextBolt = performance.now() + 1500;
    build();
    start();
  }

  function init() {
    resize();
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    });
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  }

  return { init, configure };
})();

/* =========================================================
   Init
   ========================================================= */
function init() {
  syncUnitButtons();
  setPalette(DEFAULT_PALETTE);
  FX.init();
  loadWeather(loadPref(STORAGE_KEYS.query, DEFAULT_CITY));
}

init();