// console-stats - temperatures, fan, storage and uptime, read from the payload's
// /__stats endpoint. Reference for:
//   props.hubVisible  polling stops while a page, Settings or the screensaver
//                     covers the tiles
//   settings          temperature unit and refresh interval (Options)
//   sizes             DEFAULT shows the headline numbers; LARGE and FULL add a
//                     usage bar per drive
(function (wh) {
  var React = wh.React;
  var View = wh.View;
  var Label = wh.Label;
  var ce = React.createElement;
  var F = wh.FontSizePS;

  var STATS_URL = 'http://127.0.0.1:8098/__stats';
  var WARM_C = 80, HOT_C = 90;            // value colors: warm / hot
  var DEG = String.fromCharCode(176);     // degree sign (keeps the source ASCII)

  var styles = wh.StyleSheet.create({
    body: { flex: 1, padding: 16 },
    cells: { flexDirection: 'row', marginTop: 8 },
    cell: { flex: 1 },
    value: { fontSize: F.SizeSmall },
    caption: { fontSize: F.Size3XSmall, opacity: 0.6 },
    warm: { color: '#ffb347' },
    hot: { color: '#ff5a4f' },
    section: { marginTop: 16 },
    barRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
    track: { height: 6, borderRadius: 3, marginTop: 6, backgroundColor: '#ffffff1f' },
    fill: { height: 6, borderRadius: 3, backgroundColor: '#ffffff' },
    error: { fontSize: F.Size3XSmall, opacity: 0.6, marginTop: 12 }
  });

  var DRIVE_NAMES = { internal: 'Console storage', m2: 'M.2 SSD', extended: 'Extended storage' };
  function driveName(name) {
    if (DRIVE_NAMES[name]) return DRIVE_NAMES[name];
    var usb = /^usb(\d+)$/.exec(name);
    return usb ? 'USB drive' + (usb[1] !== '0' ? ' ' + (+usb[1] + 1) : '') : name;
  }

  function gb(bytes) {
    var v = bytes / 1e9;
    return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + ' GB';
  }
  function temp(c, unit) {
    if (c == null) return '-';
    return unit === 'f' ? Math.round(c * 9 / 5 + 32) + DEG + 'F' : c + DEG + 'C';
  }
  function tempStyle(c) {
    return c == null ? null : c >= HOT_C ? styles.hot : c >= WARM_C ? styles.warm : null;
  }
  function watts(mw) {
    if (mw == null) return '-';
    return (mw / 1000).toFixed(1) + 'W';
  }
  function mhz(v) {
    if (v == null) return '-';
    return v >= 1000 ? (v / 1000).toFixed(2) + ' GHz' : v + ' MHz';
  }
  function uptime(s) {
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm';
  }

  function Cell(props) {
    return ce(View, { style: styles.cell },
      ce(Label, { style: [styles.value, props.style] }, props.value),
      ce(Label, { style: styles.caption }, props.caption));
  }

  // A labelled usage bar: used / total.
  function Bar(props) {
    var used = Math.max(0, props.total - props.free);
    var w = props.width * (props.total > 0 ? Math.min(1, used / props.total) : 0);
    return ce(View, null,
      ce(View, { style: styles.barRow },
        ce(Label, { style: styles.caption }, props.label),
        ce(Label, { style: styles.caption }, gb(props.free) + ' free of ' + gb(props.total))),
      ce(View, { style: [styles.track, { width: props.width }] },
        ce(View, { style: [styles.fill, { width: w }] })));
  }

  function ConsoleStats(props) {
    var settings = props.settings || {};
    var unit = settings.unit === 'f' ? 'f' : 'c';
    var showPower = settings.showPower === 'on';
    var refreshMs = (parseInt(settings.refresh, 10) || 5) * 1000;
    var st = React.useState(null), stats = st[0], setStats = st[1];
    var er = React.useState(null), err = er[0], setErr = er[1];
    var hubVisible = props.hubVisible !== false;      // undefined on older loaders

    React.useEffect(function () {
      if (!hubVisible) return;
      var live = true;
      function load() {
        fetch(STATS_URL)
          .then(function (r) { return r.json(); })
          .then(function (d) { if (live) { setStats(d); setErr(null); } })
          .catch(function (e) { if (live) setErr((e && e.message) || 'no data'); });
      }
      load();
      var id = setInterval(load, refreshMs);
      return function () { live = false; clearInterval(id); };
    }, [hubVisible, refreshMs]);

    var cfg = props.config || {};
    var W = props.width || 504, H = props.height || 152;
    var inner = W - 32;
    var s = stats || {};
    var drives = s.storage || [];
    var internal = drives.filter(function (d) { return d.name === 'internal'; })[0];

    var headlineCells = [
      ce(Cell, { key: 'cpu', value: temp(s.cpuTemp, unit), caption: 'CPU', style: tempStyle(s.cpuTemp) }),
      ce(Cell, { key: 'soc', value: temp(s.socTemp, unit), caption: 'SoC', style: tempStyle(s.socTemp) }),
      ce(Cell, { key: 'fan', value: s.fan == null ? '-' : s.fan + '%', caption: 'Fan' }),
      ce(Cell, { key: 'free', value: internal ? gb(internal.free) : '-', caption: 'Free' })
    ];
    if (showPower && H <= 200) {
      headlineCells.push(ce(Cell, { key: 'pwr', value: watts(s.socPowerMw), caption: 'Power' }));
    }

    var body = [
      // The console's own thermal alert outranks the uptime badge.
      ce(wh.Title, { key: 't', iconId: cfg.iconId || 'ps5',
        badge: s.thermalAlert ? 'Thermal alert' : s.uptime != null ? 'Up ' + uptime(s.uptime) : null },
        cfg.title || 'Console Stats'),
      ce(View, { key: 'c', style: styles.cells }, headlineCells)
    ];
    if (!stats && err) body.push(ce(Label, { key: 'e', style: styles.error }, 'Stats unavailable: ' + err));

    if (stats && H > 200) {
      var extraH = 0;
      if (showPower) {
        extraH = 72;
        body.push(
          ce(View, { key: 'p', style: [styles.cells, styles.section] },
            ce(Cell, { key: 'tot', value: watts(s.socPowerMw), caption: 'SoC Power' }),
            ce(Cell, { key: 'gfx', value: watts(s.gfxPowerMw), caption: 'GFX ' + mhz(s.gfxClockMhz) }),
            ce(Cell, { key: 'cpup', value: watts(s.cpuPowerMw), caption: 'CPU ' + mhz(s.cpuClockMhz) }))
        );
      }
      var bars = [];
      drives.forEach(function (d) {
        bars.push(ce(Bar, { key: d.name, label: driveName(d.name), total: d.total, free: d.free, width: inner }));
      });
      // As many bars as fit above the frame's bottom key guide (about 48 px while
      // the tile is focused): padding, title row, number row, section gap.
      var room = Math.max(1, Math.floor((H - 32 - 40 - 64 - 16 - extraH - 48) / 42));
      body.push(ce(View, { key: 'b', style: styles.section }, bars.slice(0, room)));
    }

    return ce(View, { style: [styles.body, { width: W, height: H }] }, body);
  }

  wh.register(ConsoleStats);
})(globalThis.__wh);
