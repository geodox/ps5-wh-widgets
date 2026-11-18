// hello-wh - minimal reference widget. Shows the stock-look building blocks:
//   wh.Title      stock title row (white IconPS glyph 40px + bold size-21 text)
//   wh.Label      stock text (size 21, theme color, font scaling capped)
//   wh.Focusable  selectable items inside the tile: X enters the tile, arrows
//                 (or L1/R1) move between items, X presses one, Circle leaves
//   wh.onPressed  tile-wide button handlers (here: Square resets both chips)
//   settings      config.json "settings": Options opens the stock settings menu,
//                 values arrive on props.settings and persist across reboots.
//                 Here they are the clock's defaults; the chips flip them for now.
//   props         config / settings / focused / editing / size / width / height
(function (wh) {
  var React = wh.React;
  var View = wh.View;
  var Label = wh.Label;
  var ce = React.createElement;
  var F = wh.FontSizePS;
  var B = wh.Button;

  var styles = wh.StyleSheet.create({
    card: { borderRadius: 16, overflow: 'hidden' },
    body: { flex: 1, padding: 16 },
    row: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
    clock: { fontSize: F.SizeLarge, flex: 1 },                 // 36
    chip: {
      height: 36, paddingHorizontal: 14, marginLeft: 8, borderRadius: 18,
      justifyContent: 'center', backgroundColor: '#ffffff1f'
    },
    chipOn: { backgroundColor: '#ffffff' },                    // selected chip
    chipText: { fontSize: F.Size3XSmall },                     // 18
    chipTextOn: { color: '#17191e' },
    cap: { fontSize: F.Size3XSmall, opacity: 0.6, marginTop: 'auto' }  // 18, dimmed
  });

  // One selectable chip. wh.Focusable passes `selected` to a function child.
  function Chip(props) {
    return ce(wh.Focusable, {
      onPress: props.onPress,                      // X while this chip is selected
      style: styles.chip,
      focusedStyle: styles.chipOn
    }, function (selected) {
      return ce(Label, { style: [styles.chipText, selected ? styles.chipTextOn : null] }, props.label);
    });
  }

  function HelloWH(props) {
    var s = React.useState(Date.now());
    var now = s[0], setNow = s[1];
    var settings = props.settings || {};
    var default12 = settings.format === '12h', defaultSec = settings.seconds !== false;
    var h12 = React.useState(default12), use12 = h12[0], set12 = h12[1];
    var sec = React.useState(defaultSec), showSec = sec[0], setSec = sec[1];
    // A change in the settings menu (or the saved values loading) resets the chips.
    React.useEffect(function () { set12(default12); setSec(defaultSec); }, [default12, defaultSec]);
    var mounted = React.useRef(true);
    React.useEffect(function () {
      mounted.current = true;
      var id = setInterval(function () { if (mounted.current) setNow(Date.now()); }, 1000);
      return function () { mounted.current = false; clearInterval(id); };
    }, []);

    // Tile-wide handler: works whichever chip is selected. Square resets to the settings.
    wh.onPressed(B.Square, function () { set12(default12); setSec(defaultSec); });

    var d = new Date(now);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    var hr = d.getHours(), ampm = '';
    if (use12) { ampm = hr < 12 ? ' AM' : ' PM'; hr = hr % 12 || 12; }
    var clock = (use12 ? hr : pad(hr)) + ':' + pad(d.getMinutes()) + (showSec ? ':' + pad(d.getSeconds()) : '') + ampm;

    var cfg = props.config || {};
    // Fill the tile the grid gives us (L1/R1 resize changes size/width/height in edit mode).
    var dims = { width: props.width || 504, height: props.height || 152 };
    return ce(View, { style: [styles.card, dims] },
      ce(View, { style: styles.body },
        ce(wh.Title, {
          iconId: cfg.iconId || 'app_welcome',
          badge: props.active ? 'Circle: done' : (props.focused ? 'X: edit' : null)
        }, cfg.title || 'Hello Hub'),
        ce(View, { style: styles.row },
          ce(Label, { style: styles.clock }, clock),
          ce(Chip, { label: use12 ? '12h' : '24h', onPress: function () { set12(function (v) { return !v; }); } }),
          ce(Chip, { label: showSec ? 'Seconds' : 'No seconds', onPress: function () { setSec(function (v) { return !v; }); } })
        ),
        props.size > 1
          ? ce(Label, { style: styles.cap }, props.active ? 'Arrows: move  X: toggle  Square: reset' : 'Options: settings - size ' + props.size)
          : null
      )
    );
  }

  wh.register(HelloWH);
})(globalThis.__wh);
