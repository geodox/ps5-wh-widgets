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

  var F = wh.FontSizePS;
  var styles = wh.StyleSheet.create({
    body: { flex: 1, padding: 16 },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    card: { borderRadius: 12, borderWidth: 2, borderColor: 'transparent', padding: 6,
      backgroundColor: 'rgba(255,255,255,0.08)' },
    cardFocus: { borderColor: '#ffffff', backgroundColor: 'rgba(255,255,255,0.22)' },
    cardTop: { flexDirection: 'row', alignItems: 'center', height: 24 },
    cardIcon: { width: 24, height: 24 },
    cardPort: { flex: 1, marginLeft: 6, textAlign: 'right', fontSize: F.Size4XSmall, opacity: 0.7 },
    cardName: { fontSize: F.Size3XSmall, marginTop: 4 },
    dim: { opacity: 0.6 }
  });

  // Cards: `columns` per row (the Cards per row setting; twice that on an XL tile,
  // which is two tiles wide), as many rows as the tile height allows.
  var GAP = 8, MIN_H = 64;
  function cardGrid(W, H, columns) {
    var cols = (+columns || 2) * (W > 600 ? 2 : 1);
    var avail = H - 64 - (H > 200 ? 48 : 16);   // title row above, focus key guide below
    var rows = Math.max(1, Math.floor((avail + GAP) / (MIN_H + GAP)));
    return { cols: cols, rows: rows, w: Math.floor((W - 32 - GAP * (cols - 1)) / cols),
      h: Math.floor((avail - GAP * (rows - 1)) / rows) };
  }
  function cardBox(g, i) {
    return { width: g.w, height: g.h, marginRight: i % g.cols === g.cols - 1 ? 0 : GAP, marginBottom: GAP };
  }
  // Scrolling: the grid shows g.rows rows from row `top`. Down on a card in the last
  // row shown (Up in the first) scrolls one row and selects the card nearest the same
  // column. The card's `buttons` get the arrow before the loader moves the selection;
  // `autoSelect` selects the card that scrolls in. Returns the index, or -1.
  function scrollTarget(n, cols, from, dir) {
    var row = Math.floor(from / cols) + dir;
    if (row < 0 || row * cols >= n) return -1;
    return Math.min(n - 1, row * cols + from % cols);
  }

  function PageCard(props) {
    var p = props.page;
    return ce(wh.Focusable, {
      onPress: function () { wh.launch(url(p.port)); },
      buttons: props.buttons,
      autoSelect: props.autoSelect,
      style: [styles.card, props.box],
      focusedStyle: styles.cardFocus
    }, [
      ce(View, { key: 't', style: styles.cardTop },
        ce(wh.IconPS, { iconId: 'internet_browser', style: styles.cardIcon }),
        ce(Label, { style: styles.cardPort, numberOfLines: 1 }, ':' + p.port)),
      ce(Label, { key: 'n', style: styles.cardName, numberOfLines: props.box.height >= 96 ? 2 : 1 }, p.name)
    ]);
  }

  function PayloadLauncher(props) {
    var st = React.useState(null), pages = st[0], setPages = st[1];
    var mounted = React.useRef(true);
    var tp = React.useState(0), top = tp[0], setTop = tp[1];             // first row shown
    var sp = React.useState(null), scrollPick = sp[0], setScrollPick = sp[1]; // port to select after a scroll
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
    var grid = cardGrid(W, H, (props.settings || {}).columns), cols = grid.cols;

    var body, range = null;
    if (!pages) body = ce(Label, { style: styles.dim }, 'Looking for payload pages...');
    else if (!pages.length) body = ce(Label, { style: styles.dim }, 'No payload pages found');
    else {
      var n = pages.length;
      var t = Math.min(top, Math.max(0, Math.ceil(n / cols) - grid.rows));
      var first = t * cols, end = Math.min(n, first + grid.rows * cols);
      var scroll = function (from, dir) {
        var to = scrollTarget(n, cols, from, dir);
        if (to < 0) return false;                    // the loader plays the blocked sound
        var row = Math.floor(to / cols);
        setTop(dir > 0 ? row - grid.rows + 1 : row);
        setScrollPick(pages[to].port);
        wh.playSound('move');
      };
      var cards = pages.slice(first, end).map(function (p, j) {
        var i = first + j, row = Math.floor(i / cols);
        var buttons = {};
        if (row === t + grid.rows - 1) buttons[wh.Button.Down] = function () { return scroll(i, 1); };
        if (row === t && t > 0) buttons[wh.Button.Up] = function () { return scroll(i, -1); };
        return ce(PageCard, { key: String(p.port), page: p, box: cardBox(grid, j), buttons: buttons,
          autoSelect: p.port === scrollPick });
      });
      if (n > end - first) range = (first + 1) + '-' + end + ' of ' + n;
      body = ce(View, { style: styles.grid }, cards);
    }

    var cfg = props.config || {};
    var badge = range || (props.active ? 'X: open' : (pages && pages.length ? pages.length + ' found' : null));
    return ce(View, { style: { width: W, height: H } },
      ce(View, { style: styles.body },
        ce(wh.Title, { iconId: cfg.iconId, badge: badge, style: { marginBottom: 8 } }, cfg.title || 'Payload Launcher'),
        body
      )
    );
  }

  wh.register(PayloadLauncher);
})(globalThis.__wh);
