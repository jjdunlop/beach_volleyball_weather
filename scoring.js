// Shared settings, scoring and data parsing for the page (index.html) and the alert script (scripts/alert.js).
// Plain script: in the browser its top-level names are globals; in Node it is required as a module.

// ---------- Settings: tune these after a few weekends ----------
const LAT = -37.8455, LON = 144.9475;          // South Melbourne Beach
const TZ = "Australia/Melbourne";
const BEACH_FACES = 209;                        // shoreline runs 299°/119° (WNW–ESE), so the beach faces 209° (SSW); wind FROM here is onshore
const BLOCKS = [                                // dow: 5 = Fri, 6 = Sat, 0 = Sun. Hours are local, end exclusive.
  { name: "Fri night",  dow: 5, start: 17, end: 20 },
  { name: "Sat midday", dow: 6, start: 11, end: 14 },
  { name: "Sat arvo",   dow: 6, start: 14, end: 18 },
  { name: "Sun midday", dow: 0, start: 11, end: 14 },
  { name: "Sun arvo",   dow: 0, start: 14, end: 18 },
];
const TIERS = [                                 // first match wins
  { min: 8.5, key: "epic",   label: "Epic" },
  { min: 7,   key: "go",     label: "Solid" },
  { min: 5,   key: "decent", label: "Decent" },
  { min: 3,   key: "meh",    label: "Meh" },
  { min: 0,   key: "skip",   label: "Crap" },
];
const tierOf = r => TIERS.find(t => r >= t.min);

// ---------- Scoring ----------
// How much the wind comes off the bay (onshore, 1 = dead on) or off the land/city (offshore, 1 = dead off).
function exposure(fromDeg) {
  const c = Math.cos(((fromDeg - BEACH_FACES) * Math.PI) / 180);
  return { on: Math.max(0, c), off: Math.max(0, -c) };
}
// Local shelter at the courts, on top of the bay/land blend (which already makes bay winds stronger than city winds).
// Offshore wind is in the lee of the buildings and trees along Beaconsfield Parade: 15% off in light wind, fading to
// 5% by 25 km/h as the wake gets turbulent. Onshore wind arrives straight off the water: no change.
function dirFactor(fromDeg, speed = 0) {
  return 1 - curve(speed, [[8, 0.15], [25, 0.05]]) * exposure(fromDeg).off;
}
// Typical 3 s gust ÷ average for the exposure (WMO: onshore at a coast 1.38, offshore 1.52; ~1.6 behind a city).
const exposureGustFactor = fromDeg => 1.38 + 0.22 * exposure(fromDeg).off;
function curve(x, pts) {                        // linear interpolation through [x, y] points, flat beyond the ends
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}
// Recency-weighted rain over the previous 12 hours (mm): rain 1h ago counts fully, 12h ago barely.
// getP(k) returns the precipitation stamped at index k (the total for the hour ending at k).
function wetness(getP, i) {
  let w = 0;
  for (let k = 1; k <= 12 && i - k >= 0; k++) w += (getP(i - k) ?? 0) * (1 - (k - 1) / 12);
  return w;
}

// ECMWF over-forecasts 10 m gusts by about 1.5 m/s on average (SMHI verification), so model gusts are reduced by this.
const GUST_BIAS = 5;                            // km/h
// Gustiness: how far gusts rise above the average wind. Players can adjust to steady wind; sudden changes they can't.
// Uses the model's gust, but never less than what the exposure typically produces: the 25 km model grid can't see
// the turbulence in the city's wake, so offshore winds get their realistic gustiness even when the model's looks tame.
const gustExcess = h => Math.max(0, (h.gust ?? h.wind * 1.4) - h.wind, h.wind * (exposureGustFactor(h.dir ?? BEACH_FACES) - 1));
// ---------- Rating factors (each one is plotted on the page) ----------
// Effective wind (km/h, after direction) → base rating 0–10. Glassy = 10; still rewards calm below 12.
const windRating = eff => curve(eff, [[5, 10], [12, 7.5], [25, 2], [32, 0]]);
// Gusts above the average wind (km/h) → points off. The gust is the hour's single strongest ~3 s puff and most of the
// hour sits near the average, so gustiness costs only a little unless it's extreme.
const gustPenalty = excess => curve(excess, [[8, 0], [15, 0.5], [25, 1.5], [35, 3]]);
// Feels-like temperature (°C) → multiplier. Includes sun, wind and humidity. 18–32°C no penalty.
const tempFactor = feels => curve(feels, [[10, 0.3], [18, 1], [32, 1], [35, 0.75], [40, 0.3]]);
// Rain this hour (mm) → multiplier. A few drops are fine; steady rain isn't.
const rainFactor = mm => curve(mm, [[0.2, 1], [0.5, 0.85], [1, 0.6], [3, 0.3]]);
// UV index → multiplier. Minor: getting burnt makes a session less pleasant, but high UV is normal on good summer days.
const uvFactor = uv => curve(uv, [[6, 1], [8, 0.97], [11, 0.92], [14, 0.85]]);
// Recency-weighted rain over the previous 12 hours (mm) → multiplier, for soggy, heavy sand.
const wetFactor = mm => curve(mm, [[2, 1], [5, 0.8], [10, 0.55]]);

