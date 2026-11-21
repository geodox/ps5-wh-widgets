// home-assistant - control and watch Home Assistant entities. Reference for:
//   WebSocket     one shared connection to HA's /api/websocket: live state with
//                 subscribe_entities, actions with call_service
//   config.json   haUrl and haToken (a long-lived access token) are read from
//                 props.config; the user edits them before copying the folder over
//   storage       the chosen entities are kept per user in props.storage
//   wh.Focusable  X enters the tile, arrows pick an entity, X runs its action
//   pages         Square opens the page: every chosen entity with full controls
//                 (climate target and mode) and the entity chooser
//   AlertDialogPS unlocking a lock or opening a garage door asks first
(function (wh) {
  var React = wh.React;
  var View = wh.View;
  var Label = wh.Label;
  var ce = React.createElement;
  var F = wh.FontSizePS;
  var B = wh.Button;
  var log = wh.logger('home-assistant');

  var DEG = String.fromCharCode(176);
  var CONNECT_TIMEOUT = 6000;              // the hub's own network timeout is 60 s
  var CALL_TIMEOUT = 10000;
  var BACKOFF = [2000, 5000, 10000, 30000];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------------------------------------------------------------- helpers

  function assign(to) {
    for (var i = 1; i < arguments.length; i++) {
      var from = arguments[i];
      for (var k in from) if (Object.prototype.hasOwnProperty.call(from, k)) to[k] = from[k];
    }
    return to;
  }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, Math.max(1, n - 3)) + '...' : s; }
  function domainOf(id) { return String(id).split('.')[0]; }
  function nameOf(id, st) { return (st && st.a && st.a.friendly_name) || id; }
  function word(s) {
    s = String(s);
    if (/^[a-z_]+$/.test(s)) s = s.replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function isNum(v) { return v !== '' && v != null && !isNaN(+v); }
  function fmtNum(v) { return isNum(v) ? String(Math.round(+v * 100) / 100) : String(v); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var h = d.getHours(), t;
    if (wh.getLocale && wh.getLocale().timeFormat === 12) t = (h % 12 || 12) + ':' + pad(d.getMinutes()) + (h < 12 ? ' AM' : ' PM');
    else t = pad(h) + ':' + pad(d.getMinutes());
    var now = new Date();
    return d.toDateString() === now.toDateString() ? t : MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + t;
  }

  // HA's own wording for binary sensors, by device class.
  var BINARY = {
    door: ['Open', 'Closed'], window: ['Open', 'Closed'], garage_door: ['Open', 'Closed'], opening: ['Open', 'Closed'],
    motion: ['Detected', 'Clear'], occupancy: ['Detected', 'Clear'], presence: ['Home', 'Away'],
    moisture: ['Wet', 'Dry'], lock: ['Unlocked', 'Locked'], connectivity: ['Connected', 'Disconnected'],
    battery: ['Low', 'Normal'], plug: ['Plugged in', 'Unplugged'], problem: ['Problem', 'OK'],
    smoke: ['Detected', 'Clear'], gas: ['Detected', 'Clear'], carbon_monoxide: ['Detected', 'Clear'],
    safety: ['Unsafe', 'Safe'], tamper: ['Tampering', 'Clear'], running: ['Running', 'Not running']
  };

  // The state as the tile and the page show it.
  function stateText(id, st, unitT) {
    if (!st) return '...';
    var s = st.s, a = st.a || {}, d = domainOf(id);
    if (s === 'unavailable') return 'Unavailable';
    if (s === 'unknown') return '-';
    switch (d) {
      case 'light':
        return s === 'on' && a.brightness != null ? 'On ' + Math.round(a.brightness / 2.55) + '%' : word(s);
      case 'fan':
        return s === 'on' && a.percentage != null ? 'On ' + a.percentage + '%' : word(s);
      case 'cover':
        return a.current_position != null && s !== 'closed' ? word(s) + ' ' + a.current_position + '%' : word(s);
      case 'climate':
      case 'water_heater': {
        var parts = [word(s)];
        if (a.current_temperature != null) parts.push(fmtNum(a.current_temperature) + unitT);
        if (a.temperature != null) parts.push('to ' + fmtNum(a.temperature) + unitT);
        else if (a.target_temp_low != null) parts.push('to ' + fmtNum(a.target_temp_low) + '-' + fmtNum(a.target_temp_high) + unitT);
        return parts.join(' ');
      }
      case 'media_player':
        return a.media_title && (s === 'playing' || s === 'paused') ? word(s) + ': ' + a.media_title : word(s);
      case 'scene': return 'Activate';
      case 'script': return s === 'on' ? 'Running' : 'Run';
      case 'button':
      case 'input_button': return 'Press';
      case 'weather':
        return word(s) + (a.temperature != null ? ' ' + fmtNum(a.temperature) + (a.temperature_unit || '') : '');
      case 'binary_sensor': {
        var w = BINARY[a.device_class];
        if (w && (s === 'on' || s === 'off')) return s === 'on' ? w[0] : w[1];
        break;
      }
    }
    if (a.unit_of_measurement) return fmtNum(s) + ' ' + a.unit_of_measurement;
    if (a.device_class === 'timestamp' || /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s)) return fmtTime(s);
    return isNum(s) ? fmtNum(s) : word(s);
  }

  var TOGGLE = { light: 1, 'switch': 1, fan: 1, input_boolean: 1, automation: 1, siren: 1, humidifier: 1 };

  // What X does on an entity: {service, data?, sound, confirm?}, {page: true} for
  // entities only the page can control, or null when it is read-only.
  function actionFor(id, st) {
    if (!st || st.s === 'unavailable') return null;
    var d = domainOf(id), s = st.s, a = st.a || {};
    if (TOGGLE[d]) return { service: 'toggle', sound: s === 'on' ? 'switchOff' : 'switchOn' };
    switch (d) {
      case 'valve': return { service: 'toggle', sound: s === 'open' ? 'switchOff' : 'switchOn' };
      case 'scene':
      case 'script': return { service: 'turn_on', sound: 'enter' };
      case 'button':
      case 'input_button': return { service: 'press', sound: 'enter' };
      case 'cover':
        if (s === 'opening' || s === 'closing') return { service: 'stop_cover', sound: 'enter' };
        if (s === 'open') return { service: 'close_cover', sound: 'enter' };
        return { service: 'open_cover', sound: 'enter',
          confirm: a.device_class === 'garage' || a.device_class === 'gate' ? 'Open' : null };
      case 'lock':
        return s === 'locked'
          ? { service: 'unlock', sound: 'enter', confirm: 'Unlock' }
          : { service: 'lock', sound: 'enter' };
      case 'media_player':
        return s === 'off' ? { service: 'turn_on', sound: 'enter' } : { service: 'media_play_pause', sound: 'enter' };
      case 'vacuum':
        return s === 'cleaning' ? { service: 'return_to_base', sound: 'enter' } : { service: 'start', sound: 'enter' };
      case 'lawn_mower':
        return s === 'mowing' ? { service: 'dock', sound: 'enter' } : { service: 'start_mowing', sound: 'enter' };
      case 'select':
      case 'input_select': return { service: 'select_next', sound: 'move' };
      case 'climate':
      case 'water_heater': return { page: true };
    }
    return null;
  }

  // Applies a subscribe_entities event to a {entity_id: {s, a}} map. Entities that
  // change get a new object, so list rows re-render only for those.
  function applyEvent(map, ev) {
    var id;
    if (ev.a) for (id in ev.a) map[id] = { s: ev.a[id].s, a: ev.a[id].a || {} };
    if (ev.c) {
      for (id in ev.c) {
        var ch = ev.c[id], cur = map[id] || { s: '', a: {} }, nx = { s: cur.s, a: cur.a };
        var plus = ch['+'], minus = ch['-'];
        if (plus) {
          if (plus.s !== undefined) nx.s = plus.s;
          if (plus.a) nx.a = assign({}, cur.a, plus.a);
        }
        if (minus && minus.a) {
          nx.a = assign({}, nx.a);
          for (var i = 0; i < minus.a.length; i++) delete nx.a[minus.a[i]];
        }
        map[id] = nx;
      }
    }
    if (ev.r) for (var j = 0; j < ev.r.length; j++) delete map[ev.r[j]];
  }

  function configured(cfg) {
    return /^https?:\/\/\S+$/.test(String(cfg.haUrl || '')) &&
      String(cfg.haToken || '').length > 40 && !/PASTE/.test(cfg.haToken);
  }

  // ---------------------------------------------------------------- connection
  // One WebSocket shared by the tile and the page. It is open while either uses it
  // (acquire / release) and closes a few seconds after the last one lets go.
  var client = (function () {
    var ws = null, status = 'idle', url = '', token = '';
    var users = 0, nextId = 1, nextKey = 1, backoff = 0;
    var pending = {}, subs = {}, statusFns = [];
    var retryTimer = null, connectTimer = null, closeTimer = null;
    var probing = false;                     // the fetch check before the socket is running
    var info = { tempUnit: DEG + 'C' };

    function setStatus(s) {
      if (s === status) return;
      status = s;
      log('connection: ' + s);
      for (var i = 0; i < statusFns.length; i++) statusFns[i](s);
    }
    function send(msg) {
      if (!ws || status !== 'ok') return false;
      try { ws.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
    }
    function request(msg, cb) {
      var id = nextId++;
      msg.id = id;
      var timer = setTimeout(function () {
        if (pending[id]) { delete pending[id]; cb('timed out'); }
      }, CALL_TIMEOUT);
      pending[id] = function (m) {
        clearTimeout(timer);
        if (m.success) cb(null, m.result);
        else cb((m.error && (m.error.message || m.error.code)) || 'failed');
      };
      if (!send(msg)) { clearTimeout(timer); delete pending[id]; cb('not connected'); }
    }
    function startSub(key) {
      var s = subs[key];
      s.id = nextId++;
      send({ id: s.id, type: 'subscribe_entities', entity_ids: s.ids });
    }
    // Opening a WebSocket to a host that does not answer blocks the hub's JS thread
    // until the TCP connect gives up (about 75 s; console-verified on 13.20): input
    // freezes and ShellUI may be killed. fetch does not block, so ask the server
    // with fetch first and open the socket only once it has answered.
    function open() {
      clearTimeout(retryTimer); retryTimer = null;
      setStatus('connecting');
      var done = false, at = url;
      probing = true;
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        probing = false;
        if (ctl) { try { ctl.abort(); } catch (e) {} }
        log('server did not answer within ' + CONNECT_TIMEOUT / 1000 + ' s');
        if (at === url && users > 0) drop(null, 'unreachable');
      }, CONNECT_TIMEOUT);
      function answered(ok) {
        if (done) return;
        done = true;
        probing = false;
        clearTimeout(timer);
        if (at !== url || users === 0) return;           // released or reconfigured meanwhile
        if (ok) openSocket(); else drop(null, 'unreachable');
      }
      try {
        // Any HTTP answer (401 included) means the server is up.
        fetch(url + '/api/', { signal: ctl ? ctl.signal : undefined })
          .then(function () { answered(true); }, function () { answered(false); });
      } catch (e) { answered(false); }
    }
    function openSocket() {
      var sock;
      try { sock = new WebSocket(url.replace(/^http/, 'ws') + '/api/websocket'); }
      catch (e) { log('connect failed: ' + (e && e.message)); drop(null, 'unreachable'); return; }
      ws = sock;
      connectTimer = setTimeout(function () {
        if (ws === sock && status !== 'ok') { log('connect timed out'); drop(sock, 'unreachable'); }
      }, CONNECT_TIMEOUT);
      sock.onmessage = function (e) { if (ws === sock) onMessage(sock, e.data); };
      sock.onclose = function () { if (ws === sock) drop(sock, 'unreachable'); };
      sock.onerror = function () {};
    }
    function drop(sock, why) {
      clearTimeout(connectTimer);
      if (sock) {
        if (ws === sock) ws = null;
        sock.onclose = null; sock.onmessage = null;
        try { sock.close(); } catch (e) {}
      }
      for (var id in pending) {
        var p = pending[id];
        delete pending[id];
        p({ success: false, error: { message: 'disconnected' } });
      }
      setStatus(why);
      // A rejected token stays rejected: wait for the next acquire (a new hub
      // session after the user fixed config.json) instead of retrying.
      if (users > 0 && why === 'unreachable') {
        var delay = BACKOFF[Math.min(backoff, BACKOFF.length - 1)];
        backoff++;
        retryTimer = setTimeout(open, delay);
      }
    }
    function onMessage(sock, data) {
      var m;
      try { m = JSON.parse(data); } catch (e) { return; }
      if (m.type === 'auth_required') {
        try { sock.send(JSON.stringify({ type: 'auth', access_token: token })); } catch (e) {}
      } else if (m.type === 'auth_ok') {
        clearTimeout(connectTimer);
        backoff = 0;
        setStatus('ok');
        request({ type: 'get_config' }, function (err, res) {
          var u = res && res.unit_system && res.unit_system.temperature;
          if (u) info.tempUnit = u;
        });
        for (var key in subs) startSub(key);
      } else if (m.type === 'auth_invalid') {
        log('token rejected: ' + (m.message || ''));
        drop(sock, 'auth');
      } else if (m.type === 'result') {
        var p = pending[m.id];
        if (p) { delete pending[m.id]; p(m); }
      } else if (m.type === 'event') {
        for (var k in subs) if (subs[k].id === m.id) { subs[k].handler(m.event); break; }
      }
    }

    return {
      status: function () { return status; },
      info: info,
      onStatus: function (fn) {
        statusFns.push(fn);
        return function () { statusFns = statusFns.filter(function (f) { return f !== fn; }); };
      },
      acquire: function (u, t) {
        clearTimeout(closeTimer); closeTimer = null;
        u = String(u).replace(/\/+$/, '');
        if (u !== url || t !== token) {
          url = u; token = t;
          if (ws) drop(ws, 'idle');
        }
        users++;
        if (!ws && !retryTimer && !probing) { backoff = 0; open(); }
      },
      release: function () {
        users = Math.max(0, users - 1);
        if (users > 0) return;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(function () {
          if (users > 0) return;
          clearTimeout(retryTimer); retryTimer = null;
          if (ws) drop(ws, 'idle'); else setStatus('idle');
        }, 3000);
      },
      // handler(event) gets the compressed subscribe_entities events.
      subscribe: function (ids, handler) {
        var key = 's' + nextKey++;
        subs[key] = { ids: ids, handler: handler, id: 0 };
        if (status === 'ok') startSub(key);
        return function () {
          var s = subs[key];
          delete subs[key];
          if (s && s.id) send({ id: nextId++, type: 'unsubscribe_events', subscription: s.id });
        };
      },
      getStates: function (cb) { request({ type: 'get_states' }, cb); },
      call: function (domain, service, entityId, data, cb) {
        request({ type: 'call_service', domain: domain, service: service,
          service_data: data || {}, target: { entity_id: entityId } }, cb);
      }
    };
  })();

  // Runs an entity's action and plays the stock sound for it.
  function runAction(id, act, sound) {
    client.call(act.domain || domainOf(id), act.service, id, act.data, function (err) {
      if (err) {
        log(act.service + ' ' + id + ' failed: ' + err);
        wh.playSound('error');
      } else if (sound !== false) {
        wh.playSound(act.sound || 'enter');
      }
    });
  }

  // ---------------------------------------------------------------- hooks

  function useStatus() {
    var s = React.useState(client.status()), status = s[0], setStatus = s[1];
    React.useEffect(function () {
      setStatus(client.status());
      return client.onStatus(setStatus);
    }, []);
    return status;
  }

  // Holds the connection open while `on` is true.
  function useConnection(cfg, on) {
    var ok = configured(cfg);
    React.useEffect(function () {
      if (!on || !ok) return;
      client.acquire(cfg.haUrl, cfg.haToken);
      return client.release;
    }, [on, ok, cfg.haUrl, cfg.haToken]);
  }

  // Live states for `ids`, as {entity_id: {s, a}}.
  function useEntities(ids, on) {
    var s = React.useState({}), states = s[0], setStates = s[1];
    var key = ids.join('|');
    React.useEffect(function () {
      if (!on || !ids.length) return;
      var map = {}, live = true;
      var unsub = client.subscribe(ids, function (ev) {
        applyEvent(map, ev);
        if (live) setStates(assign({}, map));
      });
      return function () { live = false; unsub(); };
    }, [on, key]);
    return states;
  }

  // The chosen entity ids, re-read from storage whenever `on` turns true (the
  // page may have changed them).
  function usePicks(storage, on) {
    var s = React.useState(null), picks = s[0], setPicks = s[1];
    React.useEffect(function () {
      if (!on || !storage) return;
      var live = true;
      storage.get('entities', []).then(function (v) {
        if (!live) return;
        var list = Array.isArray(v) ? v : [];
        setPicks(function (old) { return old && old.join('|') === list.join('|') ? old : list; });
      });
      return function () { live = false; };
    }, [on]);
    return picks;
  }

  function statusMessage(status, cfg) {
    if (!configured(cfg)) return 'Add haUrl and haToken to config.json';
    if (status === 'auth') return 'Home Assistant rejected the token';
    if (status === 'unreachable') return "Can't reach " + String(cfg.haUrl).replace(/^https?:\/\//, '') + ', retrying';
    if (status === 'connecting' || status === 'idle') return 'Connecting...';
    return null;
  }

  // ---------------------------------------------------------------- tile

  var styles = wh.StyleSheet.create({
    body: { flex: 1, padding: 16 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
    card: { borderRadius: 12, borderWidth: 2, borderColor: 'transparent', padding: 6,
      backgroundColor: 'rgba(255,255,255,0.08)' },
    cardOn: { backgroundColor: 'rgba(255,255,255,0.22)' },
    cardFocus: { borderColor: '#ffffff' },
    cardTop: { flexDirection: 'row', alignItems: 'center', height: 24 },
    cardIcon: { width: 24, height: 24 },
    cardState: { flex: 1, marginLeft: 6, textAlign: 'right', fontSize: F.Size4XSmall, opacity: 0.7 },
    cardName: { fontSize: F.Size3XSmall, marginTop: 4 },
    dim: { opacity: 0.5 },
    note: { fontSize: F.Size3XSmall, opacity: 0.6, marginTop: 8, paddingHorizontal: 12 },
    pageRoot: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
    pageBox: { width: 1500, height: 918, marginTop: 162 },
    pageTitle: { fontSize: F.Size2XLarge },
    pageNote: { fontSize: F.Size3XSmall, opacity: 0.6, marginTop: 8 },
    search: { width: 900, height: 72, paddingHorizontal: 16, marginTop: 24 },
    list: { flex: 1, width: '100%', marginVertical: 40 }
  });

  // ---- cards: a grid of `columns` (the Cards per row setting; twice that on an XL
  // tile, which is two tiles wide), as many rows as the tile height allows
  var CARD_GAP = 8, CARD_MIN_H = 64;
  function cardGrid(W, H, columns) {
    var cols = (+columns || 3) * (W > 600 ? 2 : 1);
    var avail = H - 64 - 16;   // title row above, bottom padding below
    var rows = Math.max(1, Math.floor((avail + CARD_GAP) / (CARD_MIN_H + CARD_GAP)));
    return {
      cols: cols,
      rows: rows,
      w: Math.floor((W - 32 - CARD_GAP * (cols - 1)) / cols),
      h: Math.floor((avail - CARD_GAP * (rows - 1)) / rows)
    };
  }
  function cardBox(g, i) {
    return { width: g.w, height: g.h, marginRight: i % g.cols === g.cols - 1 ? 0 : CARD_GAP,
      marginBottom: CARD_GAP };
  }
  // Scrolling: the grid shows grid.rows rows from row `top`. Down on a card in the
  // last row shown (Up in the first) scrolls to the next row with a selectable card
  // and selects the one nearest the same column. The card's `buttons` get the arrow
  // before the loader moves the selection; `autoSelect` selects the card that
  // scrolls in. Returns {row, index}, or null when there is nothing further.
  function scrollTarget(n, cols, from, dir, canSelect) {
    var col = from % cols, rows = Math.ceil(n / cols);
    for (var r = Math.floor(from / cols) + dir; r >= 0 && r < rows; r += dir) {
      var best = -1;
      for (var i = r * cols; i < Math.min(n, (r + 1) * cols); i++) {
        if (canSelect(i) && (best < 0 || Math.abs(i % cols - col) < Math.abs(best % cols - col))) best = i;
      }
      if (best >= 0) return { row: r, index: best };
    }
    return null;
  }

  // Domain icons (stock IconPS ids; there is no bulb, fan or thermometer glyph).
  var ICONS = {
    light: 'psvr_screen_brightness', switch: 'power', input_boolean: 'power', fan: 'power',
    siren: 'alarm', humidifier: 'power', valve: 'power', lock: 'lock', cover: 'home',
    media_player: 'tv', climate: 'settings_preference', water_heater: 'settings_preference',
    scene: 'appearance', script: 'control_play', automation: 'control_play',
    button: 'control_play', input_button: 'control_play', sensor: 'linegraph_curve_default',
    binary_sensor: 'information', person: 'person', device_tracker: 'person',
    camera: 'camera_generic', alarm_control_panel: 'alarm', number: 'list', input_number: 'list',
    select: 'list', input_select: 'list', weather: 'cloud', update: 'update', vacuum: 'home',
    lawn_mower: 'home'
  };
  function iconFor(id, st) {
    var d = domainOf(id), a = (st && st.a) || {};
    if (d === 'lock' && st && st.s !== 'locked') return 'unlock';
    if (d === 'media_player' && a.device_class === 'speaker') return 'speaker';
    if (d === 'binary_sensor' && (a.device_class === 'motion' || a.device_class === 'occupancy' ||
      a.device_class === 'presence')) return 'person';
    return ICONS[d] || 'home';
  }
  // Lit cards: the entity is on, open, unlocked, playing, home or heating.
  var ACTIVE = { on: 1, open: 1, opening: 1, unlocked: 1, playing: 1, home: 1, cleaning: 1, mowing: 1,
    heat: 1, cool: 1, heat_cool: 1, auto: 1, dry: 1, fan_only: 1, triggered: 1 };
  function isActive(st) { return !!st && !!ACTIVE[st.s]; }

  // One entity card. Read-only entities are not selectable.
  function EntityCard(props) {
    var box = [styles.card, props.box, props.on ? styles.cardOn : null];
    var two = props.box.height >= 96;
    var inner = [
      ce(View, { key: 't', style: styles.cardTop },
        ce(wh.IconPS, { iconId: props.icon, style: [styles.cardIcon, props.on ? null : styles.dim] }),
        ce(Label, { style: styles.cardState, numberOfLines: 1 }, props.value)),
      ce(Label, { key: 'n', style: styles.cardName, numberOfLines: two ? 2 : 1 }, props.name)
    ];
    if (!props.onPress) return ce(View, { style: box }, inner);
    return ce(wh.Focusable, { onPress: props.onPress, buttons: props.buttons, autoSelect: props.autoSelect,
      style: box, focusedStyle: styles.cardFocus }, inner);
  }

  function confirmDialog(ask, setAsk) {
    if (!ask) return null;
    function answer(yes) { return function () { setAsk(null); if (yes) ask.run(); }; }
    return ce(wh.AlertDialogPS, {
      title: ask.verb + ' ' + ask.name + '?',
      buttons: {
        positive: { text: ask.verb, onPress: answer(true) },
        negative: { text: 'Cancel', onPress: answer(false) }
      },
      onRequestClose: answer(false)
    }, ce(wh.Text, null, ask.verb === 'Unlock' ? 'This unlocks it for anyone nearby.' : 'This opens it for anyone nearby.'));
  }

  function HomeAssistant(props) {
    var cfg = props.config || {};
    var hubVisible = props.hubVisible !== false;          // undefined on older loaders
    var status = useStatus();
    var picks = usePicks(props.storage, hubVisible);
    useConnection(cfg, hubVisible);
    var states = useEntities(picks || [], hubVisible && status === 'ok');
    var a = React.useState(null), ask = a[0], setAsk = a[1];
    var tp = React.useState(0), top = tp[0], setTop = tp[1];             // first row shown
    var sp = React.useState(null), scrollPick = sp[0], setScrollPick = sp[1]; // card to select after a scroll
    var unitT = client.info.tempUnit;

    function openPage(view) {
      if (props.openPage) props.openPage({ view: view });
    }
    // X reaches this only when no row is selectable (otherwise it enters the tile).
    wh.onPressed(B.Cross, function () {
      if (configured(cfg) && status === 'ok') openPage(picks && picks.length ? 'home' : 'pick');
    });
    wh.onPressed(B.Square, function () {
      if (configured(cfg)) openPage('home');
    });

    var W = props.width || 504, H = props.height || 152;
    var grid = cardGrid(W, H, (props.settings || {}).columns), cols = grid.cols;
    var msg = statusMessage(status, cfg);
    var body = [], range = null;

    if (msg && !(status === 'ok')) {
      body.push(ce(Label, { key: 'm', style: styles.note }, msg));
    } else if (picks && !picks.length) {
      body.push(ce(Label, { key: 'm', style: styles.note }, 'Press X to choose entities'));
    } else if (picks) {
      var n = picks.length;
      var presses = picks.map(function (id) {
        var st = states[id], act = actionFor(id, st), name = nameOf(id, st);
        if (act && act.page) return function () { openPage('home'); };
        if (!act) return null;
        return function () {
          var run = function () { runAction(id, act); };
          if (act.confirm) setAsk({ verb: act.confirm, name: name, run: run });
          else run();
        };
      });
      var canSelect = function (i) { return !!presses[i]; };
      var t = Math.min(top, Math.max(0, Math.ceil(n / cols) - grid.rows));
      var first = t * cols, end = Math.min(n, first + grid.rows * cols);
      var scroll = function (from, dir) {
        var to = scrollTarget(n, cols, from, dir, canSelect);
        if (!to) return false;                       // the loader plays the blocked sound
        setTop(dir > 0 ? to.row - grid.rows + 1 : to.row);
        setScrollPick(picks[to.index]);
        wh.playSound('move');
      };
      var cards = picks.slice(first, end).map(function (id, j) {
        var i = first + j, row = Math.floor(i / cols), st = states[id];
        var buttons = {};
        if (row === t + grid.rows - 1) buttons[B.Down] = function () { return scroll(i, 1); };
        if (row === t && t > 0) buttons[B.Up] = function () { return scroll(i, -1); };
        return ce(EntityCard, { key: id, name: nameOf(id, st), value: stateText(id, st, unitT), icon: iconFor(id, st),
          on: isActive(st), box: cardBox(grid, j), onPress: presses[i], buttons: buttons,
          autoSelect: id === scrollPick });
      });
      if (n > end - first) range = (first + 1) + '-' + end + ' of ' + n;
      body.push(ce(View, { key: 'g', style: styles.grid }, cards));
    }

    return ce(View, { style: [styles.body, { width: W, height: H }] },
      ce(wh.Title, { iconId: cfg.iconId || 'home', badge: range || (props.active ? 'Square: all' : null) },
        cfg.title || 'Home Assistant'),
      body,
      confirmDialog(ask, setAsk));
  }

  // ---------------------------------------------------------------- page

  var M = wh.MenuListItemPS;

  function pickerItems(pairs) {
    return pairs.map(function (p) {
      return ce(wh.Picker.Item, { key: String(p[1]), label: String(p[0]), value: p[1] });
    });
  }

  // Target temperatures from min_temp to max_temp in target_temp_step steps.
  function tempSteps(a, unitT) {
    var step = +a.target_temp_step || (/F/.test(unitT) ? 1 : 0.5);
    var lo = isNum(a.min_temp) ? +a.min_temp : 7, hi = isNum(a.max_temp) ? +a.max_temp : 35;
    var out = [];
    for (var t = lo; t <= hi + 1e-9 && out.length < 200; t += step) out.push(t.toFixed(1));
    return out;
  }
  function nearest(list, v) {
    if (!isNum(v)) return list[0];
    var best = list[0];
    for (var i = 1; i < list.length; i++) if (Math.abs(+list[i] - v) < Math.abs(+best - v)) best = list[i];
    return best;
  }

  // A slider row for entities with a level: light brightness, fan speed, cover
  // position, media volume, number value. `scale` turns the slider value into the
  // service field (volume_level is 0-1).
  function sliderFor(id, st) {
    var d = domainOf(id), a = st.a || {}, name = nameOf(id, st);
    function row(label, value, min, max, step, service, field, scale) {
      // Each press moves the slider one step: keep it to about 100 positions so a
      // wide range (1-1000 in steps of 1) still moves visibly.
      if ((max - min) / step > 100) step = step * Math.ceil((max - min) / 100 / step);
      var unit = d === 'number' || d === 'input_number' ? (a.unit_of_measurement || '') : '%';
      return { kind: 'slider', id: id, name: label, value: value, min: min, max: max, step: step,
        service: service, field: field, scale: scale || 1, unit: unit, desc: sliderText(value, unit) };
    }
    if (d === 'light') {
      var modes = a.supported_color_modes || [];
      var dims = modes.length && !(modes.length === 1 && modes[0] === 'onoff');
      if (!dims) return null;
      return row(name + ' brightness', st.s === 'on' && a.brightness != null ? Math.round(a.brightness / 2.55) : 0,
        0, 100, 1, 'turn_on', 'brightness_pct');
    }
    if (d === 'fan' && a.percentage != null) {
      return row(name + ' speed', +a.percentage || 0, 0, 100, +a.percentage_step || 1, 'set_percentage', 'percentage');
    }
    if (d === 'cover' && a.current_position != null) {
      return row(name + ' position', +a.current_position, 0, 100, 1, 'set_cover_position', 'position');
    }
    if (d === 'media_player' && a.volume_level != null) {
      return row(name + ' volume', Math.round(a.volume_level * 100), 0, 100, 1, 'volume_set', 'volume_level', 0.01);
    }
    if ((d === 'number' || d === 'input_number') && isNum(st.s)) {
      return row(name, +st.s, isNum(a.min) ? +a.min : 0, isNum(a.max) ? +a.max : 100, +a.step || 1, 'set_value', 'value');
    }
    return null;
  }

  function sliderText(v, unit) {
    return fmtNum(v) + (unit === '%' ? '%' : unit ? ' ' + unit : '');
  }
  // The slider's value from its callback (a number on 13.20), snapped to the row's
  // step and range.
  function sliderValue(row, v) {
    if (v && typeof v === 'object') v = v.nativeEvent ? v.nativeEvent.value : v.value;
    var x = +v;
    if (isNaN(x)) return null;
    x = row.min + Math.round((x - row.min) / row.step) * row.step;
    return Math.round(Math.min(row.max, Math.max(row.min, x)) * 1000) / 1000;
  }

  // Page rows for one entity: plain data, rendered by renderHomeRow.
  function entityRows(id, st, unitT) {
    var d = domainOf(id), a = (st && st.a) || {}, name = nameOf(id, st), desc = stateText(id, st, unitT);
    var off = !st || st.s === 'unavailable';
    var slider = off ? null : sliderFor(id, st);
    if (!off && (TOGGLE[d] || d === 'valve')) {
      var sw = [{ kind: 'switch', id: id, name: name, desc: desc, on: d === 'valve' ? st.s === 'open' : st.s === 'on' }];
      return slider ? sw.concat([slider]) : sw;
    }
    if (slider) return [slider];
    if (!off && (d === 'climate' || d === 'water_heater')) {
      var rows = [], steps = tempSteps(a, unitT);
      if (a.temperature != null || d === 'water_heater') {
        rows.push({ kind: 'temp', id: id, name: name, desc: desc, steps: steps, unitT: unitT,
          value: nearest(steps, a.temperature), field: 'temperature' });
      } else if (a.target_temp_low != null) {
        rows.push({ kind: 'temp', id: id, name: name + ' low', desc: desc, steps: steps, unitT: unitT,
          value: nearest(steps, a.target_temp_low), field: 'target_temp_low', other: a.target_temp_high });
        rows.push({ kind: 'temp', id: id, name: name + ' high', desc: desc, steps: steps, unitT: unitT,
          value: nearest(steps, a.target_temp_high), field: 'target_temp_high', other: a.target_temp_low });
      }
      var modes = d === 'climate' ? a.hvac_modes : a.operation_list;
      if (Array.isArray(modes) && modes.length) {
        rows.push({ kind: 'mode', id: id, name: name + ' mode', modes: modes, value: st.s,
          service: d === 'climate' ? 'set_hvac_mode' : 'set_operation_mode',
          field: d === 'climate' ? 'hvac_mode' : 'operation_mode' });
      }
      if (rows.length) return rows;
    }
    var act = actionFor(id, st);
    return [{ kind: act && !act.page ? 'action' : 'info', id: id, name: name, desc: desc, act: act }];
  }

  function HomeAssistantPage(props) {
    var cfg = props.config || {};
    var status = useStatus();
    useConnection(cfg, true);
    var v = React.useState((props.params && props.params.view) || 'home'), view = v[0], setView = v[1];
    var p = React.useState(null), picks = p[0], setPicks = p[1];
    var a = React.useState(null), ask = a[0], setAsk = a[1];
    // "Name: value" of the slider being adjusted, shown above the list: changing a
    // slider row's props while it is being adjusted ends the adjustment.
    var lv = React.useState(null), live = lv[0], setLive = lv[1];
    var unitT = client.info.tempUnit;

    React.useEffect(function () {
      props.storage.get('entities', []).then(function (list) { setPicks(Array.isArray(list) ? list : []); });
    }, []);
    function savePicks(next) {
      setPicks(next);
      props.storage.set('entities', next);
    }

    var states = useEntities(view === 'home' ? (picks || []) : [], status === 'ok');

    // ---- chooser data: every entity, read once per visit to the chooser
    var all = React.useState(null), allStates = all[0], setAll = all[1];
    var f = React.useState('all'), filter = f[0], setFilter = f[1];
    var q = React.useState(''), query = q[0], setQuery = q[1];
    React.useEffect(function () {
      if (view !== 'pick' || status !== 'ok') return;
      var live = true;
      client.getStates(function (err, list) {
        if (!live) return;
        if (err) { log('get_states failed: ' + err); setAll([]); return; }
        var out = (list || []).map(function (e) {
          return { id: e.entity_id, st: { s: e.state, a: e.attributes || {} } };
        });
        out.sort(function (x, y) {
          var nx = nameOf(x.id, x.st).toLowerCase(), ny = nameOf(y.id, y.st).toLowerCase();
          return nx < ny ? -1 : nx > ny ? 1 : 0;
        });
        log('chooser: ' + out.length + ' entities');
        setAll(out);
      });
      return function () { live = false; };
    }, [view, status]);

    // Row objects are cached per entity and choice, so toggling one re-renders one row.
    var cache = React.useRef({});
    var rows = React.useMemo(function () {
      var out = [];
      var msg = statusMessage(status, cfg);
      if (msg && status !== 'ok') out.push({ kind: 'note', name: msg });
      if (!picks) return out;
      if (view === 'home') {
        out.push({ kind: 'pick', name: 'Choose entities', desc: picks.length + ' chosen' });
        picks.forEach(function (id) { out = out.concat(entityRows(id, states[id], unitT)); });
        return out;
      }
      out.push({ kind: 'done', name: 'Done', desc: 'Back to your entities' });
      if (!allStates) { if (status === 'ok') out.push({ kind: 'note', name: 'Loading entities...' }); return out; }
      var counts = {};
      allStates.forEach(function (e) { var d = domainOf(e.id); counts[d] = (counts[d] || 0) + 1; });
      out.push({ kind: 'filter', value: filter, counts: counts, total: allStates.length });
      var needle = query.toLowerCase();
      var chosen = {};
      picks.forEach(function (id) { chosen[id] = 1; });
      allStates.forEach(function (e) {
        if (filter !== 'all' && domainOf(e.id) !== filter) return;
        var name = nameOf(e.id, e.st);
        if (needle && name.toLowerCase().indexOf(needle) < 0 && e.id.indexOf(needle) < 0) return;
        var key = e.id + (chosen[e.id] ? '|1' : '|0');
        var row = cache.current[key];
        if (!row) {
          row = cache.current[key] = { kind: 'choose', id: e.id, name: name,
            desc: e.id + ' - ' + stateText(e.id, e.st, unitT), on: !!chosen[e.id] };
        }
        out.push(row);
      });
      if (out.length && out[out.length - 1].kind === 'filter') out.push({ kind: 'note', name: 'No entities match' });
      return out;
    }, [view, status, picks, states, allStates, filter, query, unitT]);

    function call(id, service, data) {
      client.call(domainOf(id), service, id, data, function (err) {
        if (err) { log(service + ' ' + id + ' failed: ' + err); wh.playSound('error'); }
      });
    }

    function renderItem(row) {
      switch (row.kind) {
        case 'pick':
          return ce(M.Button, { label: row.name, description: row.desc, onPress: function () { setView('pick'); } });
        case 'done':
          return ce(M.Button, { label: row.name, description: row.desc,
            onPress: function () { setQuery(''); setFilter('all'); setView('home'); } });
        case 'note':
          return ce(M.Button, { label: row.name, onPress: function () {} });
        case 'filter': {
          var doms = Object.keys(row.counts).sort();
          return ce(M.Dropdown, {
            label: 'Show', value: row.value, onValueChange: setFilter,
            items: pickerItems([['All (' + row.total + ')', 'all']].concat(doms.map(function (d) {
              return [word(d) + ' (' + row.counts[d] + ')', d];
            })))
          });
        }
        case 'choose':
          return ce(M.Switch, {
            label: trunc(row.name, 60), description: trunc(row.desc, 90), value: row.on,
            onValueChange: function (on) {
              var next = picks.filter(function (x) { return x !== row.id; });
              if (on) next.push(row.id);
              savePicks(next);
            }
          });
        case 'switch':
          return ce(M.Switch, {
            label: trunc(row.name, 60), description: row.desc, value: row.on,
            onValueChange: function (on) {
              var d = domainOf(row.id);
              call(row.id, d === 'valve' ? (on ? 'open_valve' : 'close_valve') : (on ? 'turn_on' : 'turn_off'));
            }
          });
        case 'temp':
          return ce(M.Dropdown, {
            label: trunc(row.name, 60), description: row.desc, value: row.value,
            items: pickerItems(row.steps.map(function (t) { return [fmtNum(t) + row.unitT, t]; })),
            onValueChange: function (t) {
              var data = {};
              data[row.field] = +t;
              if (row.field === 'target_temp_low') data.target_temp_high = row.other;
              if (row.field === 'target_temp_high') data.target_temp_low = row.other;
              call(row.id, 'set_temperature', data);
            }
          });
        case 'slider':
          return ce(M.Slider, {
            label: trunc(row.name, 60), description: row.desc, value: row.value,
            minimumValue: row.min, maximumValue: row.max, step: row.step,
            // While the user adjusts (X to start, left / right, X to set), show the
            // value above the list; HA gets it only when it is set.
            onValueChanging: function (v) {
              var x = sliderValue(row, v);
              if (x != null) setLive(trunc(row.name, 60) + ': ' + sliderText(x, row.unit));
            },
            onValueChange: function (v) {
              var x = sliderValue(row, v);
              setLive(null);
              if (x == null) return;
              var data = {};
              data[row.field] = Math.round(x * row.scale * 1000) / 1000;
              if (row.field === 'brightness_pct' && x === 0) call(row.id, 'turn_off');
              else call(row.id, row.service, data);
            }
          });
        case 'mode':
          return ce(M.Dropdown, {
            label: trunc(row.name, 60), value: row.value,
            items: pickerItems(row.modes.map(function (m) { return [word(m), m]; })),
            onValueChange: function (m) {
              var data = {};
              data[row.field] = m;
              call(row.id, row.service, data);
            }
          });
        case 'action':
          return ce(M.Button, {
            label: trunc(row.name, 60), description: row.desc,
            onPress: function () {
              var run = function () { runAction(row.id, row.act); };
              if (row.act.confirm) setAsk({ verb: row.act.confirm, name: row.name, run: run });
              else run();
            }
          });
        default:
          return ce(M.Button, { label: trunc(row.name, 60), description: row.desc, onPress: function () {} });
      }
    }

    if (!wh.List || !M || !wh.Picker) {
      return ce(View, { style: styles.pageRoot },
        ce(Label, null, 'This page needs a newer wh_bridge payload.'));
    }
    var head = [ce(Label, { key: 't', style: styles.pageTitle }, view === 'pick' ? 'Choose entities' : (cfg.title || 'Home Assistant'))];
    if (view === 'home') {
      head.push(ce(Label, { key: 'n', style: styles.pageNote },
        live || 'Sliders: X to adjust, left and right to change, X to set.'));
    }
    if (view === 'pick') {
      head.push(ce(Label, { key: 'n', style: styles.pageNote },
        'Chosen entities show on the tile in the order you choose them.'));
      if (wh.TextInput) {
        head.push(ce(wh.TextInput, {
          key: 's', value: query, placeholder: 'Search', keyboardWindowTitle: 'Search entities',
          focusable: true, style: styles.search, onChangeText: setQuery
        }));
      }
    }
    return ce(View, { style: styles.pageRoot },
      ce(View, { style: styles.pageBox },
        head,
        ce(wh.List, { key: view, data: rows, renderItem: renderItem, style: styles.list })),
      confirmDialog(ask, setAsk));
  }

  wh.register(HomeAssistant);
  wh.registerPage(HomeAssistantPage);
})(globalThis.__wh);
