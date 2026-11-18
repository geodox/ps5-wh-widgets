// Payload Launcher - lists the payload web pages answering on this console and
// opens one in the console's browser. X enters the tile, arrows pick a page,
// X opens http://127.0.0.1:<port>/ (wh.launch), Circle leaves.
// Detection probes known ports on loopback; process names are not used because
// payloads name their own processes and some move to another port when theirs
// is taken.
(function (wh) {
  var React = wh.React;
  var View = wh.View;
  var Label = wh.Label;
  var ce = React.createElement;

  // Default web UI ports, from each project's README (or its live page).
  // `pick`: several payloads share the port; the page <title> decides the name.
  var PAGES = [
    { port: 7777, name: 'Welcome Hub Activator' },
    { port: 8080, name: 'websrv' },
    { port: 8081, name: 'App Dumper' },
    { port: 8082, name: 'Garlic Save Manager' },
    { port: 8084, name: 'Payload Manager' },
    { port: 8095, name: 'Dump Forge' },
    { port: 8765, name: 'NeoEnabler' },
    { port: 8770, name: 'PS4Mount' },
    { port: 8844, name: 'PKG Manager' },
    { port: 8888, name: 'Web File Manager', pick: [[/zftpd/i, 'zftpd'], [/file manager/i, 'Web File Manager']] },
    { port: 9180, name: 'PS5Upload Minion' },
    { port: 9999, name: 'CheatRunner' },
    { port: 5905, name: 'BFpilot' },
    { port: 10101, name: 'ShadowMount+' },
    { port: 12800, name: 'etaHEN PKG Installer' }
  ];
  var PROBE_MS = 10000;      // how often the ports are probed
  var TIMEOUT_MS = 2000;     // a port that has not answered by then counts as closed

  function url(port) { return 'http://127.0.0.1:' + port + '/'; }

  // Resolves true if anything answers HTTP on the port (any status counts).
  function probe(port) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(false); }, TIMEOUT_MS);
      fetch(url(port), { method: 'HEAD' })
        .then(function () { clearTimeout(t); resolve(true); },
              function () { clearTimeout(t); resolve(false); });
    });
  }

  // Name for a shared port, from the page title; falls back to the table name.
  function nameFor(page) {
    if (!page.pick) return Promise.resolve(page.name);
    return fetch(url(page.port))
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var m = /<title[^>]*>([^<]*)/i.exec(html);
        var title = m ? m[1] : '';
        for (var i = 0; i < page.pick.length; i++) if (page.pick[i][0].test(title)) return page.pick[i][1];
        return page.name;
      }, function () { return page.name; });
  }

  var styles = wh.StyleSheet.create({
    card: { borderRadius: 16, overflow: 'hidden' },
    body: { flex: 1, padding: 16 },
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, borderRadius: 8 },
    rowOn: { backgroundColor: '#ffffff' },
    textOn: { color: '#17191e' },
    small: { fontSize: 18 },
    dim: { opacity: 0.6 }
  });

  function PageRow(props) {
    var p = props.page;
    return ce(wh.Focusable, {
      onPress: function () { wh.launch(url(p.port)); },
      style: [styles.row, { height: props.rowH }],
      focusedStyle: styles.rowOn
    }, function (selected) {
      var on = selected ? styles.textOn : null;
      return [
        ce(Label, { key: 'n', numberOfLines: 1, style: [props.compact ? styles.small : null, { flex: 1 }, on] }, p.name),
        ce(Label, { key: 'p', style: [styles.small, selected ? on : styles.dim] }, ':' + p.port)
      ];
    });
  }

  function PayloadLauncher(props) {
    var st = React.useState(null), pages = st[0], setPages = st[1];
    var mounted = React.useRef(true);
    // Scan only while the tiles can be seen (props.hubVisible, see payload-monitor).
    var hubVisible = props.hubVisible !== false;

    React.useEffect(function () {
      if (!hubVisible) return;
      mounted.current = true;
      var names = {};          // port -> resolved name, kept while the port stays open
      function scan() {
        Promise.all(PAGES.map(function (pg) { return probe(pg.port); })).then(function (open) {
          var found = PAGES.filter(function (pg, i) { return open[i]; });
          return Promise.all(found.map(function (pg) {
            return names[pg.port] ? names[pg.port] : nameFor(pg).then(function (n) { return (names[pg.port] = n); });
          })).then(function (labels) {
            for (var port in names) if (!found.some(function (pg) { return String(pg.port) === port; })) delete names[port];
            if (!mounted.current) return;
            setPages(found.map(function (pg, i) { return { port: pg.port, name: labels[i] }; })
              .sort(function (a, b) { return a.name.localeCompare(b.name); }));
          });
        });
      }
      scan();
      var id = setInterval(scan, PROBE_MS);
      return function () { mounted.current = false; clearInterval(id); };
    }, [hubVisible]);

    var W = props.width || 504, H = props.height || 152;
    var compact = H < 300;
    var rowH = compact ? 28 : 36;
    var maxRows = Math.max(1, Math.floor((H - 32 - 48) / rowH));

    var body;
    if (!pages) body = ce(Label, { style: styles.dim }, 'Looking for payload pages...');
    else if (!pages.length) body = ce(Label, { style: styles.dim }, 'No payload pages found');
    else {
      var shown = pages.length > maxRows ? maxRows - 1 : pages.length;
      var rows = pages.slice(0, shown).map(function (p) {
        return ce(PageRow, { key: String(p.port), page: p, rowH: rowH, compact: compact });
      });
      if (pages.length > shown) {
        rows.push(ce(Label, { key: '__more', style: [styles.small, styles.dim, { paddingHorizontal: 10 }] },
          '+' + (pages.length - shown) + ' more (make the tile bigger)'));
      }
      body = ce(View, null, rows);
    }

    var cfg = props.config || {};
    var badge = props.active ? 'X: open' : (pages && pages.length ? pages.length + ' found' : null);
    return ce(View, { style: [styles.card, { width: W, height: H }] },
      ce(View, { style: styles.body },
        ce(wh.Title, { iconId: cfg.iconId, badge: badge, style: { marginBottom: 8 } }, cfg.title || 'Payload Launcher'),
        body
      )
    );
  }

  wh.register(PayloadLauncher);
})(globalThis.__wh);