// Rating from wind alone, for steady wind with the exposure's typical gusts (what the polar plot shows).
const windOnlyRating = (speed, fromDeg) => Math.max(0, windRating(speed * dirFactor(fromDeg, speed)) - gustPenalty(speed * (exposureGustFactor(fromDeg) - 1)));

// 0–10 "worth going" rating for one hour.
function hourScore(h) {
  const base = windRating(h.wind * dirFactor(h.dir, h.wind)) - gustPenalty(gustExcess(h));
  const mult = tempFactor(h.feels ?? h.temp) * rainFactor(h.rain) * wetFactor(h.wetness ?? 0) * uvFactor(h.uv ?? 0);
  return Math.max(0, Math.min(10, base * mult));
}

// ---------- Helpers ----------
const dowOf = d => new Date(d + "T12:00:00Z").getUTCDay();
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const pctile = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const compass = d => COMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
function circMean(degs) {
  let x = 0, y = 0; for (const d of degs) { x += Math.cos(d * Math.PI / 180); y += Math.sin(d * Math.PI / 180); }
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function nowMelb() {                             // "YYYY-MM-DDTHH" in Melbourne time
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}`;
}
const todayMelb = () => nowMelb().slice(0, 10);
const fmtDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const hr = h => (h % 12 || 12) + (h % 24 < 12 ? "am" : "pm");
const hrsOf = s => { const [h, m] = s.slice(11, 16).split(":").map(Number); return h + m / 60; };
const hm = x => { const h = Math.floor(x), m = Math.round((x - h) * 60); return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`; };

// ---------- Daylight ----------
function utcOffset(day) {                        // Melbourne's UTC offset in hours on that date (10 or 11)
  const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
    .formatToParts(new Date(day + "T02:00:00Z")).find(p => p.type === "timeZoneName").value;
  const m = s.match(/GMT([+-]\d+)(?::(\d+))?/);
  return m ? +m[1] + (m[2] ? Math.sign(+m[1]) * m[2] / 60 : 0) : 10;
}
const sunCache = {};
function sunTimes(day) {                         // [sunrise, sunset] in local hours (NOAA approximation, ±2 min)
  if (sunCache[day]) return sunCache[day];
  const d = new Date(day + "T12:00:00Z"), n = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  const g = 2 * Math.PI / 365 * (n - 1), rad = Math.PI / 180;
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = Math.acos(Math.cos(90.833 * rad) / (Math.cos(LAT * rad) * Math.cos(dec)) - Math.tan(LAT * rad) * Math.tan(dec)) / rad;
  const off = utcOffset(day);
  return sunCache[day] = [(720 - 4 * (LON + ha) - eq) / 60 + off, (720 - 4 * (LON - ha) - eq) / 60 + off];
}
// An hour is playable if its midpoint is after sunrise and no later than 15 min after sunset.
function playable(day, h) { const [rise, set] = sunTimes(day); return h + 0.5 >= rise && h + 0.5 <= set + 0.25; }

// ---------- Data ----------
const VARS = ["temperature_2m", "apparent_temperature", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "precipitation"];

