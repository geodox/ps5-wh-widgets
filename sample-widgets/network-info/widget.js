// network-info - local IP, Wi-Fi signal, band, channel, link state and uptime,
// read directly from ShellUI's RN-PS native network modules (completely offline,
// no payload round-trip).
(function (wh) {
  var React = wh.React;
  var View = wh.View;
  var Label = wh.Label;
  var ce = React.createElement;
  var F = wh.FontSizePS;

  var styles = wh.StyleSheet.create({
    body: { flex: 1, padding: 16 },
    cells: { flexDirection: 'row', marginTop: 8 },
    cell: { flex: 1 },
    cellWide: { flex: 2 },
    value: { fontSize: F.SizeSmall },
    caption: { fontSize: F.Size3XSmall, opacity: 0.6 },
    good: { color: '#6ee7a8' },
    warn: { color: '#ffb347' },
    bad: { color: '#ff5a4f' },
    section: { marginTop: 16 },
    barRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
    track: { height: 6, borderRadius: 3, marginTop: 6, backgroundColor: '#ffffff1f' },
    fill: { height: 6, borderRadius: 3, backgroundColor: '#ffffff' },
    error: { fontSize: F.Size3XSmall, opacity: 0.6, marginTop: 12 }
  });

  function getNativeModules() {
    try {
      var req = globalThis.__whRequire;
      if (typeof req !== 'function') return null;
      var rn = req(1);
      return rn && rn.NativeModules ? rn.NativeModules : null;
    } catch (e) {
      return null;
    }
  }

  function safeCall(fn) {
    if (typeof fn !== 'function') return Promise.resolve(null);
    try {
      var r = fn();
      if (r && typeof r.then === 'function') {
        return r.then(function (v) { return v; }, function () { return null; });
      }
      return Promise.resolve(r);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function formatDuration(s) {
    if (s == null || s < 0) return '-';
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm';
  }

  function bandLabel(band) {
    var code = Array.isArray(band) ? band[0] : band;
    if (code === 1) return '2.4 GHz';
    if (code === 2) return '5 GHz';
    if (code === 3) return '6 GHz';
    return null;
  }

  function pickIcon(d) {
    if (!d) return 'wifi';
    if (d.link === 0) return 'wifi_disconnected_status';
    if (d.device === 0) return 'wired';
    var pct = d.rssiPct;
    if (pct == null) return 'wifi';
    if (pct >= 75) return 'wifi';
    if (pct >= 45) return 'wifi_mid';
    if (pct >= 20) return 'wifi_low';
    return 'wifi_lowest';
  }

  function signalStyle(pct) {
    if (pct == null) return null;
    if (pct >= 60) return styles.good;
    if (pct >= 35) return styles.warn;
    return styles.bad;
  }

  function Cell(props) {
    return ce(
      View,
      { style: props.wide ? styles.cellWide : styles.cell },
      ce(Label, { style: [styles.value, props.style] }, props.value),
      ce(Label, { style: styles.caption }, props.caption)
    );
  }

  function NetworkInfo(props) {
    var settings = props.settings || {};
    var refreshMs = (parseInt(settings.refresh, 10) || 5) * 1000;
    var showSsid = settings.showSsid !== 'off';
    var st = React.useState(null), info = st[0], setInfo = st[1];
    var er = React.useState(null), err = er[0], setErr = er[1];
    var hubVisible = props.hubVisible !== false;

    React.useEffect(function () {
      if (!hubVisible) return;
      var live = true;

      function load() {
        var nm = getNativeModules();
        var net = nm && nm.VshNMSystemNetModule;
        var snet = nm && nm.VshNMSettingsNetwork;
        if (!net) {
          if (live) setErr('native network module unavailable');
          return;
        }
        Promise.all([
          safeCall(net.NetCtlGetInfoIpAddress),
          safeCall(net.NetCtlGetInfoDevice),
          safeCall(net.NetCtlGetInfoLink),
          safeCall(net.NetCtlGetInfoSsid),
          safeCall(net.NetCtlGetInfoRssiPercentage),
          safeCall(net.NetCtlGetInfoRssiDbm),
          safeCall(net.NetCtlGetInfoChannel),
          safeCall(net.NetCtlGetInfoConnectElapsedTime),
          safeCall(snet && snet.NetCtlGetInfoBand),
          safeCall(snet && snet.GetNatInfo)
        ]).then(function (r) {
          if (!live) return;
          setInfo({
            ip: r[0],
            device: r[1],
            link: r[2],
            ssid: r[3],
            rssiPct: r[4],
            rssiDbm: r[5],
            channel: r[6],
            elapsed: r[7],
            band: r[8],
            nat: r[9]
          });
          setErr(null);
        }, function (e) {
          if (live) setErr((e && e.message) || 'read failed');
        });
      }

      load();
      var id = setInterval(load, refreshMs);
      return function () { live = false; clearInterval(id); };
    }, [hubVisible, refreshMs]);

    var cfg = props.config || {};
    var W = props.width || 504, H = props.height || 152;
    var inner = W - 32;
    var d = info || {};
    var isWifi = d.device === 1;
    var isWired = d.device === 0;
    var connected = d.link === 1;
    var band = isWifi ? bandLabel(d.band) : null;

    var badge = null;
    if (info) {
      if (!connected) badge = 'Offline';
      else if (isWired) badge = 'Wired';
      else if (isWifi) badge = band ? 'Wi-Fi ' + band : 'Wi-Fi';
    }

    var sigVal = '-';
    var sigSty = null;
    if (info) {
      if (!connected) { sigVal = 'Down'; sigSty = styles.bad; }
      else if (isWired) { sigVal = 'Wired'; sigSty = styles.good; }
      else if (d.rssiPct != null) { sigVal = d.rssiPct + '%'; sigSty = signalStyle(d.rssiPct); }
    }

    var body = [
      ce(
        wh.Title,
        { key: 't', iconId: pickIcon(info), badge: badge },
        cfg.title || 'Network Info'
      ),
      ce(
        View,
        { key: 'c1', style: styles.cells },
        ce(Cell, { wide: true, value: d.ip || '-', caption: 'Local IP' }),
        ce(Cell, { value: sigVal, caption: isWired ? 'Link' : 'Signal', style: sigSty }),
        ce(Cell, { value: connected ? formatDuration(d.elapsed) : '-', caption: 'Connected' })
      )
    ];

    if (!info && err) {
      body.push(ce(Label, { key: 'e', style: styles.error }, 'Network info unavailable: ' + err));
    }

    if (info && H > 200) {
      var details = [];
      if (isWifi && connected && d.rssiPct != null) {
        var fillW = Math.round(inner * Math.max(0, Math.min(100, d.rssiPct)) / 100);
        details.push(
          ce(
            View,
            { key: 'bar' },
            ce(
              View,
              { style: styles.barRow },
              ce(Label, { style: styles.caption }, 'Wi-Fi signal'),
              ce(
                Label,
                { style: styles.caption },
                d.rssiPct + '%' + (d.rssiDbm != null ? ' (' + d.rssiDbm + ' dBm)' : '')
              )
            ),
            ce(
              View,
              { style: [styles.track, { width: inner }] },
              ce(View, { style: [styles.fill, { width: fillW }] })
            )
          )
        );
      }

      var netName = isWired ? 'Ethernet' : (showSsid ? (d.ssid || '-') : 'Hidden');
      var chVal = isWifi && d.channel != null ? 'Ch ' + d.channel : (isWired ? 'LAN' : '-');
      var natType = d.nat && d.nat.natTypeEx > 0 ? 'Type ' + d.nat.natTypeEx : '-';

      details.push(
        ce(
          View,
          { key: 'c2', style: [styles.cells, { marginTop: 14 }] },
          ce(Cell, { wide: true, value: netName, caption: isWired ? 'Interface' : 'Network' }),
          ce(Cell, { value: chVal, caption: band || 'Channel' }),
          ce(Cell, { value: natType, caption: 'NAT' })
        )
      );

      body.push(ce(View, { key: 'sec', style: styles.section }, details));
    }

    return ce(View, { style: [styles.body, { width: W, height: H }] }, body);
  }

  wh.register(NetworkInfo);
})(globalThis.__wh);
