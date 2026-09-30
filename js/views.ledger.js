/* Moon — the ledger view (#defter).
 *
 * Three hundred rows have to stay readable, so this file spends its structure
 * on the three decisions the design brief makes (00-tasarim.md, "Harcama
 * listesi"):
 *
 *   - Day groups, not row lines. One 1px rule between days instead of one per
 *     row; each group is its own container so the `content-visibility: auto`
 *     already in moon.css can skip the groups that are off screen.
 *   - A12: as soon as a filter narrows the list below FLAT_MAX, the grouping
 *     collapses (.is-flat) and the date moves into the row, because nine sticky
 *     day heads over twelve results read worse than a flat list.
 *   - G5: inside a heavy day (or anywhere in the flat list) every fifth row
 *     carries a guide line, the way a log table does.
 *
 * The view never writes to Moon.Store; every mutation goes through Moon.Model,
 * and every user-visible string comes from Moon.I18n. render() is idempotent:
 * the router calls it again on state:change and on lang:change, and the filter
 * state below survives that because it lives in the module, not in the DOM.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var util = Moon.util;
  var dom = Moon.dom;

  var FLAT_MAX = 20;        /* A12: below this a filtered list goes flat      */
  var GUIDE_STEP = 5;       /* G5                                             */
  var HEAVY_DAY = 8;        /* G5: a day this long earns guide lines          */
  var NOTE_MAX = 200;       /* the model truncates there too                  */
  var SEARCH_WAIT = 90;     /* ms — "instant" without redrawing on every key  */
  var UNDO_SECONDS = 8;     /* G12                                            */

  /* The three margin marks (G6) share one 28px column, so a row can print
     only one. A row waiting for confirmation is the only one of the three that
     asks the reader to do something, so it wins. */
  var MARK_ORDER = ["unconfirmed", "over", "recurring"];

  /* ui.js asks the catalogue for "a11y.mark.over"; the catalogue spells it
     "a11y.markOver". Repaired per mark below rather than in ui.js, which this
     agent does not own. */
  var MARK_SR = {
    over: "a11y.markOver",
    recurring: "a11y.markRecurring",
    unconfirmed: "a11y.markUnconfirmed"
  };

  /* ------------------------------------------------------------ view state */

  var filters = { search: "", categoryId: "", direction: "" };
  var dense = false;
  var selected = Object.create(null);

  /* Shown once at the top of the next draw: a result sentence, never a toast
     flying out of a corner (G12). */
  var flash = null;

  /* "Write one more" — the date and the category of the last saved entry come
     back as the defaults, because entries arrive in runs. */
  var lastUsed = { date: null, categoryId: null, direction: "out" };

  var rowIndex = 0;
  var roving = null;
  var host = null;          /* the element render() was handed, for redraws   */
  var clearButton = null;
  var listHost = null;
  var asideNode = null;
  var noticeHost = null;
  var debouncedSearch = null;

  /* ------------------------------------------------------------- plumbing */

  function t(key, params) {
    var I18n = Moon.I18n;
    if (key === null || key === undefined) return "";
    if (!I18n || typeof I18n.t !== "function") return String(key);
    return I18n.t(key, params);
  }

  /* Two finished sentences with a space between them. Nothing here builds a
     sentence out of fragments — Turkish suffixes would not survive it. */
  function sentences(a, b) {
    if (!a) return b || "";
    if (!b) return a;
    return a + " " + b;
  }

  function lang() {
    var I18n = Moon.I18n;
    return (I18n && I18n.lang) || "tr";
  }

  function settings() {
    var Store = Moon.Store;
    var state = Store && Store.state ? Store.state : null;
    return (state && state.settings) || {};
  }

  function currency() {
    return settings().currency || "TRY";
  }

  function today() {
    var Dates = Moon.Dates;
    return Dates && Dates.today ? Dates.today() : null;
  }

  /* The period selector lives in the header; the view only reads it. */
  function currentPeriod() {
    var App = Moon.App;
    var value = null;
    if (App) value = typeof App.period === "function" ? App.period() : App.period;
    if (value) return value;
    var Dates = Moon.Dates;
    if (!Dates || !Dates.periodKey) return null;
    return Dates.periodKey(today(), settings().monthStartDay) || null;
  }

  function money(minor, opts) {
    var Money = Moon.Money;
    var options = opts || {};
    if (!Money || typeof Money.format !== "function") return String(minor);
    return Money.format(minor, {
      currency: options.symbol === false ? null : currency(),
      lang: lang(),
      symbol: options.symbol !== false,
      sign: options.sign === true
    });
  }

  function shortDate(date) {
    var Dates = Moon.Dates;
    if (!Dates || !Dates.formatDate) return String(date || "");
    return Dates.formatDate(date, lang(), "short");
  }

  function weekday(date) {
    var Dates = Moon.Dates;
    if (!Dates || !Dates.weekdayShort) return "";
    return Dates.weekdayShort(date, lang());
  }

  /* moon.css and ui.js disagree on a handful of class names (ui.js emits
     BEM-style modifiers, the stylesheet keys off .is-* state classes). The
     view bridges them here instead of leaving unstyled nodes on the page. */
  function alias(root, from, to) {
    if (!root) return root;
    dom.qsa("." + from, root).forEach(function (node) {
      to.split(" ").forEach(function (name) {
        if (node.classList) node.classList.add(name);
      });
    });
    return root;
  }

  function directionOf(entry) {
    return entry && entry.direction === "in" ? "in" : "out";
  }

  /* Ledger amounts are signed for the reader: money leaving is negative. The
     stored amount is always positive (schema), so the sign is applied here. */
  function signedAmount(entry) {
    var amount = entry && typeof entry.amount === "number" ? entry.amount : 0;
    return directionOf(entry) === "in" ? amount : -amount;
  }

  function netOf(rows) {
    var total = 0;
    rows.forEach(function (entry) {
      total += signedAmount(entry);
    });
    return total;
  }

  function filtersActive() {
    return !!(filters.search || filters.categoryId || filters.direction);
  }

  function selectedIds() {
    return Object.keys(selected);
  }

  /* --------------------------------------------------------------- reading */

  function allEntries(period) {
    var Model = Moon.Model;
    if (!Model || typeof Model.entries !== "function") return [];
    var query = {};
    if (period) query.period = period;
    return Model.entries(query) || [];
  }

  function filteredEntries(period) {
    var Model = Moon.Model;
    if (!Model || typeof Model.entries !== "function") return [];
    var query = {};
    if (period) query.period = period;
    if (filters.search) query.search = filters.search;
    if (filters.categoryId) query.categoryId = filters.categoryId;
    if (filters.direction) query.direction = filters.direction;
    return Model.entries(query) || [];
  }

  /* Which categories are over their limit this period — the † mark reads from
     the same numbers the Limits section draws. */
  function overCategories(period) {
    var set = Object.create(null);
    var Model = Moon.Model;
    if (!Model || typeof Model.budgetRows !== "function" || !period) return set;
    var rows = Model.budgetRows(period) || [];
    rows.forEach(function (row) {
      if (row && row.categoryId && row.driftState === "over") set[row.categoryId] = true;
    });
    return set;
  }

  function categoryName(id) {
    var Model = Moon.Model;
    if (Model && typeof Model.categoryName === "function") return Model.categoryName(id);
    return t("common.unclassified");
  }

  function categoryOptions(kind) {
    var Model = Moon.Model;
    if (!Model || typeof Model.categories !== "function") return [];
    var list = Model.categories(kind ? { kind: kind } : null) || [];
    return list.map(function (cat) {
      return { value: cat.id, label: String(cat.name || "").trim() || t("common.unclassified") };
    });
  }

  function markKindFor(entry, overSet) {
    if (entry.confirmed === false) return "unconfirmed";
    if (entry.categoryId && overSet[entry.categoryId] && directionOf(entry) === "out") return "over";
    if (entry.source === "recurring" || entry.recurringId) return "recurring";
    return null;
  }

  /* ----------------------------------------------------------------- parts */

  function markNode(kind) {
    var UI = Moon.UI;
    var node = UI && typeof UI.mark === "function" ? UI.mark(kind) : null;
    if (!node) return null;
    if (node.classList) {
      node.classList.add("ledger-row__mark");
      node.classList.add("is-" + kind);
    }
    var sr = dom.qs(".sr", node);
    if (sr) sr.textContent = t(MARK_SR[kind]);
    return node;
  }

  function iconButton(glyph, labelKey, onClick) {
    var label = t(labelKey);
    var node = dom.el("button", {
      "class": "btn is-quiet ledger-row__action",
      type: "button",
      title: label,
      "aria-label": label
    }, dom.el("span", { "aria-hidden": "true" }, glyph));
    node.addEventListener("click", function (event) {
      event.stopPropagation();
      onClick();
    });
    return node;
  }

  /* One row. Child order is the grid order moon.css declares: date, category,
     note, actions, amount, mark — the date hides itself outside .is-flat and
     the actions hide themselves inside it, so no cell has to be left out. */
  function rowNode(entry, opts) {
    var classes = ["ledger-row"];
    if (entry.confirmed === false) classes.push("is-unconfirmed");
    if (opts.guide) classes.push("is-guide");
    if (selected[entry.id]) classes.push("is-active");

    var row = dom.el("div", {
      "class": classes.join(" "),
      tabindex: "-1",
      dataset: { row: "1", id: entry.id }
    });

    row.appendChild(dom.el("span", {
      "class": "ledger-row__date num",
      text: shortDate(entry.date)
    }));

    var name = categoryName(entry.categoryId);
    var pick = dom.el("input", {
      "class": "ledger-row__pick",
      type: "checkbox",
      /* The accessible name is the row's own data, not a phrase to translate. */
      "aria-label": String(entry.note || "").trim() || name
    });
    pick.checked = !!selected[entry.id];
    pick.addEventListener("change", function () {
      if (pick.checked) selected[entry.id] = true;
      else delete selected[entry.id];
      refreshList();
    });

    var cat = dom.el("span", { "class": "ledger-row__cat", title: name }, [
      pick,
      " ",
      name
    ]);
    row.appendChild(cat);

    var note = String(entry.note || "");
    row.appendChild(dom.el("span", {
      "class": "ledger-row__note",
      title: note,
      text: note
    }));

    /* The space is reserved at all times (moon.css only animates opacity), so
       hovering a row never nudges the layout. */
    row.appendChild(dom.el("span", {
      "class": "ledger-row__actions",
      role: "group",
      "aria-label": t("a11y.rowActions")
    }, [
      iconButton("✎", "ledger.action.edit", function () { openForm(entry); }),
      iconButton("⧉", "ledger.action.copy", function () { copyEntry(entry); }),
      iconButton("×", "ledger.action.delete", function () { askDelete(entry); })
    ]));

    /* Ledger rows carry no currency symbol (only the hero strip does), and the
       cell's spans are the grid — nothing may wrap them. */
    var UI = Moon.UI;
    var value = signedAmount(entry);
    var amount = UI && typeof UI.moneyCell === "function"
      ? UI.moneyCell(value, {
          sign: true,
          "class": "ledger-row__amount " + (value > 0 ? "is-in" : "is-out")
        })
      : dom.el("span", { "class": "ledger-row__amount num", text: money(value) });
    row.appendChild(amount);

    var kind = markKindFor(entry, opts.overSet);
    row.appendChild(kind
      ? markNode(kind)
      : dom.el("span", { "class": "ledger-row__mark", "aria-hidden": "true" }));

    return row;
  }

  /* Day groups. Each one is its own element: that is what makes the
     content-visibility rule in moon.css able to skip whole days. */
  function dayGroups(rows, flat, overSet) {
    var frag = dom.frag([]);
    var groups = util.groupBy(rows, function (entry) { return entry.date; });
    var flatCount = 0;

    groups.forEach(function (list, date) {
      var group = dom.el("div", { "class": "day" });
      var heavy = list.length > HEAVY_DAY;

      group.appendChild(dom.el("div", { "class": "day__head" }, [
        dom.el("span", { "class": "day__label" }, [
          weekday(date),
          " ",
          shortDate(date)
        ]),
        dom.el("span", {
          "class": "day__total",
          text: t("ledger.dayTotal", { amount: money(netOf(list), { sign: true }) })
        })
      ]));

      list.forEach(function (entry, index) {
        /* G5: in the flat list the count runs across the whole view, inside a
           group it restarts — the guide line has to measure what the eye is
           actually scanning. */
        var ordinal = flat ? (flatCount += 1) : index + 1;
        var guide = (flat || heavy) &&
          ordinal % GUIDE_STEP === 0 &&
          (flat || ordinal < list.length);
        group.appendChild(rowNode(entry, { guide: guide, overSet: overSet }));
      });

      frag.appendChild(group);
    });

    return frag;
  }

  /* ---------------------------------------------------------------- notices */

  function drawNotices(period) {
    if (!noticeHost) return;
    dom.clear(noticeHost);
    var UI = Moon.UI;
    if (!UI || typeof UI.notice !== "function") return;

    if (flash) {
      noticeHost.appendChild(alias(UI.notice({
        kind: "info",
        "class": "is-info",
        messageKey: flash.messageKey,
        params: flash.params,
        dismissible: true,
        dismissKey: "common.close"
      }), "notice__text", "notice__body"));
      flash = null;
    }

    /* Rows that came in from a statement and nobody has looked at yet. The
       band counts them for the whole period, not for the filtered view. */
    var waiting = allEntries(period).filter(function (entry) {
      return entry.confirmed === false;
    });
    if (!waiting.length) return;

    var ids = waiting.map(function (entry) { return entry.id; });
    noticeHost.appendChild(alias(UI.notice({
      kind: "warn",
      "class": "is-warn",
      messageKey: "ledger.unconfirmedCount",
      params: { count: waiting.length },
      body: t("ledger.unconfirmed.note"),
      actions: [{
        labelKey: "ledger.confirmAll",
        kind: "primary",
        "class": "is-primary",
        onClick: function () { confirmAll(ids); }
      }]
    }), "notice__text", "notice__body"));
  }

  function bulkBar() {
    var ids = selectedIds();
    if (!ids.length) return null;
    var UI = Moon.UI;
    if (!UI || typeof UI.notice !== "function") return null;

    return alias(UI.notice({
      kind: "info",
      "class": "is-info",
      messageKey: "ledger.count",
      params: { count: ids.length },
      actions: [
        {
          labelKey: "common.delete",
          kind: "danger",
          "class": "is-danger",
          onClick: function () { askDeleteMany(ids); }
        },
        {
          labelKey: "common.cancel",
          kind: "quiet",
          "class": "is-quiet",
          onClick: function () {
            selected = Object.create(null);
            refreshList();
          }
        }
      ]
    }), "notice__text", "notice__body");
  }

  /* ---------------------------------------------------------------- filters */

  function filterBar() {
    var UI = Moon.UI;
    var bar = dom.el("div", { "class": "filters" });
    if (!UI || typeof UI.field !== "function") return bar;

    bar.appendChild(dom.el("div", { "class": "form__actions" }, [
      (function () {
        var node = dom.el("button", {
          "class": "btn is-primary",
          type: "button",
          text: t("ledger.form.submit")
        });
        node.addEventListener("click", function () { openForm(null); });
        return node;
      })()
    ]));

    debouncedSearch = util.debounce(function () {
      refreshList();
    }, SEARCH_WAIT);

    var search = UI.field({
      name: "search",
      type: "search",
      labelKey: "ledger.filter.search",
      value: filters.search,
      onInput: function (value) {
        /* Moon.util.lower (inside Model.entries) makes the match
           Turkish-aware on both sides, so "İstanbul" and "istanbul" meet. */
        filters.search = String(value || "");
        debouncedSearch();
      }
    });
    bar.appendChild(search);

    bar.appendChild(UI.field({
      name: "categoryId",
      type: "select",
      labelKey: "ledger.filter.category",
      value: filters.categoryId,
      options: [{ value: "", labelKey: "ledger.filter.category.all" }]
        .concat(categoryOptions(null)),
      onChange: function (value) {
        filters.categoryId = String(value || "");
        refreshList();
      }
    }));

    bar.appendChild(UI.field({
      name: "direction",
      type: "select",
      labelKey: "ledger.filter.direction",
      value: filters.direction,
      options: [
        { value: "", labelKey: "ledger.filter.direction.all" },
        { value: "out", labelKey: "form.direction.out" },
        { value: "in", labelKey: "form.direction.in" }
      ],
      onChange: function (value) {
        filters.direction = value === "in" || value === "out" ? value : "";
        refreshList();
      }
    }));

    bar.appendChild(UI.field({
      name: "density",
      type: "select",
      labelKey: "ledger.density",
      value: dense ? "dense" : "roomy",
      options: [
        { value: "roomy", labelKey: "ledger.density.roomy" },
        { value: "dense", labelKey: "ledger.density.dense" }
      ],
      onChange: function (value) {
        dense = value === "dense";
        refreshList();
      }
    }));

    /* Built once and hidden while nothing is filtered: typing in the search box
       redraws only the list, so a button that appeared on the first keystroke
       would have to rebuild this bar and take the caret with it. */
    clearButton = dom.el("button", {
      "class": "btn is-quiet",
      type: "button",
      text: t("ledger.filter.clear"),
      hidden: !filtersActive()
    });
    clearButton.addEventListener("click", clearFilters);
    bar.appendChild(clearButton);

    return bar;
  }

  /* ------------------------------------------------------------- the list */

  function clearFilters() {
    filters.search = "";
    filters.categoryId = "";
    filters.direction = "";
    draw();
  }

  /* The whole ledger, not just this period: an empty September in a ledger
     that has an August is not a first-run screen. */
  function ledgerIsEmpty() {
    var Model = Moon.Model;
    if (!Model || typeof Model.entries !== "function") return true;
    return (Model.entries({}) || []).length === 0;
  }

  function emptyFiltered() {
    var UI = Moon.UI;
    if (!UI || typeof UI.emptyState !== "function") return dom.el("div");
    return alias(UI.emptyState({
      headingKey: "empty.ledger.filtered.heading",
      bodyKey: "empty.ledger.filtered.body",
      actions: filtersActive()
        ? [{ labelKey: "ledger.filter.clear", onClick: clearFilters }]
        : null
    }), "empty__heading", "empty__title");
  }

  /* The first page of the notebook (G9): the rules are printed, the lines are
     simply empty, and the three ways in are real rows, not a button row. */
  function emptyLedger() {
    var UI = Moon.UI;
    if (!UI || typeof UI.emptyState !== "function") return dom.el("div");
    var node = UI.emptyState({
      ghost: true,
      columns: 3,
      headingKey: "empty.ledger.heading",
      bodyKey: "empty.ledger.body",
      footKey: "empty.ledger.footer",
      actions: [
        { labelKey: "empty.ledger.action1", onClick: function () { openForm(null); } },
        { labelKey: "empty.ledger.action2", href: "#veri" },
        {
          labelKey: "empty.ledger.action3",
          onClick: function () {
            var Sample = Moon.Sample;
            if (Sample && typeof Sample.apply === "function") Sample.apply();
          }
        }
      ]
    });
    alias(node, "empty__heading", "empty__title");
    alias(node, "empty__action", "btn is-row");
    return node;
  }

  /* Rebuilds the list without touching the filter bar, so the caret stays in
     the search box while the reader types. */
  function refreshList() {
    if (!listHost) return;

    var period = currentPeriod();
    var rows = filteredEntries(period);
    var total = allEntries(period).length;

    /* A selection only means anything for rows the reader can see. */
    var visible = Object.create(null);
    rows.forEach(function (entry) { visible[entry.id] = true; });
    Object.keys(selected).forEach(function (id) {
      if (!visible[id]) delete selected[id];
    });

    var flat = filtersActive() && rows.length < FLAT_MAX;
    var sum = netOf(rows);

    if (clearButton) clearButton.hidden = !filtersActive();

    if (asideNode) {
      asideNode.textContent = filtersActive()
        ? t("ledger.summary", {
            count: total,
            shown: rows.length,
            total: money(sum, { sign: true })
          })
        : t("ledger.count", { count: rows.length });
    }

    dom.clear(listHost);
    drawNotices(period);

    var bulk = bulkBar();
    if (bulk) listHost.appendChild(bulk);

    if (!rows.length) {
      listHost.appendChild(ledgerIsEmpty() ? emptyLedger() : emptyFiltered());
      return;
    }

    var classes = ["ledger"];
    if (dense) classes.push("is-dense");
    if (flat) classes.push("is-flat");

    var ledger = dom.el("div", { "class": classes.join(" ") });
    ledger.appendChild(dayGroups(rows, flat, overCategories(period)));
    listHost.appendChild(ledger);

    listHost.appendChild(dom.el("p", {
      "class": "ledger__summary num",
      text: t("ledger.total", { total: money(sum, { sign: true }) })
    }));

    if (roving && typeof roving.destroy === "function") roving.destroy();
    var UI = Moon.UI;
    roving = UI && typeof UI.rovingList === "function"
      ? UI.rovingList(ledger, {
          selector: "[data-row]",
          start: rowIndex,
          onFocus: function (index) { rowIndex = index; },
          onActivate: function (index, row) {
            var entry = entryById(rows, row);
            if (entry) openForm(entry);
          },
          onDelete: function (index, row) {
            var entry = entryById(rows, row);
            if (entry) askDelete(entry);
          }
        })
      : null;
  }

  function entryById(rows, row) {
    var id = row && row.dataset ? row.dataset.id : null;
    if (!id) return null;
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].id === id) return rows[i];
    }
    return null;
  }

  /* ------------------------------------------------------------ mutations */

  function undo(message, restore) {
    var UI = Moon.UI;
    if (!UI || typeof UI.undoStrip !== "function") return;
    UI.undoStrip({
      message: message,
      seconds: UNDO_SECONDS,
      dismissKey: "common.close",
      onUndo: restore
    });
    /* ui.js counts down with t("common.secondsLeft"), a key no catalogue
       carries, so the raw key would sit in the strip for eight seconds. The
       countdown is aria-hidden decoration; the sentence above already says how
       long the offer stands. */
    var count = dom.qs("#strip .undo__count");
    if (count && count.parentNode) count.parentNode.removeChild(count);
  }

  function restoreEntries(records) {
    var Model = Moon.Model;
    if (!Model || typeof Model.addEntry !== "function") return;
    records.forEach(function (record) {
      if (record) Model.addEntry(record);
    });
    flash = { messageKey: "ledger.undone" };
    draw();
  }

  function askDelete(entry) {
    var UI = Moon.UI;
    if (!UI || typeof UI.confirm !== "function") return;
    UI.confirm({
      titleKey: "ledger.delete.title",
      bodyKey: "ledger.delete.body",
      confirmKey: "ledger.delete.confirm",
      danger: true
    }).then(function (yes) {
      if (!yes) return;
      var Model = Moon.Model;
      if (!Model || typeof Model.removeEntry !== "function") return;
      /* removeEntry hands the record back — that is the undo payload. */
      var removed = Model.removeEntry(entry.id);
      if (!removed) return;
      delete selected[entry.id];
      undo(
        sentences(t("ledger.deleted"), t("ledger.undo.hint", { seconds: UNDO_SECONDS })),
        function () { restoreEntries([removed]); }
      );
      draw();
    });
  }

  function askDeleteMany(ids) {
    var UI = Moon.UI;
    if (!UI || typeof UI.confirm !== "function") return;
    UI.confirm({
      titleKey: "ledger.delete.title",
      bodyKey: "ledger.delete.body",
      confirmKey: "ledger.delete.confirm",
      danger: true
    }).then(function (yes) {
      if (!yes) return;
      var Model = Moon.Model;
      if (!Model || typeof Model.removeEntries !== "function") return;
      var removed = Model.removeEntries(ids) || [];
      if (!removed.length) return;
      selected = Object.create(null);
      undo(
        sentences(
          t("ledger.deletedMany", { count: removed.length }),
          t("ledger.undo.hint", { seconds: UNDO_SECONDS })
        ),
        function () { restoreEntries(removed); }
      );
      draw();
    });
  }

  function confirmAll(ids) {
    var Model = Moon.Model;
    if (!Model || typeof Model.confirmEntries !== "function") return;
    var count = Model.confirmEntries(ids);
    if (!count) return;
    flash = { messageKey: "ledger.confirmedCount", params: { count: count } };
    draw();
  }

  function copyEntry(entry) {
    var Model = Moon.Model;
    if (!Model || typeof Model.addEntry !== "function") return;
    var id = Model.addEntry({
      date: today() || entry.date,
      amount: entry.amount,
      direction: directionOf(entry),
      categoryId: entry.categoryId,
      note: entry.note,
      fixed: entry.fixed,
      source: "manual",
      confirmed: true
    });
    if (!id) return;
    flash = { messageKey: "ledger.copied" };
    draw();
  }

  /* ----------------------------------------------------------------- form */

  function fillSelect(select, options, value) {
    if (!select) return;
    dom.clear(select);
    options.forEach(function (option) {
      var attrs = { value: option.value };
      if (String(value || "") === String(option.value)) attrs.selected = true;
      select.appendChild(dom.el("option", attrs, option.label));
    });
  }

  function openForm(entry) {
    var UI = Moon.UI;
    if (!UI || typeof UI.form !== "function" || typeof UI.dialog !== "function") return;

    var editing = !!entry;
    var direction = editing ? directionOf(entry) : (lastUsed.direction || "out");
    var kindOf = function (dir) { return dir === "in" ? "income" : "expense"; };
    var options = categoryOptions(kindOf(direction));

    var chosen = editing ? entry.categoryId : lastUsed.categoryId;
    var known = options.some(function (option) { return option.value === chosen; });
    if (!known) chosen = options.length ? options[0].value : "";

    /* One summary line above the form, per moon.css .form__summary: what
       happened, how many fields, and the fields say the rest themselves. */
    var summary = dom.el("p", { "class": "form__summary", hidden: true });
    var box = null;

    var api = UI.form({
      fields: [
        {
          name: "date",
          type: "date",
          labelKey: "form.date",
          required: true,
          value: editing ? entry.date : (lastUsed.date || today() || "")
        },
        {
          name: "amount",
          type: "money",
          labelKey: "form.amount",
          hintKey: "form.amount.hint",
          required: true,
          currency: currency(),
          value: editing ? entry.amount : null,
          autofocus: !editing
        },
        {
          name: "direction",
          type: "select",
          labelKey: "form.direction",
          required: true,
          value: direction,
          options: [
            { value: "out", labelKey: "form.direction.out" },
            { value: "in", labelKey: "form.direction.in" }
          ],
          onChange: function (value) {
            /* An income category can never take an expense, so the list is
               rebuilt instead of letting the reader pick an invalid pair. */
            var dir = value === "in" ? "in" : "out";
            var next = categoryOptions(kindOf(dir));
            var field = api.fields.categoryId;
            fillSelect(field ? field.control : null, next,
              next.length ? next[0].value : "");
          }
        },
        {
          name: "categoryId",
          type: "select",
          labelKey: "form.category",
          required: true,
          value: chosen,
          options: options
        },
        {
          name: "note",
          type: "text",
          labelKey: "form.note",
          hintKey: "form.note.hint",
          params: { max: NOTE_MAX },
          maxLength: NOTE_MAX,
          value: editing ? entry.note : ""
        }
      ],
      actions: [
        {
          labelKey: editing ? "ledger.form.submit.edit" : "ledger.form.submit",
          kind: "primary",
          "class": "is-primary",
          type: "submit"
        },
        {
          labelKey: "common.cancel",
          kind: "quiet",
          "class": "is-quiet",
          onClick: function () { if (box) box.close(); }
        }
      ],
      onSubmit: function (values) {
        save(values, entry, api, summary, box);
      }
    });

    box = UI.dialog({
      titleKey: editing ? "ledger.form.title.edit" : "ledger.form.title.new",
      body: [summary, api.element]
    });
    box.open();
  }

  function showErrors(api, summary, errors) {
    var names = Object.keys(errors);
    api.setErrors(errors);
    summary.hidden = false;
    summary.textContent = sentences(
      t("form.errors.title"),
      t("form.errors.body", { count: names.length })
    );
    api.focusFirstError();
  }

  function save(values, entry, api, summary, box) {
    var Money = Moon.Money;
    var Model = Moon.Model;
    if (!Model || typeof Model.validateEntry !== "function") return;

    var errors = api.fieldErrors() || {};

    /* Moon.Money.parse returns a SIGNED reading; the schema keeps the amount
       positive and puts the direction in its own field. So a typed minus is a
       real mistake with its own sentence (E1), and the stored value is r.abs. */
    var field = api.fields.amount;
    var raw = field ? String(field.control.value || "").trim() : "";
    var parsed = raw && Money && typeof Money.parse === "function"
      ? Money.parse(raw, { decimal: "auto" })
      : { ok: false };

    if (!raw) errors.amount = "err.required";
    else if (!parsed.ok) errors.amount = parsed.error || "money.invalid";
    else if (parsed.negative) errors.amount = "err.negativeAmount";
    else if (!parsed.abs) errors.amount = "err.zeroAmount";

    var draft = {
      date: values.date,
      amount: parsed.ok ? parsed.abs : 0,
      direction: values.direction === "in" ? "in" : "out",
      categoryId: values.categoryId,
      note: values.note,
      source: entry ? entry.source : "manual",
      confirmed: entry ? entry.confirmed !== false : true
    };
    if (entry) draft.fixed = entry.fixed;

    var check = Model.validateEntry(draft);
    Object.keys(check.errors).forEach(function (name) {
      /* Our own amount reading is more precise than "must be positive". */
      if (!errors[name]) errors[name] = check.errors[name];
    });

    if (Object.keys(errors).length) {
      showErrors(api, summary, errors);
      return;
    }

    var ok = entry
      ? Model.updateEntry(entry.id, draft)
      : Model.addEntry(draft);

    if (!ok) {
      /* The fields are all clean, so the fault belongs to the write, not to a
         value the reader can correct in place. */
      api.setErrors(null);
      summary.hidden = false;
      summary.textContent = t("err.unknown");
      return;
    }

    /* Entries arrive in runs, so the next dialog opens on the same day and the
       same category. */
    lastUsed.date = draft.date;
    lastUsed.categoryId = draft.categoryId;
    lastUsed.direction = draft.direction;

    flash = { messageKey: "ledger.saved" };
    if (box) box.close();
    draw();
  }

  /* ----------------------------------------------------------- lifecycle */

  function draw() {
    if (!host) return;
    dom.clear(host);

    noticeHost = dom.el("div", { "class": "ledger__notices" });
    listHost = dom.el("div", { "class": "ledger__list" });
    asideNode = dom.el("span", { "class": "section__aside num" });

    var UI = Moon.UI;
    var body = [noticeHost, filterBar(), listHost];

    var node = UI && typeof UI.section === "function"
      ? UI.section({
          id: "ledger",
          titleKey: "ledger.title",
          aside: asideNode,
          body: body
        })
      : dom.el("section", null, body);

    host.appendChild(node);
    refreshList();
  }

  Moon.Views = Moon.Views || {};

  Moon.Views.ledger = {
    id: "ledger",
    titleKey: "nav.ledger",

    render: function (root) {
      host = root;
      draw();
    },

    destroy: function () {
      if (roving && typeof roving.destroy === "function") roving.destroy();
      if (debouncedSearch && typeof debouncedSearch.cancel === "function") {
        debouncedSearch.cancel();
      }
      roving = null;
      debouncedSearch = null;
      clearButton = null;
      listHost = null;
      noticeHost = null;
      asideNode = null;
      host = null;
    }
  };
})(window);
