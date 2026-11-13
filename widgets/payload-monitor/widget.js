// Payload Monitor - live non-stock payload list from ps5-payload-manager (:8084)
// Drop-in Welcome Hub widget. No import/require. Gets RN primitives from wh.
(function (wh) {
  var React = wh.React;
  var View = wh.View;
  var ce = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;

  var PROCS_URL = 'http://127.0.0.1:8084/processes_list';

  // Sony/system processes to hide, so only non-stock payloads show.
  var STOCK = {
    kernel: 1, intr: 1, idle: 1, usb: 1, cam: 1, geom: 1, audit: 1,
    pagedaemon: 1, localpagedaemon: 1, rand_harvestq: 1, bufdaemon: 1,
    syncer: 1, vnlru: 1,
    'mini-syscore.elf': 1, 'AgcCompositor.elf': 1, 'orbis_audiod.elf': 1,
    'webrtc_daemon.self': 1, 'fs_cleaner.elf': 1
  };
  function isPayload(p) {
    var nm = String(p.name || '');
    if (nm.indexOf('Sce') === 0) return false; // Sony-prefixed
    return STOCK[nm] !== 1;
  }

  function PayloadMonitor(props) {
    var focused = props && props.focused;

    var procState = useState(null);
    var procs = procState[0];
    var setProcs = procState[1];
    var errState = useState(null);
    var err = errState[0];
    var setErr = errState[1];
    var mounted = useRef(true);

    useEffect(function () {
      mounted.current = true;
      function load() {
        try {
          fetch(PROCS_URL, { headers: { Accept: 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!mounted.current) return;
              var list = (d && Array.isArray(d.processes)) ? d.processes : [];
              setProcs(list.filter(isPayload));   // sorted at render from props.settings
              setErr(null);
            })
            .catch(function (e) {
              if (mounted.current) setErr((e && e.message) || 'fetch failed');
            });
        } catch (e) {
          if (mounted.current) setErr('err');
        }
      }
      load();
      var id = setInterval(load, 3000);
      return function () { mounted.current = false; clearInterval(id); };
    }, []);

    // Tile size comes from the grid (L1/R1 resize in edit mode): fill the given
    // height and show as many rows as fit (padding 32 + header 38, ~30px per row).
    var W = (props && props.width) || 504;
    var H = (props && props.height) || 152;
    // padding 32 + stock title row 40 + gap 8. Short tiles (DEFAULT) use compact
    // 24px rows with size-18 names so 3 rows fit; taller tiles use 32px rows.
    var COMPACT = H < 300;
    var ROW_H = COMPACT ? 24 : 32;
    var maxRows = Math.max(1, Math.floor((H - 32 - 48) / ROW_H));

    // Stock text: wh.Label = hub Text (size 21, theme color, font scaling capped);
    // secondary info is dimmed with opacity rather than a custom color.
    var Label = wh.Label;
    var DIM = { opacity: 0.6 };
    var SMALL = { fontSize: 18 };   // FontSizePS.Size3XSmall

    // Settings (config.json "settings" -> props.settings; menu on the Options button).
    var set = props.settings || {};
    var showPid = set.showPid !== false;
    if (procs) {
      procs = procs.slice().sort(set.sort === 'name'
        ? function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); }
        : function (a, b) { return (b.memory || 0) - (a.memory || 0); });
    }

    var rows = [];
    if (procs) {
      // If the list doesn't fit, the last visible row becomes "+N more" instead
      // of silently dropping payloads (the list is sorted by memory, biggest first).
      var shown = procs.length > maxRows ? maxRows - 1 : procs.length;
      for (var i = 0; i < shown; i++) {
        var p = procs[i];
        rows.push(
          ce(View, {
            key: String(p.pid || i),
            style: { flexDirection: 'row', alignItems: 'center', height: ROW_H }
          },
            ce(View, { style: { width: 10, height: 10, borderRadius: 5, backgroundColor: p.is_daemon ? '#16a34a' : '#60a5fa', marginRight: 10 } }),
            ce(Label, { style: COMPACT ? [SMALL, { flex: 1 }] : { flex: 1 } }, String(p.name || '?')),
            showPid ? ce(Label, { style: [SMALL, DIM, { marginRight: 12 }] }, String(p.pid)) : null,
            ce(Label, { style: [SMALL, DIM, { minWidth: 72, textAlign: 'right' }] }, (p.memory != null ? ((Math.round(p.memory * 10) / 10) + ' MB') : ''))
          )
        );
      }
      var hidden = procs.length - shown;
      if (hidden > 0) {
        rows.push(
          ce(View, { key: '__more', style: { flexDirection: 'row', alignItems: 'center', height: ROW_H } },
            ce(View, { style: { width: 10, marginRight: 10 } }),
            ce(Label, { style: [SMALL, DIM] }, '+' + hidden + ' more' + (shown ? '' : ' running'))
          )
        );
      }
    }

    var body;
    if (err && !procs) {
      body = ce(Label, { style: DIM, numberOfLines: 2 }, 'Error: ' + err);
    } else if (!procs) {
      body = ce(Label, { style: DIM }, 'Loading...');
    } else if (!procs.length) {
      body = ce(Label, { style: DIM }, 'No payloads running');
    } else {
      body = ce(View, null, rows);
    }

    var count = procs ? procs.length : 0;
    // Stock title row: 40px white glyph + bold 21 title + right-aligned badge.
    // iconId = 'wh:payload-monitor': the payload manager icon as a white glyph
    // (config.json "glyph": "glyph.png", served by the framework's asset server).
    var cfg = (props && props.config) || {};
    var header = ce(wh.Title, {
      iconId: cfg.iconId,
      badge: procs ? (count + ' running') : null,
      style: { marginBottom: 8 }
    }, 'Payload Monitor');

    // Stock widget shell: solid mat color (#17191E) with the native lightMat
    // sheen behind the content, rounded + clipped. Focus is handled natively by
    // the loader's FocusLayerPS, so no manual border (matches stock).
    return ce(View, {
      style: { width: W, height: H, borderRadius: 16, overflow: 'hidden' }
    },
      ce(View, {
        lightMat: 'auto',
        style: {
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: '#17191ef0', // stock mat, slight transparency
          borderRadius: 16
        }
      }),
      ce(View, { style: { padding: 16 } }, header, body)
    );
  }

  wh.register(PayloadMonitor);
})(globalThis.__wh);
