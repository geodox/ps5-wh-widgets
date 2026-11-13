// hello-wh - minimal reference widget. Shows the stock-look building blocks:
//   wh.Title      stock title row (white IconPS glyph 40px + bold size-21 text)
//   wh.Label      stock text (size 21, theme color, font scaling capped)
//   wh.Focusable  selectable items inside the tile: X enters the tile, arrows
//                 (or L1/R1) move between items, X presses one, Circle leaves
//   wh.onPressed  tile-wide button handlers (here: Square resets both chips)
//   props         config / focused / editing / size / width / height from the loader
(function (wh) {
  var React = wh.React;
  var View = wh.View;
  var Label = wh.Label;
  var ce = React.createElement;
  var F = wh.FontSizePS;
  var B = wh.Button;

  var styles = wh.StyleSheet.create({
    card: { borderRadius: 16, overflow: 'hidden' },
    // stock mat: #17191E + native lightMat sheen
    mat: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: '#17191ef0', borderRadius: 16
    },
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
    var h12 = React.useState(false), use12 = h12[0], set12 = h12[1];
    var sec = React.useState(true), showSec = sec[0], setSec = sec[1];
    var mounted = React.useRef(true);
    React.useEffect(function () {
      mounted.current = true;
      var id = setInterval(function () { if (mounted.current) setNow(Date.now()); }, 1000);
      return function () { mounted.current = false; clearInterval(id); };
    }, []);

    // Tile-wide handler: works whichever chip is selected.
    wh.onPressed(B.Square, function () { set12(false); setSec(true); });

    var d = new Date(now);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    var hr = d.getHours(), ampm = '';
    if (use12) { ampm = hr < 12 ? ' AM' : ' PM'; hr = hr % 12 || 12; }
    var clock = (use12 ? hr : pad(hr)) + ':' + pad(d.getMinutes()) + (showSec ? ':' + pad(d.getSeconds()) : '') + ampm;

    var cfg = props.config || {};
    // Fill the tile the grid gives us (L1/R1 resize changes size/width/height in edit mode).
    var dims = { width: props.width || 504, height: props.height || 152 };
    return ce(View, { style: [styles.card, dims] },
      ce(View, { lightMat: 'auto', style: styles.mat }),
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
          ? ce(Label, { style: styles.cap }, props.active ? 'Arrows: move  X: toggle  Square: reset' : 'reference widget - size ' + props.size)
          : null
      )
    );
  }

  wh.register(HelloWH);
})(globalThis.__wh);