// The model grid is ~25 km, and the beach sits between two grid cells: one over the bay (38.0°S 145.0°E) and one
// over the inner suburbs (37.75°S 145.0°E). Bay winds are often 2–3× stronger than land winds. So both cells are
// fetched and blended by wind direction: wind off the bay takes the bay cell, wind off the city takes the land cell,
// side-on takes a mix. (Open-Meteo's default picks the land cell, which badly understated sea breezes.)
async function fetchCell(base, params, cell) {
  const r = await fetch(base + "?" + new URLSearchParams({ ...params, cell_selection: cell }));
  if (!r.ok) throw new Error("Forecast service returned " + r.status);
  return r.json();
}
async function fetchBlended(base, params) {
  const [sea, land] = await Promise.all([fetchCell(base, params, "sea"), fetchCell(base, params, "land")]);
  return blendCells(sea, land);
}
// Weight of the bay cell for a wind direction: 1 straight off the bay, 0 straight off the city, 0.5 side-on.
const seaWeight = dir => 0.5 + 0.5 * Math.cos(((dir - BEACH_FACES) * Math.PI) / 180);
// Temperature needs a lighter touch. The bay cell's air sits over ~15°C water mid-bay (spring afternoons often read
// 5°C+ cooler than land), while air reaching the beach on a sea breeze has warmed over the shallows and the sand sits in
// full sun. So for temperatures the bay cell counts at most half, even with the wind dead onshore.
const SEA_WEIGHT_CAP = { temperature_2m: 0.5, apparent_temperature: 0.5 };
function blendCells(sea, land) {
  const S = sea.hourly, L = land.hourly, out = { time: S.time };
  for (const key of Object.keys(S)) {
    if (key === "time") continue;
    const v = VARS.find(v => key === v || key.startsWith(v + "_"));
    const dirKey = v ? "wind_direction_10m" + key.slice(v.length) : null;
    if (!v || v === "wind_direction_10m" || !L[key] || !S[dirKey]) { out[key] = S[key]; continue; }
    out[key] = S[key].map((x, i) => {
      const y = L[key][i], d = S[dirKey][i];
      if (x == null || y == null || d == null) return x ?? y ?? null;
      const w = Math.min(seaWeight(d), SEA_WEIGHT_CAP[v] ?? 1);
      return w * x + (1 - w) * y;
    });
  }
  return { ...sea, hourly: out, blended: true };
}
function fetchEnsemble() {
  return fetchBlended("https://ensemble-api.open-meteo.com/v1/ensemble", {
    latitude: LAT, longitude: LON, hourly: VARS.join(","), models: "ecmwf_ifs025",
    forecast_days: 15, timezone: TZ, wind_speed_unit: "kmh",
  });
}
// UV index by local hour ("YYYY-MM-DDTHH:00" → value) from the regular forecast API. Shown, not scored.
// Optional: on any failure it returns {} and the rest of the forecast still works.
async function fetchUV() {
  try {
    const r = await fetch("https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
      latitude: LAT, longitude: LON, hourly: "uv_index", forecast_days: 16, timezone: TZ }));
    if (!r.ok) return {};
    const j = await r.json(), out = {};
    j.hourly.time.forEach((t, i) => { if (j.hourly.uv_index[i] != null) out[t] = j.hourly.uv_index[i]; });
    return out;
  } catch { return {}; }
}
// Australian UV categories (BOM / Cancer Council). Sun protection is recommended from 3.
function uvLabel(u) { return u == null ? "" : u < 3 ? "Low" : u < 6 ? "Moderate" : u < 8 ? "High" : u < 11 ? "Very high" : "Extreme"; }

// Split Open-Meteo's flat keys ("wind_speed_10m", "wind_speed_10m_member01", …) into members.
function toMembers(json) {
  const H = json.hourly, members = {};
  for (const key of Object.keys(H)) {
    const v = VARS.find(v => key === v || key.startsWith(v + "_member"));
    if (!v) continue;
    const m = key === v ? "00" : key.slice(v.length + 7);
    (members[m] ??= {})[v] = H[key];
  }
  return { time: H.time, members: Object.values(members).filter(m => m.wind_speed_10m && m.temperature_2m) };
}
// Conditions for the playing hour starting at index i (h:00 to h+1:00). get(variable, index) reads one value.
// Open-Meteo wind and temperature are instantaneous at each hour mark, but gusts (maximum) and precipitation (total)
// cover the hour ending at their timestamp. So the hour h→h+1 averages the marks at i and i+1, and takes the
// gust and rain stamped at i+1.
function hourFrom(get, i, uvAt) {
  const j = get("wind_speed_10m", i + 1) != null ? i + 1 : i;
  const avg = v => { const a = get(v, i), b = get(v, j); return a == null ? (b ?? undefined) : b == null ? a : (a + b) / 2; };
  const wind = avg("wind_speed_10m"), temp = avg("temperature_2m");
  if (wind == null || temp == null) return null;
  const d0 = get("wind_direction_10m", i), d1 = get("wind_direction_10m", j), g = get("wind_gusts_10m", j);
  return { wind, temp, feels: avg("apparent_temperature"),
    dir: d0 == null ? 180 : d1 == null ? d0 : circMean([d0, d1]),
    gust: g == null ? undefined : Math.max(wind, g - GUST_BIAS),
    rain: get("precipitation", j) ?? 0,
    wetness: wetness(k => get("precipitation", k), j), uv: uvAt?.(i) ?? undefined };
}
const memberHour = (m, i) => hourFrom((v, k) => m[v]?.[k], i);

