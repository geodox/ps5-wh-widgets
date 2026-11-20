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
      wh.AlertDialogPS = vendor.AlertDialogPS;
      wh.TextInput = vendor.TextInput;
      wh.Picker = vendor.Picker; // Picker.Item elements for MenuListItemPS.Dropdown items
      wh.ScrollView = vendor.ScrollView;
      wh.LayoutAnimation = vendor.LayoutAnimation;
      wh.findNodeHandle = vendor.findNodeHandle;
      if (!Image) Image = vendor.Image;
    } catch (e) {}
  }
  // Hub tile sizes. A widget with a MINI* size goes to the hub's MINI row instead of
  // the grid: see docs/sdk/sizes-and-layout.md.
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
  // The stock widget frame and header are hub modules fetched through the
  // bridge's __whRequire. Their module ids move between firmware builds, so the
  // payload passes this firmware's ids in __wh_hubmods (absent = not available). null
  // when unavailable, in which case tiles are drawn in a FocusLayer instead.
  wh.__hubFrame = function () {
    if (wh.__hf !== undefined) return wh.__hf;
    var hubRequire = root.__whRequire;
    if (typeof hubRequire !== 'function') return null;
    var mods = root.__wh_hubmods || {};
    var Frame = null;
    try {
      var frameModule = mods.stockFrame ? hubRequire(mods.stockFrame) : null;
      Frame = frameModule && (frameModule['default'] || null);
      if (Frame && typeof Frame !== 'function' && !Frame.$$typeof) Frame = null;
    } catch (e) {
      logLine('stock frame unavailable: ' + errorText(e));
    }
    try {
      var headerModule = mods.stockHeader ? hubRequire(mods.stockHeader) : null;
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
  // MINI and MINI_EXPANDED_HEIGHT have no fixed width: like the stock MINI tiles they
  // shrink to their content (width null) within minWidth/maxWidth.
  wh.dims = function (size) {
    if (size === 0) return { width: null, minWidth: 100, maxWidth: 504, height: 56, borderRadius: 28 };
    if (size === 0.1) return { width: 504, height: 56, borderRadius: 28 };
    if (size === 0.2) return { width: null, maxWidth: 504, height: 120, borderRadius: 16 };
    var heights = { 1: 152, 2: 328, 3: 504, 6: 504 };
    return { width: size === 6 ? 1032 : 504, height: heights[size] != null ? heights[size] : 152, borderRadius: 16 };
  };
  // The outer box of a tile: fixed width, or the MINI bounds when it shrinks to fit.
  wh.__box = function (dims) {
    return dims.width != null
      ? { width: dims.width, height: dims.height }
      : { minWidth: dims.minWidth, maxWidth: dims.maxWidth, height: dims.height };
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
      // iconIds (the full stock id list, for wh.IconPS.iconIds.includes(id)) may be
      // a non-enumerable static the loop above skips.
      if (!WrappedIconPS.iconIds && StockIconPS.iconIds) WrappedIconPS.iconIds = StockIconPS.iconIds;
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

  // --- Widget storage ----------------------------------------------------------------
  // props.storage: a small key/value store per widget, kept by the hub in the signed-in
  // user's AsyncStorage under 'wh:data:<widget id>' as one JSON object. It is per user
  // and survives reboots, also without the payload. get/set/remove return promises;
  // values must be JSON. Writes run in call order (each one stores the whole object).
  var WH_STORAGE_PREFIX = 'wh:data:';
  wh.__stores = {};
  wh.__storage = function (id) {
    if (wh.__stores[id]) return wh.__stores[id];
    var key = WH_STORAGE_PREFIX + id,
      loaded = null,
      queue = null;
    var asyncStorage = function () {
      var storage = vendor && vendor.AsyncStorage;
      if (!storage || typeof storage.getItem !== 'function') throw new Error('AsyncStorage not found');
      return storage;
    };
    var load = function () {
      if (!loaded)
        loaded = root.Promise.resolve()
          .then(function () {
            return asyncStorage().getItem(key);
          })
          .then(function (text) {
            var data = text ? root.JSON.parse(text) : null;
            return data && typeof data === 'object' && !root.Array.isArray(data) ? data : {};
          })
          .then(null, function (e) {
            loaded = null;
            throw e;
          });
      return loaded;
    };
    var write = function (change) {
      // Wait for the previous write, failed or not, then apply this one.
      queue = (queue || root.Promise.resolve())
        .then(null, function () {})
        .then(load)
        .then(function (data) {
          change(data);
          return asyncStorage().setItem(key, root.JSON.stringify(data));
        });
      return queue.then(null, function (e) {
        logLine('storage write failed: ' + errorText(e), id, 1);
        throw e;
      });
    };
    var store = {
      get: function (name, fallback) {
        return load().then(function (data) {
          return name in data ? data[name] : fallback;
        });
      },
      set: function (name, value) {
        if (value === undefined) return store.remove(name);
        root.JSON.stringify(value); // throws now for values JSON cannot store
        return write(function (data) {
          data[name] = value;
        });
      },
      remove: function (name) {
        return write(function (data) {
          delete data[name];
        });
      },
      // Widget data page: the user deleted this widget's data; read it again.
      __forget: function () {
        loaded = null;
      },
    };
    return (wh.__stores[id] = store);
  };

  // --- Full-screen pages -----------------------------------------------------------
  // A widget registers a page with wh.registerPage(Page) and opens it with
  // props.openPage(params). The page is a route of the hub's main stack navigator,
  // like Settings, so it slides in over the hub and Circle closes it through the
  // stock back handling. The route table is closed (the router builds it once), so
  // the loader wraps the router's methods in place to add one route, WH_PAGE_ROUTE,
  // whose params name the widget.
  var WH_PAGE_ROUTE = 'WhPage',
    pageSeq = 0;
  root.__wh_pages = root.__wh_pages || {};
  function WhPageScreen(props) {
    var navigation = props.navigation || {},
      params = (navigation.state && navigation.state.params) || {},
      id = params.__wh,
      Page = root.__wh_pages[id],
      pageParams = {};
    for (var k in params) if (k !== '__wh') pageParams[k] = params[k];
    var close = function () {
      try {
        navigation.goBack();
      } catch (e) {
        logLine('page close failed: ' + errorText(e), id);
      }
    };
    var body = Page
      ? createElement(
          ErrorBoundary,
          { wid: id },
          createElement(Page, {
            config: root.__wh_cfgs[id] || {},
            params: pageParams,
            close: close,
            storage: id.charAt(0) === '.' ? undefined : wh.__storage(id),
          })
        )
      : null;
    return createElement(
      View,
      { style: { flex: 1, backgroundColor: wh.StockTile.MAT_COLOR } },
      FocusLayer ? createElement(FocusLayer, { name: 'wh-page:' + id, style: { flex: 1 } }, body) : body
    );
  }
  // Add WH_PAGE_ROUTE to the main navigator's router, once. False when it is missing.
  wh.__pageRoute = function () {
    if (wh.__pr !== undefined) return wh.__pr;
    wh.__pr = false;
    try {
      var hubRequire = root.__whRequire,
        id = (root.__wh_hubmods || {}).mainNavigator,
        navigator = typeof hubRequire === 'function' && id ? hubRequire(id) : null,
        router = navigator && navigator['default'] && navigator['default'].router;
      if (!router || typeof router.getStateForAction !== 'function' || typeof router.getComponentForRouteName !== 'function')
        throw new Error('main navigator not found on this firmware');
      var getState = router.getStateForAction,
        getComponent = router.getComponentForRouteName,
        getComponentForState = router.getComponentForState,
        getOptions = router.getScreenOptions;
      var top = function (state) {
        return state && state.routes ? state.routes[state.index] : null;
      };
      var isPage = function (route) {
        return !!route && route.routeName === WH_PAGE_ROUTE;
      };
      router.getComponentForRouteName = function (name) {
        return name === WH_PAGE_ROUTE ? WhPageScreen : getComponent.apply(this, arguments);
      };
      if (typeof getComponentForState === 'function')
        router.getComponentForState = function (state) {
          return isPage(top(state)) ? WhPageScreen : getComponentForState.apply(this, arguments);
        };
      if (typeof getOptions === 'function')
        router.getScreenOptions = function (navigation) {
          return navigation && isPage(navigation.state) ? {} : getOptions.apply(this, arguments);
        };
      router.getStateForAction = function (action, state) {
        var next;
        if (action && action.type === 'Navigation/NAVIGATE' && action.routeName === WH_PAGE_ROUTE && state && state.routes) {
          var route = { key: 'wh-page-' + ++pageSeq, routeName: WH_PAGE_ROUTE, params: action.params || {} };
          next = root.Object.assign({}, state, { routes: state.routes.concat([route]), index: state.routes.length });
          if ('isTransitioning' in state) next.isTransitioning = true;
          logLine('page opened', route.params.__wh);
        } else {
          next = getState.apply(this, arguments);
          if (isPage(top(state)) && next && !isPage(top(next))) logLine('page closed', top(state).params.__wh);
        }
        // The hub's tiles show only while the first route (Root) is on top: a page,
        // Settings or the screensaver covers them (props.hubVisible).
        if (next && next.routes) setHubState('visible', next.index === 0, top(next) && top(next).routeName);
        return next;
      };
      wh.__pr = true;
      logLine('pages: route ' + WH_PAGE_ROUTE + ' added to the main navigator');
    } catch (e) {
      logLine('pages unavailable: ' + errorText(e), 0, 1);
    }
    return wh.__pr;
  };

  // --- Hub state: props.hubVisible / props.hubFocused, wh.useHubState() -------------
  // visible: no screen (a widget page, Settings, the screensaver) covers the hub's
  //   tiles; the main navigator's router wrap above reports it. Pause polling while
  //   false. In a game the hub does not run at all, so nothing else is needed there.
  // focused: the hub area has the focus (embedded: Home's HubAppContext.isHubFocused,
  //   false while the user is on the game row) and the app is active (AppState is
  //   'inactive' while the Control Center is open). The tiles stay on screen then.
  var hubState = { visible: true, appActive: true },
    hubListeners = [];
  function setHubState(key, value, why) {
    if (hubState[key] === value) return;
    var next = root.Object.assign({}, hubState);
    next[key] = value;
    hubState = next;
    if (key === 'visible') logLine(value ? 'hub tiles shown' : 'hub tiles covered by ' + (why || 'a screen'));
    else logLine('hub app ' + (value ? 'active' : 'inactive'));
    var listeners = hubListeners.slice();
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i]();
      } catch (e) {}
    }
  }
  wh.__hubStateInit = function () {
    var appState = vendor && vendor.AppState;
    if (!appState || typeof appState.addEventListener !== 'function') {
      logLine('hub state: AppState unavailable, hubFocused ignores overlays');
      return;
    }
    var isActive = function (s) {
      return s !== 'inactive' && s !== 'background';
    };
    try {
      hubState.appActive = isActive(appState.currentState);
      appState.addEventListener('change', function (s) {
        setHubState('appActive', isActive(s));
      });
    } catch (e) {
      logLine('hub state: AppState subscribe failed: ' + errorText(e));
    }
  };
  // Home's HubAppContext (hub module hubSdk), or null when unavailable.
  wh.__hubContext = function () {
    if (wh.__hc !== undefined) return wh.__hc;
    wh.__hc = null;
    try {
      var id = (root.__wh_hubmods || {}).hubSdk,
        mod = id && typeof root.__whRequire === 'function' ? root.__whRequire(id) : null;
      wh.__hc = (mod && mod.HubAppContext) || null;
    } catch (e) {}
    if (!wh.__hc) logLine('hub state: HubAppContext unavailable, hubFocused ignores the game row');
    return wh.__hc;
  };
  // { visible, focused } for any component in the hub (tiles and pages).
  wh.useHubState = function () {
    var HubContext = wh.__hubContext(), // fixed per hub runtime, so the hook order is stable
      context = HubContext ? React.useContext(HubContext) : null,
      state = React.useState(hubState),
      setState = state[1];
    React.useEffect(function () {
      function update() {
        setState(hubState);
      }
      hubListeners.push(update);
      update();
      return function () {
        var i = hubListeners.indexOf(update);
        if (i >= 0) hubListeners.splice(i, 1);
      };
    }, []);
    var areaFocused = !context || context.isStandaloneMode || context.isHubFocused !== false;
    return { visible: state[0].visible, focused: state[0].appActive && areaFocused };
  };

  // --- Widget registration -------------------------------------------------------
  // Each widget section in the prelude runs: __begin(cfg, rawConfigJson), then the
  // widget.js body (which calls wh.register), then __end(). __fail records a throw.
  wh.register = function (Component) {
    wh._c = Component;
  };
  // The widget's full-screen page; the widget opens it with props.openPage(params).
  wh.registerPage = function (Page) {
    wh._p = Page;
  };
  wh.log = function (message) {
    logLine(message);
  };
  wh.logger = function (widgetId) {
    return function (message) {
      logLine(message, widgetId);
    };
  };
  // Show a system notification (the toast at the top right) with `text`. Resolves to
  // true once the payload sent it. Plain text, at most 256 bytes, newlines allowed.
  wh.notify = function (text) {
    if (typeof text !== 'string' || !text) {
      logLine('notify ignored: text must be a non-empty string');
      return root.Promise.resolve(false);
    }
    try {
      return root.fetch('http://127.0.0.1:8098/__notify?text=' + root.encodeURIComponent(text)).then(
        function (r) {
          if (!r.ok) logLine('notify failed (HTTP ' + r.status + ')');
          return !!r.ok;
        },
        function (e) {
          logLine('notify failed: ' + errorText(e));
          return false;
        }
      );
    } catch (e) {
      logLine('notify failed: ' + errorText(e));
      return root.Promise.resolve(false);
    }
  };
  // Ask ShellUI to launch a URI (a game, a game hub, ...) through the payload's
  // /__launch endpoint. Resolves true once the launch was accepted, else false.
  wh.launch = function (uri) {
    if (typeof uri !== 'string' || !uri) {
      logLine('launch ignored: uri must be a non-empty string');
      return root.Promise.resolve(false);
    }
    try {
      return root.fetch('http://127.0.0.1:8098/__launch?uri=' + root.encodeURIComponent(uri)).then(
        function (r) {
          if (!r.ok) logLine('launch failed: ' + uri + ' (HTTP ' + r.status + ')');
          return !!r.ok;
        },
        function (e) {
          logLine('launch failed: ' + uri + ' (' + errorText(e) + ')');
          return false;
        }
      );
    } catch (e) {
      logLine('launch failed: ' + uri + ' (' + errorText(e) + ')');
      return root.Promise.resolve(false);
    }
  };

  // --- Lists ---------------------------------------------------------------------
  // wh.List: the stock scrolling list (vendor ListViewPS over the native list) for
  // pages. The native list owns scrolling and focus; rows bring their own focus
  // target (a wh.MenuListItemPS cell, or a View with focusable: true), as in the
  // hub's Settings screen.
  //   data           array of rows (anything)
  //   renderItem     (row, index) -> element
  //   onFocusIndex   (index) -> void, when the focused row changes
  //   initialIndex   row focused first
  // Any other prop (style, itemMargin, ...) goes to ListViewPS. A ref gets the
  // list's methods: setFocusIndex({itemIndex, animated}), scrollTo({firstVisibleItemIndex}).
  // A row re-renders when it is a different value than before (rows are compared
  // with !==), so pass plain data for long lists and build elements in renderItem.
  var ListView = vendor && vendor.ListViewPS;
  if (ListView && ListView.DataSource && React.forwardRef) {
    var renderList = function (props, ref) {
      var source = React.useMemo(function () {
        return new ListView.DataSource({
          rowHasChanged: function (a, b) {
            return a !== b;
          },
        });
      }, []);
      var data = props.data || [],
        initialIndex = props.initialIndex;
      var dataSource = React.useMemo(
        function () {
          return source.cloneWithRows(data, undefined, initialIndex);
        },
        [data]
      );
      var listProps = {};
      for (var key in props)
        if (key !== 'data' && key !== 'renderItem' && key !== 'onFocusIndex' && key !== 'initialIndex')
          listProps[key] = props[key];
      listProps.ref = ref;
      listProps.dataSource = dataSource;
      listProps.renderRow = function (row, sectionId, rowId) {
        return props.renderItem(row, +rowId);
      };
      if (!('rowItemFocusable' in listProps)) listProps.rowItemFocusable = false;
      if (props.onFocusIndex)
        listProps.onFocusItemChanged = function (e) {
          props.onFocusIndex(e && e.itemIndex);
        };
      return createElement(ListView, listProps);
    };
    wh.List = React.forwardRef(renderList);
  }

  // --- System sounds -------------------------------------------------------------
  // wh.playSound(name) plays a stock UI sound through vendor SystemSoundPS.playByID.
  // Only this curated set: system-event sounds (game boot, trophies, log out, ...)
  // would mislead the user. A sound plays only when this firmware lists its id in
  // SystemSoundPS.SoundIds, and at most one every 100 ms.
  var WH_SOUNDS = {
    move: 'psfx_focus_move',
    blocked: 'psfx_cannot_move_focus',
    enter: 'psfx_enter',
    back: 'psfx_cancel',
    error: 'psfx_error',
    optionsOpen: 'psfx_open_option_menu',
    optionsClose: 'psfx_close_option_menu',
    dialogOpen: 'psfx_open_dialog',
    errorDialogOpen: 'psfx_open_error_dialog',
    positive: 'psfx_button_for_positive_in_dialog',
    negative: 'psfx_button_for_negative_in_dialog',
    neutral: 'psfx_neutral_in_dialog',
    switchOn: 'psfx_switch_on',
    switchOff: 'psfx_switch_off',
    checkOn: 'psfx_checkbox_on',
    checkOff: 'psfx_checkbox_off',
    toastInfo: 'psfx_informative_toasts_something_to_read',
    toastAction: 'psfx_interactive_toasts_something_to_do',
    toastError: 'psfx_error_toasts_something_is_broken',
  };
  var lastSoundAt = 0;
  // SoundIds is the firmware's list of playable ids (an array or an object of ids).
  function soundIdKnown(list, id) {
    if (!list) return false;
    if (root.Array.isArray(list)) return list.indexOf(id) >= 0;
    for (var key in list) if (list[key] === id) return true;
    return false;
  }
  wh.playSound = function (name) {
    var id = root.Object.prototype.hasOwnProperty.call(WH_SOUNDS, name) ? WH_SOUNDS[name] : null;
    if (!id) {
      logLine('playSound ignored: unknown sound "' + name + '"');
      return false;
    }
    var sound = vendor && vendor.SystemSoundPS;
    if (!sound || typeof sound.playByID !== 'function' || !soundIdKnown(sound.SoundIds, id)) {
      if (!wh.__soundWarned) logLine('playSound: ' + id + ' is not available on this firmware');
      wh.__soundWarned = 1;
      return false;
    }
    var now = root.Date.now();
    if (now - lastSoundAt < 100) return false;
    lastSoundAt = now;
    try {
      sound.playByID(id);
      return true;
    } catch (e) {
      logLine('playSound failed: ' + errorText(e));
      return false;
    }
  };

  // --- Locale --------------------------------------------------------------------
  // The console's language (I18nPS) and its date and time format settings (hub module
  // dateFormats: getFormats() over the system registry, plus a change event).
  // wh.getLocale() returns { locale, timeFormat: 12 | 24 | null, dateFormat:
  // 'YYYY/MM/DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | null }; null until the hub answered
  // (a moment after the hub starts) or when the module is unavailable.
  // wh.useLocale() is the same as a hook that re-renders on a change.
  var whLocale = { timeFormat: null, dateFormat: null },
    localeListeners = [];
  function applyFormats(formats) {
    if (!formats) return;
    var time = formats.timeFormat === 12 || formats.timeFormat === 24 ? formats.timeFormat : null,
      date = typeof formats.dateFormat === 'string' ? formats.dateFormat : null;
    if (time === whLocale.timeFormat && date === whLocale.dateFormat) return;
    whLocale = { timeFormat: time, dateFormat: date };
    logLine('locale: ' + time + ' h, ' + date);
    var listeners = localeListeners.slice();
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i]();
      } catch (e) {}
    }
  }
  wh.__localeInit = function () {
    var id = (root.__wh_hubmods || {}).dateFormats,
      hubRequire = root.__whRequire;
    if (!id || typeof hubRequire !== 'function') {
      logLine('locale: date and time formats unavailable on this firmware');
      return;
    }
    try {
      var formats = hubRequire(id);
      root.Promise.resolve(formats.getFormats()).then(applyFormats, function (e) {
        logLine('locale: reading the formats failed: ' + errorText(e));
      });
      formats.registerDateTimeFormatChangeHandler(applyFormats);
    } catch (e) {
      logLine('locale: date and time formats unavailable: ' + errorText(e));
    }
  };
  wh.getLocale = function () {
    var locale = null;
    try {
      locale = (vendor && vendor.I18nPS && vendor.I18nPS.getCurrentLocale()) || null;
    } catch (e) {}
    return { locale: locale, timeFormat: whLocale.timeFormat, dateFormat: whLocale.dateFormat };
  };
  wh.useLocale = function () {
    var state = React.useState(wh.getLocale),
      setLocale = state[1];
    React.useEffect(function () {
      function update() {
        var next = wh.getLocale();
        setLocale(function (prev) {
          return prev.locale === next.locale &&
            prev.timeFormat === next.timeFormat &&
            prev.dateFormat === next.dateFormat
            ? prev
            : next;
        });
      }
      localeListeners.push(update);
      update(); // the formats may have arrived between render and effect
      return function () {
        var i = localeListeners.indexOf(update);
        if (i >= 0) localeListeners.splice(i, 1);
      };
    }, []);
    return state[0];
  };
  root.__wh = wh;
  root.__wh_c = 1;
  wh.__vend = !!vendor;
  root.__wh_widgets = {};
  root.__wh_cfgs = {};
  root.__wh_order = [];
  root.__wh_mini = [];
  // A MINI widget (config.json size below DEFAULT) goes to the MINI row, not the grid.
  wh.__isMini = function (size) {
    return typeof size === 'number' && size >= 0 && size < 1;
  };
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
    wh._p = null;
    wh.__ferr = null;
  };
  wh.__fail = function (e) {
    wh._c = null;
    wh._p = null;
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
    // `context` is the legacy context: the hub's screens provide `navigation` to
    // everything they render, the grid and our tiles included (WidgetTile.contextTypes).
    function WidgetTile(props, context) {
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
        // The widget renders once its saved settings are in (or after 1.5 s), so it
        // never draws the defaults first and then the saved values.
        readyState = React.useState(!(cfg.settings && cfg.settings.length)),
        settingsReady = readyState[0],
        setSettingsReady = readyState[1],
        rerender = React.useState(0)[1],
        controllerRef = React.useRef(null),
        frameRef = React.useRef(null),
        outerRefRef = React.useRef(null),
        // MINI widgets only: props.setVisible(false) hides the pill (config.json
        // "visible": false starts hidden).
        visibleState = React.useState(cfg.visible !== false),
        visible = visibleState[0],
        setVisibleState = visibleState[1],
        visibleRef = React.useRef(visible),
        isMini = wh.__isMini(cfg.size);
      // The stock frame instance (its Options handler opens the settings menu), also
      // handed on to the ref the hub passed (the MINI row's). Stable, so React does
      // not detach and reattach the ref on every render. The MINI row counts an item
      // as shown while that ref holds an instance, so a hidden MINI hands it null:
      // the row then gives it no space and no focus.
      outerRefRef.current = props.__whRef;
      visibleRef.current = visible;
      var forwardRef = React.useCallback(function (instance) {
        var outer = outerRefRef.current;
        if (typeof outer === 'function') outer(instance);
        else if (outer && typeof outer === 'object') outer.current = instance;
      }, []);
      var setFrameRef = React.useCallback(function (instance) {
        frameRef.current = instance;
        forwardRef(visibleRef.current ? instance : null);
      }, []);
      React.useEffect(
        function () {
          if (isMini) forwardRef(visible ? frameRef.current : null);
        },
        [visible]
      );
      var setVisible = React.useCallback(function (next) {
        next = !!next;
        if (next === visibleRef.current) return;
        setVisibleState(next);
        if (!wh.__visLog) wh.__visLog = {};
        if (!wh.__visLog[id + next]) {
          wh.__visLog[id + next] = 1;
          logLine('MINI ' + (next ? 'shown' : 'hidden') + ' by the widget', id);
        }
      }, []);
      // Per-tile controller: registered button handlers (hs) and Focusables (items).
      if (!controllerRef.current) {
        var newController = { id: id, hs: [], items: [], bump: rerender };
        newController.reg = function (item) {
          newController.items.push(item);
          // autoSelect: a list that scrolls swaps rows of items; it marks the item to
          // select next. Mount effects run after the old rows' cleanups, so the index
          // is final here.
          if (item.current.p && item.current.p.autoSelect)
            setSelectedIndex(newController.items.length - 1);
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
          setSettingsReady(true);
        };
        var readyTimer = root.setTimeout(function () {
          setSettingsReady(true);
        }, 1500);
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
        return function () {
          root.clearTimeout(readyTimer);
        };
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
      var hub = wh.useHubState();
      // Watch the main navigator from the first tile on (props.hubVisible); the hub's
      // modules are all loaded once a tile renders.
      React.useEffect(function () {
        wh.__pageRoute();
      }, []);
      function openPage(params) {
        var navigation = context && context.navigation;
        if (!navigation || typeof navigation.navigate !== 'function') {
          logLine('page not opened: no navigation here', id, 1);
          return false;
        }
        if (!wh.__pageRoute()) return false;
        navigation.navigate(WH_PAGE_ROUTE, root.Object.assign({}, params, { __wh: id }));
        return true;
      }
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
          settingsReady && createElement(Component, {
            config: cfg,
            settings: settings,
            focused: focused,
            active: active,
            editing: !!props.editing,
            size: size,
            width: dims.width,
            height: dims.height,
            visible: isMini ? visible : undefined,
            setVisible: isMini ? setVisible : undefined,
            openPage: root.__wh_pages[id] ? openPage : undefined,
            storage: wh.__storage(id),
            hubVisible: hub.visible,
            hubFocused: hub.focused,
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
      // The stock frame draws the tile mat and owns the settings menu (Options). Without
      // it (unknown firmware) the tile draws both itself.
      var Frame = wh.__hubFrame();
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
        if (best >= 0 && best < itemCount) {
          setSelectedIndex(best);
          wh.playSound('move');
        } else wh.playSound('blocked');
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
          // The stock frame binds Options on its own view, which never has focus
          // (the tile view does), so call its handler: it opens the frame's menu.
          var frame = Frame ? frameRef.current : null;
          var menu = frame ? null : optionsMenuRef.current;
          if (frame && typeof frame.onOptionsKeyDown === 'function') {
            frame.onOptionsKeyDown(event);
            stopBubble(event, key);
            if (!wh.__omLog) {
              wh.__omLog = 1;
              logLine('settings menu opened', id);
            }
            return true;
          }
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
            // While entered, native focus stays on the tile, as in the stock frame's
            // `locked` mode: the arrow handlers below return false, which tells the
            // native dispatcher the key was handled (no focus move); the cursor-end
            // ("cannot move") sound is off; moveSelection plays the move or blocked
            // sound for the selection instead. canMove*: false is a fallback for any
            // arrow event no handler sees.
            focusCustomSettings: active ? wh.__LOCKED : undefined,
            cursorEndSFXEnabledDirection: active ? ['none'] : undefined,
            style: root.Object.assign(
              wh.__box(dims),
              { borderRadius: dims.borderRadius, overflow: 'hidden' },
              Frame ? null : { backgroundColor: wh.StockTile.MAT_COLOR }
            ),
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
                  onButton('Up', e);
                  return false; // handled: the native focus does not move
                }
              : undefined,
            onDownKeyDown: active
              ? function (e) {
                  onButton('Down', e);
                  return false; // handled: the native focus does not move
                }
              : undefined,
            onLeftKeyDown: active
              ? function (e) {
                  onButton('Left', e);
                  return false; // handled: the native focus does not move
                }
              : undefined,
            onRightKeyDown: active
              ? function (e) {
                  onButton('Right', e);
                  return false; // handled: the native focus does not move
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
      // A hidden MINI stays mounted (so the widget can show itself again) in a
      // transparent box taken out of the row's layout, out of focus. Overflow does not
      // clip on the console, so opacity hides it. The element tree is the same either
      // way, so hiding and showing never remounts the widget.
      var hidden = isMini && !visible;
      if (Frame)
        return createElement(
          View,
          hidden ? { style: { position: 'absolute', opacity: 0, width: 0, height: 0 } } : null,
          createElement(
            ErrorBoundary,
            { wid: id },
            createElement(
              Frame,
              root.Object.assign({}, props, {
                ref: setFrameRef,
                name: id,
                id: id,
                data: frameData,
                Template: FrameTemplate,
                templateFocusable: true,
                templateProps: { __whMk: renderTileView },
                // Menu rows are MenuListItemPS elements; each row applies its own change.
                options: hasSettings ? wh.__buildOpts(cfg.settings, settings, setSetting) : undefined,
                initialFocusOption: 0,
              },
              hidden ? { focusable: false } : null)
            )
          ),
          hidden ? null : renderKeyGuide()
        );
      return createElement(
        View,
        null,
        createElement(
          FocusLayer,
          { style: width != null ? { width: width } : null },
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
    WidgetTile.contextTypes = {
      navigation: function () {
        return null;
      },
    };
    root.__wh_pages[id] = wh._p || null;
    root.__wh_cfgs[id] = cfg;
    if (wh.__isMini(cfg.size) && React.forwardRef) {
      // The MINI row hands each item a callback ref and counts an item as shown
      // while that ref holds an instance, so the ref goes on to the stock frame.
      var MiniTile = React.forwardRef(function (props, ref) {
        return createElement(WidgetTile, root.Object.assign({}, props, { __whRef: ref }));
      });
      MiniTile.__whId = id;
      root.__wh_widgets[id] = MiniTile;
      root.__wh_mini.push(id);
      return;
    }
    root.__wh_widgets[id] = WidgetTile;
    root.__wh_order.push(id);
  };

  // --- Hub hand-off ----------------------------------------------------------------
  // The patched bridge assigns the hub's WIDGET_MAP to __whWidgetMap (and its module
  // require to __whRequire) while the hub builds that map, before the first render.
  // The setter installed by __install registers our widgets at that moment.
  wh.__map = null;
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
  // MINI widgets: the hub's MINI ("transient") registry module holds WIDGET_MAP and
  // WIDGET_CONFIGS keyed by id, and WIDGET_PRIORITY, the order of the MINI row. The
  // hub copies the map and sizes the row on its first render, so this runs as soon
  // as the hub runtime is up (the __whWidgetMap setter), before that render.
  wh.__miniReg = function () {
    var hubRequire = root.__whRequire,
      id = (root.__wh_hubmods || {}).miniWidgets;
    if (typeof hubRequire !== 'function' || !id) return null;
    var reg = hubRequire(id);
    return reg && reg.WIDGET_MAP && reg.WIDGET_CONFIGS && root.Array.isArray(reg.WIDGET_PRIORITY) ? reg : null;
  };
  wh.__registerMini = function () {
    var ids = root.__wh_mini;
    if (!ids.length) return;
    try {
      var reg = wh.__miniReg();
      if (!reg) {
        logLine('MINI widgets [' + ids.join(', ') + '] not shown: MINI registry not found on this firmware', 0, 1);
        return;
      }
      for (var i = 0; i < ids.length; i++) {
        var cfg = root.__wh_cfgs[ids[i]] || {};
        reg.WIDGET_MAP[ids[i]] = root.__wh_widgets[ids[i]];
        // The row grows a focused item to expandedSize (MINI when unset).
        reg.WIDGET_CONFIGS[ids[i]] = cfg.size > 0 ? { expandedSize: cfg.size } : {};
        if (reg.WIDGET_PRIORITY.indexOf(ids[i]) < 0) reg.WIDGET_PRIORITY.push(ids[i]);
      }
      if (!wh.__miniLogged) {
        wh.__miniLogged = 1;
        logLine('MINI row registered ' + ids.length + ' widget(s) [' + ids.join(', ') + ']');
      }
    } catch (e) {
      logLine('registering MINI widgets failed: ' + errorText(e), 0, 1);
    }
  };
  // Keep our widget ids out of the hub's telemetry. The hub's widget telemetry module
  // reports the placed layout at startup: widgetConfiguration(layout) sends unknown
  // ids raw, widgetEncodedLayout(layout) sends them as -1. Both skip empty (null)
  // cells, and callers look the exports up at call time, so the wrappers below blank
  // our ids in a copy of the layout before the stock functions see it.
  wh.__hideTelemetry = function () {
    var hubRequire = root.__whRequire,
      id = (root.__wh_hubmods || {}).widgetTelemetry;
    if (wh.__telemetryHidden || typeof hubRequire !== 'function' || !id) return;
    try {
      var telemetry = hubRequire(id);
      if (!telemetry) return;
      var blankOurs = function (layout) {
        if (!root.Array.isArray(layout)) return layout;
        return layout.map(function (column) {
          if (!root.Array.isArray(column)) return column;
          return column.map(function (cell) {
            return typeof cell === 'string' && root.__wh_widgets[cell] ? null : cell;
          });
        });
      };
      var wrapped = 0;
      ['widgetConfiguration', 'widgetEncodedLayout'].forEach(function (name) {
        var original = telemetry[name];
        if (typeof original !== 'function') return;
        telemetry[name] = function (layout) {
          var args = root.Array.prototype.slice.call(arguments);
          try {
            args[0] = blankOurs(layout);
          } catch (e) {}
          return original.apply(this, args);
        };
        if (telemetry[name] !== original) wrapped++;
      });
      wh.__telemetryHidden = 1;
      logLine(
        wrapped === 2
          ? 'telemetry: custom widget ids filtered'
          : 'telemetry: custom widget ids NOT filtered (' + wrapped + '/2 hooks)',
        0,
        wrapped === 2 ? 0 : 1
      );
    } catch (e) {
      logLine('telemetry: filter failed: ' + errorText(e), 0, 1);
    }
  };

  // --- Telemetry switch (Welcome Hub Settings > Telemetry) ---------------------------
  // 'filter' (the default): the stock telemetry, without our widget ids (above).
  // 'off': no telemetry event leaves ShellUI's JavaScript. Every event goes through
  // NativeModules.VshNMTelemetryNq.SetEvent (hub module 863, the telemetry client's
  // native-queue transport), which callers look up at call time, so one wrapper there
  // stops all of them. It is installed in every runtime the loader runs in, before
  // that runtime's app code. The setting is console-wide, kept by the payload
  // (/__wget?w=.hub); until it arrives, events wait in memory.
  var HUB_SETTINGS_URL = 'http://127.0.0.1:8098/__wget?w=.hub';
  wh.__hubSettings = {};
  wh.__telemetry = { mode: null, queue: [], dropped: 0, send: null };
  wh.__telemetryApply = function (mode) {
    var t = wh.__telemetry,
      queue = t.queue;
    t.mode = mode === 'off' ? 'off' : 'filter';
    t.queue = [];
    if (t.mode === 'off') t.dropped += queue.length;
    else
      for (var i = 0; i < queue.length; i++)
        try {
          t.send.apply(queue[i][0], queue[i][1]);
        } catch (e) {}
    logLine(
      t.mode === 'off'
        ? 'telemetry: off (' + t.dropped + ' event(s) not sent so far)'
        : 'telemetry: on, custom widget ids filtered (' + queue.length + ' held event(s) sent)'
    );
  };
  wh.__telemetryGate = function () {
    var t = wh.__telemetry,
      native = null;
    try {
      native = vendor && vendor.NativeModules && vendor.NativeModules.VshNMTelemetryNq;
    } catch (e) {}
    if (!native || typeof native.SetEvent !== 'function') {
      logLine('telemetry: switch unavailable (VshNMTelemetryNq not found)', 0, 1);
      return;
    }
    if (native.SetEvent.__wh) return;
    t.send = native.SetEvent;
    var gate = function () {
      if (t.mode === 'filter') return t.send.apply(this, arguments);
      if (t.mode === 'off' || t.queue.length >= 500) t.dropped++;
      else t.queue.push([this, arguments]);
      return root.Promise.resolve();
    };
    gate.__wh = 1;
    try {
      native.SetEvent = gate;
    } catch (e) {}
    if (native.SetEvent !== gate) {
      logLine('telemetry: switch unavailable (SetEvent is read-only)', 0, 1);
      return;
    }
    // Read the setting; retry for 30 s (the payload may be busy), then send as usual.
    var tries = 0;
    var load = function () {
      var retry = function () {
        if (++tries < 15) root.setTimeout(load, 2000);
        else {
          logLine('telemetry: setting not readable, sending as usual', 0, 1);
          wh.__telemetryApply('filter');
        }
      };
      try {
        root
          .fetch(HUB_SETTINGS_URL)
          .then(function (response) {
            return response.json();
          })
          .then(function (saved) {
            if (saved && typeof saved === 'object') wh.__hubSettings = saved;
            wh.__telemetryApply(wh.__hubSettings.telemetry);
          }, retry);
      } catch (e) {
        retry();
      }
    };
    load();
  };
  wh.__setHubSetting = function (name, value) {
    wh.__hubSettings[name] = value;
    try {
      root.fetch(
        'http://127.0.0.1:8098/__wset?w=.hub&h=' + hexEncode(root.JSON.stringify(wh.__hubSettings))
      );
    } catch (e) {
      logLine('hub settings not saved: ' + errorText(e), 0, 1);
    }
  };
  wh.__telemetryGate();

  // --- Welcome Hub Settings rows ---------------------------------------------------
  // The Settings screen builds its rows in a useMemo and reads each row module's
  // `default` every time, so wrapping the "Followed games" row (hub module
  // hubSettingsFollowedGames, the last row it always shows) adds ours after it.
  var DATA_PAGE = '.data'; // a leading dot: never a widget id
  function hubPickerItems(pairs) {
    return pairs.map(function (p) {
      return createElement(wh.Picker.Item, { key: p[1], label: p[0], value: p[1] });
    });
  }
  function TelemetryRow() {
    var state = React.useState(wh.__telemetry.mode || 'filter'),
      mode = state[0],
      setMode = state[1];
    return createElement(wh.MenuListItemPS.Dropdown, {
      label: 'Telemetry',
      description:
        mode === 'off'
          ? 'Nothing is reported.'
          : 'Reported as usual, without your custom widgets.',
      value: mode,
      items: hubPickerItems([
        ['Hide custom widgets', 'filter'],
        ['Off', 'off'],
      ]),
      onValueChange: function (value) {
        setMode(value);
        wh.__setHubSetting('telemetry', value);
        wh.__telemetryApply(value);
      },
    });
  }
  function WidgetDataRow(props, context) {
    return createElement(wh.MenuListItemPS.Button, {
      label: 'Widget Data',
      description: 'See and delete what widgets saved for you.',
      onPress: function () {
        var navigation = context && context.navigation;
        if (!navigation || typeof navigation.navigate !== 'function' || !wh.__pageRoute()) {
          logLine('widget data page not opened: no navigation here', 0, 1);
          return;
        }
        navigation.navigate(WH_PAGE_ROUTE, { __wh: DATA_PAGE });
      },
    });
  }
  // Legacy context: the hub's react-navigation passes `navigation` this way.
  WidgetDataRow.contextTypes = {
    navigation: function () {
      return null;
    },
  };
  wh.__hubSettingsRows = function () {
    var hubRequire = root.__whRequire,
      id = (root.__wh_hubmods || {}).hubSettingsFollowedGames;
    if (typeof hubRequire !== 'function' || !id || !wh.MenuListItemPS || !wh.Picker) {
      logLine('settings rows unavailable on this firmware', 0, 1);
      return;
    }
    try {
      var row = hubRequire(id),
        Stock = row && row['default'];
      if (!Stock) throw new Error('Followed games row not found');
      if (Stock.__wh) return;
      var Rows = function (props) {
        return [
          createElement(Stock, root.Object.assign({ key: 'stock' }, props)),
          createElement(TelemetryRow, { key: 'whTelemetry' }),
          createElement(WidgetDataRow, { key: 'whData' }),
        ];
      };
      Rows.__wh = 1;
      row['default'] = Rows;
      if (row['default'] !== Rows) throw new Error('row is read-only');
      logLine('settings rows added (Telemetry, Widget data)');
    } catch (e) {
      logLine('settings rows not added: ' + errorText(e), 0, 1);
    }
  };

  // --- Widget data page ----------------------------------------------------------
  // Lists what widgets keep with props.storage for the signed-in user (AsyncStorage
  // 'wh:data:<id>'), so the data of removed widgets can be deleted.
  function dataSize(chars) {
    return chars < 1024 ? chars + ' B' : (chars / 1024).toFixed(1) + ' KB';
  }
  function WidgetDataPage() {
    var listState = React.useState(null),
      list = listState[0],
      setList = listState[1],
      askState = React.useState(null),
      ask = askState[0],
      setAsk = askState[1];
    var storage = vendor && vendor.AsyncStorage;
    var load = function () {
      if (!storage || typeof storage.getAllKeys !== 'function') {
        setList([]);
        return;
      }
      root.Promise.resolve(storage.getAllKeys())
        .then(function (keys) {
          keys = (keys || []).filter(function (k) {
            return typeof k === 'string' && k.indexOf(WH_STORAGE_PREFIX) === 0;
          });
          return keys.length ? storage.multiGet(keys) : [];
        })
        .then(
          function (pairs) {
            var out = (pairs || []).map(function (pair) {
              var id = pair[0].slice(WH_STORAGE_PREFIX.length),
                text = pair[1] || '',
                count = 0,
                cfg = root.__wh_cfgs[id];
              try {
                var data = root.JSON.parse(text);
                if (data && typeof data === 'object') count = root.Object.keys(data).length;
              } catch (e) {}
              return {
                id: id,
                title: (cfg && cfg.title) || id,
                installed: !!cfg,
                size: text.length,
                count: count,
              };
            });
            out.sort(function (a, b) {
              if (a.installed !== b.installed) return a.installed ? 1 : -1;
              return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
            });
            setList(out);
          },
          function (e) {
            logLine('widget data: reading failed: ' + errorText(e), 0, 1);
            setList([]);
          }
        );
    };
    React.useEffect(load, []);
    var remove = function (items) {
      var ids = items.map(function (item) {
        return item.id;
      });
      root.Promise.all(
        ids.map(function (id) {
          return storage.removeItem(WH_STORAGE_PREFIX + id);
        })
      ).then(
        function () {
          ids.forEach(function (id) {
            if (wh.__stores[id]) wh.__stores[id].__forget();
          });
          logLine('widget data deleted: ' + ids.join(', '));
          load();
        },
        function (e) {
          logLine('widget data: delete failed: ' + errorText(e), 0, 1);
          load();
        }
      );
    };
    var Item = wh.MenuListItemPS;
    var rows = [];
    if (!list) rows.push({ kind: 'note', label: 'Loading...' });
    else if (!list.length) rows.push({ kind: 'note', label: 'No widget data saved for you' });
    else {
      var removed = list.filter(function (item) {
        return !item.installed;
      });
      if (removed.length > 1)
        rows.push({
          kind: 'removed',
          label: 'Delete data of all removed widgets',
          description: removed.length + ' widgets that are not installed',
          items: removed,
        });
      list.forEach(function (item) {
        rows.push({
          kind: 'widget',
          label: item.title,
          description:
            (item.installed ? 'Installed' : 'Not installed') +
            ' - ' +
            item.count +
            (item.count === 1 ? ' value, ' : ' values, ') +
            dataSize(item.size),
          items: [item],
        });
      });
    }
    var renderItem = function (row) {
      return createElement(Item.Button, {
        label: row.label,
        description: row.description,
        onPress: function () {
          if (row.kind === 'widget')
            setAsk({ title: 'Delete the data of ' + row.label + '?', items: row.items });
          else if (row.kind === 'removed')
            setAsk({ title: 'Delete the data of ' + row.items.length + ' removed widgets?', items: row.items });
        },
      });
    };
    var answer = function (yes) {
      return function () {
        var items = ask && ask.items;
        setAsk(null);
        if (yes && items) remove(items);
      };
    };
    var F = wh.FontSizePS;
    return createElement(
      View,
      { style: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' } },
      createElement(
        View,
        { style: { width: 1500, height: 918, marginTop: 162 } },
        createElement(wh.Label, { style: { fontSize: F.Size2XLarge } }, 'Widget Data'),
        createElement(
          wh.Label,
          { numberOfLines: 2, style: { fontSize: F.Size3XSmall, opacity: 0.6, marginTop: 8 } },
          'What widgets saved for the signed-in user. Deleting it resets that widget; one on screen keeps what it shows until you sign out and back in.'
        ),
        wh.List
          ? createElement(wh.List, {
              data: rows,
              renderItem: renderItem,
              style: { flex: 1, width: '100%', marginVertical: 40 },
            })
          : null
      ),
      ask && wh.AlertDialogPS
        ? createElement(
            wh.AlertDialogPS,
            {
              title: ask.title,
              buttons: {
                positive: { text: 'Delete', onPress: answer(true) },
                negative: { text: 'Cancel', onPress: answer(false) },
              },
              onRequestClose: answer(false),
            },
            createElement(Text, null, 'This cannot be undone.')
          )
        : null
    );
  }
  root.__wh_pages[DATA_PAGE] = WidgetDataPage;
  // Custom placements survive a boot without the payload. The hub keeps the saved
  // layout in AsyncStorage 'widget:customTemplates' ({templateId: columns of widget
  // ids}). Without the payload it loads our ids as empty (null) cells, and the next
  // save (leaving Edit Widgets, a layout change) stores those nulls. So while the
  // payload runs, every save of that key is mirrored to WH_LAYOUT_BACKUP, and when the
  // hub reads the layout, our ids from the backup go back into the cells that are
  // still empty. The read is wrapped, so the hub sees the restored layout before it
  // first lays out the grid.
  var HUB_LAYOUT_KEY = 'widget:customTemplates',
    WH_LAYOUT_BACKUP = 'wh:customTemplates';
  // Restore our grid widgets from backupJson into storedJson. A save without the
  // payload keeps a null where one of our widgets shared a column with stock ones,
  // and drops columns that held only ours (console-verified). So the saved columns
  // are lined up with the stored ones first: a saved column holding only our
  // widgets, all missing, comes back whole; every other one matches the next stored
  // column (the editor keeps their order). Then each missing widget goes back into
  // its cells if they are all still empty, or else into the first free run of cells
  // of its height. Returns {json, count}, or null when nothing changes.
  wh.__restoreLayout = function (storedJson, backupJson) {
    var stored = root.JSON.parse(storedJson),
      backup = root.JSON.parse(backupJson),
      restored = 0,
      isArray = root.Array.isArray;
    if (!stored || typeof stored !== 'object' || !backup || typeof backup !== 'object') return null;
    var ours = function (id) {
      return typeof id === 'string' && root.__wh_order.indexOf(id) >= 0;
    };
    for (var key in stored) {
      var columns = stored[key],
        saved = backup[key];
      if (!isArray(columns) || !isArray(saved)) continue;
      var present = {};
      for (var c = 0; c < columns.length; c++)
        if (isArray(columns[c]))
          for (var r = 0; r < columns[c].length; r++) if (columns[c][r]) present[columns[c][r]] = 1;
      var missing = function (id) {
        return ours(id) && !present[id];
      };
      // 1. Line up the columns: where[i] is the result column of saved column i.
      var result = [],
        where = [],
        inserted = [],
        next = 0;
      for (var i = 0; i < saved.length; i++) {
        var col = saved[i],
          onlyOurs = isArray(col) && col.length > 0,
          anyMissing = false;
        for (var k = 0; onlyOurs && k < col.length; k++) {
          if (col[k] != null && !ours(col[k])) onlyOurs = false;
          if (missing(col[k])) anyMissing = true;
        }
        if (onlyOurs && anyMissing) {
          where[i] = result.length;
          inserted.push(result.length);
          result.push(col.map(function () {
            return null;
          }));
        } else if (next < columns.length) {
          where[i] = result.length;
          result.push(columns[next++]);
        } else where[i] = -1;
      }
      while (next < columns.length) result.push(columns[next++]);
      // 2. The cells each missing widget held, in result coordinates.
      var spots = {},
        order = [];
      for (var i2 = 0; i2 < saved.length; i2++)
        if (isArray(saved[i2]))
          for (var r2 = 0; r2 < saved[i2].length; r2++) {
            var id = saved[i2][r2];
            if (!missing(id)) continue;
            if (!spots[id]) {
              spots[id] = [];
              order.push(id);
            }
            spots[id].push([where[i2], r2]);
          }
      var free = function (cells) {
        for (var q = 0; q < cells.length; q++) {
          var column = cells[q][0] >= 0 ? result[cells[q][0]] : null;
          if (!isArray(column) || cells[q][1] >= column.length || column[cells[q][1]] != null) return false;
        }
        return true;
      };
      var place = function (widgetId, cells) {
        for (var q = 0; q < cells.length; q++) result[cells[q][0]][cells[q][1]] = widgetId;
        restored++;
      };
      // Own cells first, so a widget never takes the cells of another one of ours.
      var blocked = [];
      for (var o = 0; o < order.length; o++) {
        if (free(spots[order[o]])) place(order[o], spots[order[o]]);
        else blocked.push(order[o]);
      }
      // Then the first free run of the same height, for widgets in one column.
      for (var bi = 0; bi < blocked.length; bi++) {
        var cellsOf = spots[blocked[bi]],
          height = cellsOf.length,
          oneColumn = true;
        for (var h = 1; h < height; h++) if (cellsOf[h][0] !== cellsOf[0][0]) oneColumn = false;
        if (!oneColumn) continue;
        search: for (var rc = 0; rc < result.length; rc++) {
          if (!isArray(result[rc])) continue;
          for (var start = 0; start + height <= result[rc].length; start++) {
            var run = [];
            for (var z = 0; z < height; z++) run.push([rc, start + z]);
            if (free(run)) {
              place(blocked[bi], run);
              break search;
            }
          }
        }
      }
      // A reinserted column whose widgets could not come back is dropped again.
      stored[key] = result.filter(function (column, index) {
        if (inserted.indexOf(index) < 0) return true;
        for (var q = 0; q < column.length; q++) if (column[q] != null) return true;
        return false;
      });
    }
    return restored ? { json: root.JSON.stringify(stored), count: restored } : null;
  };
  wh.__layoutBackup = function () {
    var storage = vendor && vendor.AsyncStorage;
    if (!storage || typeof storage.multiGet !== 'function' || typeof storage.setItem !== 'function') {
      logLine('layout backup off: AsyncStorage not found', 0, 1);
      return;
    }
    // A new widget revision runs the loader again; the wrappers stay installed.
    if (storage.multiGet.__wh) return;
    var multiGet = storage.multiGet,
      setItem = storage.setItem,
      removeItem = storage.removeItem;
    try {
      storage.setItem = function (key, value) {
        var result = setItem.apply(this, arguments);
        if (key === HUB_LAYOUT_KEY)
          try {
            root.Promise.resolve(setItem.call(storage, WH_LAYOUT_BACKUP, value)).then(function () {
              if (!wh.__lbSaved) {
                wh.__lbSaved = 1;
                logLine('layout backup saved');
              }
            }, function () {});
          } catch (e) {}
        return result;
      };
      if (typeof removeItem === 'function')
        storage.removeItem = function (key) {
          var result = removeItem.apply(this, arguments);
          // The user reset the layout: forget the backup too.
          if (key === HUB_LAYOUT_KEY)
            try {
              root.Promise.resolve(removeItem.call(storage, WH_LAYOUT_BACKUP)).then(null, function () {});
            } catch (e) {}
          return result;
        };
      storage.multiGet = function (keys) {
        var result = multiGet.apply(this, arguments);
        if (
          !root.Array.isArray(keys) ||
          keys.indexOf(HUB_LAYOUT_KEY) < 0 ||
          typeof arguments[1] === 'function' ||
          !result ||
          typeof result.then !== 'function'
        )
          return result;
        return result.then(function (pairs) {
          var at = -1;
          for (var i = 0; root.Array.isArray(pairs) && i < pairs.length; i++)
            if (pairs[i] && pairs[i][0] === HUB_LAYOUT_KEY) at = i;
          var stored = at >= 0 ? pairs[at][1] : null;
          if (!stored) return pairs;
          return root.Promise.resolve(multiGet.call(storage, [WH_LAYOUT_BACKUP])).then(
            function (backupPairs) {
              var backup = backupPairs && backupPairs[0] && backupPairs[0][1];
              try {
                if (!backup) {
                  // First run with this feature: start the backup from the saved layout.
                  setItem.call(storage, WH_LAYOUT_BACKUP, stored);
                  logLine('layout backup started from the saved layout');
                  return pairs;
                }
                var change = wh.__restoreLayout(stored, backup);
                if (change) {
                  pairs[at] = [HUB_LAYOUT_KEY, change.json];
                  logLine('layout: restored ' + change.count + ' custom widget placement(s) from the backup');
                }
              } catch (e) {
                logLine('layout restore failed: ' + errorText(e), 0, 1);
              }
              return pairs;
            },
            function () {
              return pairs;
            }
          );
        });
      };
      storage.multiGet.__wh = 1;
      logLine('layout backup on');
    } catch (e) {
      logLine('layout backup off: ' + errorText(e), 0, 1);
    }
  };
  // Drop our ids from the MINI registry (a new widget revision registers afresh).
  wh.__miniReset = function () {
    var ids = root.__wh_mini;
    try {
      var reg = ids.length ? wh.__miniReg() : null;
      for (var i = 0; reg && i < ids.length; i++) {
        delete reg.WIDGET_MAP[ids[i]];
        delete reg.WIDGET_CONFIGS[ids[i]];
        var at = reg.WIDGET_PRIORITY.indexOf(ids[i]);
        if (at >= 0) reg.WIDGET_PRIORITY.splice(at, 1);
      }
    } catch (e) {}
    root.__wh_mini = [];
    wh.__miniLogged = 0;
  };
  // Edit Widgets list. The hub offers the ids in the widget-id module's EDITABLE
  // table and reads each entry's title, icon and description from three tables
  // keyed by widget id. All four are read when the list is built, so filling them
  // when the hub runtime comes up (the __whWidgetMap setter) is early enough.
  // [hub module name in __wh_hubmods, config field the table is filled from]
  wh.__editFields = [
    ['editTitles', 'title'],
    ['editIcons', 'iconId'],
    ['editDescs', 'description'],
  ];
  wh.__registerEditList = function () {
    var hubRequire = root.__whRequire,
      mods = root.__wh_hubmods || {},
      order = root.__wh_order;
    if (typeof hubRequire !== 'function' || !order.length) return;
    try {
      var widgetIds = mods.widgetIds ? hubRequire(mods.widgetIds) : null;
      if (!widgetIds || !widgetIds.EDITABLE || typeof widgetIds.EDITABLE !== 'object')
        throw new Error('widget id table not found on this firmware');
      // The module's `default` is a copy of EDITABLE plus the non-editable ids;
      // our ids go in both, like the stock editable ones.
      var copy = widgetIds['default'];
      for (var i = 0; i < order.length; i++) {
        widgetIds.EDITABLE['__wh_' + order[i]] = order[i];
        if (copy && typeof copy === 'object' && copy !== widgetIds.EDITABLE) copy['__wh_' + order[i]] = order[i];
      }
    } catch (e) {
      if (!wh.__editErr) {
        wh.__editErr = 1;
        logLine('marking widgets editable failed (edit mode would drop them): ' + errorText(e), 0, 1);
      }
    }
    for (var f = 0; f < wh.__editFields.length; f++) {
      var moduleName = wh.__editFields[f][0],
        field = wh.__editFields[f][1],
        table = null;
      try {
        var tableModule = mods[moduleName] ? hubRequire(mods[moduleName]) : null;
        table = tableModule && tableModule['default'];
      } catch (e) {}
      if (!table || typeof table !== 'object') {
        if (!wh['__el_' + field]) {
          wh['__el_' + field] = 1;
          logLine('edit list ' + field + ' not set: ' + moduleName + ' not found on this firmware', 0, 1);
        }
        continue;
      }
      for (var j = 0; j < order.length; j++) {
        try {
          var widgetCfg = root.__wh_cfgs[order[j]] || {};
          var value = widgetCfg[field];
          if (!value && field === 'title') value = order[j];
          if (!value && field === 'iconId') value = 'app_welcome';
          if (
            field === 'iconId' &&
            typeof value === 'string' &&
            value.indexOf('wh:') === 0 &&
            !wh.__iconPatched
          )
            value = widgetCfg.iconFallback || 'app_welcome';
          table[order[j]] = value || '';
        } catch (e) {
          logLine('edit list ' + field + ' not set: ' + errorText(e), order[j]);
        }
      }
      if (!wh['__el_' + field]) {
        wh['__el_' + field] = 1;
        logLine('edit list ' + field + ' set for ' + order.length + ' widget(s)');
      }
    }
  };
  // Turn the bridge's hand-off global into an accessor. A value assigned before the
  // loader ran is re-assigned through the new setter.
  wh.__install = function () {
    var previousMap = null;
    try {
      var descriptor = root.Object.getOwnPropertyDescriptor(root, '__whWidgetMap');
      if (descriptor && 'value' in descriptor && descriptor.value) previousMap = descriptor.value;
    } catch (e) {}
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
            } catch (e) {}
            wh.__localeInit();
            wh.__hubStateInit();
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
          wh.__registerEditList();
          wh.__layoutBackup();
          wh.__registerMini();
          wh.__hideTelemetry();
          if (!wh.__hsr) {
            // Once the hub's own startup code has run (the row module's dependencies).
            wh.__hsr = 1;
            root.setTimeout(wh.__hubSettingsRows, 0);
          }
        },
      });
      if (previousMap) root.__whWidgetMap = previousMap;
    } catch (e) {
      logLine('installing registry hooks failed: ' + errorText(e), 0, 1);
    }
  };
  // Called after the last widget section: register now, or poll for up to 8 s.
  wh.__flush = function () {
    wh.__install();
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
