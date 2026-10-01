/* Moon — the Limits section (#limitler; contract §13, addendum E10/E11,
 * simplification §4).
 *
 * NO DIALOG LIVES HERE ANY MORE. A limit is a figure the reader changes over
 * and over, and paying a modal for it — open, wait, fill, save, close — is the
 * single most expensive way to type four digits. Every write on this screen is
 * now made in place:
 *
 *   - the limit on each scale row IS a Moon.UI.inlineValue: click the number,
 *     type, Enter. Empty + Enter removes the limit (onSave(null)), which is
 *     why there is no "remove" button and no confirmation next to it.
 *   - the scale is DRAGGABLE: the grip sits on the 100% end cap that charts.js
 *     draws — the end of the filled track — and pulling it right or left moves
 *     the limit under the finger. It is one pointer path for mouse and touch
 *     alike, it carries role="slider" with its own aria values, and the arrow
 *     keys do the same job, so the drag is an ADDITION and never the only way.
 *   - category management (rename, fix, archive) is inline too: the name is an
 *     inlineValue, the two marks are pressed buttons. Deleting a category asks
 *     nothing and offers an eight-second undo band instead, because nothing is
 *     destroyed: Moon.Model moves the entries to the catch-all and this file
 *     keeps enough of a snapshot to put every one of them back.
 *   - the adder at the bottom is a Moon.UI.quickRow, so Enter writes the
 *     category and parks the caret back on the name for the next one.
 *
 * Three readings, in reading order:
 *   0. beside the section title, one quiet control that offers to read the
 *      reader's own closed periods and propose a limit per category
 *      (Moon.Model.suggestLimits). It opens a block inside this same section,
 *      not a screen or a standing band, and closes itself once the chosen rows
 *      are written. Rows that already carry a limit arrive unticked.
 *   1. one horizontal scale per category (Moon.Charts.meter). This IS the
 *      category comparison chart — every row shares one x axis — which is why
 *      there is no pie anywhere in this application.
 *   2. the year grid (jury G2): twelve periods by category, density drawn as
 *      line spacing rather than colour, so it survives a monochrome printer.
 *   3. the category list, because a limit needs a category before it exists.
 *
 * The view only reads. Every write goes through Moon.Model, never through
 * Moon.Store, and the router re-renders this whole file on state:change and
 * lang:change — so render() clears its root, keeps no state between calls and
 * may run any number of times. That redraw is also why every inline control
 * leaves a `data-focus` stamp behind: a write destroys the control that made
 * it, and the stamp is how the focus finds its way back to the same number.
 *
 * Three deliberate seams, all documented where they are used:
 *   - ui.js and moon.css were written in parallel and spell a handful of class
 *     names differently. Neither file is ours to edit, so the stylesheet's
 *     spelling is added to the nodes Moon.UI hands back.
 *   - charts.js is not ours either, so the grip is measured against the
 *     meter's documented geometry (E4: trackWidth and readoutWidth are one
 *     setting) from the outside and the listener is installed on our side.
 *   - the brief names i18n keys the catalogue does not carry yet
 *     (limits.drift.*, limits.year.*, limits.category.*). Each is asked for
 *     first, so a later catalogue wins automatically, and falls back to the
 *     sentence that already says the same thing. Nothing is hard-coded.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var dom = Moon.dom;

  /* E4: these two are one setting. An overrun leaves the track and reaches into
     the readout column; that reach is measured against READOUT_WIDTH, so a row
     built to another ratio would land the spill in the wrong place (jury G1). */
  var TRACK_WIDTH = 240;
  var READOUT_WIDTH = 132;

  /* The rest of the meter's geometry, read off charts.js rather than guessed:
     the viewBox is labelWidth + trackWidth + readoutWidth + 8 and the track
     starts at labelWidth + 4. We pass no labelWidth, so it is 0. The spill is
     allowed max(12, readoutWidth - 8) and the scale only renormalises above
     150% — above that one unit of track is worth (track + spill) / ratio.
     This is the whole conversion the drag needs: pixel -> ratio -> amount. */
  var VIEW_WIDTH = TRACK_WIDTH + READOUT_WIDTH + 8;
  var TRACK_X0 = 4;
  var MAX_SPILL = Math.max(12, READOUT_WIDTH - 8);
  var RENORM_AT = 1.5;

  /* 100 TL a step, 10 TL once the limit is under 500 TL — a 300 TL limit moved
     in hundreds would only have three usable positions. */
  var STEP_COARSE = 10000;
  var STEP_FINE = 1000;
  var FINE_BELOW = 50000;

  /* A finger is not a pixel: the grip is a 44px target centred on a 1px cap. */
  var GRIP_PX = 44;

  /* The suggestion block (Moon.Model.suggestLimits) is asked for, never
     standing: it opens from one control beside the section title and closes
     again the moment it has done its work. These variables are the whole of
     its state, and every one of them survives a re-render on purpose —
     the router redraws this file on state:change and lang:change, and a reader
     who switched language mid-review must not lose their ticks. */
  var SUGGEST_ID = "limits-suggest";
  var TOGGLE_ID = "limits-suggest-toggle";

  var suggestOpen = false;
  /* categoryId -> boolean. null means "nobody has touched a box yet", which is
     not the same as "every box is off". */
  var suggestPicks = null;
  /* How many limits the last write produced, read once by the next render. */
  var appliedCount = 0;
  var lastRoot = null;

  /* Every inline write replaces the control that made it, because the write
     emits state:change and the router redraws the section. This is the stamp
     the next render looks for to hand the focus back. */
  var pendingFocus = null;

  /* The adder keeps its kind and its fixed mark between writes. keepOnSubmit
     does that within one quickRow; this does it across the redraw that every
     write brings with it. */
  var addMemory = { kind: "expense", fixed: false };

  /* True only while a pointer is dragging a grip: text selection is turned off
     on <html> for that time and has to be turned back on even if the reader
     navigates away mid-drag. */
  var dragLock = false;

  /* The category whose limit was just written. The next render marks that one
     scale and clears this, so the mark belongs to the action and never to the
     redraw — both the Limits screen and the panel's short list read it, and
     whichever draws first takes it. */
  var settleId = null;

  /* ---------------------------------------------------------------- basics */

  function log(error) {
    if (global.console && global.console.error) {
      global.console.error("Moon.Views.limits", error);
    }
  }

  /* No handler on this screen may take the page down with it. */
  function guard(fn) {
    return function (a, b) {
      try {
        return fn(a, b);
      } catch (error) {
        log(error);
        return undefined;
      }
    };
  }

  function t(key, params) {
    var i18n = Moon.I18n;
    if (key === null || key === undefined) return "";
    if (i18n && typeof i18n.t === "function") {
      try {
        return i18n.t(key, params);
      } catch (error) {
        log(error);
      }
    }
    return String(key);
  }

  function has(key) {
    var i18n = Moon.I18n;
    if (!i18n || typeof i18n.has !== "function") return false;
    try {
      return !!i18n.has(key);
    } catch (error) {
      return false;
    }
  }

  /* The key the brief asked for if the catalogue can answer it, otherwise the
     existing key that carries the same sentence. */
  function key(wanted, fallback) {
    return has(wanted) ? wanted : fallback;
  }

  function tk(wanted, fallback, params) {
    return t(key(wanted, fallback), params);
  }

  function addClass(node, name) {
    if (node && name && node.classList) node.classList.add(name);
    return node;
  }

  function css(node, prop, value) {
    if (!node || !node.style || typeof node.style.setProperty !== "function") return node;
    node.style.setProperty(prop, value);
    return node;
  }

  function focusIt(node) {
    if (!node || typeof node.focus !== "function") return false;
    try {
      node.focus();
    } catch (error) {
      log(error);
      return false;
    }
    return true;
  }

  function settings() {
    var store = Moon.Store;
    var state = store && store.state ? store.state : null;
    return state && state.settings ? state.settings : {};
  }

  /* Read-only peek at a bucket Moon.Model exposes no reader for. The view
     never writes here (E10) — the recurring rules of a category being deleted
     have to be remembered so the undo band can point them back. */
  function bucket(name) {
    var store = Moon.Store;
    var state = store && store.state ? store.state : null;
    var rows = state ? state[name] : null;
    return Object.prototype.toString.call(rows) === "[object Array]" ? rows : [];
  }

  function lang() {
    var i18n = Moon.I18n;
    return (i18n && i18n.lang) || "tr";
  }

  function currency() {
    return settings().currency || "TRY";
  }

  function overflowMark() {
    return settings().overflowMark === "flare" ? "flare" : "pigment";
  }

  /* ----------------------------------------------------------------- money */

  function moneyOpts() {
    return { currency: currency(), lang: lang(), symbol: true };
  }

  /* Charts get this as opts.formatValue (E4), and every sentence on the screen
     gets its {amount} from it, so one rule formats every number here. */
  function money(minor) {
    var Money = Moon.Money;
    var value = typeof minor === "number" && isFinite(minor) ? Math.round(minor) : 0;
    if (Money && typeof Money.format === "function") {
      try {
        var text = Money.format(value, moneyOpts());
        if (text) return String(text);
      } catch (error) {
        log(error);
      }
    }
    return String(value);
  }

  function symbolFirst() {
    var Money = Moon.Money;
    if (Money && typeof Money.parts === "function") {
      try {
        return !!Money.parts(0, moneyOpts()).symbolFirst;
      } catch (error) { /* fall through to the language rule */ }
    }
    return lang() !== "tr";
  }

  /* moon.css places the symbol span by grid column, and needs .is-sym-first to
     move it in front of the digits; ui.js only changes the DOM order. */
  function moneyCell(minor, extra) {
    var UI = Moon.UI;
    var opts = { currency: currency(), lang: lang(), sign: false };
    var classes = symbolFirst() ? "is-sym-first" : "";
    if (extra) classes = classes ? classes + " " + extra : extra;
    if (classes) opts["class"] = classes;
    if (UI && typeof UI.moneyCell === "function") {
      try {
        return UI.moneyCell(minor, opts);
      } catch (error) {
        log(error);
      }
    }
    return dom.el("span", { "class": "money", text: money(minor) });
  }

  /* ----------------------------------------------------------------- dates */

  function formatDay(date) {
    var Dates = Moon.Dates;
    if (Dates && typeof Dates.formatDate === "function") {
      try {
        return String(Dates.formatDate(date, lang(), "short") || "");
      } catch (error) {
        log(error);
      }
    }
    return date === null || date === undefined ? "" : String(date);
  }

  function fullMonth(periodKey) {
    var Dates = Moon.Dates;
    if (Dates && typeof Dates.formatPeriod === "function") {
      try {
        var text = Dates.formatPeriod(periodKey, lang());
        if (text) return String(text);
      } catch (error) {
        log(error);
      }
    }
    return periodKey === null || periodKey === undefined ? "" : String(periodKey);
  }

  /* charts.yearGrid clips a column head to four characters and formatPeriod has
     no short style (it answers "September 2026"), so the abbreviation is taken
     from the locale's own short date with its day number stripped off. */
  function shortMonth(periodKey) {
    if (!/^\d{4}-\d{2}$/.test(String(periodKey || ""))) return "";
    var abbreviated = formatDay(periodKey + "-01")
      .replace(/[0-9]/g, "")
      .replace(/[.,\s ]+/g, " ")
      .replace(/^\s+|\s+$/g, "");
    if (abbreviated) return abbreviated;
    return fullMonth(periodKey).replace(/\s*\d{4}\s*/, "").replace(/^\s+|\s+$/g, "");
  }

  /* The header owns the period selector; the view only reads it (E10). */
  function activePeriod() {
    var app = Moon.App;
    var chosen = app && app.period ? String(app.period) : "";
    if (/^\d{4}-\d{2}$/.test(chosen)) return chosen;

    var Dates = Moon.Dates;
    if (Dates && typeof Dates.periodKey === "function" && typeof Dates.today === "function") {
      try {
        var derived = Dates.periodKey(Dates.today(), settings().monthStartDay || 1);
        if (derived) return String(derived);
      } catch (error) {
        log(error);
      }
    }
    return null;
  }

  /* --------------------------------------------------------------- controls */

  /* moon.css styles a button as .btn plus one state class; ui.js emits
     .btn--<kind> instead, and ui.js does not export its builder. */
  function btn(labelKey, variant, onClick, params) {
    var classes = ["btn"];
    if (variant) classes.push("is-" + variant);
    var node = dom.el("button", {
      type: "button",
      "class": classes.join(" "),
      text: t(labelKey, params)
    });
    node.addEventListener("click", guard(function () {
      onClick();
    }));
    return node;
  }

  function small(text) {
    return dom.el("p", { "class": "sm dim", text: text });
  }

  /* The one live region (#strip). ui.js asks for common.dismiss, which the
     catalogue does not carry; common.close does and says the same thing. */
  function strip(messageKey, params, onUndo) {
    var UI = Moon.UI;
    if (!UI || typeof UI.undoStrip !== "function") return;
    try {
      UI.undoStrip({
        messageKey: messageKey,
        params: params,
        dismissKey: "common.close",
        onUndo: guard(onUndo),
        seconds: 8
      });
    } catch (error) {
      log(error);
    }
  }

  function notice(kind, messageKey, params, dismissible) {
    var UI = Moon.UI;
    if (!UI || typeof UI.notice !== "function") return null;
    var node;
    try {
      node = UI.notice({
        kind: kind,
        messageKey: messageKey,
        params: params,
        dismissible: !!dismissible,
        dismissKey: "common.close"
      });
    } catch (error) {
      log(error);
      return null;
    }
    addClass(node, "is-" + kind);
    addClass(dom.qs(".notice__text", node), "notice__body");
    return node;
  }

  /* moon.css styles the chart twin as .numbers > .table; ui.js emits
     .datatable / .datatable__table. A wide grid also needs somewhere to
     scroll, which .preview already provides. */
  function numbers(node) {
    if (!node) return null;
    addClass(node, "numbers");
    var table = dom.qs(".datatable__table", node);
    if (table && table.parentNode) {
      addClass(table, "table");
      var scroller = dom.el("div", { "class": "preview" });
      table.parentNode.insertBefore(scroller, table);
      scroller.appendChild(table);
    }
    return node;
  }

  /* moon.css styles the empty page as .empty__title and full-width .btn.is-row
     rows; ui.js emits .empty__heading and .empty__action. */
  function emptyBlock(spec) {
    var UI = Moon.UI;
    if (!UI || typeof UI.emptyState !== "function") return null;
    var node;
    try {
      node = UI.emptyState(spec);
    } catch (error) {
      log(error);
      return null;
    }
    addClass(dom.qs(".empty__heading", node), "empty__title");
    dom.qsa(".empty__action", node).forEach(function (control) {
      addClass(control, "btn");
      addClass(control, "is-row");
    });
    return node;
  }

  function dataTable(columns, rows, opts) {
    var UI = Moon.UI;
    if (!UI || typeof UI.dataTable !== "function" || !rows.length) return null;
    try {
      return numbers(UI.dataTable(columns, rows, opts));
    } catch (error) {
      log(error);
      return null;
    }
  }

  /* ------------------------------------------------------------ model reads */

  function model() {
    return Moon.Model;
  }

  function read(name, argument, fallback) {
    var Model = model();
    if (!Model || typeof Model[name] !== "function") return fallback;
    try {
      var value = Model[name](argument);
      return value === null || value === undefined ? fallback : value;
    } catch (error) {
      log(error);
      return fallback;
    }
  }

  function context() {
    var periodKey = activePeriod();
    return {
      period: periodKey,
      rows: read("budgetRows", periodKey, []),
      summary: read("periodSummary", periodKey, {}),
      mark: overflowMark()
    };
  }

  function isOver(row) {
    return !!row && row.limit !== null && row.limit !== undefined && row.spent > row.limit;
  }

  function overBy(row) {
    return Math.max(0, (row.spent || 0) - (row.limit || 0));
  }

  function pctOf(row) {
    if (row.pct === null || row.pct === undefined || !isFinite(row.pct)) return 0;
    return Math.round(row.pct);
  }

  function paceOf(row) {
    var ratio = Number(row.paceRatio);
    return isFinite(ratio) ? Math.round(Math.max(0, Math.min(1, ratio)) * 100) : 0;
  }

  function hasLimit(row) {
    return !!row && row.limit !== null && row.limit !== undefined && row.limit > 0;
  }

  /* ---------------------------------------------------------- focus stamps */

  function focusTag(kind, id) {
    return kind + ":" + (id === null || id === undefined ? "" : String(id));
  }

  function stamp(node, tag) {
    if (node && typeof node.setAttribute === "function") node.setAttribute("data-focus", tag);
    return node;
  }

  /* Compared rather than selected: a category id is generated text, and
     building a selector out of it would be one escaping bug waiting to
     happen. */
  function restoreFocus(root) {
    var want = pendingFocus;
    pendingFocus = null;
    if (!want || !root) return;
    var found = null;
    dom.qsa("[data-focus]", root).forEach(function (candidate) {
      if (!found && candidate.getAttribute("data-focus") === want) found = candidate;
    });
    if (found) focusIt(found);
  }

  /* ----------------------------------------------------- the limit, in place */

  function stepFor(limit) {
    var value = typeof limit === "number" && isFinite(limit) ? limit : 0;
    return value > 0 && value < FINE_BELOW ? STEP_FINE : STEP_COARSE;
  }

  function snap(amount, step) {
    var size = step > 0 ? step : STEP_COARSE;
    var value = Math.round((Number(amount) || 0) / size) * size;
    return value < size ? size : value;
  }

  /* The one write every inline path on this row goes through, so typing a
     number, dragging the bar and pressing an arrow key cannot disagree about
     what "saved" means. Returns false the way inlineValue asks: the old value
     comes back and the row says it did not save. */
  function writeLimit(categoryId, next, focus) {
    var Model = model();
    if (!categoryId || !Model || typeof Model.setLimit !== "function") return false;

    var previous = read("limitFor", categoryId, null);
    /* Empty or zero means the limit is gone. This is the only way to remove
       one, and it is deliberately not guarded by a question: the figure is
       still in the undo band for eight seconds. */
    var amount = next === null || next === undefined || next === 0 ? null : next;

    if (amount !== null) {
      if (typeof amount !== "number" || !isFinite(amount) || amount < 0) return false;
      amount = Math.round(amount);
      if (typeof Model.validateLimit === "function") {
        var check = read("validateLimit", { categoryId: categoryId, amount: amount }, null);
        if (check && check.ok === false) return false;
      }
    }
    if (amount === previous) return true;

    pendingFocus = focus || focusTag("limit", categoryId);
    var written = Model.setLimit(categoryId, amount);
    /* setLimit answers null both when it removed a limit and when it refused
       one, so only the setting case can read null as a failure. */
    if (amount !== null && written === null) {
      pendingFocus = null;
      return false;
    }
    /* Which scale the next render should redraw in front of the reader. A
       drag ends in a full rebuild, so the bar arrives already at its new
       length with nothing to show that it moved; this is what shows it. */
    settleId = categoryId;
    strip(amount === null ? "limits.removed" : "limits.saved", null, function () {
      Model.setLimit(categoryId, previous);
    });
    return true;
  }

  /* The reading IS the control: click it, type, Enter. Closed and open are the
     same width (ui.js sizes both halves from one --iv-ch), so the column does
     not twitch when a row goes into edit. */
  function limitCell(row) {
    var UI = Moon.UI;
    if (!UI || typeof UI.inlineValue !== "function") return null;
    var id = row.categoryId;
    var api;
    try {
      api = UI.inlineValue({
        value: hasLimit(row) ? row.limit : null,
        type: "money",
        currency: currency(),
        labelKey: "limits.edit",
        labelParams: function (value) {
          return { amount: value === null || value === undefined ? t("common.none") : money(value) };
        },
        /* A row without a limit must not stand as an empty button: it says
           what it is for, and that sentence is also the way to set one. */
        format: function (value) {
          if (value === null || value === undefined || value === "") {
            return t("limits.form.title.new");
          }
          return money(value);
        },
        step: stepFor(row.limit),
        min: 0,
        onSave: function (value) {
          return writeLimit(id, value, focusTag("limit", id));
        }
      });
    } catch (error) {
      log(error);
      return null;
    }
    stamp(dom.qs(".inlinevalue__btn", api.element), focusTag("limit", id));
    return api;
  }

  /* --------------------------------------------------- the draggable scale */

  /* charts.js keeps one unit of track worth the same money up to 150% so that
     105% and 140% look different (G1); past that it squeezes the whole run
     into the room left. The drag has to speak the same scale or the grip would
     not sit on the cap it is grabbing. */
  function trackUnit(ratio) {
    var value = Number(ratio);
    if (!isFinite(value) || value <= RENORM_AT) return TRACK_WIDTH;
    return (TRACK_WIDTH + MAX_SPILL) / value;
  }

  function ratioOf(row) {
    if (!hasLimit(row)) return 0;
    var ratio = (row.spent || 0) / row.limit;
    return isFinite(ratio) && ratio > 0 ? ratio : 0;
  }

  /* pixel -> ratio -> amount. The grip starts on the cap, where the ratio is
     exactly 1 and the amount is exactly the limit it was grabbed at, so one
     drag spans 0 to about 1.5 limits and two drags compose. */
  function amountAt(viewX, base, unit) {
    var x = Number(viewX);
    if (!isFinite(x)) x = TRACK_X0;
    if (x < TRACK_X0) x = TRACK_X0;
    if (x > VIEW_WIDTH) x = VIEW_WIDTH;
    if (!(unit > 0) || !(base > 0)) return base > 0 ? base : 0;
    return (x - TRACK_X0) / unit * base;
  }

  function percentFor(amount, base, unit) {
    var x = TRACK_X0;
    if (base > 0 && unit > 0) x = TRACK_X0 + (amount / base) * unit;
    if (!isFinite(x) || x < 0) x = 0;
    if (x > VIEW_WIDTH) x = VIEW_WIDTH;
    return (x / VIEW_WIDTH) * 100;
  }

  /* Text selection during a drag turns the whole row blue and makes the
     gesture look like a failed click. Cleared again by hand, including from
     destroy() — a reader may navigate away mid-drag. */
  function setDragLock(on) {
    var root = global.document && global.document.documentElement;
    dragLock = !!on;
    if (!root || !root.style || typeof root.style.setProperty !== "function") return;
    if (on) {
      root.style.setProperty("user-select", "none");
      root.style.setProperty("-webkit-user-select", "none");
    } else if (typeof root.style.removeProperty === "function") {
      root.style.removeProperty("user-select");
      root.style.removeProperty("-webkit-user-select");
    }
  }

  function gripFor(row, iv) {
    if (!hasLimit(row)) return null;
    var id = row.categoryId;
    var unit = trackUnit(ratioOf(row));
    var ceiling = amountAt(VIEW_WIDTH, row.limit, unit);

    var node = dom.el("span", {
      "class": "meter__grip",
      role: "slider",
      tabindex: "0",
      "aria-orientation": "horizontal",
      style: {
        position: "absolute",
        top: "0",
        bottom: "0",
        width: GRIP_PX + "px",
        "min-height": GRIP_PX + "px",
        "margin-left": (-GRIP_PX / 2) + "px",
        cursor: "ew-resize",
        /* Without this a touch drag scrolls the page instead. */
        "touch-action": "none"
      }
    });
    stamp(node, focusTag("grip", id));

    function paint(amount) {
      css(node, "left", percentFor(amount, row.limit, unit) + "%");
      node.setAttribute("aria-valuenow", String(Math.round(amount)));
      node.setAttribute("aria-valuemin", "0");
      node.setAttribute("aria-valuemax", String(Math.round(Math.max(ceiling, amount))));
      /* The number a screen reader should hear, and the tooltip a pointer
         hovering the cap should see. Both come from the catalogue. */
      var label = t("limits.edit", { amount: money(amount) });
      node.setAttribute("aria-valuetext", money(amount));
      node.setAttribute("title", label);
      node.setAttribute("aria-label", label);
    }

    paint(row.limit);

    var drag = null;

    function host() {
      return node.parentNode;
    }

    function release(event) {
      if (!node.releasePointerCapture || !event || event.pointerId === undefined) return;
      try {
        node.releasePointerCapture(event.pointerId);
      } catch (error) { /* already gone */ }
    }

    function revert(base) {
      paint(base);
      if (iv && typeof iv.set === "function") iv.set(base);
    }

    node.addEventListener("pointerdown", guard(function (event) {
      if (event.button !== undefined && event.button !== null && event.button !== 0) return;
      /* Read the figure fresh: this node may have outlived one redraw. */
      var base = read("limitFor", id, null);
      if (!base || !(base > 0)) return;
      var box = host();
      if (!box || typeof box.getBoundingClientRect !== "function") return;
      var rect = box.getBoundingClientRect();
      if (!rect || !(rect.width > 0)) return;

      event.preventDefault();
      drag = {
        pointerId: event.pointerId,
        rect: rect,
        base: base,
        unit: unit,
        step: stepFor(base),
        ceiling: amountAt(VIEW_WIDTH, base, unit),
        live: base,
        moved: false
      };
      ceiling = drag.ceiling;
      if (node.setPointerCapture && event.pointerId !== undefined) {
        try {
          node.setPointerCapture(event.pointerId);
        } catch (error) { /* fall back to the events that still reach us */ }
      }
      setDragLock(true);
      focusIt(node);
    }));

    node.addEventListener("pointermove", guard(function (event) {
      if (!drag) return;
      if (event.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      var viewX = (event.clientX - drag.rect.left) / drag.rect.width * VIEW_WIDTH;
      var amount = snap(amountAt(viewX, drag.base, drag.unit), drag.step);
      var top = Math.max(drag.step, Math.round(drag.ceiling));
      if (amount > top) amount = top;
      if (amount === drag.live) return;
      drag.live = amount;
      drag.moved = true;
      paint(amount);
      /* The reading changes under the finger; the bar itself is redrawn once,
         by the router, after the write. */
      if (iv && typeof iv.set === "function") iv.set(amount);
    }));

    function finish(event, save) {
      if (!drag) return;
      var amount = drag.live;
      var base = drag.base;
      var moved = drag.moved;
      drag = null;
      setDragLock(false);
      release(event);
      if (!save || !moved || amount === base) {
        revert(base);
        return;
      }
      if (!writeLimit(id, amount, focusTag("grip", id))) revert(base);
    }

    node.addEventListener("pointerup", guard(function (event) {
      finish(event, true);
    }));
    node.addEventListener("pointercancel", guard(function (event) {
      finish(event, false);
    }));
    node.addEventListener("lostpointercapture", guard(function (event) {
      finish(event, true);
    }));

    /* The drag is an addition. This is the path that always works. */
    node.addEventListener("keydown", guard(function (event) {
      var pressed = event.key;
      var steps = 0;
      if (pressed === "ArrowRight" || pressed === "ArrowUp") steps = 1;
      else if (pressed === "ArrowLeft" || pressed === "ArrowDown") steps = -1;
      else if (pressed === "PageUp") steps = 10;
      else if (pressed === "PageDown") steps = -10;
      else return;

      event.preventDefault();
      var base = read("limitFor", id, null);
      if (!base || !(base > 0)) return;
      var size = stepFor(base);
      var next = snap(base + steps * size, size);
      if (next === base) return;
      writeLimit(id, next, focusTag("grip", id));
    }));

    return node;
  }

  /* ------------------------------------------------------------- the scale */

  /* driftState reads "am I ahead of my own pace", which is the question people
     actually ask; the percentage is the second channel, not the first. */
  function driftText(row) {
    var state = row.driftState;
    if (!state) return "";
    if (state === "done") return tk("limits.drift.done", "limits.reading.done");
    var amount = state === "over" ? overBy(row) : Math.abs(Number(row.drift) || 0);
    return tk("limits.drift." + state, "limits.reading." + state, { amount: money(amount) });
  }

  function meterAria(row) {
    if (isOver(row)) {
      return t("limits.aria.over", { name: row.name, amount: money(overBy(row)) });
    }
    return t("limits.aria.meter", { name: row.name, pct: pctOf(row), pace: paceOf(row) });
  }

  function meterSvg(row, ctx) {
    var Charts = Moon.Charts;
    if (!Charts || typeof Charts.meter !== "function") return null;
    var aria = meterAria(row);
    var markup;
    try {
      markup = Charts.meter(row, {
        trackWidth: TRACK_WIDTH,
        readoutWidth: READOUT_WIDTH,
        /* charts.js never reads the Store (E4), so the setting is handed over. */
        overflowMark: ctx.mark,
        /* Never "%" + n: TR writes %72, EN writes 72%, and that difference is
           already resolved inside the key (E3). */
        percentText: t("limits.pct", { pct: pctOf(row) }),
        ariaLabel: aria,
        title: aria,
        desc: isOver(row) ? t("limits.overflow.note") : t("limits.pace", { pace: paceOf(row) }),
        emptyText: t("empty.chart.heading"),
        formatValue: money,
        formatDate: formatDay
      });
    } catch (error) {
      log(error);
      return null;
    }
    return dom.svg(markup);
  }

  /* One row: name, scale, reading. Nothing wraps it any more — the row used to
     be one big button that opened a dialog, and now the two things worth
     touching are inside it. Keeping the .meter nodes as siblings is also what
     lets moon.css draw its 1px rule between them (.meter + .meter). */
  function scaleRow(row, ctx) {
    var over = isOver(row);
    var classes = ["meter"];
    if (over) classes.push("is-over");
    if (over && ctx.mark === "flare") classes.push("is-flare");
    if (settleId && settleId === row.categoryId) {
      settleId = null;
      classes.push("is-settled");
    }

    var name = dom.el("span", {
      "class": "meter__name" + (row.fixed ? " is-fixed" : ""),
      title: row.name,
      text: row.name
    });

    var middle = dom.el("span", { "class": "meter__scale" });
    var readout = dom.el("span", { "class": "meter__readout" });

    var iv = limitCell(row);

    if (hasLimit(row)) {
      var svg = meterSvg(row, ctx);
      if (svg) {
        /* The grip is positioned against this box, which is exactly as wide as
           the SVG's own viewBox — so the cap's place in the drawing is a plain
           percentage and no measuring is needed to draw it. */
        var track = dom.el("span", {
          "class": "meter__track",
          style: { position: "relative", display: "block" }
        }, svg);
        var grip = gripFor(row, iv);
        if (grip) track.appendChild(grip);
        middle.appendChild(track);
      }
    } else {
      /* No limit: the row must not pretend to be a scale (E4). It shows what
         went out, and the reading beside it offers the one thing missing. */
      middle.appendChild(moneyCell(row.spent, "is-dim"));
    }

    if (iv) readout.appendChild(iv.element);
    var drift = hasLimit(row) ? driftText(row) : "";
    if (drift) readout.appendChild(dom.el("span", { "class": "meter__drift", text: drift }));

    return dom.el("div", { "class": classes.join(" ") }, [name, middle, readout]);
  }

  function scaleList(rows, ctx) {
    var list = dom.el("div");
    rows.forEach(function (row) {
      list.appendChild(scaleRow(row, ctx));
    });
    return list;
  }

  /* ------------------------------------------------------- the budget suggestion */

  /* Opening and closing the block change nothing in the Store, so the router
     never hears about them and the section has to redraw itself. Safe to ask
     for at any time: render() reads the model again and rebuilds from scratch,
     which is the same thing the router asks of it. */
  function redraw() {
    if (!lastRoot) return;
    try {
      render(lastRoot);
    } catch (error) {
      log(error);
    }
  }

  function openSuggest() {
    suggestOpen = true;
    /* A fresh reading starts from the model's own defaults. */
    suggestPicks = null;
    appliedCount = 0;
    pendingFocus = focusTag("suggest", "");
    redraw();
  }

  function closeSuggest() {
    suggestOpen = false;
    suggestPicks = null;
    pendingFocus = focusTag("suggest", "");
    redraw();
  }

  function suggestions() {
    var data = read("suggestLimits", undefined, null) || {};
    return {
      basis: data.basis || {},
      rows: Object.prototype.toString.call(data.rows) === "[object Array]" ? data.rows : []
    };
  }

  /* A row with a limit already on it arrives UNTICKED. Overwriting a figure the
     reader typed themselves, without being asked, is the worst thing this block
     could do; leaving the box empty says so without a sentence about it. */
  function pickedByDefault(row) {
    return row.current === null || row.current === undefined;
  }

  function isPicked(row) {
    if (!row || !row.categoryId) return false;
    if (suggestPicks && suggestPicks[row.categoryId] !== undefined) {
      return !!suggestPicks[row.categoryId];
    }
    return pickedByDefault(row);
  }

  function setPicked(categoryId, on) {
    if (!suggestPicks) suggestPicks = Object.create(null);
    suggestPicks[categoryId] = !!on;
  }

  /* One suggestion speaks in the scale rows' own grid: name left, a small grey
     note in the middle, the figure right. No new class, no new frame; the
     checkbox sits in the house control row (.switch) and the whole row is the
     <label>, so the name, the note and the amount are all one hit target. */
  function suggestRow(row, onToggle) {
    var box = dom.el("input", { type: "checkbox" });
    box.checked = isPicked(row);
    box.addEventListener("change", guard(function () {
      setPicked(row.categoryId, box.checked);
      onToggle();
    }));

    var name = dom.el("span", {
      "class": "meter__name" + (row.fixed ? " is-fixed" : ""),
      title: row.name,
      text: row.name
    });

    var note = dom.el("span", {
      "class": "meter__scale sm dim",
      /* "measured over 3 periods" / "seen in one period only". The thinness of
         the evidence is the reading here, not a score. */
      text: t("limits.suggest.confidence." + (row.confidence || "low"), { count: row.monthsSeen })
    });

    var readout = dom.el("span", { "class": "meter__readout" }, moneyCell(row.suggested));
    if (!pickedByDefault(row)) {
      readout.appendChild(dom.el("span", {
        "class": "meter__drift",
        text: t("limits.suggest.current", { amount: money(row.current) })
      }));
    }

    return dom.el("label", { "class": "meter" }, [
      dom.el("span", { "class": "switch" }, [box, name]),
      note,
      readout
    ]);
  }

  function applyPicked(rows) {
    var Model = model();
    if (!Model || typeof Model.applyLimitSuggestions !== "function") return;

    var chosen = rows.filter(isPicked);
    if (!chosen.length) return;

    /* Closed before the write, not after: the write emits state:change and the
       router redraws this section underneath, so the block has to be gone from
       this file's state by then or it would come straight back. */
    suggestOpen = false;
    suggestPicks = null;
    pendingFocus = focusTag("suggest", "");

    var written = 0;
    try {
      written = Model.applyLimitSuggestions(chosen) || 0;
    } catch (error) {
      log(error);
    }
    /* Limits are editable, so this is not an undo offer — it is a count, said
       once, in the band at the top of the section whose figures just changed. */
    appliedCount = written > 0 ? written : 0;
    /* A write emitted state:change, and the router coalesces its redraw into a
       timeout — so the redraw is already on its way and will pick up both the
       count and the focus. Asking for one here would draw the band and have it
       wiped a tick later. Only a write that never happened needs a redraw of
       its own, to put the closed block on screen. */
    if (!written) redraw();
  }

  function suggestBlock() {
    var data = suggestions();
    var basis = data.basis;
    var rows = data.rows;
    var complete = basis.complete === true;

    var nodes = [dom.el("h3", { text: t("limits.suggest.title") })];
    var applyBtn = null;

    function syncApply() {
      if (!applyBtn) return;
      var any = rows.some(isPicked);
      applyBtn.setAttribute("aria-disabled", any ? "false" : "true");
    }

    if (!complete) {
      /* No closed period: say that and draw no list at all. A suggestion made
         from half a month would be half a limit. */
      nodes.push(small(t("limits.suggest.none")));
    } else {
      nodes.push(small(t("limits.suggest.body")));
      nodes.push(small(t("limits.suggest.basis", {
        count: (basis.periods || []).length,
        entries: basis.entryCount || 0
      })));

      if (!rows.length) {
        /* Periods closed, but nothing in them to suggest from. The catalogue
           has no sentence for that case yet, so the block falls back to the one
           that already explains why there is no suggestion. */
        nodes.push(small(tk("limits.suggest.empty", "limits.suggest.none")));
      } else {
        var list = dom.el("div");
        rows.forEach(function (row) {
          list.appendChild(suggestRow(row, syncApply));
        });
        nodes.push(list);
      }
    }

    var actions = dom.el("div", { "class": "form__actions" });
    if (complete && rows.length) {
      applyBtn = btn("limits.suggest.apply", "primary", function () {
        if (applyBtn.getAttribute("aria-disabled") === "true") return;
        applyPicked(rows);
      });
      /* aria-disabled rather than [disabled]: a control that cannot act yet
         still has to be reachable from the keyboard to be read. */
      syncApply();
      actions.appendChild(applyBtn);
    }
    actions.appendChild(btn("common.close", "quiet", closeSuggest));
    nodes.push(actions);

    return dom.el("div", { id: SUGGEST_ID }, nodes);
  }

  /* The one entry point: a quiet control beside the section title, next to the
     limit total it is offering to fill in. */
  function suggestToggle() {
    var Model = model();
    if (!Model || typeof Model.suggestLimits !== "function") return null;

    var node = btn("limits.suggest.action", "quiet", function () {
      if (suggestOpen) closeSuggest();
      else openSuggest();
    });
    node.id = TOGGLE_ID;
    node.setAttribute("aria-expanded", suggestOpen ? "true" : "false");
    /* Only while the block is on the page: aria-controls pointing at an id that
       does not exist is a dangling reference, not a disclosure. */
    if (suggestOpen) node.setAttribute("aria-controls", SUGGEST_ID);
    stamp(node, focusTag("suggest", ""));
    return node;
  }

  /* ------------------------------------------------------- section: scales */

  function limitTotals(ctx) {
    var summary = ctx.summary || {};
    return t("limits.total", { amount: money(summary.limitTotal || 0) });
  }

  function split(rows) {
    var out = { variable: [], fixed: [], limited: 0, over: 0 };
    rows.forEach(function (row) {
      if (!row) return;
      if (row.fixed) out.fixed.push(row);
      else out.variable.push(row);
      if (row.limit !== null && row.limit !== undefined) out.limited += 1;
      if (isOver(row)) out.over += 1;
    });
    return out;
  }

  /* The fixed group is not part of the daily-allowance pool (A3), and the
     screen has to say so rather than leaving the reader to infer it. */
  function fixedGroup(rows, ctx) {
    var summary = ctx.summary || {};
    var nodes = [
      dom.el("h3", { text: t("common.fixed") }),
      small(tk("limits.fixed.note", "ledger.form.fixedHint"))
    ];
    if (summary.fixedCount) {
      nodes.push(small(t(key("limits.fixed.reserved", "panel.fixedReserved"), {
        count: summary.fixedCount,
        amount: money(summary.spentFixed || 0)
      })));
    }
    nodes.push(scaleList(rows, ctx));
    return dom.el("div", null, nodes);
  }

  function scaleTable(rows) {
    var columns = [
      { labelKey: "ledger.col.category" },
      { labelKey: "ledger.col.amount", type: "money" },
      { labelKey: "form.limit", type: "money" }
    ];
    var body = rows.map(function (row) {
      return [row.name, row.spent, row.limit];
    });
    return dataTable(columns, body, { currency: currency() });
  }

  function scalesSection(ctx) {
    var UI = Moon.UI;
    var groups = split(ctx.rows);
    var body = [];

    /* The empty sentence stands above the limitless rows it is talking about
       ("these rows turn into scales the moment you set a limit"), and every
       one of those rows now carries the way to set one. */
    var anyLimit = groups.limited > 0 || ((ctx.summary || {}).limitTotal || 0) > 0;

    /* The count of what the last write produced, said once. It stands above the
       scales it changed and goes away with the next reading of this screen. */
    if (appliedCount > 0) {
      var band = notice("info", "limits.suggest.applied", { count: appliedCount }, true);
      appliedCount = 0;
      if (band) body.push(band);
    }
    if (suggestOpen) body.push(suggestBlock());

    if (!anyLimit) {
      /* No action on the empty page any more: the action is the reading on
         every row below it, which reads "Limit koy" until it carries a number. */
      body.push(emptyBlock({
        headingKey: "empty.limits.heading",
        bodyKey: "empty.limits.body",
        ghost: true,
        columns: 3
      }));
    }

    if (groups.variable.length) body.push(scaleList(groups.variable, ctx));
    if (anyLimit) {
      body.push(small(t("limits.variableTotal", { amount: money(ctx.summary.limitVariable || 0) })));
    }
    if (groups.fixed.length) body.push(fixedGroup(groups.fixed, ctx));
    if (groups.over) body.push(small(t("limits.overflow.note")));
    body.push(scaleTable(ctx.rows));

    /* The head carries the total reading and, beside it, the one control that
       opens the suggestion block. .switch is the house row for "a control with
       its label", which is exactly what these two are. */
    var toggleNode = suggestToggle();
    var asideKids = [];
    if (anyLimit) {
      asideKids.push(dom.el("span", { "class": "num", text: limitTotals(ctx) }));
    }
    if (toggleNode) asideKids.push(toggleNode);

    return UI.section({
      id: "limits-scales",
      titleKey: "limits.title",
      aside: asideKids.length ? dom.el("span", { "class": "switch" }, asideKids) : null,
      body: body
    });
  }

  /* ---------------------------------------------------- section: year grid */

  function yearTable(grid) {
    if (!grid.rows.length || !grid.periods.length) return null;

    var columns = [{ labelKey: "common.period" }];
    grid.rows.forEach(function (row, index) {
      columns.push({ key: "c" + index, label: row.name, type: "money" });
    });

    var body = grid.periods.map(function (periodKey, column) {
      var record = { 0: fullMonth(periodKey) };
      grid.rows.forEach(function (row, index) {
        var cells = row.cells || [];
        var cell = cells[column];
        if (!cell || cell.period !== periodKey) {
          cell = null;
          for (var i = 0; i < cells.length; i += 1) {
            if (cells[i] && cells[i].period === periodKey) cell = cells[i];
          }
        }
        record["c" + index] = cell ? cell.amount : 0;
      });
      return record;
    });

    return dataTable(columns, body, { currency: currency() });
  }

  function yearSection(ctx) {
    var UI = Moon.UI;
    var Charts = Moon.Charts;
    var grid = read("yearGrid", ctx.period, { periods: [], rows: [] });
    if (!grid.periods) grid.periods = [];
    if (!grid.rows) grid.rows = [];

    var body = [small(tk("limits.year.body", "panel.chart.year.body"))];

    if (Charts && typeof Charts.yearGrid === "function") {
      var markup = null;
      try {
        markup = Charts.yearGrid(grid, {
          title: tk("limits.year.title", "panel.chart.year.title"),
          desc: t("a11y.chart.year.desc", { rows: grid.rows.length }),
          emptyText: t("empty.chart.heading"),
          monthLabels: grid.periods.map(shortMonth),
          /* The density key has no label in the catalogue yet; charts.js draws
             the swatches without one rather than printing a raw key. */
          keyLabel: has("limits.year.key") ? t("limits.year.key") : null,
          formatValue: money,
          formatDate: formatDay
        });
      } catch (error) {
        log(error);
      }
      if (markup) body.push(dom.el("div", { "class": "yeargrid" }, dom.svg(markup)));
    }

    body.push(yearTable(grid));

    return UI.section({
      id: "limits-year",
      titleKey: key("limits.year.title", "panel.chart.year.title"),
      body: body
    });
  }

  /* --------------------------------------------------- section: categories */

  /* moon.css aligns an inlineValue to the right, which is the only sane place
     for a number and the wrong one for a name. */
  function leftAlign(api) {
    if (!api || !api.element) return api;
    dom.qsa(".inlinevalue__btn, .inlinevalue__input", api.element).forEach(function (half) {
      css(half, "text-align", "left");
    });
    return api;
  }

  function nameCell(cat) {
    var UI = Moon.UI;
    var Model = model();
    if (!UI || typeof UI.inlineValue !== "function" || !Model) return null;
    var api;
    try {
      api = UI.inlineValue({
        value: cat.name,
        type: "text",
        maxLength: 200,
        labelKey: "form.name",
        labelParams: function () { return {}; },
        onSave: function (value) {
          var name = value === null || value === undefined ? "" : String(value).replace(/^\s+|\s+$/g, "");
          /* A category with no name cannot be found again, so an emptied name
             is the one text this control refuses. */
          if (!name || name.length > 200) return false;
          if (name === cat.name) return true;
          pendingFocus = focusTag("cat", cat.id);
          if (!Model.updateCategory(cat.id, { name: name })) {
            pendingFocus = null;
            return false;
          }
          return true;
        }
      });
    } catch (error) {
      log(error);
      return null;
    }
    stamp(dom.qs(".inlinevalue__btn", api.element), focusTag("cat", cat.id));
    return leftAlign(api);
  }

  /* Flipping the fixed mark moves money in and out of the daily-allowance pool,
     so the change says so in the strip and can be taken straight back. */
  function toggleFixed(cat) {
    var Model = model();
    if (!Model) return;
    pendingFocus = focusTag("fixed", cat.id);
    if (!Model.updateCategory(cat.id, { fixed: !cat.fixed })) {
      pendingFocus = null;
      return;
    }
    strip(key("limits.category.fixedHint", "ledger.form.fixedHint"), null, function () {
      Model.updateCategory(cat.id, { fixed: !!cat.fixed });
    });
  }

  function toggleArchived(cat) {
    var Model = model();
    if (!Model) return;
    pendingFocus = focusTag("archive", cat.id);
    if (!Model.updateCategory(cat.id, { archived: !cat.archived })) pendingFocus = null;
  }

  /* Deleting a category never deletes its entries: Moon.Model moves them to the
     catch-all and answers with the count. That makes it an undoable act, not a
     destructive one — so it asks nothing and leaves an eight-second band
     instead. The snapshot below is what makes the undo real: a new category
     under the old name, every entry and rule pointed back at it with the
     fixed mark it had, and the limit put back on top. */
  function deleteCategory(cat, host) {
    var Model = model();
    if (!Model || typeof Model.removeCategory !== "function") return;

    var snapshot = {
      name: cat.name,
      kind: cat.kind,
      fixed: !!cat.fixed,
      archived: !!cat.archived,
      limit: read("limitFor", cat.id, null),
      entries: read("entries", { categoryId: cat.id }, []).map(function (entry) {
        return { id: entry.id, fixed: entry.fixed };
      }),
      rules: bucket("recurring").filter(function (rule) {
        return rule && rule.categoryId === cat.id;
      }).map(function (rule) {
        return { id: rule.id, fixed: rule.fixed };
      })
    };

    var done = Model.removeCategory(cat.id);
    /* Model refuses to delete the catch-all itself — it is where the entries
       of every other deleted category land. */
    if (!done || !done.ok) {
      var band = notice("warn", "err.badCategory");
      if (band && host) host.insertBefore(band, host.firstChild);
      return;
    }

    strip(key("limits.category.removed", "ledger.count"), {
      name: snapshot.name,
      count: done.movedEntries || 0
    }, function () {
      var revived = Model.addCategory({
        name: snapshot.name,
        kind: snapshot.kind,
        fixed: snapshot.fixed,
        archived: snapshot.archived
      });
      if (!revived) return;
      snapshot.entries.forEach(function (entry) {
        Model.updateEntry(entry.id, { categoryId: revived, fixed: entry.fixed });
      });
      snapshot.rules.forEach(function (rule) {
        Model.updateRecurring(rule.id, { categoryId: revived, fixed: rule.fixed });
      });
      if (snapshot.limit) Model.setLimit(revived, snapshot.limit);
    });
  }

  function headCell(text) {
    return dom.el("th", { scope: "col", "class": "sm", text: text });
  }

  function categoryRow(cat, host) {
    var row = dom.el("tr");

    var nameHead = dom.el("th", { scope: "row", "class": cat.archived ? "dim" : "" });
    var iv = nameCell(cat);
    if (iv) nameHead.appendChild(iv.element);
    else nameHead.appendChild(dom.el("span", { title: cat.name, text: cat.name }));
    row.appendChild(nameHead);

    row.appendChild(dom.el("td", {
      "class": "sm dim",
      text: t(cat.kind === "income" ? "common.income" : "common.expense")
    }));

    var fixedCell = dom.el("td");
    if (cat.kind === "income") {
      /* The fixed mark only speaks about the expense pool. */
      fixedCell.appendChild(dom.el("span", { "class": "sm dim", text: t("common.none") }));
    } else {
      var toggle = btn(cat.fixed ? "common.fixed" : "common.variable", "quiet", function () {
        toggleFixed(cat);
      });
      toggle.setAttribute("aria-pressed", cat.fixed ? "true" : "false");
      stamp(toggle, focusTag("fixed", cat.id));
      fixedCell.appendChild(toggle);
    }
    row.appendChild(fixedCell);

    var actions = dom.el("td");

    /* Archiving needs two labels the catalogue does not carry. Rather than
       hard-coding a word, the control appears the moment the keys exist. */
    var archiveKey = cat.archived ? "limits.category.unarchive" : "limits.category.archive";
    if (has(archiveKey)) {
      var archive = btn(archiveKey, "quiet", function () {
        toggleArchived(cat);
      });
      archive.setAttribute("aria-pressed", cat.archived ? "true" : "false");
      stamp(archive, focusTag("archive", cat.id));
      actions.appendChild(archive);
    }

    actions.appendChild(btn("common.delete", "quiet", function () {
      deleteCategory(cat, host);
    }));
    row.appendChild(actions);

    return row;
  }

  function categoryTable(cats, host) {
    var table = dom.el("table", { "class": "table" });
    table.appendChild(dom.el("thead", null, dom.el("tr", null, [
      headCell(t("form.name")),
      headCell(t("form.kind")),
      headCell(t("common.fixed")),
      headCell(t("a11y.rowActions"))
    ])));

    var body = dom.el("tbody");
    cats.forEach(function (cat) {
      body.appendChild(categoryRow(cat, host));
    });
    table.appendChild(body);
    return dom.el("div", { "class": "preview" }, table);
  }

  /* One line, always open, Enter writes. The kind and the fixed mark are kept
     between writes — adding six expense categories in a row should be six
     words and six Enters. */
  function categoryQuickRow() {
    var UI = Moon.UI;
    var Model = model();
    if (!UI || typeof UI.quickRow !== "function" || !Model) return null;

    var api;
    try {
      api = UI.quickRow({
        id: "limits-category-add",
        memoryKey: "limits.category.quick",
        labels: "visible",
        submitLabelKey: "common.add",
        moreLabelKey: "common.more",
        keepOnSubmit: ["kind", "fixed"],
        fields: [
          { type: "text", name: "name", labelKey: "form.name", required: true, maxLength: 200 },
          {
            type: "select",
            name: "kind",
            labelKey: "form.kind",
            value: addMemory.kind,
            options: [
              { value: "expense", labelKey: "common.expense" },
              { value: "income", labelKey: "common.income" }
            ]
          }
        ],
        moreFields: [
          {
            type: "switch",
            name: "fixed",
            labelKey: "form.fixed",
            value: !!addMemory.fixed,
            hintKey: key("limits.category.fixedHint", "ledger.form.fixedHint")
          }
        ],
        onSubmit: function (values) {
          var name = String(values.name || "").replace(/^\s+|\s+$/g, "");
          if (!name) return { ok: false, errors: { name: "err.required" } };
          if (name.length > 200) return { ok: false, errors: { name: "err.noteTooLong" } };

          var kind = values.kind === "income" ? "income" : "expense";
          var fixed = !!values.fixed;
          var id = Model.addCategory({ name: name, kind: kind, fixed: fixed });
          if (!id) return { ok: false, errors: { name: "err.unknown" } };

          /* The write redraws this whole section, so what the row was asked to
             keep has to outlive the row itself. */
          addMemory = { kind: kind, fixed: fixed };
          pendingFocus = focusTag("newcat", "");
          return { ok: true };
        }
      });
    } catch (error) {
      log(error);
      return null;
    }

    var first = api.fields ? api.fields.name : null;
    if (first && first.control) stamp(first.control, focusTag("newcat", ""));
    return api.element;
  }

  function categorySection() {
    var UI = Moon.UI;
    var cats = read("categories", { includeArchived: true }, []);
    var body = dom.el("div");

    if (cats.length) {
      body.appendChild(categoryTable(cats, body));
      /* Says out loud what the fixed mark does to the daily allowance. */
      body.appendChild(small(tk("limits.category.fixedHint", "ledger.form.fixedHint")));
    }
    var adder = categoryQuickRow();
    if (adder) body.appendChild(adder);

    return UI.section({
      id: "limits-categories",
      titleKey: "form.category",
      body: body
    });
  }

  /* ---------------------------------------------------------------- render */

  function render(root) {
    if (!root || !dom) return;
    lastRoot = root;
    dom.clear(root);
    if (!Moon.UI || !model()) return;

    var ctx = context();
    /* Vertical rhythm comes from the single .view > * + * rule; no margins
       are written here (E9). */
    root.appendChild(scalesSection(ctx));
    root.appendChild(yearSection(ctx));
    root.appendChild(categorySection());

    /* Every inline write replaced the control that made it. This is the whole
       of the keyboard contract on this screen: type a limit, press Enter, and
       the caret is back on the same number — drag a bar, let go, and the grip
       is still under the finger that will nudge it with an arrow key next. */
    restoreFocus(root);
  }

  /* The panel asks for these so a reader can see where the money went and pull a
     limit to meet it without leaving the first screen. Handing over the real
     rows rather than a copy keeps one implementation of the scale, the inline
     figure and the drag: a fix here reaches both places. */
  function scalesFor(options) {
    var opts = options || {};
    var ctx = context();
    var rows = Array.isArray(ctx.rows) ? ctx.rows : [];

    if (typeof opts.filter === "function") rows = rows.filter(opts.filter);
    if (opts.limit > 0) rows = rows.slice(0, opts.limit);
    if (!rows.length) return null;

    return { element: scaleList(rows, ctx), count: rows.length, total: (ctx.rows || []).length };
  }

  var view = {
    /* The hash stays Turkish for URL permanence; the label comes from i18n. */
    id: "limitler",
    titleKey: "nav.limits",
    scales: scalesFor,
    render: function (root) {
      try {
        render(root);
      } catch (error) {
        log(error);
      }
    },
    destroy: function () {
      /* No subscription and no timer to release, and the undo offer in #strip
         is deliberately left standing — its handler calls Moon.Model, so it
         keeps working after the reader has walked away.
         What does have to go: the cached root (redrawing into a root the router
         has handed to another view would paint this section over it), the
         suggestion block, which is a transient answer to "suggest me limits",
         and the selection lock, which a reader who navigated away mid-drag
         would otherwise carry into the next section. */
      lastRoot = null;
      suggestOpen = false;
      suggestPicks = null;
      appliedCount = 0;
      pendingFocus = null;
      if (dragLock) setDragLock(false);
    }
  };

  Moon.Views = Moon.Views || {};
  Moon.Views.limits = view;
})(window);
