/* Moon — the Limits section (#limitler; contract §13, addendum E10/E11).
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
 * may run any number of times.
 *
 * Two deliberate seams, both documented where they are used:
 *   - ui.js and moon.css were written in parallel and spell a handful of class
 *     names differently. Neither file is ours to edit, so the stylesheet's
 *     spelling is added to the nodes Moon.UI hands back.
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

  /* The suggestion block (Moon.Model.suggestLimits) is asked for, never
     standing: it opens from one control beside the section title and closes
     again the moment it has done its work. These four variables are the whole
     of its state, and every one of them survives a re-render on purpose —
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
  /* Opening and closing rebuild the control that was just pressed, so the
     focus has to be put back by hand or it falls to <body>. */
  var refocusToggle = false;
  var toggleNode = null;
  var lastRoot = null;

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

  function settings() {
    var store = Moon.Store;
    var state = store && store.state ? store.state : null;
    return state && state.settings ? state.settings : {};
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
      .replace(/[.,\s ]+/g, " ")
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

  function prose(text) {
    return dom.el("p", { "class": "prose", text: text });
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

  /* One row: name, scale, reading. The whole row is the control that edits the
     limit, so it is a real button (.btn.is-row is the house full-width row) and
     works from the keyboard without a roving index. */
  function scaleRow(row, ctx) {
    var over = isOver(row);
    var classes = ["meter"];
    if (over) classes.push("is-over");
    if (over && ctx.mark === "flare") classes.push("is-flare");

    var name = dom.el("span", {
      "class": "meter__name" + (row.fixed ? " is-fixed" : ""),
      title: row.name,
      text: row.name
    });

    var middle = dom.el("span", { "class": "meter__scale" });
    var readout = dom.el("span", { "class": "meter__readout" });

    if (row.limit === null || row.limit === undefined) {
      /* No limit: the row must not pretend to be a scale (E4). It shows what
         went out and offers the one thing missing. */
      middle.appendChild(moneyCell(row.spent, "is-dim"));
      readout.appendChild(dom.el("span", {
        "class": "meter__drift",
        text: tk("limits.noLimit", "limits.form.title.new")
      }));
    } else {
      var svg = meterSvg(row, ctx);
      if (svg) middle.appendChild(svg);
      readout.appendChild(dom.el("span", { "class": "meter__drift", text: driftText(row) }));
    }

    var inner = dom.el("span", { "class": classes.join(" "), style: { width: "100%" } },
      [name, middle, readout]);

    var node = dom.el("button", { type: "button", "class": "btn is-row" }, inner);
    node.addEventListener("click", guard(function () {
      openLimitDialog(row.categoryId);
    }));
    return node;
  }

  function scaleList(rows, ctx) {
    var list = dom.el("div");
    rows.forEach(function (row) {
      list.appendChild(scaleRow(row, ctx));
    });
    return list;
  }

  /* ------------------------------------------------------- the limit dialog */

  function fail(api, errors) {
    api.setErrors(errors);
    api.focusFirstError();
  }

  function openLimitDialog(categoryId) {
    var Model = model();
    var UI = Moon.UI;
    if (!Model || !UI || typeof UI.dialog !== "function") return;

    var cats = read("categories", { kind: "expense" }, []);
    var options = cats.map(function (cat) {
      return { value: cat.id, label: cat.name };
    });
    /* A limit hangs off a category; with none there is nothing to open. */
    if (!options.length) return;

    var startId = categoryId && Model.categoryById(categoryId) ? categoryId : options[0].value;
    var current = read("limitFor", startId, null);

    var catField = UI.field({
      type: "select",
      name: "categoryId",
      labelKey: "form.category",
      options: options,
      value: startId,
      required: true
    });
    var amountField = UI.field({
      type: "money",
      name: "amount",
      labelKey: "limits.form.amount",
      hintKey: "limits.form.amount.hint",
      value: current === null ? "" : current,
      currency: currency(),
      required: true,
      autofocus: true
    });

    var box = null;

    function close() {
      if (box) box.close();
    }

    function chosenId() {
      var field = catField.moonField;
      return field ? field.read() : startId;
    }

    function typedAmount() {
      var field = amountField.moonField;
      return field ? String(field.control.value || "").replace(/^\s+|\s+$/g, "") : "";
    }

    function save(values, api) {
      var id = values.categoryId;
      var minor = values.amount;

      if (!typedAmount()) {
        fail(api, { amount: "err.required" });
        return;
      }
      if (minor === null || minor === undefined) {
        fail(api, { amount: "money.invalid" });
        return;
      }
      /* E1: parse answers SIGNED, and the schema has no negative limit. Say
         where the sign belongs instead of quietly dropping it. */
      if (minor < 0) {
        fail(api, { amount: "err.negativeAmount" });
        return;
      }
      if (minor === 0) {
        fail(api, { amount: "err.zeroAmount" });
        return;
      }

      var check = Model.validateLimit({ categoryId: id, amount: minor });
      if (!check.ok) {
        fail(api, check.errors);
        return;
      }

      var previous = read("limitFor", id, null);
      /* Close BEFORE writing: the write emits state:change, the router redraws
         the section underneath, and a modal must not outlive its own screen. */
      close();
      Model.setLimit(id, minor);
      strip("limits.saved", null, function () {
        Model.setLimit(id, previous);
      });
    }

    function remove() {
      var id = chosenId();
      var previous = read("limitFor", id, null);
      close();
      if (previous === null) return;
      Model.setLimit(id, null);
      strip("limits.removed", null, function () {
        Model.setLimit(id, previous);
      });
    }

    var actions = [
      { labelKey: "common.save", kind: "primary", "class": "is-primary", type: "submit" }
    ];
    if (current !== null) {
      actions.push({
        labelKey: "limits.form.remove",
        kind: "danger",
        "class": "is-danger",
        onClick: remove
      });
    }
    actions.push({
      labelKey: "common.cancel",
      kind: "ghost",
      "class": "is-quiet",
      onClick: close
    });

    var form = UI.form({
      fields: [catField, amountField],
      actions: actions,
      onSubmit: save
    });
    /* .form__fields carries no spacing in moon.css; .form__row does. */
    addClass(dom.qs(".form__fields", form.element), "form__row");

    if (catField.moonField) {
      catField.moonField.control.addEventListener("change", guard(function () {
        var id = chosenId();
        var limit = read("limitFor", id, null);
        form.reset({ categoryId: id, amount: limit === null ? "" : limit });
      }));
    }

    var body = [];
    var row = rowFor(startId);
    if (row && isOver(row)) {
      /* The sentence the design asks for on an overrun: the number, and the
         reminder that an unrealistic limit is a limit worth changing. */
      body.push(prose(t("limits.overLine", { name: row.name, amount: money(overBy(row)) })));
    }
    body.push(form.element);

    box = UI.dialog({
      "class": "dialog--limit",
      titleKey: current === null ? "limits.form.title.new" : "limits.form.title.edit",
      body: body
    });
    box.open();
  }

  function rowFor(categoryId) {
    var rows = read("budgetRows", activePeriod(), []);
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].categoryId === categoryId) return rows[i];
    }
    return null;
  }

  /* ------------------------------------------------- the budget suggestion */

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
    refocusToggle = true;
    redraw();
  }

  function closeSuggest() {
    suggestOpen = false;
    suggestPicks = null;
    refocusToggle = true;
    redraw();
  }

  function suggestions() {
    var data = read("suggestLimits", undefined, null) || {};
    return {
      basis: data.basis || {},
      rows: Array.isArray(data.rows) ? data.rows : []
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
    refocusToggle = true;

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
       ("these rows turn into scales the moment you set a limit"), and the
       category list below is still the way to set one. */
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
      body.push(emptyBlock({
        headingKey: "empty.limits.heading",
        bodyKey: "empty.limits.body",
        ghost: true,
        columns: 3,
        actions: [{
          labelKey: "limits.form.title.new",
          onClick: function () { openLimitDialog(null); }
        }]
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
    toggleNode = suggestToggle();
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

  function renameCategory(cat) {
    var Model = model();
    var UI = Moon.UI;
    if (!Model || !UI) return;

    var nameField = UI.field({
      type: "text",
      name: "name",
      labelKey: "form.name",
      value: cat.name,
      required: true,
      maxLength: 200,
      autofocus: true
    });
    var box = null;

    var form = UI.form({
      fields: [nameField],
      actions: [
        { labelKey: "common.save", kind: "primary", "class": "is-primary", type: "submit" },
        {
          labelKey: "common.cancel",
          kind: "ghost",
          "class": "is-quiet",
          onClick: function () { if (box) box.close(); }
        }
      ],
      onSubmit: function (values, api) {
        var name = String(values.name || "").replace(/^\s+|\s+$/g, "");
        if (!name) {
          fail(api, { name: "err.required" });
          return;
        }
        if (name.length > 200) {
          fail(api, { name: "err.noteTooLong" });
          return;
        }
        if (!Model.updateCategory(cat.id, { name: name })) {
          fail(api, { name: "err.unknown" });
          return;
        }
        if (box) box.close();
      }
    });
    addClass(dom.qs(".form__fields", form.element), "form__row");

    box = UI.dialog({ titleKey: "common.edit", body: form.element });
    box.open();
  }

  /* Flipping the fixed mark moves money in and out of the daily-allowance pool,
     so the change says so in the strip and can be taken straight back. */
  function toggleFixed(cat) {
    var Model = model();
    if (!Model) return;
    if (!Model.updateCategory(cat.id, { fixed: !cat.fixed })) return;
    strip(key("limits.category.fixedHint", "ledger.form.fixedHint"), null, function () {
      Model.updateCategory(cat.id, { fixed: !!cat.fixed });
    });
  }

  function toggleArchived(cat) {
    var Model = model();
    if (!Model) return;
    Model.updateCategory(cat.id, { archived: !cat.archived });
  }

  /* Deleting a category never deletes its entries: Model moves them to the
     catch-all. The count is on the confirmation, because deleting blind is the
     one thing this screen must not allow. */
  function deleteCategory(cat, host) {
    var Model = model();
    var UI = Moon.UI;
    if (!Model || !UI || typeof UI.confirm !== "function") return;

    var moving = read("entries", { categoryId: cat.id }, []).length;

    UI.confirm({
      titleKey: "common.delete",
      bodyKey: "ledger.count",
      params: { count: moving },
      confirmKey: "common.delete",
      cancelKey: "common.cancel",
      danger: true
    }).then(guard(function (yes) {
      if (!yes) return;
      var done = Model.removeCategory(cat.id);
      /* Model refuses to delete the catch-all itself — it is where the entries
         of every other deleted category land. */
      if (!done || !done.ok) {
        var band = notice("warn", "err.badCategory");
        if (band && host) host.insertBefore(band, host.firstChild);
      }
    }));
  }

  function th(text) {
    return dom.el("th", { scope: "col", "class": "sm", text: text });
  }

  function categoryRow(cat, host) {
    var row = dom.el("tr");
    row.appendChild(dom.el("th", {
      scope: "row",
      "class": cat.archived ? "dim" : "",
      title: cat.name,
      text: cat.name
    }));
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
      fixedCell.appendChild(toggle);
    }
    row.appendChild(fixedCell);

    var actions = dom.el("td");
    actions.appendChild(btn("common.edit", "quiet", function () {
      renameCategory(cat);
    }));

    /* Archiving needs two labels the catalogue does not carry. Rather than
       hard-coding a word, the control appears the moment the keys exist. */
    var archiveKey = cat.archived ? "limits.category.unarchive" : "limits.category.archive";
    if (has(archiveKey)) {
      actions.appendChild(btn(archiveKey, "quiet", function () {
        toggleArchived(cat);
      }));
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
      th(t("form.name")),
      th(t("form.kind")),
      th(t("common.fixed")),
      th(t("a11y.rowActions"))
    ])));

    var body = dom.el("tbody");
    cats.forEach(function (cat) {
      body.appendChild(categoryRow(cat, host));
    });
    table.appendChild(body);
    return dom.el("div", { "class": "preview" }, table);
  }

  function addCategoryForm() {
    var Model = model();
    var UI = Moon.UI;
    if (!Model || !UI || typeof UI.form !== "function") return null;

    var form = UI.form({
      fields: [
        { type: "text", name: "name", labelKey: "form.name", required: true, maxLength: 200 },
        {
          type: "select",
          name: "kind",
          labelKey: "form.kind",
          value: "expense",
          options: [
            { value: "expense", labelKey: "common.expense" },
            { value: "income", labelKey: "common.income" }
          ]
        },
        {
          type: "switch",
          name: "fixed",
          labelKey: "form.fixed",
          hintKey: key("limits.category.fixedHint", "ledger.form.fixedHint")
        }
      ],
      actions: [{ labelKey: "common.add", kind: "primary", "class": "is-primary", type: "submit" }],
      onSubmit: function (values, api) {
        var name = String(values.name || "").replace(/^\s+|\s+$/g, "");
        if (!name) {
          fail(api, { name: "err.required" });
          return;
        }
        if (name.length > 200) {
          fail(api, { name: "err.noteTooLong" });
          return;
        }
        var id = Model.addCategory({
          name: name,
          kind: values.kind === "income" ? "income" : "expense",
          fixed: !!values.fixed
        });
        if (!id) {
          fail(api, { name: "err.unknown" });
          return;
        }
        /* The re-render replaces this form; nothing to reset by hand. */
      }
    });
    addClass(dom.qs(".form__fields", form.element), "form__row");
    return form.element;
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
    var adder = addCategoryForm();
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
    toggleNode = null;
    dom.clear(root);
    if (!Moon.UI || !model()) return;

    var ctx = context();
    /* Vertical rhythm comes from the single .view > * + * rule; no margins
       are written here (E9). */
    root.appendChild(scalesSection(ctx));
    root.appendChild(yearSection(ctx));
    root.appendChild(categorySection());

    /* Opening, closing and applying all replace the control that was pressed.
       Putting the focus back on it is the whole of the disclosure's keyboard
       contract: Tab from there walks straight into the block. */
    if (refocusToggle) {
      refocusToggle = false;
      if (toggleNode && typeof toggleNode.focus === "function") {
        try {
          toggleNode.focus();
        } catch (error) {
          log(error);
        }
      }
    }
  }

  var view = {
    /* The hash stays Turkish for URL permanence; the label comes from i18n. */
    id: "limitler",
    titleKey: "nav.limits",
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
         has handed to another view would paint this section over it) and the
         suggestion block, which is a transient answer to "suggest me limits"
         and should not be waiting when the reader comes back. */
      lastRoot = null;
      toggleNode = null;
      suggestOpen = false;
      suggestPicks = null;
      appliedCount = 0;
      refocusToggle = false;
    }
  };

  Moon.Views = Moon.Views || {};
  Moon.Views.limits = view;
})(window);
