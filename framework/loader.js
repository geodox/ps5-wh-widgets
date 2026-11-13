/*
 * Welcome Hub widget loader (runs inside SceShellUI's Hermes runtimes).
 *
 * The installer prepends this file, followed by one section per widget in
 * /data/wh-widgets/, to every evaluateJavaScript call (see framework/prelude.c).
 * Everything here therefore has to be cheap to re-run: the `__wh_c` guard makes
 * every evaluation after the first a no-op.
 *
 * It finds React/react-native in the shell's shared `base_dll` module cache,
 * builds the `wh` SDK object (globalThis.__wh) that widget.js files use, and
 * hooks the globals the patched hub bridge (tools/build_bridge_hbc.js) reads,
 * so our widgets end up in the hub's WIDGET_MAP and edit list.
 *
 * Constraints:
 *   - ES5 only (Hermes compiles this as plain script). No arrows, let/const,
 *     template strings or classes.
 *   - Never throw out of the top level: a throw here would surface inside an
 *     unrelated ShellUI evaluation. Wrap anything that touches the host.
 *   - 'http://127.0.0.1:8098/' is the installer's asset server and must match
 *     WH_ASSET_URL in the C sources (tools/build_loader.js checks this).
 *
 * Built into the payload by tools/build_loader.js (minified to out/loader.min.js).
 * Developer docs: docs/sdk/loader-internals.md.
 */