// An hour that's better than its neighbours loses half the gap to their average. Forecast timing is often out by an
// hour, so a lone calm hour between windy ones is discounted, without punishing a good hour next to an OK one much.
function sustain(r) {
  return r.map((x, i) => {
    if (x == null) return null;
    const nb = [r[i - 1], x, r[i + 1]].filter(v => v != null);
    const avg = nb.reduce((a, b) => a + b, 0) / nb.length;
    return x - 0.5 * Math.max(0, x - avg);
  });
}
// A session's score is mostly its average hour, but its worst hour drags it down, so Epic needs the whole window to hold.
function blockScore(rs) {
  const v = rs.filter(x => x != null);
  if (!v.length) return null;
  return 0.75 * v.reduce((a, b) => a + b, 0) / v.length + 0.25 * Math.min(...v);
}
function ratingSeries(get, n, uvAt) {
  const hours = Array.from({ length: n }, (_, i) => hourFrom(get, i, uvAt));
  const raw = hours.map(h => h ? hourScore(h) : null);
  return { hours, raw, sust: sustain(raw) };
}
// data.uv (time → UV index) is optional and must be attached before the first call.
const memberSeries = data => data.series ??= data.members.map(m =>
  ratingSeries((v, k) => m[v]?.[k], data.time.length, k => data.uv?.[data.time[k]]));

function weekendBuckets(data) {
  const { time, members } = data, series = memberSeries(data);
  const dates = [...new Set(time.map(t => t.slice(0, 10)))];
  const fridays = dates.filter(d => dowOf(d) === 5);
  const firstDow = dowOf(dates[0]);
  if (firstDow === 6 || firstDow === 0) fridays.unshift(addDays(dates[0], firstDow === 6 ? -1 : -2));
  return fridays.slice(0, 2).map(fri => ({ fri, blocks: BLOCKS.map(b => {
    const day = addDays(fri, { 5: 0, 6: 1, 0: 2 }[b.dow]);
    const inBlock = time.map((t, i) => [t, i]).filter(([t]) => t.slice(0, 10) === day && +t.slice(11, 13) >= b.start && +t.slice(11, 13) < b.end);
    if (!inBlock.length) return { ...b, day, missing: true };
    const sunset = sunTimes(day)[1];
    const idx = inBlock.filter(([t]) => playable(day, +t.slice(11, 13))).map(([, i]) => i);
    if (!idx.length) return { ...b, day, dark: true, sunset };
    const playStart = +time[idx[0]].slice(11, 13), playEnd = +time[idx[idx.length - 1]].slice(11, 13) + 1;
    const scores = [], winds = [], gusts = [], dirs = [], temps = [], feels = []; let wet = 0, gusty = 0;
    for (const s of series) {
      const sc = blockScore(idx.map(i => s.sust[i]));
      if (sc == null) continue;
      scores.push(sc);
      let rainy = false, puffy = false;
      for (const i of idx) {
        const h = s.hours[i]; if (!h) continue;
        winds.push(h.wind); dirs.push(h.dir); temps.push(h.temp); feels.push(h.feels ?? h.temp);
        if (h.gust != null) gusts.push(h.gust);
        if (h.rain >= 0.2) rainy = true;
        if (gustExcess(h) >= 10) puffy = true;
      }
      if (rainy) wet++; if (puffy) gusty++;
    }
    const lo = pctile(scores, .25), hi = pctile(scores, .75);
    const uvs = idx.map(i => data.uv?.[time[i]]).filter(u => u != null);
    return { ...b, day, scores, med: pctile(scores, .5), lo, hi, iqr: hi - lo, i0: idx[0], uv: uvs.length ? Math.max(...uvs) : null,
      playStart, playEnd, clipped: playStart > b.start || playEnd < b.end, sunset, feels: pctile(feels, .5),
      pRain: wet / members.length, pGusty: gusty / members.length, wind: pctile(winds, .5), gust: gusts.length ? pctile(gusts, .5) : null,
      dir: circMean(dirs), temp: pctile(temps, .5),
      lead: Math.round((new Date(day) - new Date(dates[0])) / 864e5) };
  }) }));
}

if (typeof module !== "undefined") module.exports = {
  LAT, LON, TZ, BEACH_FACES, BLOCKS, TIERS, tierOf, exposure, dirFactor, exposureGustFactor, windOnlyRating, curve, hourScore,
  dowOf, ymd, addDays, pctile, compass, circMean, nowMelb, todayMelb, fmtDay, hr, hrsOf, hm,
  wetness, utcOffset, sunTimes, playable, VARS, fetchEnsemble, fetchBlended, blendCells, seaWeight, fetchUV, uvLabel, toMembers, memberHour, weekendBuckets,
  GUST_BIAS, gustExcess, windRating, gustPenalty, tempFactor, rainFactor, wetFactor, uvFactor, hourFrom, sustain, blockScore, ratingSeries, memberSeries,
};
