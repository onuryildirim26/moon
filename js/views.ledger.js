/* Moon — the ledger view (#defter).
 *
 * This is the screen that gets used sixty times a month, so the whole file is
 * built around one sentence from sadeleştirme §3: writing an entry must cost
 * one line of typing, and changing one must cost no more than that.
 *
 *   - No dialog. A permanent quickRow sits at the head of the list (date,
 *     amount, category, note) and Enter in any field saves and parks the caret
 *     back on the amount, with the date and the category kept — a run of
 *     grocery entries is one field each.
 *   - Clicking a row, or Enter on it, turns THAT row into the same quickRow in
 *     place. Enter saves, Esc gives up. The direction, the fixed mark and the
 *     row's provenance live one quiet toggle away, inside that row's own sheet.
 *   - Deleting asks nothing. It deletes and leaves the eight-second undo strip
 *     (G12); asking first and then offering undo is asking twice.
 *
 * The three decisions the design brief makes about the list itself still hold
 * (00-tasarim.md, "Harcama listesi"):
 *
 *   - Day groups, not row lines. One 1px rule between days instead of one per
 *     row; each group is its own container so the `content-visibility: auto`
 *     already in moon.css can skip the groups that are off screen.
 *   - A12: as soon as a filter narrows the list below FLAT_MAX, the grouping
 *     collapses (.is-flat) and the date moves into the row, because nine sticky
 *     day heads over twelve results read worse than a flat list.
 *   - G5: inside a heavy day (or anywhere in the flat list) every fifth row
 *     carries a guide line, the way a log table does.
 *   - One tab stop for the whole list. Three hundred rows must not put nine
 *     hundred stops between the filter bar and the total, so every control a
 *     row holds is tabindex="-1" and the keyboard walks the list with the
 *     arrows instead (see "row keyboard map" below). The open edit row is the
 *     one exception and it is a deliberate one: its fields are what the reader
 *     is typing into, and it folds back into a single row the moment it closes.
 *
 * Because the router redraws this view on every state:change — asynchronously,
 * one tick after a save (app.js schedule()) — a redraw must not throw the caret
 * on the floor. snapshot()/applyRestore() below carry the half-typed row and
 * the focused control across every rebuild, which is what makes "Enter, type,
 * Enter" actually work instead of merely looking like it does.
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
  var doc = global.document;

  var FLAT_MAX = 20;        /* A12: below this a filtered list goes flat      */
  var GUIDE_STEP = 5;       /* G5                                             */
  var HEAVY_DAY = 8;        /* G5: a day this long earns guide lines          */
  var NOTE_MAX = 200;       /* the model truncates there too                  */
  var SEARCH_WAIT = 90;     /* ms — "instant" without redrawing on every key  */
  var UNDO_SECONDS = 8;     /* G12                                            */

  /* Every quickRow gets its own memory key: the head row and the row being
     edited remember their own "more" sheet, so opening the sheet to set a
     direction once does not unfold it on the other one for the rest of the
     session. */
  var QUICK_MEMORY = "ledger.quick";
  var EDIT_MEMORY = "ledger.edit";

  var SOURCE_KEYS = {
    manual: "ledger.filter.source.manual",
    csv: "ledger.filter.source.csv",
    recurring: "ledger.filter.source.recurring",
    sample: "ledger.filter.source.sample"
  };

  var MARK_KEYS = {
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
  var lastUsed = { date: null, categoryId: null };

  /* Which row is open for editing, and the half-typed contents of both rows,
     carried across the redraws the router fires underneath us. */
  var editingId = null;
  var quickDraft = null;
  var editDraft = null;
  var restore = null;

  /* The direction and the fixed mark normally FOLLOW the category (an income
     category makes an income entry), and stop following it the moment the
     reader sets one by hand. One flag each, per open row.
     Untouched, the mark is left out of the draft entirely and Moon.Model
     answers it — see buildDraft. */
  var quickTouch = { direction: false, fixed: false };
  var editTouch = { direction: false, fixed: false };

  var quickApi = null;
  var editApi = null;

  var rowIndex = 0;
  var roving = null;
  var host = null;          /* the element render() was handed, for redraws   */
  var clearButton = null;
  var listHost = null;
  var quickHost = null;
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

  /* Not every sentence this view would like exists in the catalogue yet, and a
     missing key must never reach the page as its own name. */
  function has(key) {
    var I18n = Moon.I18n;
    if (!I18n || typeof I18n.has !== "function") return false;
    return I18n.has(key) === true;
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

  function entryById(id) {
    var Model = Moon.Model;
    if (!id || !Model || typeof Model.entries !== "function") return null;
    var all = Model.entries({}) || [];
    for (var i = 0; i < all.length; i += 1) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  function categoryName(id) {
    var Model = Moon.Model;
    if (Model && typeof Model.categoryName === "function") return Model.categoryName(id);
    return t("common.unclassified");
  }

  function categoryById(id) {
    var Model = Moon.Model;
    if (!id || !Model || typeof Model.categoryById !== "function") return null;
    return Model.categoryById(id) || null;
  }

  function categoryOptions(kind) {
    var Model = Moon.Model;
    if (!Model || typeof Model.categories !== "function") return [];
    var list = Model.categories(kind ? { kind: kind } : null) || [];
    return list.map(function (cat) {
      return { value: cat.id, label: String(cat.name || "").trim() || t("common.unclassified") };
    });
  }

  /* One list, both kinds, expense first: the entry row has no direction field
     on screen, so the category IS the direction and the reader must be able to
     reach "Salary" without opening anything. */
  function entryCategoryOptions() {
    return categoryOptions("expense").concat(categoryOptions("income"));
  }

  function directionForCategory(id) {
    var cat = categoryById(id);
    return cat && cat.kind === "income" ? "in" : "out";
  }

  function fixedForCategory(id) {
    var cat = categoryById(id);
    return !!(cat && cat.fixed);
  }

  function firstCategoryId() {
    var options = entryCategoryOptions();
    return options.length ? options[0].value : "";
  }

  function knownCategory(id) {
    if (!id) return false;
    return !!categoryById(id);
  }

  /* The three margin marks (G6) share one 28px column, so a row can print only
     one, and this order is the rule: a row waiting for confirmation is the only
     one of the three that asks the reader to do something, so it wins. */
  function markKindFor(entry, overSet) {
    if (entry.confirmed === false) return "unconfirmed";
    if (entry.categoryId && overSet[entry.categoryId] && directionOf(entry) === "out") return "over";
    if (entry.source === "recurring" || entry.recurringId) return "recurring";
    return null;
  }

  /* ------------------------------------------------- focus across a redraw

     app.js answers state:change with setTimeout(…, 0) and then re-renders this
     whole view, so every save is followed one tick later by a rebuild of the
     very input the reader is typing into. Without this pair, "Enter and keep
     typing" would lose the caret on every single entry — which is the one thing
     sadeleştirme §3 asks for. snapshot() reads where the caret is and what has
     been typed; applyRestore() puts both back. */

  function activeNode() {
    if (!doc) return null;
    var node = doc.activeElement;
    if (!node || node === doc.body || node === doc.documentElement) return null;
    return node;
  }

  function caretOf(control) {
    if (!control) return null;
    try {
      if (typeof control.selectionStart !== "number") return null;
      return { start: control.selectionStart, end: control.selectionEnd };
    } catch (error) {
      /* A date or a number input throws on selectionStart in some browsers. */
      return null;
    }
  }

  function fieldNameOf(node) {
    if (!node || typeof node.closest !== "function") return null;
    var wrap = node.closest(".field");
    if (!wrap || !wrap.dataset) return null;
    return wrap.dataset.field || null;
  }

  function partOfRow(node, row) {
    if (node === row) return "row";
    if (node.classList && node.classList.contains("ledger-row__pick")) return "pick";
    if (typeof node.closest === "function" && node.closest(".ledger-row__action")) {
      var items = dom.qsa(".ledger-row__action", row);
      var at = items.indexOf(node.closest(".ledger-row__action"));
      if (at !== -1) return "action:" + at;
    }
    return "row";
  }

  /* Raw control values, not parsed ones: a half-typed "1.2" is not a number
     yet and must survive the rebuild exactly as it was typed. */
  function draftOf(api) {
    if (!api || !api.fields) return null;
    var out = Object.create(null);
    Object.keys(api.fields).forEach(function (name) {
      var entry = api.fields[name];
      if (!entry || !entry.control) return;
      out[name] = entry.type === "switch"
        ? !!entry.control.checked
        : String(entry.control.value === undefined ? "" : entry.control.value);
    });
    out["@more"] = typeof api.isMoreOpen === "function" ? api.isMoreOpen() : false;
    return out;
  }

  function snapshot() {
    quickDraft = draftOf(quickApi);
    editDraft = draftOf(editApi);
    restore = null;

    var node = activeNode();
    if (!node || typeof node.closest !== "function") return;

    var form = node.closest(".quickrow");
    if (form) {
      var scope = null;
      if (quickApi && form === quickApi.element) scope = "quick";
      else if (editApi && form === editApi.element) scope = "edit";
      if (!scope) return;
      var name = fieldNameOf(node);
      var part = name
        ? null
        : (node.classList && node.classList.contains("quickrow__more") ? "more" : "submit");
      restore = { scope: scope, name: name, part: part, caret: caretOf(node) };
      return;
    }

    var row = node.closest("[data-row]");
    if (!row || !row.dataset) return;
    restore = {
      scope: "row",
      id: row.dataset.id || null,
      part: partOfRow(node, row),
      index: roving && typeof roving.index === "function" ? roving.index() : rowIndex
    };
  }

  function focusControl(control, caret) {
    if (!control || typeof control.focus !== "function") return false;
    try {
      control.focus();
    } catch (error) {
      return false;
    }
    if (caret && typeof control.setSelectionRange === "function") {
      try {
        control.setSelectionRange(caret.start, caret.end);
      } catch (error) { /* a type that refuses a selection: leave the caret */ }
    }
    return true;
  }

  function restoreInForm(api, want) {
    if (!api) return false;
    if (want.name && api.fields && api.fields[want.name]) {
      var entry = api.fields[want.name];
      return focusControl(entry.control, want.caret);
    }
    var selector = want.part === "more" ? ".quickrow__more" : ".quickrow__submit";
    return focusControl(dom.qs(selector, api.element), null);
  }

  function restoreOnRow(want) {
    if (!listHost) return false;
    var rows = dom.qsa("[data-row]", listHost);
    if (!rows.length) return false;

    var at = -1;
    if (want.id) {
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i].dataset && rows[i].dataset.id === want.id) {
          at = i;
          break;
        }
      }
    }
    /* The row may be gone — it was just deleted. Standing on whatever took its
       place is kinder than dropping the reader back to <body>. */
    if (at === -1) at = util.clamp(typeof want.index === "number" ? want.index : 0, 0, rows.length - 1);

    var row = rows[at];
    if (roving && typeof roving.focus === "function") roving.focus(at);
    else focusControl(row, null);

    if (want.part === "pick") {
      var pick = dom.qs(".ledger-row__pick", row);
      if (pick) return focusControl(pick, null);
    } else if (want.part && want.part.indexOf("action:") === 0) {
      var items = dom.qsa(".ledger-row__action", row).filter(onScreen);
      var index = global.parseInt(want.part.slice(7), 10) || 0;
      if (items[index]) return focusControl(items[index], null);
    }
    return true;
  }

  function applyRestore() {
    var want = restore;
    restore = null;
    if (!want) return;
    if (want.scope === "quick") restoreInForm(quickApi, want);
    else if (want.scope === "edit") restoreInForm(editApi, want);
    else if (want.scope === "row") restoreOnRow(want);
  }

  /* ----------------------------------------------------------------- parts */

  /* UI.mark already prints the translated sentence into its own .sr span
     (ui.js MARKS: a11y.markOver / markRecurring / markUnconfirmed), so the
     only thing left here is the two class hooks moon.css keys off. */
  function markNode(kind) {
    var UI = Moon.UI;
    var node = UI && typeof UI.mark === "function" ? UI.mark(kind) : null;
    if (!node) return null;
    if (node.classList) {
      node.classList.add("ledger-row__mark");
      node.classList.add("is-" + kind);
    }
    return node;
  }

  /* tabindex="-1": the list is ONE tab stop (the roving row), so nothing
     inside a row may add a stop of its own — sixty rows would otherwise put
     180 stops between the filter bar and the total. The strip is reached with
     ArrowRight from the row and left with ArrowLeft/Escape (onLedgerKey). */
  function iconButton(glyph, labelKey, onClick) {
    var label = t(labelKey);
    var node = dom.el("button", {
      "class": "btn is-quiet ledger-row__action",
      type: "button",
      tabindex: "-1",
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
     the actions hide themselves inside it, so no cell has to be left out.
     There is no edit button any more: the row itself is the edit affordance. */
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
      /* Out of the tab order for the same reason as the action buttons: the
         keyboard reaches it as Space on the row itself (onLedgerKey), and a
         screen reader still reads and toggles it through the row. */
      tabindex: "-1",
      /* The accessible name is the row's own data, not a phrase to translate. */
      "aria-label": String(entry.note || "").trim() || name
    });
    pick.checked = !!selected[entry.id];
    /* Selecting is not editing: the click must not also open the row. */
    pick.addEventListener("click", function (event) {
      event.stopPropagation();
    });
    pick.addEventListener("change", function () {
      if (pick.checked) selected[entry.id] = true;
      else delete selected[entry.id];
      /* The list is rebuilt under the pointer, so the checkbox gets the focus
         back instead of it falling to <body>. */
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
       hovering a row never nudges the layout. Edit is gone from the strip —
       the row opens on its own click — and what is left is the one action the
       row cannot express by being clicked and the one that destroys. */
    row.appendChild(dom.el("span", {
      "class": "ledger-row__actions",
      role: "group",
      "aria-label": t("a11y.rowActions")
    }, [
      iconButton("⧉", "ledger.action.copy", function () { copyEntry(entry); }),
      iconButton("×", "ledger.action.delete", function () { deleteEntry(entry); })
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

  /* --------------------------------------------------------- the entry row */

  /* The four fields every entry needs, in the order a hand fills them. Values
     come from the draft that survived the last redraw, then from the last
     thing saved, then from today. */
  function entryFieldSpecs(seed, opts) {
    var options = entryCategoryOptions();
    var chosen = knownCategory(seed.categoryId) ? seed.categoryId : firstCategoryId();

    return [
      {
        name: "date",
        type: "date",
        labelKey: "form.date",
        required: true,
        value: seed.date || ""
      },
      {
        name: "amount",
        type: "money",
        labelKey: "form.amount",
        hintKey: "form.amount.hint",
        required: true,
        currency: currency(),
        value: seed.amount === null || seed.amount === undefined ? "" : seed.amount
      },
      {
        name: "categoryId",
        type: "select",
        /* No `required`: ui.js answers a required <select> with an empty first
           option, and an empty option on a list of categories is a value the
           reader can actually pick and then be told off for. A select always
           has a value, so the flag buys nothing and costs a trap. */
        labelKey: "form.category",
        value: chosen,
        options: options,
        /* The direction and the fixed mark follow the category until the reader
           overrules them, and they do it visibly: the sheet is folded, so the
           only honest thing is to keep what is inside it true. */
        onChange: function (value) {
          opts.onCategory(value);
        }
      },
      {
        name: "note",
        type: "text",
        labelKey: "form.note",
        hintKey: "form.note.hint",
        params: { max: NOTE_MAX },
        maxLength: NOTE_MAX,
        value: seed.note === null || seed.note === undefined ? "" : seed.note
      }
    ];
  }

  /* moon.css clips every .field__label inside an unlabelled quickRow — right
     for the one-line entry row, wrong for the sheet below it, where a bare
     select and a bare checkbox would have nothing next to them. The real
     <label for> stays where it is and keeps carrying the accessible name; this
     is the same words again, for the eye only, so a screen reader is not told
     twice. The one inline style is vertical centring against the sheet's
     `align-items: stretch`, and css/moon.css belongs to another agent. */
  function caption(labelKey) {
    var node = dom.el("span", {
      "class": "sm dim",
      "aria-hidden": "true",
      text: t(labelKey)
    });
    if (node.style && typeof node.style.setProperty === "function") {
      node.style.setProperty("align-self", "center");
    }
    return node;
  }

  /* One quiet toggle away: the two flags, plus — on an open row — where that
     row came from. Nothing in here is needed to write an entry, which is
     exactly why it is in here (sadeleştirme, "Neyi gizliyoruz"). */
  function moreFieldSpecs(seed, opts) {
    return [
      caption("form.direction"),
      {
        name: "direction",
        type: "select",
        labelKey: "form.direction",
        value: seed.direction === "in" ? "in" : "out",
        options: [
          { value: "out", labelKey: "form.direction.out" },
          { value: "in", labelKey: "form.direction.in" }
        ],
        onChange: function () { opts.touch.direction = true; }
      },
      caption("form.fixed"),
      {
        name: "fixed",
        type: "switch",
        labelKey: "form.fixed",
        value: !!seed.fixed,
        onChange: function () { opts.touch.fixed = true; }
      }
    ];
  }

  function writeSelect(api, name, value) {
    var entry = api && api.fields ? api.fields[name] : null;
    if (!entry || !entry.control) return;
    entry.control.value = String(value);
  }

  function writeSwitch(api, name, value) {
    var entry = api && api.fields ? api.fields[name] : null;
    if (!entry || !entry.control) return;
    entry.control.checked = !!value;
  }

  /* Everything a draft needs, and every reason it cannot be written. The money
     field's own parse failure never arrives here — quickRow catches that one
     before onSubmit — so a reading that is present but negative or zero is a
     real mistake with a sentence of its own (E1). */
  function buildDraft(values, touch, base) {
    var errors = {};

    var dir = touch.direction
      ? (values.direction === "in" ? "in" : "out")
      : directionForCategory(values.categoryId);

    var minor = values.amount;
    if (minor === null || minor === undefined) errors.amount = "err.required";
    else if (minor < 0) errors.amount = "err.negativeAmount";
    else if (minor === 0) errors.amount = "err.zeroAmount";

    if (!values.date) errors.date = "err.required";

    var draft = {
      date: values.date,
      /* The schema keeps the amount positive and puts the direction in its own
         field, so what is stored is the magnitude (E1). */
      amount: typeof minor === "number" ? Math.abs(minor) : 0,
      direction: dir,
      categoryId: values.categoryId,
      note: values.note,
      source: base ? base.source : "manual",
      confirmed: base ? base.confirmed !== false : true
    };

    /* The fixed mark is only STATED when the reader set it by hand. Left out,
       Moon.Model owns it: a new record inherits the category's answer, and an
       updated one can tell an inherited mark (which follows the record to its
       new category) from one set on the record itself (which is kept). Sending
       the switch's value every time would overrule that and leave a row moved
       into Rent counting as variable spending. */
    if (touch.fixed) draft.fixed = !!values.fixed;

    var Model = Moon.Model;
    if (Model && typeof Model.validateEntry === "function") {
      var check = Model.validateEntry(draft) || { errors: {} };
      Object.keys(check.errors || {}).forEach(function (name) {
        /* Our own reading of the amount is more precise than "must be
           positive", so it is never overwritten. */
        if (!errors[name]) errors[name] = check.errors[name];
      });
    }

    return { draft: draft, errors: errors };
  }

  function seedFromDraft(draft, fallback) {
    if (!draft) return fallback;
    var seed = {
      date: draft.date,
      amount: draft.amount,
      categoryId: draft.categoryId,
      note: draft.note,
      direction: draft.direction,
      fixed: draft.fixed
    };
    if (!seed.date) seed.date = fallback.date;
    if (!knownCategory(seed.categoryId)) seed.categoryId = fallback.categoryId;
    return seed;
  }

  /* --------------------------------------------------------- head quickRow */

  function quickSeed() {
    var fallback = {
      date: lastUsed.date || today() || "",
      amount: "",
      categoryId: knownCategory(lastUsed.categoryId) ? lastUsed.categoryId : firstCategoryId(),
      note: "",
      direction: null,
      fixed: null
    };
    var seed = seedFromDraft(quickDraft, fallback);
    /* Whatever the sheet is not told by hand, the category says. */
    if (!quickTouch.direction) seed.direction = directionForCategory(seed.categoryId);
    if (!quickTouch.fixed) seed.fixed = fixedForCategory(seed.categoryId);
    return seed;
  }

  function buildQuickRow() {
    var UI = Moon.UI;
    if (!UI || typeof UI.quickRow !== "function") return null;

    var seed = quickSeed();
    var opts = {
      touch: quickTouch,
      onCategory: function (value) {
        if (!quickTouch.direction) writeSelect(quickApi, "direction", directionForCategory(value));
        if (!quickTouch.fixed) writeSwitch(quickApi, "fixed", fixedForCategory(value));
      }
    };

    quickApi = UI.quickRow({
      "class": "quickrow--ledger",
      memoryKey: QUICK_MEMORY,
      fields: entryFieldSpecs(seed, opts),
      moreFields: moreFieldSpecs(seed, opts),
      moreLabelKey: "common.more",
      submitLabelKey: "ledger.form.submit",
      /* What makes a run of entries cheap: the day and the category stay, the
         amount and the note empty, and the caret lands back on the amount. */
      keepOnSubmit: ["date", "categoryId"],
      onSubmit: function (values) {
        var Model = Moon.Model;
        if (!Model || typeof Model.addEntry !== "function") return { ok: false, errors: {} };

        var read = buildDraft(values, quickTouch, null);
        if (Object.keys(read.errors).length) return { ok: false, errors: read.errors };

        var id = Model.addEntry(read.draft);
        if (!id) return { ok: false, errors: { amount: "err.unknown" } };

        lastUsed.date = read.draft.date;
        lastUsed.categoryId = read.draft.categoryId;
        /* A saved row ends the override: the next entry's direction and mark
           come from whichever category it lands in. */
        quickTouch.direction = false;
        quickTouch.fixed = false;
        flash = { messageKey: "ledger.saved" };
        return { ok: true };
      }
    });

    if (quickDraft && quickDraft["@more"] && typeof quickApi.setMoreOpen === "function") {
      quickApi.setMoreOpen(true);
    }
    return quickApi;
  }

  /* ------------------------------------------------------- the edited row */

  /* Where the row came from, when it was written, and what its margin mark
     means. Read-only, inside the open row's own sheet: sadeleştirme puts the
     provenance of a row exactly one toggle away from the row. */
  function detailNode(entry, overSet) {
    var list = dom.el("dl", { "class": "sm dim" });
    var rows = 0;

    function add(labelKey, text) {
      if (!text || !has(labelKey)) return;
      list.appendChild(dom.el("dt", null, t(labelKey)));
      list.appendChild(dom.el("dd", null, text));
      rows += 1;
    }

    var sourceKey = SOURCE_KEYS[entry.source] || SOURCE_KEYS.manual;
    add("ledger.filter.source", has(sourceKey) ? t(sourceKey) : "");

    /* entry.createdAt is an INSTANT (…T21:14:03.000Z), not a civil date, so
       reading it with Date is the correct thing and not the §0.6 trap: the
       trap is "2026-03-01", a civil day that Date reads as UTC midnight. */
    add("ledger.detail.created", stamp(entry.createdAt));

    var kind = markKindFor(entry, overSet);
    var markKey = kind ? MARK_KEYS[kind] : null;
    add("ledger.detail.mark", markKey && has(markKey) ? t(markKey) : "");

    var wrap = dom.el("div", { "class": "ledger-detail" });
    if (rows) wrap.appendChild(list);

    /* The one mark whose meaning the catalogue already carries as a finished
       sentence, so it is said in full rather than filed under a label. */
    if (kind === "unconfirmed" && has("ledger.unconfirmed.note")) {
      wrap.appendChild(dom.el("p", { "class": "sm dim", text: t("ledger.unconfirmed.note") }));
    }
    if (has("ledger.form.fixedHint")) {
      wrap.appendChild(dom.el("p", { "class": "sm dim", text: t("ledger.form.fixedHint") }));
    }

    if (!wrap.childNodes.length) return null;
    /* .quickrow__extra is a wrapping flex row and this block is prose, not a
       field: it takes the whole next line instead of squeezing in beside the
       two switches. Set here because css/moon.css belongs to another agent and
       this is a layout fact about a node only this file creates. */
    if (wrap.style && typeof wrap.style.setProperty === "function") {
      wrap.style.setProperty("flex", "1 1 100%");
    }
    return wrap;
  }

  function two(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function stamp(iso) {
    if (!iso) return "";
    var when = new global.Date(iso);
    if (!when || isNaN(when.getTime())) return "";
    try {
      return new global.Intl.DateTimeFormat(lang(), {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(when);
    } catch (error) {
      /* No Intl, or a locale it refuses: the civil day alone still answers
         "when was this written" well enough to be worth printing. The civil
         string is built from the LOCAL parts, never from toISOString. */
      var Dates = Moon.Dates;
      if (!Dates || typeof Dates.formatDate !== "function") return "";
      var civil = when.getFullYear() + "-" + two(when.getMonth() + 1) + "-" + two(when.getDate());
      return Dates.formatDate(civil, lang(), "long");
    }
  }

  /* The arrows inside an open row move between that row's own fields and never
     reach the list — the roving list only ever answers keys aimed at the row
     element itself, and this handler makes the inside of the row navigable in
     the same axis. A <select> is left alone on purpose: there ArrowUp and
     ArrowDown are how you pick an option, and taking that away to gain a
     second way of moving between four fields would be a bad trade. */
  function editStops() {
    if (!editApi) return [];
    return dom.qsa("input, select, textarea, button", editApi.element).filter(onScreen);
  }

  function onEditKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    var target = event.target;
    if (!target) return;
    if (String(target.tagName || "").toUpperCase() === "SELECT") return;

    var stops = editStops();
    var at = stops.indexOf(target);
    if (at === -1) return;

    event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();

    var next = at + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0) next = stops.length - 1;
    if (next > stops.length - 1) next = 0;
    focusControl(stops[next], null);
  }

  /* The row, in place, as the same quickRow. The wrapper keeps [data-row] so
     the roving list's row count does not shift under the reader while one row
     is open, and so Escape has somewhere to put the focus back. */
  function editRowNode(entry, overSet) {
    var UI = Moon.UI;
    if (!UI || typeof UI.quickRow !== "function") return null;

    var fallback = {
      date: entry.date,
      amount: entry.amount,
      categoryId: entry.categoryId,
      note: entry.note || "",
      direction: directionOf(entry),
      fixed: !!entry.fixed
    };
    /* Nothing is derived here: an open row starts from what is STORED, and the
       category only moves the direction forward from there, through onCategory
       below. Deriving on every redraw would quietly rewrite a row whose fixed
       mark was set by hand against its category — the one case where guessing
       loses data instead of saving a keystroke. */
    var seed = seedFromDraft(editDraft, fallback);

    var opts = {
      touch: editTouch,
      onCategory: function (value) {
        if (!editTouch.direction) writeSelect(editApi, "direction", directionForCategory(value));
        /* The fixed mark is NOT moved here. On an open row the switch shows
           what is stored, and an untouched mark is left to Moon.Model, which
           can tell an inherited one from one set by hand; guessing in the
           switch would only make the row say something the save will not do. */
      }
    };

    var extra = moreFieldSpecs(seed, opts);
    var detail = detailNode(entry, overSet);
    if (detail) extra.push(detail);

    editApi = UI.quickRow({
      "class": "quickrow--edit",
      memoryKey: EDIT_MEMORY,
      fields: entryFieldSpecs(seed, opts),
      moreFields: extra,
      moreLabelKey: "common.details",
      submitLabelKey: "ledger.form.submit.edit",
      onSubmit: function (values) {
        var Model = Moon.Model;
        if (!Model || typeof Model.updateEntry !== "function") return { ok: false, errors: {} };

        var read = buildDraft(values, editTouch, entry);
        if (Object.keys(read.errors).length) return { ok: false, errors: read.errors };

        var ok = Model.updateEntry(entry.id, read.draft);
        if (!ok) return { ok: false, errors: { amount: "err.unknown" } };

        lastUsed.date = read.draft.date;
        lastUsed.categoryId = read.draft.categoryId;
        flash = { messageKey: "ledger.saved" };
        /* Closed here and now, inside onSubmit: quickRow will clear its fields
           after this returns, and clearing a row the reader is still looking at
           would blink. By the time that runs the form is off the page and the
           focus is already back on the saved row. */
        closeEdit(entry.id);
        return { ok: true };
      },
      onCancel: function () {
        closeEdit(entry.id);
      }
    });

    if (editDraft && editDraft["@more"] && typeof editApi.setMoreOpen === "function") {
      editApi.setMoreOpen(true);
    }

    editApi.element.addEventListener("keydown", onEditKey, false);

    /* Esc gives up, and quickRow already wires it — but a thumb has no Esc
       key, so the one way out of an open row cannot be a keystroke only. */
    var give = dom.el("button", {
      "class": "btn is-quiet quickrow__cancel",
      type: "button",
      text: t("common.cancel")
    });
    give.addEventListener("click", function () { closeEdit(entry.id); });
    var strip = dom.qs(".quickrow__fields", editApi.element);
    if (strip) strip.appendChild(give);

    var wrap = dom.el("div", {
      "class": "ledger-edit",
      tabindex: "-1",
      dataset: { row: "1", id: entry.id }
    }, editApi.element);
    return wrap;
  }

  function openEdit(id) {
    if (!id || editingId === id) return;
    editingId = id;
    editDraft = null;
    editApi = null;
    editTouch.direction = false;
    editTouch.fixed = false;
    refreshList();
    if (editApi && typeof editApi.focusFirst === "function") {
      /* The amount is what a reader almost always came to change, but the row
         reads left to right and the date is the first field; focusFirst keeps
         the two in agreement. */
      editApi.focusFirst();
    }
  }

  function closeEdit(focusId) {
    if (!editingId) return;
    editingId = null;
    editDraft = null;
    editApi = null;
    editTouch.direction = false;
    editTouch.fixed = false;
    restore = focusId ? { scope: "row", id: focusId, part: "row", index: rowIndex } : restore;
    refreshList(true);
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

        if (entry.id === editingId) {
          var open = editRowNode(entry, overSet);
          if (open) {
            group.appendChild(open);
            return;
          }
          /* No quickRow to be had: the row still has to be readable. */
          editingId = null;
        }
        group.appendChild(rowNode(entry, { guide: guide, overSet: overSet }));
      });

      frag.appendChild(group);
    });

    return frag;
  }

  /* ------------------------------------------------------ row keyboard map

     Moon.UI.rovingList owns the vertical axis (ArrowUp/Down/Home/End, Enter to
     edit, Delete to remove) and only ever fires while the focus sits on the row
     element itself. Everything a row holds is out of the tab order, so this
     handler owns the rest of the contract:

       Space        toggle this row's selection
       Enter        open this row for editing, in place
       Delete       delete it and leave the undo strip
       ArrowRight   step into the action strip (copy / delete)
       ArrowLeft    back out of the strip, or move inside it
       Home / End   first / last action
       Escape       back to the row
       ArrowUp/Down leave the strip and keep moving through the list

     The strip is display:none in the flat list, on a phone and on paper, and a
     hidden button is not a keyboard target — there the arrow simply does
     nothing and Enter/Delete still carry the two real actions. */

  function onScreen(node) {
    if (!node) return false;
    if (node.offsetParent === null) return false;
    return true;
  }

  function rowActions(row) {
    return dom.qsa(".ledger-row__action", row).filter(onScreen);
  }

  function allRows() {
    return listHost ? dom.qsa("[data-row]", listHost) : [];
  }

  function focusRow(row) {
    if (row && typeof row.focus === "function") row.focus();
  }

  function toggleSelection(row) {
    var id = row && row.dataset ? row.dataset.id : null;
    if (!id) return;
    if (selected[id]) delete selected[id];
    else selected[id] = true;
    refreshList();
  }

  function leaveStrip(row, delta) {
    var rows = allRows();
    var index = rows.indexOf(row);
    if (!delta || index === -1 || !roving || typeof roving.focus !== "function") {
      focusRow(row);
      return;
    }
    roving.focus(index + delta);
  }

  function onActionKey(event, row, action) {
    var items = rowActions(row);
    var at = items.indexOf(action);
    if (at === -1) return;

    switch (event.key) {
      case "ArrowRight":
        items[Math.min(at + 1, items.length - 1)].focus();
        break;
      case "ArrowLeft":
        if (at === 0) leaveStrip(row, 0);
        else items[at - 1].focus();
        break;
      case "Home":
        items[0].focus();
        break;
      case "End":
        items[items.length - 1].focus();
        break;
      case "Escape":
        leaveStrip(row, 0);
        break;
      case "ArrowUp":
        leaveStrip(row, -1);
        break;
      case "ArrowDown":
        leaveStrip(row, 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  function onLedgerKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;

    var row = target.closest("[data-row]");
    if (!row) return;

    var action = target.closest(".ledger-row__action");
    if (action) {
      onActionKey(event, row, action);
      return;
    }

    /* A control the pointer put the focus into owns its own keys — including
       every field of the row that is currently open for editing. */
    if (target !== row) return;

    /* " " on a modern browser, "Spacebar" on the ones that never updated. */
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      toggleSelection(row);
      return;
    }

    if (event.key === "ArrowRight") {
      var items = rowActions(row);
      if (!items.length) return;
      event.preventDefault();
      items[0].focus();
    }
  }

  function onLedgerClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    /* The action strip and the selection box speak for themselves. */
    if (target.closest(".ledger-row__action")) return;
    if (target.closest(".ledger-row__pick")) return;
    /* .ledger-row, not [data-row]: the open editor's wrapper carries the same
       data attribute and a click inside it must not reopen it. */
    var row = target.closest(".ledger-row");
    if (!row || !row.dataset || !row.dataset.id) return;
    openEdit(row.dataset.id);
  }

  /* One line of text, once, above the list — the keys are worth nothing if
     nobody is told about them. Printed only when the catalogue carries the
     sentence, so a key this agent asked for but has not been handed yet shows
     up as nothing rather than as its own name. */
  function keyHint() {
    if (!has("ledger.keys")) return null;
    return dom.el("p", { "class": "sm dim", text: t("ledger.keys") });
  }

  /* ---------------------------------------------------------------- notices */

  function drawNotices(period) {
    if (!noticeHost) return;
    dom.clear(noticeHost);
    var UI = Moon.UI;
    if (!UI || typeof UI.notice !== "function") return;

    if (flash) {
      noticeHost.appendChild(UI.notice({
        kind: "info",
        messageKey: flash.messageKey,
        params: flash.params,
        dismissible: true,
        dismissKey: "common.close"
      }));
      flash = null;
    }

    /* Rows that came in from a statement and nobody has looked at yet. The
       band counts them for the whole period, not for the filtered view. */
    var waiting = allEntries(period).filter(function (entry) {
      return entry.confirmed === false;
    });
    if (!waiting.length) return;

    var ids = waiting.map(function (entry) { return entry.id; });
    noticeHost.appendChild(UI.notice({
      kind: "warn",
      messageKey: "ledger.unconfirmedCount",
      params: { count: waiting.length },
      body: t("ledger.unconfirmed.note"),
      actions: [{
        labelKey: "ledger.confirmAll",
        kind: "primary",
        onClick: function () { confirmAll(ids); }
      }]
    }));
  }

  function bulkBar() {
    var ids = selectedIds();
    if (!ids.length) return null;
    var UI = Moon.UI;
    if (!UI || typeof UI.notice !== "function") return null;

    /* The class names ui.js already prints (.notice__text, .btn.is-row,
       .empty__heading) are the ones moon.css styles, so nothing here renames
       them: a view that rewrote another agent's class names would only be
       guessing at a stylesheet it does not own. */
    return UI.notice({
      kind: "info",
      "class": "is-info",
      messageKey: "ledger.count",
      params: { count: ids.length },
      actions: [
        {
          labelKey: "common.delete",
          kind: "danger",
          "class": "is-danger",
          onClick: function () { deleteMany(ids); }
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
    });
  }

  /* ---------------------------------------------------------------- filters */

  function filterBar() {
    var UI = Moon.UI;
    var bar = dom.el("div", { "class": "filters" });
    if (!UI || typeof UI.field !== "function") return bar;

    /* No "write an entry" button any more: the entry row is always open, one
       line below this bar, and a button that scrolls to a visible form is a
       button that does nothing. */

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
    return UI.emptyState({
      headingKey: "empty.ledger.filtered.heading",
      bodyKey: "empty.ledger.filtered.body",
      actions: filtersActive()
        ? [{ labelKey: "ledger.filter.clear", onClick: clearFilters }]
        : null
    });
  }

  /* The first page of the notebook (G9): the rules are printed, the lines are
     simply empty, and the three ways in are real rows, not a button row. The
     first of the three is now "the line above this one is already waiting",
     so it moves the caret there instead of opening anything. */
  function emptyLedger() {
    var UI = Moon.UI;
    if (!UI || typeof UI.emptyState !== "function") return dom.el("div");
    return UI.emptyState({
      ghost: true,
      columns: 3,
      headingKey: "empty.ledger.heading",
      bodyKey: "empty.ledger.body",
      footKey: "empty.ledger.footer",
      actions: [
        {
          labelKey: "empty.ledger.action1",
          onClick: function () {
            if (quickApi && typeof quickApi.focusFirst === "function") quickApi.focusFirst();
          }
        },
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
  }

  /* Rebuilds the list without touching the filter bar or the entry row, so the
     caret stays where the reader put it while the rows underneath change. */
  function refreshList(snapshotted) {
    if (!listHost) return;
    if (!snapshotted) snapshot();

    var period = currentPeriod();
    var rows = filteredEntries(period);
    var total = allEntries(period).length;

    /* A selection only means anything for rows the reader can see. */
    var onView = Object.create(null);
    rows.forEach(function (entry) { onView[entry.id] = true; });
    Object.keys(selected).forEach(function (id) {
      if (!onView[id]) delete selected[id];
    });
    /* A row the filter just hid cannot stay open for editing. */
    if (editingId && !onView[editingId]) {
      editingId = null;
      editApi = null;
      editDraft = null;
    }

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

    editApi = null;
    dom.clear(listHost);
    drawNotices(period);

    var bulk = bulkBar();
    if (bulk) listHost.appendChild(bulk);

    if (!rows.length) {
      listHost.appendChild(ledgerIsEmpty() ? emptyLedger() : emptyFiltered());
      if (roving && typeof roving.destroy === "function") roving.destroy();
      roving = null;
      applyRestore();
      return;
    }

    var classes = ["ledger"];
    if (dense) classes.push("is-dense");
    if (flat) classes.push("is-flat");

    var hint = keyHint();
    if (hint) listHost.appendChild(hint);

    var ledger = dom.el("div", { "class": classes.join(" ") });
    ledger.appendChild(dayGroups(rows, flat, overCategories(period)));
    /* The node is thrown away on every redraw, so the listeners go with it. */
    ledger.addEventListener("keydown", onLedgerKey, false);
    ledger.addEventListener("click", onLedgerClick, false);
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
            if (row && row.dataset) openEdit(row.dataset.id);
          },
          onDelete: function (index, row) {
            var entry = row && row.dataset ? entryById(row.dataset.id) : null;
            if (entry) deleteEntry(entry);
          }
        })
      : null;

    applyRestore();
  }

  /* ------------------------------------------------------------ mutations */

  function undo(message, restoreFn) {
    var UI = Moon.UI;
    if (!UI || typeof UI.undoStrip !== "function") return;
    UI.undoStrip({
      message: message,
      seconds: UNDO_SECONDS,
      dismissKey: "common.close",
      onUndo: restoreFn
    });
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

  /* No question asked. Deleting already leaves an eight-second undo strip
     (G12), and asking first and then offering undo is asking the same question
     twice — sadeleştirme §3 drops the first one. */
  function deleteEntry(entry) {
    var Model = Moon.Model;
    if (!Model || typeof Model.removeEntry !== "function") return;
    /* removeEntry hands the record back — that is the undo payload. */
    var removed = Model.removeEntry(entry.id);
    if (!removed) return;
    delete selected[entry.id];
    if (editingId === entry.id) {
      editingId = null;
      editApi = null;
      editDraft = null;
    }
    undo(
      sentences(t("ledger.deleted"), t("ledger.undo.hint", { seconds: UNDO_SECONDS })),
      function () { restoreEntries([removed]); }
    );
    draw();
  }

  function deleteMany(ids) {
    var Model = Moon.Model;
    if (!Model || typeof Model.removeEntries !== "function") return;
    var removed = Model.removeEntries(ids) || [];
    if (!removed.length) return;
    selected = Object.create(null);
    if (editingId && ids.indexOf(editingId) !== -1) {
      editingId = null;
      editApi = null;
      editDraft = null;
    }
    undo(
      sentences(
        t("ledger.deletedMany", { count: removed.length }),
        t("ledger.undo.hint", { seconds: UNDO_SECONDS })
      ),
      function () { restoreEntries(removed); }
    );
    draw();
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

  /* ----------------------------------------------------------- lifecycle */

  function draw() {
    if (!host) return;
    snapshot();

    quickApi = null;
    editApi = null;
    dom.clear(host);

    noticeHost = dom.el("div", { "class": "ledger__notices" });
    quickHost = dom.el("div", { "class": "ledger__entry" });
    listHost = dom.el("div", { "class": "ledger__list" });
    asideNode = dom.el("span", { "class": "section__aside num" });

    var quick = buildQuickRow();
    if (quick) quickHost.appendChild(quick.element);

    var UI = Moon.UI;
    /* The filter bar is sticky and the entry row is NOT: on a phone the entry
       row grows to four lines and a sticky one would eat the screen, and two
       sticky bands would cover each other (sadeleştirme §8). */
    var body = [noticeHost, filterBar(), quickHost, listHost];

    var node = UI && typeof UI.section === "function"
      ? UI.section({
          id: "ledger",
          titleKey: "ledger.title",
          aside: asideNode,
          body: body
        })
      : dom.el("section", null, body);

    host.appendChild(node);
    refreshList(true);
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
      quickHost = null;
      noticeHost = null;
      asideNode = null;
      quickApi = null;
      editApi = null;
      editingId = null;
      quickDraft = null;
      editDraft = null;
      restore = null;
      host = null;
    }
  };
})(window);