(function () {
  var root = globalThis;
  // Already loaded in this runtime: nothing to do.
  if (root.__wh_c) return;

  // --- Logging -------------------------------------------------------------
  // Log lines are queued and sent one at a time as GET requests to the
  // installer's /__log endpoint, which appends them to /data/wh-widgets/wh.log.
  // Only the hub runtime sends; other runtimes drop their queue after 60 s.
  var logQueue = root.__wh_logq || (root.__wh_logq = []);
  function flushLogQueue() {
    if (!root.__wh_ishub) {
      if (root.__wh_lpt0 && Date.now() - root.__wh_lpt0 > 60000) {
        try {
          root.clearInterval(root.__wh_lp);
        } catch (e) {}
        root.__wh_lp = -1;
        logQueue.length = 0;
      }
      return;
    }
    if (!logQueue.length || root.__wh_logb || typeof root.fetch !== 'function') return;
    var item = logQueue[0];
    root.__wh_logb = 1;
    var finish = function (ok, er) {
      root.__wh_logb = 0;
      if (ok || ++item.n >= 3) logQueue.shift();
      if (ok && logQueue.length) flushLogQueue();
    };
    try {
      root.fetch(item.u).then(
        function () {
          finish(1);
        },
        function (e) {
          finish(0, e);
        }
      );
    } catch (e) {
      finish(0, e);
    }
  }
  // Hex-encode text for a query string (UTF-8 for non-ASCII), capped at 400 bytes.
  function hexEncode(text) {
    var out = '';
    text = String(text);
    for (var i = 0; i < text.length && out.length < 800; i++) {
      var code = text.charCodeAt(i);
      if (code < 128) out += (code < 16 ? '0' : '') + code.toString(16);
      else {
        try {
          out += root.encodeURIComponent(text.charAt(i)).replace(/%/g, '').toLowerCase();
        } catch (e) {
          out += '3f';
        }
      }
    }
    return out;
  }
  // Queue one log line. `widgetId` tags it with a widget; `fatal` marks a load failure.
  function logLine(message, widgetId, fatal) {
    try {
      logQueue.push({
        n: 0,
        u:
          'http://127.0.0.1:8098/__log?' +
          (widgetId ? 'w=' + hexEncode(widgetId) + '&' : '') +
          'h=' +
          hexEncode(String(message).slice(0, 400)) +
          (fatal ? '&f=1' : ''),
      });
      if (logQueue.length > 200) logQueue.shift();
    } catch (e) {}
  }
  if (!root.__wh_lp) {
    try {
      root.__wh_lpt0 = Date.now();
      root.__wh_lp = root.setInterval(flushLogQueue, 400);
    } catch (e) {}
  }
  function errorText(err) {
    return err && err.message ? err.message : String(err);
  }

  // --- Host modules ----------------------------------------------------------
  // base_dll is the shell's shared webpack-style module cache. Scan it for React,
  // the react-native vendor module (View and the PS components) and Image.
  var baseDll = root.base_dll;
  if (typeof baseDll !== 'function' || !baseDll.c) return;
  var React,
    View,
    Text,
    FocusLayer,
    Image,
    vendor,
    moduleIds = root.Object.getOwnPropertyNames(baseDll.c);
  for (var i = 0; i < moduleIds.length; i++) {
    var moduleExports;
    try {
      moduleExports = baseDll.c[moduleIds[i]].exports;
    } catch (e) {
      continue;
    }
    if (!moduleExports || typeof moduleExports !== 'object') continue;
    try {
      if (
        !React &&
        moduleExports.createElement &&
        moduleExports.useState &&
        moduleExports.Component
      )
        React = moduleExports;
    } catch (e) {}
    try {
      if (
        !View &&
        moduleExports.View &&
        (moduleExports.View.displayName === 'View' || moduleExports.View.name === 'View')
      ) {
        View = moduleExports.View;
        vendor = moduleExports;
      }
    } catch (e) {}
    try {
      if (!Text && moduleExports.Text && moduleExports.Text.displayName === 'Text')
        Text = moduleExports.Text;
    } catch (e) {}
    try {
      if (!FocusLayer && moduleExports.FocusLayerPS) FocusLayer = moduleExports.FocusLayerPS;
    } catch (e) {}
    try {
      if (
        !Image &&
        moduleExports.Image &&
        (moduleExports.Image.resolveAssetSource ||
          moduleExports.Image.displayName === 'Image' ||
          moduleExports.Image.getSize)
      )
        Image = moduleExports.Image;
    } catch (e) {}
  }
  if (!React || !View || !Text) {
    logLine(
      'loader: React/View/Text not found in base_dll (' +
        (React ? '' : 'React ') +
        (View ? '' : 'View ') +
        (Text ? '' : 'Text') +
        ') - widgets cannot load',
      0,
      1
    );
    return;
  }
  // Hides a widget whose render throws instead of taking the hub down with it.
  var createElement = React.createElement;
  function ErrorBoundary(props) {
    React.Component.call(this, props);
    this.state = { e: 0 };
  }
  ErrorBoundary.prototype = root.Object.create(React.Component.prototype);
  ErrorBoundary.prototype.constructor = ErrorBoundary;
  ErrorBoundary.getDerivedStateFromError = function () {
    return { e: 1 };
  };
  ErrorBoundary.prototype.componentDidCatch = function (err) {
    try {
      logLine(
        'render error (tile hidden): ' +
          errorText(err) +
          (err && err.stack ? ' | ' + String(err.stack).slice(0, 240) : ''),
        this.props.wid,
        1
      );
    } catch (e) {}
  };
  ErrorBoundary.prototype.render = function () {
    return this.state.e ? null : this.props.children;
  };

  // --- The `wh` SDK object (documented in docs/sdk/api.md) ----------------------
  var wh = {
    React: React,
    View: View,
    Text: Text,
    Image: Image,
    FocusLayerPS: FocusLayer,
    config: null,
  };
  if (vendor) {
    try {
      wh.StyleSheet = vendor.StyleSheet;
      wh.FontSizePS = vendor.FontSizePS;
      wh.IconPS = vendor.IconPS;
      wh.I18nPS = vendor.I18nPS;
      wh.Animated = vendor.Animated;
      wh.ActivityIndicator = vendor.ActivityIndicator;
      wh.KeyGuidePS = vendor.KeyGuidePS;
      wh.OptionsMenuPS = vendor.OptionsMenuPS;
      wh.MenuListItemPS = vendor.MenuListItemPS;
      wh.ScrollView = vendor.ScrollView;
      wh.LayoutAnimation = vendor.LayoutAnimation;
      wh.findNodeHandle = vendor.findNodeHandle;
      if (!Image) Image = vendor.Image;
    } catch (e) {}
  }
  // Hub tile sizes. MINI* values exist in the hub but are not offered for custom
  // widgets (the custom grid uses whole cells): see docs/sdk/sizes-and-layout.md.
  wh.WidgetSize = {
    MINI: 0,
    MINI_EXPANDED: 0.1,
    MINI_EXPANDED_HEIGHT: 0.2,
    DEFAULT: 1,
    LARGE: 2,
    FULL: 3,
    XL: 6,
  };
  // Fallback values when the vendor module does not export FontSizePS.
  if (!wh.FontSizePS)
    wh.FontSizePS = {
      Size3XLarge: 72,
      Size2XLarge: 54,
      SizeXLarge: 45,
      SizeLarge: 36,
      SizeNormal: 30,
      SizeSmall: 27,
      SizeXSmall: 24,
      Size2XSmall: 21,
      Size3XSmall: 18,
      Size4XSmall: 15,
    };
  // Measurements of the stock hub tiles, in pixels.
  wh.StockTile = {
    WIDGET_WIDTH: 504,
    WIDGET_HEIGHT: 152,
    WIDGET_WIDTH_SPACING: 528,
    WIDGET_SPACING: 24,
    WIDGET_PADDING: 16,
    WIDGET_BORDER_RADIUS: 16,
    MINI_WIDGET_HEIGHT: 56,
    XL_WIDTH: 1032,
    MAT_COLOR: '#17191E',
  };
  // Friendly button names -> the key names the focus engine reports.
  wh.Button = {
    Cross: 'Enter',
    Circle: 'Back',
    Square: 'Square',
    Triangle: 'Triangle',
    Options: 'Options',
    L1: 'L',
    R1: 'R',
    L2: 'L2',
    R2: 'R2',
    L3: 'L3',
    R3: 'R3',
    Up: 'Up',
    Down: 'Down',
    Left: 'Left',
    Right: 'Right',
  };
  // Buttons a widget may claim with wh.onPressed. Circle and the D-pad belong to
  // the system (focus movement and leaving the tile).
  wh.__btnOk = {
    Enter: 1,
    Square: 1,
    Options: 1,
    Triangle: 1,
    L: 1,
    R: 1,
    L2: 1,
    R2: 1,
    L3: 1,
    R3: 1,
  };
  // focusCustomSettings that keep focus on the tile while it is "entered".
  wh.__LOCKED = { canMoveLeft: false, canMoveRight: false, canMoveUp: false, canMoveDown: false };
  // Context linking wh.onPressed / wh.Focusable to their tile's controller.
  wh.__ctx = function () {
    if (!wh.__btnCtx) wh.__btnCtx = wh.React.createContext(null);
    return wh.__btnCtx;
  };
  // Hook: run `handler` when `button` is pressed while the tile has focus.
  // Only registered buttons get a key handler on the tile, so unclaimed buttons
  // (R3 Edit Widgets, Triangle Utilities) keep their stock behavior.
  wh.onPressed = function (button, handler) {
    var ReactLib = wh.React,
      ctx = ReactLib.useContext(wh.__ctx()),
      controller = ctx && ctx.cx,
      handlerRef = ReactLib.useRef(handler);
    handlerRef.current = handler;
    ReactLib.useEffect(
      function () {
        if (!controller) return;
        if (!wh.__btnOk[button]) {
          logLine(
            'onPressed(' + button + ') ignored: that button belongs to the system',
            controller.id
          );
          return;
        }
        var entry = { b: button, r: handlerRef };
        controller.hs.push(entry);
        if (controller.bump)
          controller.bump(function (n) {
            return n + 1;
          });
        return function () {
          var i = controller.hs.indexOf(entry);
          if (i >= 0) controller.hs.splice(i, 1);
          if (controller.bump)
            controller.bump(function (n) {
              return n + 1;
            });
        };
      },
      [controller, button]
    );
  };
  // A selectable item inside a tile. After X enters the tile, the arrows move the
  // selection between Focusables by their on-screen position.
  wh.Focusable = function (props) {
    var ReactLib = wh.React,
      ctx = ReactLib.useContext(wh.__ctx()),
      controller = ctx && ctx.cx,
      selfRef = ReactLib.useRef({}),
      viewRef = ReactLib.useRef(null);
    selfRef.current.p = props;
    ReactLib.useEffect(
      function () {
        if (controller) return controller.reg(selfRef);
      },
      [controller]
    );
    var selected = !!(ctx && ctx.sel === selfRef);
    var children = typeof props.children === 'function' ? props.children(selected) : props.children;
    return createElement(
      View,
      {
        ref: viewRef,
        style: [props.style, selected ? props.focusedStyle : null],
        onLayout: function (event) {
          try {
            var node = viewRef.current;
            if (node && typeof node.measureInWindow === 'function') {
              node.measureInWindow(function (x, y, w, h) {
                selfRef.current.r = { x: x, y: y, w: w, h: h };
              });
            } else {
              var layout = event && event.nativeEvent && event.nativeEvent.layout;
              if (layout)
                selfRef.current.r = { x: layout.x, y: layout.y, w: layout.width, h: layout.height };
            }
          } catch (z) {}
        },
      },
      children
    );
  };

  // --- Resize hooks (called from the patched hub bytecode) --------------------
  // L1/R1 in the edit screen step a custom widget through 1 -> 2 -> 3 -> XL (6).
  // Returns the new size, or `stock` to leave stock widgets to the hub.
  wh.__sizeStep = function (target, up, stock) {
    var id = target && target.id,
      size = target && target.size;
    try {
      var cfg = id && root.__wh_cfgs && root.__wh_cfgs[id];
      if (!cfg) return stock;
      var steps = [1, 2, 3, 6],
        i = 0;
      for (var k = 0; k < steps.length; k++) if (steps[k] <= size) i = k;
      var next = up ? i + 1 : steps[i] === size ? i - 1 : i;
      next = Math.max(0, Math.min(steps.length - 1, next));
      logLine('resize ' + size + ' -> ' + steps[next] + (up ? ' (R1)' : ' (L1)'), id);
      return steps[next];
    } catch (e) {
      logLine('resize step failed: ' + errorText(e), id);
      return stock;
    }
  };
  // Prefix of the hub layout library's resize(). The layout is an array of
  // 3-cell columns; XL is two adjacent full columns of the same id. Builds or
  // removes the XL pair; returns true when it handled the resize itself.
  // Note: the editor restores its start-of-session layout before every resize,
  // so this must work from any starting shape.
  root.__whLayoutResize = function (layout, position, size) {
    try {
      if (!root.Array.isArray(layout) || !root.Array.isArray(position)) return false;
      var colIndex = position[0],
        column = layout[colIndex];
      if (!root.Array.isArray(column)) return false;
      var id = column[position[1]];
      if (!id || !root.__wh_cfgs || !root.__wh_cfgs[id]) return false;
      var isFullColumn = function (k) {
        var cells = layout[k];
        return (
          root.Array.isArray(cells) &&
          cells.length === 3 &&
          cells[0] === id &&
          cells[1] === id &&
          cells[2] === id
        );
      };
      var partner = isFullColumn(colIndex)
        ? isFullColumn(colIndex + 1)
          ? colIndex + 1
          : isFullColumn(colIndex - 1)
            ? colIndex - 1
            : -1
        : -1;
      if (size === 6) {
        if (partner >= 0) return true;
        var insertAt = colIndex + 1,
          k,
          row,
          hadCells;
        for (k = layout.length - 1; k >= 0; k--) {
          var cells = layout[k];
          if (!root.Array.isArray(cells)) continue;
          hadCells = false;
          for (row = 0; row < cells.length; row++)
            if (cells[row] === id) {
              cells[row] = null;
              hadCells = true;
            }
          if (
            hadCells &&
            cells.every(function (v) {
              return v == null;
            })
          ) {
            layout.splice(k, 1);
            if (k < insertAt) insertAt--;
          }
        }
        layout.splice(insertAt, 0, [id, id, id], [id, id, id]);
        position[0] = insertAt;
        position[1] = 0;
        logLine('layout: XL at columns ' + insertAt + '-' + (insertAt + 1), id);
        return true;
      }
      if (partner >= 0) {
        layout.splice(partner, 1);
        if (partner < colIndex) position[0] = colIndex - 1;
        logLine('layout: left XL (removed column ' + partner + ')', id);
        return size === 3;
      }
      return false;
    } catch (e) {
      logLine('layout resize hook failed: ' + errorText(e));
      return false;
    }
  };
  // Prefix of the layout library's find(): report an XL pair as size 6 (the stock
  // code would see one full column and say 3).
  root.__whFind = function (layout, id) {
    try {
      if (!id || !root.__wh_cfgs || !root.__wh_cfgs[id] || !root.Array.isArray(layout))
        return false;
      var isFullColumn = function (k) {
        var cells = layout[k];
        return (
          root.Array.isArray(cells) &&
          cells.length === 3 &&
          cells[0] === id &&
          cells[1] === id &&
          cells[2] === id
        );
      };
      for (var k = 0; k + 1 < layout.length; k++)
        if (isFullColumn(k) && isFullColumn(k + 1)) return { id: id, position: [k, 0], size: 6 };
      return false;
    } catch (e) {
      return false;
    }
  };
  // Prefix of the hub's scrollTo(): when the focused custom widget is XL, scroll
  // far enough that its second column is visible too.
  root.__whScrollTo = function (column, windowRef) {
    try {
      var id = root.__wh_focusId,
        visible = windowRef && windowRef.current;
      if (
        id &&
        root.__wh_rsize &&
        root.__wh_rsize[id] === 6 &&
        typeof column === 'number' &&
        visible &&
        typeof visible.end === 'number' &&
        column + 1 > visible.end
      )
        return column + 1;
    } catch (e) {}
    return column;
  };
  root.__whSizeUp = function (target, stock) {
    return wh.__sizeStep(target, 1, stock);
  };
  root.__whSizeDown = function (target, stock) {
    return wh.__sizeStep(target, 0, stock);
  };
  // Log uncaught JS errors in the hub runtime. A fatal error is passed on to the
  // stock handler after 2.5 s so the log line has a chance to go out first.
  wh.__errHook = function () {
    if (wh.__eh) return;
    wh.__eh = 1;
    try {
      var ErrorUtils = root.ErrorUtils;
      if (!ErrorUtils || typeof ErrorUtils.setGlobalHandler !== 'function') {
        logLine('error hook: ErrorUtils not available');
        return;
      }
      var previousHandler =
        typeof ErrorUtils.getGlobalHandler === 'function' ? ErrorUtils.getGlobalHandler() : null;
      ErrorUtils.setGlobalHandler(function (e, fatal) {
        try {
          logLine('JS ' + (fatal ? 'FATAL' : 'error') + ': ' + errorText(e));
          if (e && e.stack) logLine('stack: ' + String(e.stack).slice(0, 390));
        } catch (z) {}
        if (fatal && previousHandler) {
          try {
            root.setTimeout(function () {
              previousHandler(e, fatal);
            }, 2500);
            return;
          } catch (z) {}
        }
        if (previousHandler) previousHandler(e, fatal);
      });
      logLine('error hook installed');
    } catch (e) {
      logLine('error hook failed: ' + errorText(e));
    }
  };

  // --- Settings menu ---------------------------------------------------------
  // Build OptionsMenuPS items for a widget's normalized config.json settings.
  wh.__buildOpts = function (schema, values, setValue) {
    var Item = wh.MenuListItemPS;
    if (!Item || !schema || !schema.length) return null;
    var items = [];
    for (var i = 0; i < schema.length; i++) {
      (function (setting) {
        var current = values[setting.id];
        if (setting.type === 'toggle') {
          items.push(
            createElement(Item.Switch, {
              key: setting.id,
              id: setting.id,
              label: setting.title,
              value: !!current,
              onValueChange: function (v) {
                setValue(setting.id, v);
              },
            })
          );
        } else {
          var choices = [];
          for (var j = 0; j < setting.options.length; j++) {
            (function (option) {
              choices.push(
                createElement(Item.Selectable, {
                  key: String(option.value),
                  label: option.label,
                  value: option.value,
                  checked: option.value === current,
                  onPress: function () {
                    setValue(setting.id, option.value);
                  },
                })
              );
            })(setting.options[j]);
          }
          items.push(
            createElement(
              Item.Dropdown,
              {
                key: setting.id,
                id: setting.id,
                label: setting.title,
                value: current,
                onValueChange: function (v) {
                  setValue(setting.id, v);
                },
              },
              choices
            )
          );
        }
      })(schema[i]);
    }
    return items;
  };

  // --- Stock tile frame --------------------------------------------------------
  // Hub module 106 is the stock widget frame and 77 the stock header. They are
  // fetched through the bridge's __whRequire; null when unavailable, in which
  // case tiles are drawn in a FocusLayer instead.
  wh.__hubFrame = function () {
    if (wh.__hf !== undefined) return wh.__hf;
    var hubRequire = root.__whRequire;
    if (typeof hubRequire !== 'function') return null;
    var Frame = null;
    try {
      var frameModule = hubRequire(106);
      Frame = frameModule && (frameModule['default'] || null);
      if (Frame && typeof Frame !== 'function' && !Frame.$$typeof) Frame = null;
    } catch (e) {
      logLine('stock frame unavailable: ' + errorText(e));
    }
    try {
      var headerModule = hubRequire(77);
      wh.__hubHeader = (headerModule && headerModule['default']) || null;
    } catch (e) {
      wh.__hubHeader = null;
    }
    wh.__hf = Frame;
    logLine(
      'stock frame ' +
        (Frame ? 'on' : 'off - using the loader frame') +
        ', stock header ' +
        (wh.__hubHeader ? 'on' : 'off')
    );
    return Frame;
  };

  // --- Drawing helpers -----------------------------------------------------------
  // Pixel size of a tile at a given WidgetSize.
  wh.dims = function (size) {
    var heights = { 0: 56, 0.1: 56, 0.2: 120, 1: 152, 2: 328, 3: 504, 6: 504 };
    return { width: size === 6 ? 1032 : 504, height: heights[size] != null ? heights[size] : 152 };
  };
  var fontScaling = { maxLevel: 'large' };
  wh.fontScalingOptions = fontScaling;
  wh.TextStyles = {
    label: { fontSize: 21 },
    title: { fontSize: 21, fontWeight: 'bold' },
    badge: { minWidth: 100, textAlign: 'right', fontWeight: 'normal', fontSize: 21 },
  };
  wh.Label = function (props) {
    var textProps = root.Object.assign({}, props);
    if (textProps.numberOfLines === undefined) textProps.numberOfLines = 1;
    if (textProps.allowFontScaling === undefined) textProps.allowFontScaling = fontScaling;
    textProps.style = [wh.TextStyles.label, props.style];
    return createElement(Text, textProps);
  };
  // Draw a vector glyph from rectangles: spec = { box: [x, y, w, h], rects: [[x, y, w, h, radius], ...] }.
  wh.Glyph = function (props) {
    var spec = props.spec || {},
      box = spec.box || [0, 0, 1, 1],
      size = props.size || 40,
      pad = props.pad != null ? props.pad : 0.06,
      color = props.color || '#ffffff',
      scale = (size * (1 - 2 * pad)) / Math.max(box[2], box[3]),
      offsetX = (size - box[2] * scale) / 2,
      offsetY = (size - box[3] * scale) / 2,
      rects = spec.rects || [],
      children = [];
    for (var i = 0; i < rects.length; i++) {
      var rect = rects[i];
      children.push(
        createElement(View, {
          key: 'g' + i,
          style: {
            position: 'absolute',
            left: offsetX + (rect[0] - box[0]) * scale,
            top: offsetY + (rect[1] - box[1]) * scale,
            width: rect[2] * scale,
            height: rect[3] * scale,
            borderRadius: (rect[4] || 0) * scale,
            backgroundColor: color,
          },
        })
      );
    }
    return createElement(View, { style: [{ width: size, height: size }, props.style] }, children);
  };
  // Tile title row: icon (element, image URL list tried in order, or IconPS id),
  // text and optional badge. Uses the stock header when there is no custom icon.
  wh.Title = function (props) {
    var sources = props.iconImage;
    if (sources != null && !root.Array.isArray(sources)) sources = [sources];
    sources = (sources || []).filter(function (x) {
      return !!x;
    });
    var sourceState = React.useState(0),
      sourceIndex = sourceState[0],
      setSourceIndex = sourceState[1],
      loadedRef = React.useRef(false);
    React.useEffect(
      function () {
        loadedRef.current = false;
        if (!sources.length || sourceIndex >= sources.length) return;
        var timer = root.setTimeout(function () {
          if (!loadedRef.current) setSourceIndex(sourceIndex + 1);
        }, 4000);
        return function () {
          root.clearTimeout(timer);
        };
      },
      [sourceIndex, sources.length]
    );
    var StockHeader = wh.__hubHeader;
    if (StockHeader && !props.icon && !sources.length) {
      var header = createElement(
        StockHeader,
        { iconId: props.iconId, style: { flex: 1 } },
        props.children
      );
      return createElement(
        View,
        { style: [{ flexDirection: 'row', alignItems: 'center' }, props.style] },
        header,
        props.badge != null
          ? createElement(wh.Label, { style: wh.TextStyles.badge }, props.badge)
          : null
      );
    }
    var icon = null,
      iconStyle = [{ width: 40, height: 40, marginRight: 4 }, props.iconStyle];
    if (props.icon) {
      icon = createElement(View, { style: iconStyle }, props.icon);
    } else if (sources.length && sourceIndex < sources.length && Image) {
      var source = sources[sourceIndex];
      icon = createElement(Image, {
        key: 'i' + sourceIndex,
        source: typeof source === 'string' ? { uri: source } : source,
        style: iconStyle,
        onLoad: function () {
          loadedRef.current = true;
        },
        onError: function () {
          setSourceIndex(sourceIndex + 1);
        },
      });
    } else if (props.iconId && wh.IconPS)
      icon = createElement(wh.IconPS, { iconId: props.iconId, style: iconStyle });
    var title = createElement(
      Text,
      {
        numberOfLines: 1,
        ellipsizeMode: 'tail',
        allowFontScaling: fontScaling,
        style: [wh.TextStyles.title, { flex: 1 }, props.textStyle],
      },
      props.children
    );
    var badge =
      props.badge != null
        ? createElement(
            Text,
            {
              numberOfLines: 1,
              allowFontScaling: fontScaling,
              style: [wh.TextStyles.badge, props.badgeStyle],
            },
            props.badge
          )
        : null;
    return createElement(
      View,
      { style: [{ flexDirection: 'row', alignItems: 'center', height: 40 }, props.style] },
      icon,
      title,
      badge
    );
  };

  // --- Custom icons ------------------------------------------------------------
  // IconPS ids of the form "wh:<name>" resolve to glyphs registered here, both in
  // widgets and in the hub's own UI (edit list), via a wrapped IconPS.
  wh.__glyphs = {};
  wh.registerGlyph = function (name, spec) {
    wh.__glyphs[name] = spec;
  };
  var StockIconPS = wh.IconPS;
  wh.__IconPSOrig = StockIconPS;
  // A PNG glyph served by the asset server, tinted like a stock icon; falls back
  // to a stock IconPS id when it fails or takes longer than 4 s.
  wh.GlyphImage = function (props) {
    var failedState = React.useState(0),
      failed = failedState[0],
      setFailed = failedState[1],
      loadedRef = React.useRef(false);
    React.useEffect(
      function () {
        var timer = root.setTimeout(function () {
          if (!loadedRef.current) {
            logLine(
              'glyph image did not load within 4s: ' +
                props.uri +
                ' -> stock ' +
                (props.fallback || 'app_welcome')
            );
            setFailed(1);
          }
        }, 4000);
        return function () {
          root.clearTimeout(timer);
        };
      },
      [props.uri]
    );
    if (failed || !Image)
      return StockIconPS
        ? createElement(StockIconPS, {
            iconId: props.fallback || 'app_welcome',
            style: props.style,
          })
        : null;
    return createElement(Image, {
      source: { uri: props.uri },
      resizeMode: 'contain',
      style: [props.style, { width: props.size, height: props.size, tintColor: props.color }],
      onLoad: function () {
        loadedRef.current = true;
      },
      onError: function (e) {
        logLine(
          'glyph image failed: ' +
            props.uri +
            ' (' +
            ((e && e.nativeEvent && e.nativeEvent.error) || 'error') +
            ') -> stock ' +
            (props.fallback || 'app_welcome')
        );
        setFailed(1);
      },
    });
  };
  wh.__iconPatched = false;
  // StyleSheet.flatten, with a manual fallback.
  function flattenStyle(style) {
    try {
      if (vendor && vendor.StyleSheet && vendor.StyleSheet.flatten)
        return vendor.StyleSheet.flatten(style) || {};
    } catch (e) {}
    var flat = {};
    (function f(part) {
      if (!part) return;
      if (root.Array.isArray(part)) {
        for (var i = 0; i < part.length; i++) f(part[i]);
      } else if (typeof part === 'object') {
        root.Object.assign(flat, part);
      }
    })(style);
    return flat;
  }
  if (StockIconPS) {
    var renderIcon = function (props, ref) {
      var id = props && props.iconId;
      if (typeof id === 'string' && id.indexOf('wh:') === 0) {
        var glyph = wh.__glyphs[id.slice(3)];
        if (glyph) {
          var flat = flattenStyle(props.style),
            size = root.Math.min(flat.width || 40, flat.height || flat.width || 40);
          var color = flat.color || flat.tintColor || '#ffffff';
          if (glyph.image)
            return createElement(wh.GlyphImage, {
              uri: glyph.image,
              fallback: glyph.fallback,
              size: size,
              color: color,
              style: props.style,
            });
          return createElement(wh.Glyph, {
            spec: glyph,
            size: size,
            color: color,
            style: props.style,
          });
        }
      }
      var forwarded = ref ? root.Object.assign({}, props, { ref: ref }) : props;
      return createElement(StockIconPS, forwarded);
    };
    var WrappedIconPS = React.forwardRef
      ? React.forwardRef(renderIcon)
      : function (p) {
          return renderIcon(p, null);
        };
    try {
      for (var key in StockIconPS) {
        if (!(key in WrappedIconPS)) WrappedIconPS[key] = StockIconPS[key];
      }
    } catch (e) {}
    try {
      WrappedIconPS.displayName = 'IconPS';
    } catch (e) {}
    wh.IconPS = WrappedIconPS;
    // Called once in the hub runtime: install the wrapped IconPS into the vendor
    // module so the hub's own icons understand "wh:" ids too.
    wh.__hubInit = function () {
      try {
        var descriptor = root.Object.getOwnPropertyDescriptor(vendor, 'IconPS');
        if (descriptor && descriptor.writable) {
          vendor.IconPS = WrappedIconPS;
        } else if (descriptor && descriptor.configurable) {
          root.Object.defineProperty(vendor, 'IconPS', {
            configurable: true,
            enumerable: true,
            get: function () {
              return WrappedIconPS;
            },
          });
        } else if (!descriptor) {
          vendor.IconPS = WrappedIconPS;
        }
      } catch (e) {}
      wh.__iconPatched = vendor && vendor.IconPS === WrappedIconPS;
    };
  }
  wh._c = null;

  // --- Widget registration -------------------------------------------------------
  // Each widget section in the prelude runs: __begin(cfg, rawConfigJson), then the
  // widget.js body (which calls wh.register), then __end(). __fail records a throw.
  wh.register = function (Component) {
    wh._c = Component;
  };
  wh.log = function (message) {
    logLine(message);
  };
  wh.logger = function (widgetId) {
    return function (message) {
      logLine(message, widgetId);
    };
  };
  root.__wh = wh;
  root.__wh_c = 1;
  wh.__vend = !!vendor;
  root.__wh_widgets = {};
  root.__wh_cfgs = {};
  root.__wh_order = [];
  // Validate config.json `settings` into { list, values } (values = defaults).
  wh.__normSettings = function (entries, id) {
    var settings = [],
      defaults = {};
    if (entries == null) return { list: settings, values: defaults };
    if (!root.Array.isArray(entries)) {
      logLine('config.json settings ignored: must be an array', id);
      return { list: settings, values: defaults };
    }
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
        logLine('config.json settings[' + i + '] ignored: needs a string id', id);
        continue;
      }
      var type = entry.type || (root.Array.isArray(entry.options) ? 'choice' : 'toggle');
      if (type === 'choice') {
        var options = [];
        if (root.Array.isArray(entry.options))
          for (var j = 0; j < entry.options.length; j++) {
            var option = entry.options[j];
            if (option && typeof option === 'object' && option.value !== undefined)
              options.push({
                value: option.value,
                label: String(option.label != null ? option.label : option.value),
              });
            else if (typeof option === 'string' || typeof option === 'number')
              options.push({ value: option, label: String(option) });
          }
        if (!options.length) {
          logLine('config.json setting ' + entry.id + ' ignored: choice needs options', id);
          continue;
        }
        var wanted = entry['default'],
          valid = false;
        for (var q = 0; q < options.length; q++) if (options[q].value === wanted) valid = true;
        settings.push({
          id: entry.id,
          title: String(entry.title || entry.id),
          type: 'choice',
          options: options,
          'default': valid ? wanted : options[0].value,
        });
        defaults[entry.id] = valid ? wanted : options[0].value;
      } else if (type === 'toggle') {
        var value = !!entry['default'];
        settings.push({
          id: entry.id,
          title: String(entry.title || entry.id),
          type: 'toggle',
          'default': value,
        });
        defaults[entry.id] = value;
      } else logLine('config.json setting ' + entry.id + ' ignored: unknown type ' + type, id);
    }
    return { list: settings, values: defaults };
  };
  // Merge the parsed config.json under the installer-provided fields (installer wins).
  wh.__begin = function (cfg, raw) {
    var parsed = null;
    if (raw) {
      try {
        parsed = root.JSON.parse(raw);
      } catch (e) {
        logLine(
          'config.json is not valid JSON (' + errorText(e) + '); only id/title/icon fields used',
          cfg.id
        );
      }
    }
    if (parsed && typeof parsed === 'object' && !root.Array.isArray(parsed)) {
      var merged = {};
      for (var k in parsed)
        if (root.Object.prototype.hasOwnProperty.call(parsed, k)) merged[k] = parsed[k];
      for (var k2 in cfg) merged[k2] = cfg[k2];
      cfg = merged;
    }
    var normalized = wh.__normSettings(cfg.settings, cfg.id);
    cfg.settings = normalized.list;
    cfg.__settingDefaults = normalized.values;
    wh.config = cfg;
    wh._c = null;
    wh.__ferr = null;
  };
  wh.__fail = function (e) {
    wh._c = null;
    wh.__ferr = e;
  };
  // Wrap the registered component in a hub tile and record it under its id.
  wh.__end = function () {
    var cfg = wh.config,
      Component = wh._c;
    if (!Component) {
      logLine(
        wh.__ferr
          ? 'not loaded: widget.js threw: ' + errorText(wh.__ferr)
          : 'not loaded: widget.js ran but never called wh.register(Component)',
        cfg && cfg.id,
        1
      );
      return;
    }
    var id = cfg.id,
      frameData = {};
    // The stock frame renders its Template with templateProps; ours draws the tile.
    function FrameTemplate(templateProps) {
      var renderTile = templateProps && templateProps.__whMk;
      return renderTile ? renderTile(!!templateProps.focusable) : null;
    }
    // The component the hub mounts for this widget id. Props come from the hub:
    // size, editing, focusable, onFocus, onPressEdit, ...
    function WidgetTile(props) {
      props = props || {};
      var focusState = React.useState(false),
        focused = focusState[0],
        setFocused = focusState[1],
        indexState = React.useState(0),
        selectedIndex = indexState[0],
        setSelectedIndex = indexState[1],
        enteredState = React.useState(false),
        entered = enteredState[0],
        setEntered = enteredState[1],
        settingsState = React.useState(cfg.__settingDefaults || {}),
        settings = settingsState[0],
        setSettings = settingsState[1],
        optionsMenuRef = React.useRef(null),
        tileRef = React.useRef(null),
        settingsLoadedRef = React.useRef(false),
        rerender = React.useState(0)[1],
        controllerRef = React.useRef(null);
      // Per-tile controller: registered button handlers (hs) and Focusables (items).
      if (!controllerRef.current) {
        var newController = { id: id, hs: [], items: [], bump: rerender };
        newController.reg = function (item) {
          newController.items.push(item);
          rerender(function (n) {
            return n + 1;
          });
          return function () {
            var i = newController.items.indexOf(item);
            if (i >= 0) newController.items.splice(i, 1);
            rerender(function (n) {
              return n + 1;
            });
          };
        };
        controllerRef.current = newController;
      }
      var controller = controllerRef.current,
        itemCount = controller.items.length,
        currentIndex = itemCount ? Math.min(selectedIndex, itemCount - 1) : -1,
        active = !!(entered && focused && !props.editing && currentIndex >= 0),
        selectedItem = active ? controller.items[currentIndex] : null;
      React.useEffect(
        function () {
          if (!active) return;
          // While entered: hold focus on this tile (__wh_lock, read by the bridge) and
          // make Circle leave the tile instead of navigating back.
          var lockToken = (root.__wh_lockTok = (root.__wh_lockTok || 0) + 1);
          root.__wh_lock = id;
          root.__wh_exit = function () {
            setEntered(false);
          };
          var BackHandler = null,
            subscription = null,
            onBackPress = function () {
              if (!root.__wh_lock) return false;
              try {
                if (typeof root.__wh_exit === 'function') root.__wh_exit();
              } catch (z) {}
              return true;
            };
          try {
            BackHandler = vendor && vendor.BackHandler;
            if (BackHandler && BackHandler.addEventListener)
              subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
          } catch (z) {}
          if (!wh.__bhLog) {
            wh.__bhLog = 1;
            logLine(
              'focus lock on (BackHandler ' + (BackHandler ? 'hooked' : 'not found') + ')',
              id
            );
          }
          return function () {
            root.setTimeout(function () {
              if (root.__wh_lockTok === lockToken) {
                if (root.__wh_lock === id) root.__wh_lock = 0;
                root.__wh_exit = null;
              }
              try {
                if (subscription && typeof subscription.remove === 'function')
                  subscription.remove();
                else if (BackHandler && BackHandler.removeEventListener)
                  BackHandler.removeEventListener('hardwareBackPress', onBackPress);
              } catch (z) {}
            }, 300);
          };
        },
        [active]
      );
      // Load saved settings once (/__wget); save on every change (/__wset).
      React.useEffect(function () {
        if (!(cfg.settings && cfg.settings.length)) {
          settingsLoadedRef.current = true;
          return;
        }
        var applySaved = function (saved) {
          if (saved && typeof saved === 'object') {
            var merged = root.Object.assign({}, cfg.__settingDefaults);
            for (var k in saved)
              if (root.Object.prototype.hasOwnProperty.call(saved, k) && k in merged)
                merged[k] = saved[k];
            setSettings(merged);
          }
          settingsLoadedRef.current = true;
        };
        try {
          root
            .fetch('http://127.0.0.1:8098/__wget?w=' + id)
            .then(function (response) {
              return response.json();
            })
            .then(applySaved, function () {
              applySaved(null);
            });
        } catch (e) {
          applySaved(null);
        }
      }, []);
      React.useEffect(
        function () {
          if (!settingsLoadedRef.current || !(cfg.settings && cfg.settings.length)) return;
          try {
            root.fetch(
              'http://127.0.0.1:8098/__wset?w=' +
                id +
                '&h=' +
                hexEncode(root.JSON.stringify(settings))
            );
          } catch (e) {}
        },
        [settings]
      );
      var size = props.size != null ? props.size : cfg.size != null ? cfg.size : 1,
        dims = wh.dims(size),
        width = dims.width;
      // Current size per id, read by __whScrollTo.
      (root.__wh_rsize || (root.__wh_rsize = {}))[id] = size;
      var content = createElement(
        wh.__ctx().Provider,
        { value: { cx: controller, sel: selectedItem } },
        createElement(
          ErrorBoundary,
          { wid: id },
          createElement(Component, {
            config: cfg,
            settings: settings,
            focused: focused,
            active: active,
            editing: !!props.editing,
            size: size,
            width: dims.width,
            height: dims.height,
          })
        )
      );
      if (!FocusLayer && !root.__whRequire) return content;
      var focusProps = root.Object.assign({}, props, { id: id, name: id });
      function setSetting(key, value) {
        setSettings(function (previous) {
          var next = root.Object.assign({}, previous);
          next[key] = value;
          return next;
        });
        if (!wh.__setLog) wh.__setLog = {};
        if (!wh.__setLog[id + key]) {
          wh.__setLog[id + key] = 1;
          logLine('setting ' + key + ' changed', id);
        }
      }
      var hasSettings = !!(
        cfg.settings &&
        cfg.settings.length &&
        wh.OptionsMenuPS &&
        wh.MenuListItemPS
      );
      // Buttons some wh.onPressed handler asked for.
      var wanted = {};
      for (var wi = 0; wi < controller.hs.length; wi++) wanted[controller.hs[wi].b] = 1;
      function runHandler(handler, key, event, source) {
        if (!wh.__btnLog) wh.__btnLog = {};
        if (!wh.__btnLog[id + key + source]) {
          wh.__btnLog[id + key + source] = 1;
          logLine('button ' + key + ' handled (' + source + ')', id);
        }
        var handled = true;
        try {
          handled = handler(event) !== false;
        } catch (x) {
          logLine('button ' + key + ' handler threw: ' + errorText(x), id);
        }
        if (handled) stopBubble(event, key);
        return handled;
      }
      function stopBubble(event, key) {
        try {
          if (event) event.cancelBubble = true;
        } catch (z) {}
      }
      // Pick the nearest Focusable in the arrow's direction (L1/R1 step by index).
      function moveSelection(key) {
        var dx = key === 'Left' ? -1 : key === 'Right' ? 1 : 0,
          dy = key === 'Up' ? -1 : key === 'Down' ? 1 : 0,
          current = controller.items[currentIndex],
          from = current && current.current.r,
          best = -1;
        if (!dx && !dy) best = currentIndex + (key === 'R' ? 1 : -1);
        else if (from) {
          var fromX = from.x + from.w / 2,
            fromY = from.y + from.h / 2,
            bestScore = 1e9;
          for (var i = 0; i < itemCount; i++) {
            if (i === currentIndex) continue;
            var to = controller.items[i].current.r;
            if (!to) continue;
            var toX = to.x + to.w / 2,
              toY = to.y + to.h / 2,
              ahead = (toX - fromX) * dx + (toY - fromY) * dy;
            if (ahead <= 1) continue;
            var score = ahead + 2 * Math.abs(dx ? toY - fromY : toX - fromX);
            if (score < bestScore) {
              bestScore = score;
              best = i;
            }
          }
        } else best = currentIndex + (dx > 0 || dy > 0 ? 1 : -1);
        if (best >= 0 && best < itemCount) setSelectedIndex(best);
      }
      // Route a key press: selected item first, then tile behavior (enter, leave,
      // settings), then wh.onPressed handlers (newest first). True = consumed.
      function onButton(key, event) {
        if (props.editing) return false;
        if (active) {
          var itemProps = selectedItem.current.p,
            handler =
              key === 'Enter' ? itemProps.onPress : itemProps.buttons && itemProps.buttons[key];
          if (typeof handler === 'function' && runHandler(handler, key, event, 'item')) return true;
          if (key === 'Back') {
            setEntered(false);
            stopBubble(event, key);
            return true;
          }
          if (
            key === 'L' ||
            key === 'R' ||
            key === 'Up' ||
            key === 'Down' ||
            key === 'Left' ||
            key === 'Right'
          ) {
            moveSelection(key);
            stopBubble(event, key);
            return true;
          }
        } else if (key === 'Options' && hasSettings && focused) {
          var menu = optionsMenuRef.current;
          if (menu && menu.open) {
            menu.open();
            stopBubble(event, key);
            if (!wh.__omLog) {
              wh.__omLog = 1;
              logLine('settings menu opened', id);
            }
            return true;
          }
        } else if (key === 'Enter' && itemCount > 0 && focused) {
          setEntered(true);
          stopBubble(event, key);
          if (!wh.__entLog) {
            wh.__entLog = 1;
            logLine('entered (X): arrows move, Circle leaves', id);
          }
          return true;
        }
        if (key === 'Back' || key === 'Up' || key === 'Down' || key === 'Left' || key === 'Right')
          return false;
        for (var i = controller.hs.length - 1; i >= 0; i--) {
          var entry = controller.hs[i];
          if (
            entry.b === key &&
            typeof entry.r.current === 'function' &&
            runHandler(entry.r.current, key, event, 'tile')
          )
            return true;
        }
        return false;
      }
      // The focusable tile view. A key handler is attached only when this tile uses
      // that button, so the hub's own bindings work for every other button.
      function renderTileView(focusable) {
        return createElement(
          View,
          {
            ref: tileRef,
            focusable: focusable,
            name: id,
            focusCustomSettings: active ? wh.__LOCKED : undefined,
            style: { width: width, height: dims.height, borderRadius: 16, overflow: 'hidden' },
            onFocus: function (e) {
              root.__wh_focusId = id;
              setFocused(true);
              try {
                if (props.onFocus)
                  props.onFocus({ component: { props: focusProps }, originalEvent: e });
              } catch (x) {
                logLine('focus forwarding failed: ' + errorText(x), id);
              }
            },
            onBlur: function () {
              if (root.__wh_focusId === id) root.__wh_focusId = null;
              setFocused(false);
              setEntered(false);
            },
            onPress: function (e) {
              try {
                if (props.editing && props.onPressEdit) return props.onPressEdit();
              } catch (x) {
                logLine('edit press forwarding failed: ' + errorText(x), id);
              }
              return onButton('Enter', e);
            },
            onSquareKeyDown: wanted.Square
              ? function (e) {
                  return onButton('Square', e);
                }
              : undefined,
            onOptionsKeyDown:
              hasSettings || wanted.Options
                ? function (e) {
                    return onButton('Options', e);
                  }
                : undefined,
            onLKeyDown:
              active || wanted.L
                ? function (e) {
                    return onButton('L', e);
                  }
                : undefined,
            onRKeyDown:
              active || wanted.R
                ? function (e) {
                    return onButton('R', e);
                  }
                : undefined,
            onL2KeyDown: wanted.L2
              ? function (e) {
                  return onButton('L2', e);
                }
              : undefined,
            onR2KeyDown: wanted.R2
              ? function (e) {
                  return onButton('R2', e);
                }
              : undefined,
            onL3KeyDown: wanted.L3
              ? function (e) {
                  return onButton('L3', e);
                }
              : undefined,
            onR3KeyDown: wanted.R3
              ? function (e) {
                  return onButton('R3', e);
                }
              : undefined,
            onUpKeyDown: active
              ? function (e) {
                  return onButton('Up', e);
                }
              : undefined,
            onDownKeyDown: active
              ? function (e) {
                  return onButton('Down', e);
                }
              : undefined,
            onLeftKeyDown: active
              ? function (e) {
                  return onButton('Left', e);
                }
              : undefined,
            onRightKeyDown: active
              ? function (e) {
                  return onButton('Right', e);
                }
              : undefined,
            onBackKeyDown: active
              ? function (e) {
                  return onButton('Back', e);
                }
              : undefined,
            onTriangleKeyDown:
              active || wanted.Triangle
                ? function (e) {
                    return onButton('Triangle', e);
                  }
                : undefined,
          },
          content
        );
      }
      function renderOptionsMenu() {
        if (!hasSettings) return null;
        var items = wh.__buildOpts(cfg.settings, settings, setSetting);
        try {
          return createElement(wh.OptionsMenuPS, {
            ref: optionsMenuRef,
            targetComponent: tileRef.current,
            contextItems: items,
            onRequestClose: function () {},
            initialFocusItem: { sectionIndex: 0, itemIndex: 0 },
          });
        } catch (e) {
          if (!wh.__omErr) {
            wh.__omErr = 1;
            logLine('OptionsMenuPS render failed: ' + errorText(e), id);
          }
          return null;
        }
      }
      // Key-guide hints shown at the bottom of the screen while the tile has focus.
      function renderKeyGuide() {
        if (!wh.KeyGuidePS || props.editing || !focused) return null;
        var hints = {};
        if (itemCount) {
          hints.enter = active ? 'Select' : 'Edit';
        }
        if (active) {
          hints.back = 'Done';
          if (itemCount > 1) {
            hints.l1 = 'Prev';
            hints.r1 = 'Next';
          }
        }
        if (hasSettings && !active) hints.options = 'Settings';
        if (!root.Object.keys(hints).length) return null;
        try {
          return createElement(
            wh.KeyGuidePS,
            root.Object.assign(
              {
                autoHideBehavior: 'none',
                style: { position: 'absolute', left: 0, right: 0, bottom: 0 },
              },
              hints
            )
          );
        } catch (e) {
          if (!wh.__hintErr) {
            wh.__hintErr = 1;
            logLine('KeyGuidePS render failed: ' + errorText(e), id);
          }
          return null;
        }
      }
      var Frame = wh.__hubFrame();
      if (Frame)
        return createElement(
          View,
          null,
          createElement(
            ErrorBoundary,
            { wid: id },
            createElement(
              Frame,
              root.Object.assign({}, props, {
                name: id,
                id: id,
                data: frameData,
                Template: FrameTemplate,
                templateFocusable: true,
                templateProps: { __whMk: renderTileView },
              })
            )
          ),
          renderOptionsMenu(),
          renderKeyGuide()
        );
      return createElement(
        View,
        null,
        createElement(
          FocusLayer,
          { style: { width: width } },
          renderTileView(props.focusable !== false)
        ),
        renderOptionsMenu(),
        renderKeyGuide()
      );
    }
    if (cfg.glyph && cfg.assetBase)
      wh.registerGlyph(id, { image: cfg.assetBase + cfg.glyph, fallback: cfg.iconFallback });
    logLine(
      'loaded (size ' +
        (cfg.size != null ? cfg.size : 1) +
        (cfg.glyph ? ', glyph ' + cfg.glyph : '') +
        ')',
      id
    );
    WidgetTile.__whId = id;
    root.__wh_widgets[id] = WidgetTile;
    root.__wh_cfgs[id] = cfg;
    root.__wh_order.push(id);
  };

  // --- Hub hand-off ----------------------------------------------------------------
  // The patched bridge assigns the hub's WIDGET_MAP, editable-widget set and edit
  // list tables (titles, icons, descriptions) to these globals. Setters installed
  // by __install add our widgets the moment the hub provides each table.
  wh.__map = null;
  wh.__editable = null;
  wh.__register = function () {
    var widgetMap = wh.__map;
    if (!widgetMap) {
      try {
        widgetMap = root['__whWidgetMap'];
      } catch (e) {}
    }
    if (!widgetMap || typeof widgetMap !== 'object') return false;
    var order = root.__wh_order;
    for (var i = 0; i < order.length; i++) {
      try {
        widgetMap[order[i]] = root.__wh_widgets[order[i]];
      } catch (e) {}
    }
    if (!wh.__regLogged) {
      wh.__regLogged = 1;
      logLine(
        'hub registered ' +
          order.length +
          ' widget(s) [' +
          order.join(', ') +
          ']; WIDGET_MAP now ' +
          root.Object.keys(widgetMap).length
      );
    }
    return true;
  };
  // [global the bridge assigns, config field it is filled from]
  wh.__metaKeys = [
    ['__whTitles', 'title'],
    ['__whIcons', 'iconId'],
    ['__whDescs', 'description'],
  ];
  wh.__meta = {};
  wh.__metaFill = function (globalName, field) {
    var table = wh.__meta[globalName];
    if (!table || typeof table !== 'object') return;
    var order = root.__wh_order;
    for (var i = 0; i < order.length; i++) {
      try {
        var widgetCfg = root.__wh_cfgs[order[i]] || {};
        var value = widgetCfg[field];
        if (!value && field === 'title') value = order[i];
        if (!value && field === 'iconId') value = 'app_welcome';
        if (
          field === 'iconId' &&
          typeof value === 'string' &&
          value.indexOf('wh:') === 0 &&
          !wh.__iconPatched
        )
          value = widgetCfg.iconFallback || 'app_welcome';
        table[order[i]] = value || '';
      } catch (e) {
        logLine('edit list ' + field + ' not set: ' + errorText(e), order[i]);
      }
    }
    if (!wh['__ml_' + globalName]) {
      wh['__ml_' + globalName] = 1;
      logLine('edit list ' + field + ' set for ' + order.length + ' widget(s)');
    }
  };
  wh.__metaAll = function () {
    var keys = wh.__metaKeys;
    for (var i = 0; i < keys.length; i++) wh.__metaFill(keys[i][0], keys[i][1]);
  };
  // Turn the hand-off globals into accessors. Values assigned before the loader
  // ran are re-assigned through the new setters.
  wh.__install = function () {
    var hookedGlobals = ['__whWidgetMap', '__whEditable'],
      metaKeys = wh.__metaKeys,
      previousValues = {};
    for (var gi = 0; gi < metaKeys.length; gi++) hookedGlobals.push(metaKeys[gi][0]);
    for (var gi = 0; gi < hookedGlobals.length; gi++) {
      try {
        var descriptor = root.Object.getOwnPropertyDescriptor(root, hookedGlobals[gi]);
        if (descriptor && 'value' in descriptor && descriptor.value)
          previousValues[hookedGlobals[gi]] = descriptor.value;
      } catch (e) {}
    }
    try {
      root.Object.defineProperty(root, '__whWidgetMap', {
        configurable: true,
        get: function () {
          return wh.__map;
        },
        set: function (map) {
          wh.__map = map;
          if (!root.__wh_ishub) {
            root.__wh_ishub = 1;
            try {
              if (wh.__hubInit) wh.__hubInit();
              wh.__metaAll();
            } catch (e) {}
            wh.__errHook();
            logLine(
              'loader ready in the hub runtime (vendor ' +
                (wh.__vend ? 'ok' : 'MISSING') +
                ', icons ' +
                (wh.__iconPatched ? 'wrapped' : 'NOT wrapped - wh: glyphs fall back') +
                ')'
            );
          }
          try {
            wh.__register();
          } catch (e) {
            logLine('registering into WIDGET_MAP failed: ' + errorText(e), 0, 1);
          }
        },
      });
      root.Object.defineProperty(root, '__whEditable', {
        configurable: true,
        get: function () {
          return wh.__editable;
        },
        set: function (editable) {
          wh.__editable = editable;
          try {
            var order = root.__wh_order;
            for (var i = 0; i < order.length; i++) {
              editable['__wh_' + order[i]] = order[i];
            }
          } catch (e) {
            logLine('marking widgets editable failed (edit mode would drop them): ' + errorText(e));
          }
        },
      });
      var metaGlobals = wh.__metaKeys;
      for (var mi = 0; mi < metaGlobals.length; mi++) {
        (function (globalName, field) {
          root.Object.defineProperty(root, globalName, {
            configurable: true,
            get: function () {
              return wh.__meta[globalName];
            },
            set: function (table) {
              wh.__meta[globalName] = table;
              wh.__metaFill(globalName, field);
            },
          });
        })(metaGlobals[mi][0], metaGlobals[mi][1]);
      }
      for (var name in previousValues) {
        try {
          root[name] = previousValues[name];
        } catch (e) {}
      }
    } catch (e) {
      logLine('installing registry hooks failed: ' + errorText(e), 0, 1);
    }
  };
  // Called after the last widget section: register now, or poll for up to 8 s.
  wh.__flush = function () {
    wh.__install();
    wh.__metaAll();
    if (wh.__register()) return;
    var attempts = 0;
    var timer = root.setInterval(function () {
      attempts++;
      if (wh.__register() || attempts > 160) {
        try {
          root.clearInterval(timer);
        } catch (e) {}
      }
    }, 50);
  };
})();
