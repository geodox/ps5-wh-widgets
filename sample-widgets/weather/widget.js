// weather - current weather and forecast for saved places anywhere in the world,
// from Open-Meteo (no key needed). Based on the Weather widget by VintendoPower
// (github.com/manchildtechnologies-ui/ps5-widget-store). Reference for:
//   pages         X opens the places page: search by city or postal code with
//                 wh.TextInput, results and saved places in wh.List
//   storage       the saved places and the selected one, per PS5 user
//   settings      temperature and wind units (or the console's region), photos
//   wh.useLocale  12/24-hour clock, units and place-name language from the console
//   hubVisible    refreshes only while the tiles are on screen
//   images        condition icons and background photos from props.config.assetBase
//   sizes         DEFAULT: now; LARGE: + 5-day forecast; FULL: + details and hours
(function (wh) {
  var React = wh.React;
  var View = wh.View;
  var Label = wh.Label;
  var Image = wh.Image;
  var ce = React.createElement;
  var F = wh.FontSizePS;
  var B = wh.Button;
  var log = wh.logger('weather');

  var DEG = String.fromCharCode(176);
  var MAX_PLACES = 20;
  var REFRESH = 15 * 60 * 1000;            // weather refresh while on screen
  var RETRY = 2 * 60 * 1000;               // after a failed load
  var TIMEOUT = 8000;                      // the hub's own network timeout is 60 s
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Regions that use Fahrenheit, and miles per hour, by default.
  var FAHRENHEIT = { US: 1, LR: 1, MM: 1, BS: 1, BZ: 1, KY: 1, PW: 1, FM: 1, MH: 1 };
  var MPH = { US: 1, GB: 1, LR: 1, MM: 1 };
  var WIND_LABEL = { kmh: 'km/h', mph: 'mph', ms: 'm/s', kn: 'kn' };

  // ---------------------------------------------------------------- helpers

  function region() {
    var loc = (wh.getLocale && wh.getLocale().locale) || 'en-US';
    return (String(loc).split(/[-_]/)[1] || '').toUpperCase();
  }
  function language() {
    var loc = (wh.getLocale && wh.getLocale().locale) || 'en';
    return String(loc).split(/[-_]/)[0].toLowerCase() || 'en';
  }
  function unitsFor(settings) {
    var r = region();
    var temp = settings.units === 'c' || settings.units === 'f' ? settings.units : (FAHRENHEIT[r] ? 'f' : 'c');
    var wind = WIND_LABEL[settings.wind] ? settings.wind : (MPH[r] ? 'mph' : 'kmh');
    return { temp: temp, wind: wind };
  }
  function num(v, suffix) {
    return typeof v === 'number' && isFinite(v) ? Math.round(v) + (suffix || '') : '-';
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clock(hour, minute, use12) {
    if (use12) return (hour % 12 || 12) + ':' + pad(minute) + (hour < 12 ? ' AM' : ' PM');
    return pad(hour) + ':' + pad(minute);
  }
  // The place's local time, from the forecast's UTC offset.
  function placeTime(now, offsetSeconds, use12) {
    var d = new Date(now + offsetSeconds * 1000);
    return clock(d.getUTCHours(), d.getUTCMinutes(), use12);
  }
  function hourLabel(iso, use12) {           // "2026-11-20T14:00" (place time)
    var h = parseInt(String(iso).slice(11, 13), 10);
    if (isNaN(h)) return '';
    return use12 ? (h % 12 || 12) + (h < 12 ? ' AM' : ' PM') : pad(h) + ':00';
  }
  function dayLabel(date) {                  // "2026-11-20"
    return DAYS[new Date(date + 'T12:00:00Z').getUTCDay()] || '';
  }
  function placeLine(p) {
    return [p.admin1, p.country].filter(function (s) { return s && s !== p.name; }).join(', ');
  }

  // WMO weather codes, as Open-Meteo reports them.
  function condition(code) {
    if (code === 0) return 'Clear sky';
    if (code === 1) return 'Mainly clear';
    if (code === 2) return 'Partly cloudy';
    if (code === 3) return 'Overcast';
    if (code === 45 || code === 48) return 'Fog';
    if (code >= 51 && code <= 55) return 'Drizzle';
    if (code === 56 || code === 57) return 'Freezing drizzle';
    if (code >= 61 && code <= 65) return 'Rain';
    if (code === 66 || code === 67) return 'Freezing rain';
    if (code >= 71 && code <= 75) return 'Snow';
    if (code === 77) return 'Snow grains';
    if (code >= 80 && code <= 82) return 'Rain showers';
    if (code === 85 || code === 86) return 'Snow showers';
    if (code === 95) return 'Thunderstorm';
    if (code === 96 || code === 99) return 'Thunderstorm, hail';
    return 'Cloudy';
  }
  function iconName(code, isDay) {
    if (code === 0) return isDay ? 'sun' : 'moon';
    if (code === 1 || code === 2) return isDay ? 'partly-day' : 'partly-night';
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    return 'cloud';
  }
  function photoName(code, isDay) {
    if (code === 0 || code === 1) return isDay ? 'weather-clear-day.jpg' : 'weather-clear-night.jpg';
    if (code <= 3) return 'weather-cloudy.jpg';
    if (code <= 48) return 'weather-fog.jpg';
    if (code <= 67 || (code >= 80 && code <= 82)) return 'weather-rain.jpg';
    if (code <= 86) return 'weather-snow.jpg';
    return 'weather-storm.jpg';
  }

  // fetch with our own timeout: an unreachable server otherwise takes 60 s to fail.
  function fetchJson(url) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctl) { try { ctl.abort(); } catch (e) {} }
        reject(new Error('the weather service did not answer'));
      }, TIMEOUT);
      fetch(url, { headers: { Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined })
        .then(function (r) {
          if (!r.ok) throw new Error('the weather service returned HTTP ' + r.status);
          return r.json();
        })
        .then(function (j) { if (!done) { done = true; clearTimeout(timer); resolve(j); } },
          function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
  }

  function searchPlaces(query) {
    var url = 'https://geocoding-api.open-meteo.com/v1/search?count=10&format=json' +
      '&language=' + encodeURIComponent(language()) + '&name=' + encodeURIComponent(query);
    return fetchJson(url).then(function (j) {
      return ((j && j.results) || []).filter(function (r) {
        return typeof r.latitude === 'number' && typeof r.longitude === 'number';
      }).map(function (r) {
        return { id: r.id, name: r.name, admin1: r.admin1 || '', country: r.country || r.country_code || '',
          cc: r.country_code || '', lat: r.latitude, lon: r.longitude };
      });
    });
  }

  // Forecasts by place and units, shared by the tile and the page.
  var cache = {};
  function forecastKey(p, u) { return p.lat + ',' + p.lon + '|' + u.temp + '|' + u.wind; }
  function loadForecast(p, u) {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + p.lat + '&longitude=' + p.lon +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m' +
      '&hourly=temperature_2m,weather_code,is_day' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&forecast_days=6&timezone=auto' +
      '&temperature_unit=' + (u.temp === 'f' ? 'fahrenheit' : 'celsius') + '&wind_speed_unit=' + u.wind;
    return fetchJson(url).then(function (d) {
      if (!d || !d.current) throw new Error('no current weather in the answer');
      cache[forecastKey(p, u)] = { data: d, at: Date.now() };
      return d;
    });
  }

  // ---------------------------------------------------------------- hooks

  // Saved places and the selected one's id, re-read whenever `on` turns true (the
  // page may have changed them).
  function usePlaces(storage, on) {
    var s = React.useState(null), state = s[0], setState = s[1];
    React.useEffect(function () {
      if (!on || !storage) return;
      var live = true;
      Promise.all([storage.get('places', []), storage.get('current', null)]).then(function (v) {
        if (!live) return;
        var places = Array.isArray(v[0]) ? v[0] : [];
        setState(function (old) {
          var same = old && JSON.stringify(old.places) === JSON.stringify(places) && old.current === v[1];
          return same ? old : { places: places, current: v[1] };
        });
      });
      return function () { live = false; };
    }, [on]);
    return [state, setState];
  }

  // The forecast for `place`, refreshed every 15 minutes while `on`. When only the
  // units change, the previous forecast stays on screen until the new one is in,
  // instead of the tile emptying and refilling.
  function useForecast(place, units, on, nonce) {
    var s = React.useState({}), state = s[0], setState = s[1];
    var key = place ? forecastKey(place, units) : '';
    var where = place ? place.lat + ',' + place.lon : '';
    var lastNonce = React.useRef(nonce);
    React.useEffect(function () {
      if (!on || !place) return;
      var live = true, timer = null;
      var force = nonce !== lastNonce.current;          // Square: reload now
      lastNonce.current = nonce;
      function keep(old, extra) {
        return assign({ where: where, data: old.where === where ? old.data : null }, extra);
      }
      function schedule(ms) { timer = setTimeout(load, ms); }
      function load() {
        setState(function (old) { return keep(old, { loading: true }); });
        loadForecast(place, units).then(function (d) {
          if (!live) return;
          setState({ where: where, data: d, at: Date.now() });
          schedule(REFRESH);
        }, function (e) {
          if (!live) return;
          var msg = (e && e.message) || 'no data';
          log('load failed for ' + place.name + ': ' + msg);
          setState(function (old) { return keep(old, { error: msg }); });
          schedule(RETRY);
        });
      }
      var hit = cache[key];
      if (hit && !force && Date.now() - hit.at < REFRESH) {
        setState({ where: where, data: hit.data, at: hit.at });
        schedule(REFRESH - (Date.now() - hit.at));
      } else {
        load();
      }
      return function () { live = false; clearTimeout(timer); };
    }, [key, on, nonce]);
    return state.where === where ? state : {};
  }

  function useNow(on) {
    var s = React.useState(Date.now()), now = s[0], setNow = s[1];
    React.useEffect(function () {
      if (!on) return;
      setNow(Date.now());
      var id = setInterval(function () { setNow(Date.now()); }, 30000);
      return function () { clearInterval(id); };
    }, [on]);
    return now;
  }

  function assign(a, b) {
    var o = {}, k;
    for (k in a) o[k] = a[k];
    for (k in b) o[k] = b[k];
    return o;
  }

  // ---------------------------------------------------------------- tile

  var styles = wh.StyleSheet.create({
    photo: { position: 'absolute', left: 0, top: 0, borderRadius: 16 },
    shade: { position: 'absolute', left: 0, top: 0, borderRadius: 16, backgroundColor: '#000000', opacity: 0.45 },
    body: { flex: 1, padding: 16 },
    now: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
    temp: { fontSize: F.SizeXLarge, marginLeft: 12 },
    tempBig: { fontSize: F.Size2XLarge, marginLeft: 12 },
    nowText: { flex: 1, marginLeft: 16 },
    small: { fontSize: F.Size3XSmall },
    dim: { fontSize: F.Size4XSmall, opacity: 0.7 },
    note: { fontSize: F.Size3XSmall, opacity: 0.7, marginTop: 12 },
    section: { flexDirection: 'row', marginTop: 14 },
    col: { flex: 1, alignItems: 'center' },
    cell: { flex: 1 },
    pageRoot: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
    pageBox: { width: 1500, height: 918, marginTop: 162 },
    pageTitle: { fontSize: F.Size2XLarge },
    pageNote: { fontSize: F.Size3XSmall, opacity: 0.6, marginTop: 8 },
    search: { width: 900, height: 72, paddingHorizontal: 16, marginTop: 24 },
    list: { flex: 1, width: '100%', marginVertical: 40 }
  });

  function Icon(props) {
    var size = props.size;
    if (!props.show || !Image || !props.base) return ce(View, { style: { width: size, height: size } });
    return ce(Image, { source: { uri: props.base + 'icon-' + iconName(props.code, props.isDay) + '.png' },
      resizeMode: 'contain', style: { width: size, height: size } });
  }

  function Weather(props) {
    var cfg = props.config || {};
    var settings = props.settings || {};
    var base = cfg.assetBase || '';
    var hubVisible = props.hubVisible !== false;          // undefined on older loaders
    var locale = wh.useLocale ? wh.useLocale() : {};
    var use12 = locale.timeFormat === 12;
    var units = unitsFor(settings);
    var pp = usePlaces(props.storage, hubVisible), saved = pp[0], setSaved = pp[1];
    var places = (saved && saved.places) || [];
    var index = 0;
    for (var i = 0; i < places.length; i++) if (places[i].id === (saved && saved.current)) index = i;
    var place = places[index] || null;
    var n = React.useState(0), nonce = n[0], setNonce = n[1];
    var fc = useForecast(place, units, hubVisible, nonce);
    var now = useNow(hubVisible);
    // Images (photo, condition icons) only once the tile has settled, and never in
    // edit mode: there the hub remounts tiles, and an image removed while it loads
    // crashes ShellUI about 15 s later (console-verified on 13.20).
    var st = React.useState(false), settled = st[0], setSettled = st[1];
    React.useEffect(function () {
      var t = setTimeout(function () { setSettled(true); }, 1000);
      return function () { clearTimeout(t); };
    }, []);
    var images = settled && !props.editing && !!Image && !!base;

    function openPage() { if (props.openPage) props.openPage({ units: units }); }
    function step(dir) {
      if (places.length < 2) return;
      var next = places[(index + dir + places.length) % places.length];
      setSaved({ places: places, current: next.id });
      props.storage.set('current', next.id);
      wh.playSound('move');
    }
    wh.onPressed(B.Cross, openPage);
    wh.onPressed(B.L1, function () { step(-1); });
    wh.onPressed(B.R1, function () { step(1); });
    wh.onPressed(B.Square, function () { if (place) { setNonce(nonce + 1); wh.playSound('enter'); } });

    var W = props.width || 504, H = props.height || 152;
    var d = fc.data, cur = d && d.current, daily = d && d.daily;
    var isDay = cur ? cur.is_day === 1 : true;
    var iconId = cfg.glyph ? 'wh:' + (cfg.id || 'weather') : 'cloud';
    var layers = [];
    if (cur && settings.photos !== false && images) {
      layers.push(ce(Image, { key: 'p', source: { uri: base + photoName(cur.weather_code, isDay) }, resizeMode: 'cover',
        style: [styles.photo, { width: W, height: H }] }));
      layers.push(ce(View, { key: 's', style: [styles.shade, { width: W, height: H }] }));
    }

    var body = [];
    if (!saved) {
      body.push(ce(Label, { key: 'm', style: styles.note }, 'Loading...'));
    } else if (!place) {
      body.push(ce(Label, { key: 'm', style: styles.note }, 'Press X to add a place'));
    } else if (!cur) {
      body.push(ce(Label, { key: 'm', style: styles.note },
        fc.error ? "Can't load the weather: " + fc.error + '. Retrying soon.' : 'Loading the weather for ' + place.name + '...'));
    } else {
      var hi = daily && daily.temperature_2m_max ? num(daily.temperature_2m_max[0], DEG) : '-';
      var lo = daily && daily.temperature_2m_min ? num(daily.temperature_2m_min[0], DEG) : '-';
      var more = places.length > 1 && props.focused ? '   ' + (index + 1) + ' of ' + places.length + '  L1 / R1' : '';
      body.push(ce(View, { key: 'now', style: styles.now },
        ce(Icon, { code: cur.weather_code, isDay: isDay, size: H > 200 ? 64 : 56, base: base, show: images }),
        ce(Label, { style: H > 200 ? styles.tempBig : styles.temp }, num(cur.temperature_2m, DEG)),
        ce(View, { style: styles.nowText },
          ce(Label, { style: styles.small, numberOfLines: 1 }, condition(cur.weather_code)),
          ce(Label, { style: styles.dim, numberOfLines: 1 },
            'H ' + hi + '  L ' + lo + '  Feels ' + num(cur.apparent_temperature, DEG) + more))));

      if (H > 200 && daily && daily.time) {
        var days = [];
        for (var k = 1; k < Math.min(6, daily.time.length); k++) {
          days.push(ce(View, { key: k, style: styles.col },
            ce(Label, { style: styles.dim }, dayLabel(daily.time[k])),
            ce(Icon, { code: daily.weather_code[k], isDay: true, size: 36, base: base, show: images }),
            ce(Label, { style: styles.dim },
              num(daily.temperature_2m_max[k], DEG) + ' / ' + num(daily.temperature_2m_min[k], DEG))));
        }
        body.push(ce(View, { key: 'days', style: styles.section }, days));
      }

      if (H > 400) {
        var rain = daily && daily.precipitation_probability_max ? daily.precipitation_probability_max[0] : null;
        body.push(ce(View, { key: 'det', style: styles.section },
          detail(num(cur.relative_humidity_2m, '%'), 'Humidity'),
          detail(num(cur.wind_speed_10m) + ' ' + WIND_LABEL[units.wind], 'Wind'),
          detail(num(rain, '%'), 'Rain today'),
          detail(placeTime(now, d.utc_offset_seconds || 0, use12), 'Local time')));
        var h = d.hourly, hours = [];
        if (h && h.time) {
          var start = 0;
          while (start < h.time.length && h.time[start] <= cur.time) start++;
          for (var j = start; j < Math.min(start + 6, h.time.length); j++) {
            hours.push(ce(View, { key: j, style: styles.col },
              ce(Label, { style: styles.dim }, hourLabel(h.time[j], use12)),
              ce(Icon, { code: h.weather_code[j], isDay: h.is_day[j] === 1, size: 32, base: base, show: images }),
              ce(Label, { style: styles.small }, num(h.temperature_2m[j], DEG))));
          }
        }
        if (hours.length) body.push(ce(View, { key: 'hrs', style: styles.section }, hours));
      }
    }

    var title = place ? place.name : (cfg.title || 'Weather');
    var badge = cur ? placeTime(now, d.utc_offset_seconds || 0, use12) : null;
    return ce(View, { style: { width: W, height: H } },
      layers,
      ce(View, { style: styles.body },
        ce(wh.Title, { iconId: iconId, badge: badge }, title),
        body));
  }

  function detail(value, caption) {
    return ce(View, { key: caption, style: styles.cell },
      ce(Label, { style: styles.small }, value),
      ce(Label, { style: styles.dim }, caption));
  }

  // ---------------------------------------------------------------- page

  var M = wh.MenuListItemPS;

  function WeatherPage(props) {
    var units = (props.params && props.params.units) || unitsFor({});   // the tile's units
    var v = React.useState('list'), view = v[0], setView = v[1];
    var pp = usePlaces(props.storage, true), saved = pp[0], setSaved = pp[1];
    var q = React.useState(''), query = q[0], setQuery = q[1];
    var r = React.useState({ state: 'idle', list: [] }), found = r[0], setFound = r[1];
    var a = React.useState(null), ask = a[0], setAsk = a[1];
    var places = (saved && saved.places) || [];
    var current = saved && saved.current;

    function save(nextPlaces, nextCurrent) {
      setSaved({ places: nextPlaces, current: nextCurrent });
      props.storage.set('places', nextPlaces);
      props.storage.set('current', nextCurrent);
    }

    // Search shortly after the text stops changing, and again on the keyboard's Done.
    var seq = React.useRef(0);
    function search(text) {
      text = String(text || '').trim();
      var id = ++seq.current;
      if (text.length < 2) { setFound({ state: 'idle', list: [] }); return; }
      setFound({ state: 'busy', list: [] });
      searchPlaces(text).then(function (list) {
        if (id === seq.current) setFound({ state: list.length ? 'done' : 'none', list: list });
      }, function (e) {
        if (id !== seq.current) return;
        log('search failed: ' + ((e && e.message) || e));
        setFound({ state: 'error', list: [], error: (e && e.message) || 'search failed' });
      });
    }
    React.useEffect(function () {
      if (view !== 'add') return;
      var t = setTimeout(function () { search(query); }, 700);
      return function () { clearTimeout(t); };
    }, [query, view]);

    function add(p) {
      var dup = places.filter(function (x) { return x.id === p.id; })[0];
      if (dup) { save(places, dup.id); setView('list'); return; }
      if (places.length >= MAX_PLACES) { wh.playSound('error'); return; }
      var place = { id: p.id, name: p.name, admin1: p.admin1, country: p.country, cc: p.cc, lat: p.lat, lon: p.lon };
      save(places.concat([place]), place.id);
      wh.playSound('enter');
      setQuery(''); setFound({ state: 'idle', list: [] });
      setView('list');
    }
    function remove(p) {
      var rest = places.filter(function (x) { return x.id !== p.id; });
      save(rest, current === p.id ? (rest[0] ? rest[0].id : null) : current);
    }

    var rows = React.useMemo(function () {
      var out = [];
      if (!saved) return out;
      if (view === 'list') {
        places.forEach(function (p) {
          var hit = cache[forecastKey(p, units)], c = hit && hit.data.current;
          var desc = placeLine(p) + (c ? ' - ' + num(c.temperature_2m, DEG) + ' ' + condition(c.weather_code) : '');
          out.push({ kind: 'place', place: p, name: p.name + (p.id === current ? '  (on the tile)' : ''), desc: desc });
        });
        out.push({ kind: 'add', name: 'Add a place',
          desc: places.length >= MAX_PLACES ? 'The list is full (' + MAX_PLACES + ' places)' : 'Search by city or postal code, in any country' });
        if (places.length) out.push({ kind: 'removeView', name: 'Remove a place' });
        return out;
      }
      if (view === 'remove') {
        out.push({ kind: 'back', name: 'Done' });
        places.forEach(function (p) { out.push({ kind: 'remove', place: p, name: p.name, desc: placeLine(p) }); });
        return out;
      }
      out.push({ kind: 'back', name: 'Back', desc: 'To your places' });
      if (found.state === 'busy') out.push({ kind: 'note', name: 'Searching...' });
      else if (found.state === 'none') out.push({ kind: 'note', name: 'No places found' });
      else if (found.state === 'error') out.push({ kind: 'note', name: "Can't search: " + found.error });
      found.list.forEach(function (p) {
        out.push({ kind: 'result', place: p, name: p.name,
          desc: placeLine(p) + '  (' + p.lat.toFixed(2) + ', ' + p.lon.toFixed(2) + ')' });
      });
      return out;
    }, [saved, view, found]);

    function renderItem(row) {
      switch (row.kind) {
        case 'place':
          return ce(M.Button, { label: row.name, description: row.desc, onPress: function () {
            save(places, row.place.id); wh.playSound('enter'); props.close();
          } });
        case 'add':
          return ce(M.Button, { label: row.name, description: row.desc, onPress: function () {
            if (places.length < MAX_PLACES) setView('add'); else wh.playSound('error');
          } });
        case 'removeView':
          return ce(M.Button, { label: row.name, onPress: function () { setView('remove'); } });
        case 'back':
          return ce(M.Button, { label: row.name, description: row.desc, onPress: function () { setView('list'); } });
        case 'remove':
          return ce(M.Button, { label: row.name, description: row.desc, onPress: function () { setAsk(row.place); } });
        case 'result':
          return ce(M.Button, { label: row.name, description: row.desc, onPress: function () { add(row.place); } });
        default:
          return ce(M.Button, { label: row.name, onPress: function () {} });
      }
    }

    if (!wh.List || !M || !wh.TextInput) {
      return ce(View, { style: styles.pageRoot }, ce(Label, null, 'This page needs a newer wh_bridge payload.'));
    }
    var head = [ce(Label, { key: 't', style: styles.pageTitle },
      view === 'add' ? 'Add a place' : view === 'remove' ? 'Remove a place' : 'Your places')];
    if (view === 'add') {
      head.push(ce(Label, { key: 'n', style: styles.pageNote }, 'Type a city or a postal code, then pick the place.'));
      head.push(ce(wh.TextInput, { key: 's', value: query, placeholder: 'City or postal code',
        keyboardWindowTitle: 'Find a place', focusable: true, style: styles.search,
        onChangeText: setQuery, onSubmitEditing: function (e) { search((e && e.nativeEvent && e.nativeEvent.text) || query); } }));
    } else if (view === 'list') {
      head.push(ce(Label, { key: 'n', style: styles.pageNote },
        'X on a place shows it on the tile. On the tile, L1 and R1 switch places.'));
    }
    return ce(View, { style: styles.pageRoot },
      ce(View, { style: styles.pageBox },
        head,
        ce(wh.List, { key: view, data: rows, renderItem: renderItem, style: styles.list })),
      ask ? ce(wh.AlertDialogPS, {
        title: 'Remove ' + ask.name + '?',
        buttons: {
          positive: { text: 'Remove', onPress: function () { remove(ask); setAsk(null); } },
          negative: { text: 'Cancel', onPress: function () { setAsk(null); } }
        },
        onRequestClose: function () { setAsk(null); }
      }, ce(wh.Text, null, placeLine(ask))) : null);
  }

  wh.register(Weather);
  wh.registerPage(WeatherPage);
})(globalThis.__wh);
