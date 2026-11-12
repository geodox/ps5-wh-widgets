// hello-wh - minimal reference widget. Shows the stock-look building blocks:
//   wh.Title  stock title row (white IconPS glyph 40px + bold size-21 text)
//   wh.Label  stock text (size 21, theme color, font scaling capped)
//   props     config / focused / editing / size / width / height from the loader
// plus hooks + host timers.
(function (wh) {
  var React = wh.React;
  var View = wh.View;
  var Label = wh.Label;
  var ce = React.createElement;
  var F = wh.FontSizePS;

  var styles = wh.StyleSheet.create({
    card: { borderRadius: 16, overflow: 'hidden' },
    // stock mat: #17191E + native lightMat sheen
    mat: {
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: '#17191ef0', borderRadius: 16
    },
    body: { flex: 1, padding: 16 },
    clock: { fontSize: F.SizeLarge, marginTop: 8 },        // 36
    cap: { fontSize: F.Size3XSmall, opacity: 0.6, marginTop: 'auto' }  // 18, dimmed
  });

  function HelloWH(props) {
    var s = React.useState(Date.now());
    var now = s[0], setNow = s[1];
    var mounted = React.useRef(true);
    React.useEffect(function () {
      mounted.current = true;
      var id = setInterval(function () { if (mounted.current) setNow(Date.now()); }, 1000);
      return function () { mounted.current = false; clearInterval(id); };
    }, []);
    var d = new Date(now);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    var clock = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());

    var cfg = props.config || {};
    // Fill the tile the grid gives us (L1/R1 resize changes size/width/height).
    var dims = { width: props.width || 504, height: props.height || 152 };
    return ce(View, { style: [styles.card, dims] },
      ce(View, { lightMat: 'auto', style: styles.mat }),
      ce(View, { style: styles.body },
        ce(wh.Title, { iconId: cfg.iconId || 'app_welcome' }, cfg.title || 'Hello Hub'),
        ce(Label, { style: styles.clock }, clock),
        props.size > 1
          ? ce(Label, { style: styles.cap }, (props.focused ? 'focused' : 'reference widget') + ' - size ' + props.size)
          : null
      )
    );
  }

  wh.register(HelloWH);
})(globalThis.__wh);
