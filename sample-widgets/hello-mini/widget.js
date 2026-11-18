// hello-mini - minimal MINI widget. "size": 0 (wh.WidgetSize.MINI) in config.json
// puts the widget in the hub's MINI row (Welcome Hub Settings > Temporary
// Widgets Position decides whether that row sits above or below the tiles)
// instead of the tile grid. Like the stock MINI tiles it is a 56px pill that
// shrinks to its content (props.width is null; 100-504px wide): give the root
// no width and no flex: 1 children. A MINI widget can hide itself while it has
// nothing to show: props.setVisible(false) (docs/sdk/sizes-and-layout.md).
(function (wh) {
  var ce = wh.React.createElement;

  // The stock MINI template: padding 8 (16 on the right), a 40px icon, one line of
  // Size2XSmall (21) text.
  var styles = wh.StyleSheet.create({
    root: { height: 56, borderRadius: 28, padding: 8, paddingRight: 16, flexDirection: 'row', alignItems: 'center' },
    icon: { width: 40, height: 40, marginRight: 8 },
    text: { fontSize: wh.FontSizePS.Size2XSmall, maxWidth: 424 }
  });

  function HelloMini(props) {
    var s = wh.React.useState(Date.now()), now = s[0], setNow = s[1];
    wh.React.useEffect(function () {
      var id = setInterval(function () { setNow(Date.now()); }, 1000);
      return function () { clearInterval(id); };
    }, []);
    var d = new Date(now);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    var cfg = props.config || {};
    return ce(wh.View, { style: styles.root },
      ce(wh.IconPS, { iconId: cfg.iconId || 'app_welcome', style: styles.icon }),
      ce(wh.Label, { numberOfLines: 1, style: styles.text },
        'Hello Mini ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()))
    );
  }

  wh.register(HelloMini);
})(globalThis.__wh);
