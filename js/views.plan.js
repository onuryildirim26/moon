/* Moon — plan views: recurring payments, goals, debts
 * (contract §13, addendum E5/E6/E10, sadeleştirme §5).
 *
 * Three sections in one file because they share one shape: a list of standing
 * records, a quick row above it that writes a new one, and the SAME quick row
 * opening under a record when the reader asks to change it. Sadeleştirme §5
 * removed the dialog from all three: there is no UI.dialog and no UI.confirm
 * left in this file, because nothing here destroys data irrecoverably — a
 * delete leaves an eight-second undo band and that band is the question.
 *
 * Five facts govern everything below:
 *
 *   - Nothing here writes. Reads come from Moon.Store.state (never mutated) and
 *     from Moon.Model; every change goes through a Moon.Model call.
 *   - render() runs again on state:change and lang:change, so it rebuilds from
 *     scratch and keeps no DOM across runs. Three things must therefore survive
 *     a rebuild, and all three are parked at module level: the short sentence an
 *     action leaves behind, WHICH record is being edited, and where the caret
 *     belongs. A rebuild detaches the focused control, so "focus this once"
 *     would be spent by the first of the two redraws one click can cause and the
 *     second would drop the caret on the floor. The focus intent is re-applied
 *     on every redraw instead, and only while the reader is not holding focus
 *     somewhere else by hand.
 *   - keepOnSubmit holds the sticky fields of a quick row WITHIN one render, and
 *     a save always brings a render. So the same values are remembered here too:
 *     entering a run of records has to keep the category and the direction
 *     across the redraw the first record caused, or the second record starts
 *     from the top again.
 *   - Recurring payments are never written on their own (E6). The pending band
 *     counts what is due and waits for the button.
 *   - Moon.Model names its validation failures in its own vocabulary, which is
 *     NOT the catalogue's (err.nameRequired vs err.required). Everything it
 *     returns is translated through errKey() before it can reach a screen.
 *
 * Goals and debts are deliberately outside the allowance and limit arithmetic,
 * and both sections say so in a standing sentence rather than in a footnote:
 * a reader who does not know that reads every other number on the panel wrong.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;
  Moon.Views = Moon.Views || {};

  var dom = Moon.dom;
  var util = Moon.util;

  /* How many periods ahead the "next occurrence" scan may walk before giving
     up. A rule whose start date is a year out is not worth a longer search. */
  var LOOKAHEAD = 14;

  /* ------------------------------------------------------------ primitives */

  function t(key, params) {
    var I18n = Moon.I18n;
    if (key === null || key === undefined || key === "") return "";
    if (I18n && typeof I18n.t === "function") {
      try {
        return I18n.t(key, params);
      } catch (error) {
        /* A broken catalogue must not blank a whole section. */
      }
    }
    return String(key);
  }

  function has(key) {
    var I18n = Moon.I18n;
    if (!key || !I18n || typeof I18n.has !== "function") return false;
    try {
      return !!I18n.has(key);
    } catch (error) {
      return false;
    }
  }

  /* The first key the catalogue actually carries. A label this file asks for
     but lang.*.js has not grown yet must never reach the screen as its own
     name, so every new label names the key it wants and an existing key
     behind it; when the catalogue grows, the wanted key wins by itself. */
  function keyOf(wanted, fallback) {
    return has(wanted) ? wanted : fallback;
  }

  function lang() {
    return Moon.I18n && Moon.I18n.lang ? Moon.I18n.lang : "tr";
  }

  function stateOf() {
    return Moon.Store && Moon.Store.state ? Moon.Store.state : null;
  }

  function settings() {
    var st = stateOf();
    return st && st.settings ? st.settings : {};
  }

  function currencyCode() {
    return settings().currency || "TRY";
  }

  function intOf(value) {
    var n = typeof value === "number" ? value : Number(value);
    return isFinite(n) ? Math.round(n) : 0;
  }

  function monthStartDay() {
    var day = intOf(settings().monthStartDay);
    return day >= 1 && day <= 28 ? day : 1;
  }

  /* A copy, so a sort in a view can never reorder the stored array. */
  function records(name) {
    var st = stateOf();
    var rows = st ? st[name] : null;
    return Array.isArray(rows) ? rows.slice() : [];
  }

  function today() {
    var Dates = Moon.Dates;
    var value = Dates && Dates.today ? Dates.today() : null;
    return value || null;
  }

  /* The active period belongs to app.js; a view reads it and never sets it. */
  function periodOf() {
    if (Moon.App && Moon.App.period) return Moon.App.period;
    var Dates = Moon.Dates;
    if (!Dates || !Dates.periodKey) return null;
    return Dates.periodKey(today(), monthStartDay()) || null;
  }

  function fmtMoney(minor) {
    var Money = Moon.Money;
    if (Money && Money.format) {
      try {
        var text = Money.format(intOf(minor), {
          currency: currencyCode(),
          lang: lang(),
          symbol: true
        });
        if (text) return text;
      } catch (error) { /* fall through to the raw integer */ }
    }
    return String(intOf(minor));
  }

  function fmtDate(date, style) {
    var Dates = Moon.Dates;
    if (!date) return "";
    if (Dates && Dates.formatDate) {
      try {
        var text = Dates.formatDate(date, lang(), style || "short");
        if (text) return text;
      } catch (error) { /* fall through to the civil string */ }
    }
    return String(date);
  }

  /* The percent sign is inside the sentence, in both languages (%72 / 72%). */
  function pctText(value) {
    var n = typeof value === "number" && isFinite(value) ? Math.round(value) : 0;
    return t("limits.pct", { pct: n });
  }

  function daysFrom(a, b) {
    var Dates = Moon.Dates;
    if (!Dates || !Dates.daysBetween || !a || !b) return null;
    var n = Dates.daysBetween(a, b);
    return typeof n === "number" ? n : null;
  }

  function nameOf(record) {
    var name = record && record.name ? String(record.name).trim() : "";
    return name || t("common.unclassified");
  }

  function personOf(debt) {
    var name = debt && debt.person ? String(debt.person).trim() : "";
    return name || t("common.unclassified");
  }

  function categoriesOf(kind) {
    if (!Moon.Model || !Moon.Model.categories) return [];
    var rows = Moon.Model.categories(kind ? { kind: kind } : null);
    return Array.isArray(rows) ? rows : [];
  }

  function categoryLabel(id) {
    if (Moon.Model && Moon.Model.categoryName) return Moon.Model.categoryName(id);
    return t("common.unclassified");
  }

  /* ---------------------------------------------------------------- errors */

  /* Moon.Model answers validate*() with its own error vocabulary and the
     catalogue carries the same sentences under different names, so a key
     handed straight to a field would print as "err.nameRequired" on screen.
     One table, read through I18n.has, so a name the catalogue grows later is
     used as given and the fallback stops applying by itself. */
  var MODEL_ERROR = {
    "err.nameRequired": "err.required",
    "err.personRequired": "err.required",
    "err.categoryRequired": "err.required",
    "err.dateRequired": "err.required",
    "err.amountPositive": "err.zeroAmount",
    "err.categoryUnknown": "err.badCategory",
    "err.categoryKind": "err.badDirection",
    "err.directionInvalid": "err.badDirection",
    "err.dayOfMonthRange": "err.badDayOfMonth",
    "err.dateInvalid": "err.badDate",
    "err.dateOrder": "err.badRange"
  };

  function errKey(key) {
    if (!key) return null;
    if (has(key)) return key;
    var mapped = MODEL_ERROR[key];
    if (mapped && has(mapped)) return mapped;
    return "err.unknown";
  }

  /* First sentence wins: the field-level reading of a value is more specific
     than the model's, and both can fire on the same field. */
  function mergeErrors(target, source) {
    Object.keys(source || {}).forEach(function (name) {
      if (Object.prototype.hasOwnProperty.call(target, name)) return;
      target[name] = errKey(source[name]);
    });
    return target;
  }

  /* Moon.Money.parse is SIGNED (E1) while the schema keeps amounts positive,
     so a minus sign gets its own sentence rather than a blunt "bad amount".
     quickRow has already refused anything that does not parse before this
     runs, which is why null here can only mean an empty box. */
  function amountProblem(value, zeroKey) {
    if (value === null || value === undefined) return "err.required";
    if (value < 0) return "err.negativeAmount";
    if (value === 0) return zeroKey || "err.zeroAmount";
    return null;
  }

  /* ------------------------------------------------------------------- dom */

  function line(text, className) {
    return dom.el("p", { "class": className || null }, text);
  }

  function btn(spec) {
    var classes = ["btn"];
    if (spec.variant) classes.push(spec.variant);
    var attrs = { "class": classes.join(" "), type: "button" };
    if (spec.pressed !== undefined) attrs["aria-pressed"] = spec.pressed ? "true" : "false";
    var node = dom.el("button", attrs, t(spec.labelKey, spec.params));
    if (typeof spec.onClick === "function") node.addEventListener("click", spec.onClick);
    return node;
  }

  function actionRow(children) {
    return dom.el("div", { "class": "form__actions" }, children);
  }

  function th(labelKey, numeric) {
    return dom.el("th", {
      scope: "col",
      "class": numeric ? "is-num" : null
    }, t(labelKey));
  }

  function td(children, numeric) {
    return dom.el("td", { "class": numeric ? "is-num" : null }, children);
  }

  function rowHead(children) {
    return dom.el("th", { scope: "row" }, children);
  }

  /* A click that landed on a control belongs to that control, so the row only
     opens for the gaps between them. The pointer gets the whole row as a
     convenience; the keyboard path is the name button inside it, never this. */
  var INTERACTIVE = "a, button, input, select, textarea, label, summary, .inlinevalue";

  function bindRowOpen(tr, onOpen) {
    tr.addEventListener("click", function (event) {
      var node = event.target;
      if (node && typeof node.closest === "function" && node.closest(INTERACTIVE)) return;
      onOpen();
    });
  }

  /* .preview gives the table its own horizontal scroll, so a phone never has
     to squeeze six columns into 320px and the page itself never scrolls
     sideways. A row may arrive as a bare array of cells or as
     {cells, onOpen, attrs}. */
  function tableBlock(headCells, bodyRows) {
    var body = dom.el("tbody");
    (bodyRows || []).forEach(function (row) {
      if (!row) return;
      var cells = Array.isArray(row) ? row : row.cells;
      var tr = dom.el("tr", (!Array.isArray(row) && row.attrs) || null, cells);
      if (!Array.isArray(row) && typeof row.onOpen === "function") bindRowOpen(tr, row.onOpen);
      body.appendChild(tr);
    });
    return dom.el("div", { "class": "preview" }, dom.el("table", { "class": "table" }, [
      dom.el("thead", null, dom.el("tr", null, headCells)),
      body
    ]));
  }

  /* Moon.UI.dataTable already owns the print behaviour and the cell formatting;
     these two class names are what moon.css styles a "show the numbers" block
     with, so they are added on the way out. */
  function numbersBlock(columns, rows, opts) {
    var node = Moon.UI.dataTable(columns, rows, opts);
    if (node.classList) node.classList.add("numbers");
    var table = dom.qs("table", node);
    if (table && table.classList) table.classList.add("table");
    return node;
  }

  function amountCell(minor, className) {
    return Moon.UI.moneyCell(intOf(minor), { sign: false, "class": className || null });
  }

  /* --------------------------------------------- per-view state that lasts */

  var VIEWS = Object.create(null);
  var mounted = Object.create(null);
  var flashes = Object.create(null);

  /* Which record each section has open for editing, and the values its quick
     row carries over from the last save. Both have to outlive the redraw the
     save itself causes. */
  var editing = Object.create(null);
  var sticky = Object.create(null);

  /* Where the caret belongs after the next render: a key this render also
     publishes in its own `marks` table. See the header note on why it is not
     cleared when it is applied. */
  var intent = Object.create(null);

  /* `extra` is an optional second sentence, {key, params}: a promotion reports
     the rule it wrote and, separately, how many records left the allowance pool.
     Two catalogue sentences, so they are two lines and never concatenated. */
  function setFlash(id, key, params, kind, extra) {
    flashes[id] = key ? {
      key: key,
      params: params || null,
      kind: kind || "info",
      extra: extra && extra.key ? extra : null
    } : null;
  }

  /* Read without consuming. A written sentence outlives every redraw until the
     reader dismisses it, the next action replaces it, or the section is left —
     because the redraw this view cannot see is the one that would swallow it:
     app.js answers state:change on a timer, so a slot emptied on sight is empty
     again a tick later and the sentence never reaches the screen. */
  function flashNode(id) {
    var current = flashes[id];
    if (!current) return null;
    return Moon.UI.notice({
      kind: current.kind,
      "class": "is-" + current.kind,
      messageKey: current.key,
      params: current.params,
      body: current.extra
        ? line(t(current.extra.key, current.extra.params), "sm dim")
        : null,
      dismissible: true,
      dismissKey: "common.close",
      /* Dismissing removes the node; without this the next redraw brings the
         same sentence back and the close button reads as broken. */
      onDismiss: function () {
        if (flashes[id] === current) flashes[id] = null;
      }
    });
  }

  /* A redraw this view asks for itself, for the paths where nothing in the
     store changed (a refused call) and for the ones that must not wait for the
     router's timer. render() is idempotent, so an extra draw costs a rebuild
     and nothing else. */
  function repaint(id) {
    var view = VIEWS[id];
    var root = mounted[id];
    if (!view || !root) return;
    var doc = root.ownerDocument;
    if (doc && doc.contains && !doc.contains(root)) return;
    view.render(root);
  }

  /* After a save, the quick row that is still on screen finishes its own job
     (clear the written fields, put the caret back) before this view is allowed
     to tear it down and build the next one. A synchronous repaint from inside
     onSubmit would detach the row mid-submit. */
  function queueRepaint(id) {
    if (!global.setTimeout) {
      repaint(id);
      return;
    }
    global.setTimeout(function () {
      repaint(id);
    }, 0);
  }

  function report(id, key, params, kind, extra) {
    setFlash(id, key, params, kind, extra);
    repaint(id);
  }

  /* ------------------------------------------------------------- the caret */

  function wants(id, mark) {
    intent[id] = mark || null;
  }

  function focusNode(node) {
    if (!node || typeof node.focus !== "function") return false;
    try {
      node.focus();
    } catch (error) {
      return false;
    }
    return true;
  }

  /* The last thing every render does. The intent is NOT cleared here: one
     click can cause two redraws (the router's, on state:change, and this
     view's own), the first rebuild would spend it and the second would leave
     the caret on <body>. It is replaced when the reader does something else,
     and dropped when the section is left. A mark this render did not publish
     — an editor that has since closed, a row that was deleted — is simply
     not there, and nothing moves. */
  function applyIntent(id, root, marks) {
    var mark = intent[id];
    if (!mark || !root) return;
    var target = marks[mark];
    if (!target) return;
    /* A quickRow api, or a plain node. */
    if (typeof target.focusFirst === "function") target.focusFirst();
    else focusNode(target);
  }

  /* ------------------------------------------------------- sticky defaults */

  function stickyPick(id, name, fallback) {
    var box = sticky[id];
    if (!box || !Object.prototype.hasOwnProperty.call(box, name)) return fallback;
    var value = box[name];
    if (value === null || value === undefined || value === "") return fallback;
    return value;
  }

  function remember(id, values, names) {
    var box = sticky[id];
    if (!box) {
      box = Object.create(null);
      sticky[id] = box;
    }
    names.forEach(function (name) {
      box[name] = values[name];
    });
  }

  /* ---------------------------------------------------- opening and closing */

  function editorIdOf(id) {
    return "plan-" + id + "-editor";
  }

  function openEditor(id, recordId) {
    editing[id] = recordId || null;
    setFlash(id, null);
    wants(id, "edit");
    repaint(id);
  }

  function closeEditor(id, recordId) {
    editing[id] = null;
    wants(id, recordId ? "open:" + recordId : null);
    repaint(id);
  }

  /* remove* hands the record back (E5), so undo is a re-add of the same data.
     Sadeleştirme §3 took the confirmation away: the band IS the question, and
     asking twice for the same decision is what made this app tiring. */
  function removeWithUndo(spec) {
    var record = spec.remove();
    if (!record) {
      report(spec.id, "err.unknown", null, "error");
      return;
    }
    /* The undo band is this action's whole report, so the sentence left over
       from the previous one goes with the record. */
    setFlash(spec.id, null);
    editing[spec.id] = null;
    wants(spec.id, "add");
    repaint(spec.id);
    Moon.UI.undoStrip({
      messageKey: spec.bodyKey,
      dismissKey: "common.close",
      onUndo: function () {
        spec.restore(record);
        repaint(spec.id);
      }
    });
  }

  /* -------------------------------------------------------- the quick rows */

  /* The row that stands above a list and writes a new record. Enter in any
     field saves and the caret walks back to the first field that emptied, so
     entering a run of records is typing, not opening a run of dialogs. */
  function addRow(spec) {
    return Moon.UI.quickRow({
      labels: "visible",
      fields: spec.fields,
      moreFields: spec.moreFields,
      moreLabelKey: "common.more",
      submitLabelKey: "common.add",
      keepOnSubmit: spec.keepOnSubmit,
      memoryKey: spec.memoryKey,
      onSubmit: spec.onSubmit
    });
  }

  /* The same row, opened under the record it edits. "More" is named
     `common.details` here because what it holds IS the rest of the record:
     where the detail of a row lives is the folded half of its editor. */
  function editRow(spec) {
    var api = Moon.UI.quickRow({
      labels: "visible",
      id: editorIdOf(spec.id),
      fields: spec.fields,
      moreFields: spec.moreFields,
      moreLabelKey: "common.details",
      submitLabelKey: "common.save",
      memoryKey: spec.memoryKey,
      onSubmit: spec.onSubmit,
      onCancel: function () {
        closeEditor(spec.id, spec.recordId);
      }
    });

    /* Esc is the keyboard way out of an editor and a finger has no Esc key.
       quickRow builds its own field row and offers no slot for one more
       control, so the way out is appended to that row rather than parked on a
       line of its own below it. */
    var row = dom.qs(".quickrow__fields", api.element);
    if (row) {
      row.appendChild(btn({
        labelKey: "common.cancel",
        variant: "is-quiet",
        onClick: function () {
          closeEditor(spec.id, spec.recordId);
        }
      }));
    }
    return api;
  }

  /* The name of a record, as the control that opens its editor. This replaces
     the row's old "Edit" button rather than joining it, so the number of tab
     stops per row does not move. */
  function rowOpener(id, recordId, text) {
    var open = editing[id] === recordId;
    var node = dom.el("button", {
      "class": "btn is-quiet",
      type: "button",
      "aria-expanded": open ? "true" : "false",
      "aria-controls": open ? editorIdOf(id) : null
    }, [
      dom.el("span", null, text),
      /* The words that say what pressing it does; the name alone would read as
         nine identically-shaped buttons to a screen reader. */
      dom.el("span", { "class": "sr" }, t("common.edit"))
    ]);
    node.addEventListener("click", function () {
      if (editing[id] === recordId) closeEditor(id, recordId);
      else openEditor(id, recordId);
    });
    return node;
  }

  /* One cell spanning the table, holding the editor. A <form> may not be a
     child of <tbody> and the dialog is gone, so this is where "in place" can
     actually live inside a table. */
  function editorCells(columns, element) {
    return [dom.el("td", { colspan: String(columns) }, element)];
  }

  /* --------------------------------------------------------------------------
     RECURRING (#tekrar)
     ----------------------------------------------------------------------- */

  var RECURRING_ID = "tekrar";
  var RECURRING_COLS = 6;

  /* Which day of the period this rule falls on. Month length is asked of
     Moon.Dates (periodRange of a calendar month), so no Date is built here and
     the 31st of a short month clips to its last day exactly as Model does. */
  function occurrenceIn(rule, periodKey) {
    var Dates = Moon.Dates;
    if (!Dates || !Dates.periodRange || !periodKey || !rule) return null;
    var range = Dates.periodRange(periodKey, monthStartDay());
    if (!range || !range.start || !range.end) return null;

    var wanted = util.clamp(intOf(rule.dayOfMonth) || 1, 1, 31);
    var months = [range.start.slice(0, 7)];
    var endMonth = range.end.slice(0, 7);
    if (endMonth !== months[0]) months.push(endMonth);

    for (var i = 0; i < months.length; i += 1) {
      var span = Dates.periodRange(months[i], 1);
      var length = span && span.days ? intOf(span.days) : 31;
      var day = wanted < length ? wanted : length;
      var candidate = months[i] + "-" + util.pad2(day);
      if (candidate >= range.start && candidate <= range.end) return candidate;
    }
    return null;
  }

  function nextOccurrence(rule) {
    if (!rule || !rule.active) return null;
    var Dates = Moon.Dates;
    var start = periodOf();
    if (!start || !Dates || !Dates.shiftPeriod) return null;

    for (var i = 0; i < LOOKAHEAD; i += 1) {
      var key = i === 0 ? start : Dates.shiftPeriod(start, i);
      if (!key) return null;
      /* A period this rule already wrote is done, whatever its day says. */
      if (rule.lastGeneratedPeriod && rule.lastGeneratedPeriod >= key) continue;
      var date = occurrenceIn(rule, key);
      if (!date) continue;
      if (rule.endDate && date > rule.endDate) return null;
      if (rule.startDate && date < rule.startDate) continue;
      return date;
    }
    return null;
  }

  function pendingRecurring(periodKey) {
    if (!Moon.Model || !Moon.Model.pendingRecurring || !periodKey) return [];
    var rows = Moon.Model.pendingRecurring(periodKey);
    return Array.isArray(rows) ? rows : [];
  }

  /* E6: this is the only path that writes a recurring entry, and a reader has
     to press it. Nothing is generated on boot or on render. */
  function writeAllPending(count) {
    var periodKey = periodOf();
    if (!periodKey || !Moon.Model || !Moon.Model.generateRecurring) return;
    var written = Moon.Model.generateRecurring(periodKey);
    wants(RECURRING_ID, "add");
    if (written > 0) report(RECURRING_ID, "recurring.writtenCount", { count: written });
    else if (count > 0) report(RECURRING_ID, "err.unknown", null, "error");
  }

  function toggleRule(rule) {
    if (!Moon.Model || !Moon.Model.toggleRecurring) return;
    wants(RECURRING_ID, "toggle:" + rule.id);
    var active = Moon.Model.toggleRecurring(rule.id);
    if (active === null || active === undefined) {
      report(RECURRING_ID, "err.unknown", null, "error");
      return;
    }
    report(RECURRING_ID, active ? "recurring.resumedToast" : "recurring.pausedToast", {
      name: nameOf(rule)
    });
  }

  function pendingBand(pending) {
    var lines = dom.el("div", { "class": "notice__body" });
    pending.forEach(function (row) {
      lines.appendChild(dom.el("div", null, [
        line(nameOf(row.recurring), "sm"),
        line(t("recurring.next", {
          date: fmtDate(row.date),
          amount: fmtMoney(row.amount)
        }), "sm dim")
      ]));
    });

    return Moon.UI.notice({
      kind: "warn",
      "class": "is-warn",
      messageKey: "recurring.pendingCount",
      params: { count: pending.length },
      body: lines,
      actions: [{
        labelKey: "recurring.writeAll",
        "class": "is-primary",
        onClick: function () {
          writeAllPending(pending.length);
        }
      }]
    });
  }

  function kindOf(direction) {
    return direction === "in" ? "income" : "expense";
  }

  function categoryOptions(direction) {
    return categoriesOf(kindOf(direction)).map(function (cat) {
      return { value: cat.id, label: cat.name };
    });
  }

  /* A select is never left blank: the quick row has to be savable the moment it
     is on screen, and a placeholder option would be one more thing to clear
     after every record. */
  function defaultCategory(direction, wanted) {
    var rows = categoriesOf(kindOf(direction));
    var i;
    if (wanted) {
      for (i = 0; i < rows.length; i += 1) {
        if (rows[i] && rows[i].id === wanted) return wanted;
      }
    }
    return rows.length && rows[0] ? rows[0].id : "";
  }

  function categoryFixed(id) {
    var cat = Moon.Model && Moon.Model.categoryById ? Moon.Model.categoryById(id) : null;
    return !!(cat && cat.fixed);
  }

  /* Direction and category must agree: an income rule that writes into an
     expense category produces an entry the ledger cannot validate. The
     direction sits in the folded half, so the pair is wired here once and the
     visible row needs to know nothing about it. */
  function recurringParts(rule, carried) {
    var d = carried || {};
    var direction = rule
      ? (rule.direction === "in" ? "in" : "out")
      : (d.direction === "in" ? "in" : "out");
    var fixedTouched = false;

    var fixedField = Moon.UI.field({
      type: "switch",
      name: "fixed",
      labelKey: "form.fixed",
      hintKey: "recurring.form.fixedHint",
      value: rule ? !!rule.fixed : !!d.fixed,
      onChange: function () { fixedTouched = true; }
    });

    var categoryField = Moon.UI.field({
      type: "select",
      name: "categoryId",
      labelKey: "form.category",
      value: defaultCategory(direction, rule ? rule.categoryId : d.categoryId),
      options: categoryOptions(direction),
      onChange: function (value) {
        if (fixedTouched) return;
        fixedField.moonField.control.checked = categoryFixed(value);
      }
    });

    var directionField = Moon.UI.field({
      type: "select",
      name: "direction",
      labelKey: "form.direction",
      value: direction,
      options: [
        { value: "out", labelKey: "form.direction.out" },
        { value: "in", labelKey: "form.direction.in" }
      ],
      onChange: function (value) {
        var select = categoryField.moonField.control;
        var keep = select.value;
        dom.clear(select);
        categoriesOf(kindOf(value)).forEach(function (cat) {
          select.appendChild(dom.el("option", {
            value: cat.id,
            selected: cat.id === keep ? true : null
          }, cat.name));
        });
        if (!select.value && select.options.length) select.selectedIndex = 0;
        if (!fixedTouched) fixedField.moonField.control.checked = categoryFixed(select.value);
      }
    });

    return {
      fields: [
        Moon.UI.field({
          type: "text",
          name: "name",
          labelKey: "form.name",
          required: true,
          maxLength: 200,
          value: rule ? rule.name : ""
        }),
        Moon.UI.field({
          type: "money",
          name: "amount",
          labelKey: "form.amount",
          hintKey: "form.amount.hint",
          required: true,
          currency: currencyCode(),
          value: rule ? intOf(rule.amount) : ""
        }),
        categoryField,
        Moon.UI.field({
          type: "number",
          name: "dayOfMonth",
          labelKey: "recurring.form.dayOfMonth",
          hintKey: "recurring.form.dayOfMonth.hint",
          min: 1,
          max: 31,
          step: 1,
          value: rule ? intOf(rule.dayOfMonth) : (intOf(d.dayOfMonth) || 1)
        })
      ],
      moreFields: [
        directionField,
        fixedField,
        Moon.UI.field({
          type: "date",
          name: "startDate",
          labelKey: "form.startDate",
          value: rule ? rule.startDate : (d.startDate || today())
        }),
        Moon.UI.field({
          type: "date",
          name: "endDate",
          labelKey: "form.endDate",
          hintKey: "form.endDate.hint",
          value: rule && rule.endDate ? rule.endDate : ""
        })
      ]
    };
  }

  /* One writer for both rows: the new-record row and the editor differ only in
     which Model call they end in. Returns a quickRow answer — an explicit
     {ok:false} is the only thing that holds a typed line. */
  function saveRecurring(rule, values) {
    var errors = {};
    var problem = amountProblem(values.amount);
    if (problem) errors.amount = problem;

    var draft = {
      name: values.name,
      amount: problem ? 0 : values.amount,
      direction: values.direction,
      categoryId: values.categoryId,
      dayOfMonth: values.dayOfMonth,
      fixed: !!values.fixed,
      startDate: values.startDate || today(),
      endDate: values.endDate || null
    };

    var check = Moon.Model.validateRecurring(draft);
    if (!check.ok) mergeErrors(errors, check.errors);
    if (Object.keys(errors).length) return { ok: false, errors: errors };

    var ok = rule
      ? Moon.Model.updateRecurring(rule.id, draft)
      : Moon.Model.addRecurring(draft);
    /* The store refused the write (quota, read-only). app.js carries the
       standing band for that; this row only has to keep the typed line and
       say that nothing was written. */
    if (!ok) return { ok: false, errors: { name: "err.unknown" } };
    return null;
  }

  function recurringAddRow() {
    var parts = recurringParts(null, {
      direction: stickyPick(RECURRING_ID, "direction", "out"),
      categoryId: stickyPick(RECURRING_ID, "categoryId", ""),
      dayOfMonth: stickyPick(RECURRING_ID, "dayOfMonth", 1),
      fixed: stickyPick(RECURRING_ID, "fixed", false),
      startDate: stickyPick(RECURRING_ID, "startDate", today())
    });

    return addRow({
      memoryKey: "plan.recurring",
      fields: parts.fields,
      moreFields: parts.moreFields,
      /* What a run of rules shares: the pool they come out of, the direction,
         the day they fall on and the date the series starts. The name and the
         amount are what changes from one rule to the next. */
      keepOnSubmit: ["categoryId", "direction", "dayOfMonth", "fixed", "startDate"],
      onSubmit: function (values) {
        var answer = saveRecurring(null, values);
        if (answer) return answer;
        remember(RECURRING_ID, values, [
          "categoryId", "direction", "dayOfMonth", "fixed", "startDate"
        ]);
        wants(RECURRING_ID, "add");
        queueRepaint(RECURRING_ID);
        return null;
      }
    });
  }

  function recurringEditRow(rule) {
    var parts = recurringParts(rule, null);
    return editRow({
      id: RECURRING_ID,
      recordId: rule.id,
      memoryKey: "plan.recurring.edit",
      fields: parts.fields,
      moreFields: parts.moreFields,
      onSubmit: function (values) {
        var answer = saveRecurring(rule, values);
        if (answer) return answer;
        editing[RECURRING_ID] = null;
        setFlash(RECURRING_ID, "recurring.saved");
        wants(RECURRING_ID, "open:" + rule.id);
        queueRepaint(RECURRING_ID);
        return null;
      }
    });
  }

  function ruleRow(rule, pendingDates, marks) {
    var next = nextOccurrence(rule);
    var opener = rowOpener(RECURRING_ID, rule.id, nameOf(rule));
    marks["open:" + rule.id] = opener;

    var nameCell = [opener];
    nameCell.push(line(t(rule.fixed ? "common.fixed" : "common.variable"), "sm dim"));
    if (!rule.active) nameCell.push(line(t("recurring.paused"), "sm dim"));

    var amount = [amountCell(rule.amount, rule.direction === "in" ? "is-in" : "is-out")];
    amount.push(line(t(rule.direction === "in" ? "form.direction.in" : "form.direction.out"), "sm dim"));

    var nextCell = [line(next ? fmtDate(next) : t("common.none"), null)];
    if (next && pendingDates[rule.id]) {
      nextCell.push(line(t("recurring.pendingSince", { date: fmtDate(next) }), "sm dim"));
    }

    var toggle = btn({
      labelKey: rule.active ? "recurring.pause" : "recurring.resume",
      variant: "is-quiet",
      pressed: !rule.active,
      onClick: function () { toggleRule(rule); }
    });
    marks["toggle:" + rule.id] = toggle;

    return {
      onOpen: function () { openEditor(RECURRING_ID, rule.id); },
      cells: [
        rowHead(nameCell),
        td(line(categoryLabel(rule.categoryId), "sm dim")),
        td(amount, true),
        td(String(util.clamp(intOf(rule.dayOfMonth) || 1, 1, 31)), true),
        td(nextCell),
        td(actionRow([
          toggle,
          btn({
            labelKey: "common.delete",
            variant: "is-quiet",
            onClick: function () {
              removeWithUndo({
                id: RECURRING_ID,
                bodyKey: "recurring.delete.body",
                remove: function () { return Moon.Model.removeRecurring(rule.id); },
                restore: function (record) { Moon.Model.addRecurring(record); }
              });
            }
          })
        ]))
      ]
    };
  }

  /* Start and end date left the table and moved into the folded half of the
     editor (sadeleştirme: the row itself is always visible, where it came from
     is one press away). Six columns instead of eight. */
  function rulesTable(rules, pending, marks) {
    var pendingDates = Object.create(null);
    pending.forEach(function (row) {
      if (row && row.recurring) pendingDates[row.recurring.id] = row.date;
    });

    var rows = [];
    rules.forEach(function (rule) {
      rows.push(ruleRow(rule, pendingDates, marks));
      if (editing[RECURRING_ID] !== rule.id) return;
      var editor = recurringEditRow(rule);
      marks.edit = editor;
      rows.push({ cells: editorCells(RECURRING_COLS, editor.element) });
    });

    return tableBlock([
      th("form.name"),
      th("ledger.col.category"),
      th("ledger.col.amount", true),
      th("recurring.form.dayOfMonth", true),
      th("ledger.col.date"),
      th("a11y.rowActions")
    ], rows);
  }

  /* ------------------------------------------- repetitions with no rule yet */

  /* A proposal list, not an alarm. Three decisions keep it that way:
     it speaks the dialect of the rule table above it (same header keys, same
     cells, no colour and no mark of its own); it stays shut behind one summary
     line until a reader asks, because the standing rule here is that a new
     feature may not add a standing band or a screen of its own; and both of its
     actions are one click, since each writes a rule that appears in the list
     above and can be deleted there — a confirmation would guard nothing.
     detectRecurring() is read without a period: promoteToRecurring stamps
     lastGeneratedPeriod from today, so a window that ended in whatever period
     the reader happens to be browsing would propose a rule already standing
     behind its own first occurrence. */
  var detectOpen = false;

  function detections() {
    if (!Moon.Model || !Moon.Model.detectRecurring) return [];
    var rows = Moon.Model.detectRecurring();
    if (!Array.isArray(rows)) return [];
    /* A repetition that already has a rule is not a finding; the rule list
       above is where it is reported, and repeating it here would ask a reader
       to write a second rule for one payment. */
    return rows.filter(function (row) { return row && !row.existingRuleId; });
  }

  function promote(detection, fixed) {
    if (!Moon.Model || !Moon.Model.promoteToRecurring) return;
    var result = Moon.Model.promoteToRecurring(detection, {
      fixed: fixed,
      markCategoryFixed: false
    });
    if (!result || !result.recurringId) {
      report(RECURRING_ID, "err.unknown", null, "error");
      return;
    }
    /* Left open on purpose: the promoted row drops out of the list by itself
       (it has a rule now), and a reader who promoted one is usually looking at
       the next one. */
    detectOpen = true;
    /* The button that was pressed goes with the row (it has a rule now), so
       the caret comes to rest on the block that is still there. */
    wants(RECURRING_ID, "detect");
    var marked = intOf(result.markedFixed);
    report(RECURRING_ID, "recurring.detect.promoted", null, "info", marked > 0
      ? { key: "recurring.detect.markedFixed", params: { count: marked } }
      : null);
  }

  function detectionRow(found) {
    var periods = Array.isArray(found.periods) ? found.periods.length : 0;
    var nameCell = [line(nameOf(found), null)];
    nameCell.push(line(t("recurring.detect.periods", { count: periods }), "sm dim"));
    if (found.amountVaries) {
      nameCell.push(line(t("recurring.detect.varies", {
        amount: fmtMoney(found.amount)
      }), "sm dim"));
    }

    var amount = [amountCell(found.amount, found.direction === "in" ? "is-in" : "is-out")];
    amount.push(line(t(found.direction === "in"
      ? "form.direction.in"
      : "form.direction.out"), "sm dim"));

    /* Every record behind this row is already fixed, so "write a rule and fix
       it" would name work it cannot do. The row keeps the plain action and the
       reader still gets the rule. */
    var actions = [];
    if (!found.alreadyFixed) {
      actions.push(btn({
        labelKey: "recurring.detect.action",
        variant: "is-primary",
        onClick: function () { promote(found, true); }
      }));
    }
    actions.push(btn({
      labelKey: "recurring.detect.actionPlain",
      variant: "is-quiet",
      onClick: function () { promote(found, false); }
    }));

    return [
      rowHead(nameCell),
      td(line(categoryLabel(found.categoryId), "sm dim")),
      td(amount, true),
      td(String(util.clamp(intOf(found.dayOfMonth) || 1, 1, 31)), true),
      td(actionRow(actions))
    ];
  }

  /* Returns null on a ledger that has neither rules nor findings: there the
     empty state is already saying what to do, and one more line under it would
     be the clutter this block exists to avoid. */
  function detectBlock(hasRules, marks) {
    var rows = detections();
    if (!rows.length && !hasRules) return null;

    var box = dom.el("details", { "class": "numbers", open: detectOpen ? true : null });
    var summary = dom.el("summary", null, t("recurring.detect.title"));
    marks.detect = summary;
    box.appendChild(summary);
    /* The open flag is the one piece of state a reader sets by hand in this
       view, so it outlives the redraw that state:change and lang:change bring. */
    box.addEventListener("toggle", function () { detectOpen = !!box.open; });

    if (!rows.length) {
      box.appendChild(line(t("recurring.detect.none"), "sm dim"));
      return box;
    }

    box.appendChild(line(t("recurring.detect.body"), "prose"));
    box.appendChild(tableBlock([
      th("form.name"),
      th("ledger.col.category"),
      th("ledger.col.amount", true),
      th("recurring.form.dayOfMonth", true),
      th("a11y.rowActions")
    ], rows.map(detectionRow)));
    return box;
  }

  /* The quick row above the list is the call to action now, so the empty state
     says what the section is for and stops there — a button that opened a
     dialog is exactly what sadeleştirme §5 removed. */
  function emptyRecurring() {
    return Moon.UI.emptyState({
      headingKey: "empty.recurring.heading",
      bodyKey: "empty.recurring.body"
    });
  }

  function renderRecurring(root) {
    if (!root) return;
    mounted[RECURRING_ID] = root;
    dom.clear(root);

    var marks = Object.create(null);

    var flash = flashNode(RECURRING_ID);
    if (flash) root.appendChild(flash);

    var pending = pendingRecurring(periodOf());
    if (pending.length) root.appendChild(pendingBand(pending));

    /* Day of the month first, name second: that is the order a reader scans a
       standing-order list in. */
    var rules = util.sortBy(records("recurring"), function (rule) {
      return util.pad2(util.clamp(intOf(rule.dayOfMonth) || 1, 1, 31)) + "|" + util.lower(nameOf(rule));
    });

    /* An editor whose record is gone (deleted elsewhere, undone) must not keep
       the section in an edit it cannot show. */
    if (editing[RECURRING_ID] && !rules.some(function (rule) {
      return rule.id === editing[RECURRING_ID];
    })) {
      editing[RECURRING_ID] = null;
    }

    var entry = recurringAddRow();
    marks.add = entry;

    root.appendChild(Moon.UI.section({
      id: "plan-recurring",
      titleKey: "recurring.title",
      body: [
        entry.element,
        rules.length ? rulesTable(rules, pending, marks) : emptyRecurring(),
        detectBlock(rules.length > 0, marks)
      ]
    }));

    applyIntent(RECURRING_ID, root, marks);
  }

  /* --------------------------------------------------------------------------
     GOALS (#hedefler)
     ----------------------------------------------------------------------- */

  var GOALS_ID = "hedefler";

  function goalSaved(goal) {
    if (!goal) return 0;
    if (typeof goal.savedAmount === "number") return intOf(goal.savedAmount);
    var total = 0;
    (Array.isArray(goal.contributions) ? goal.contributions : []).forEach(function (row) {
      total += intOf(row && row.amount);
    });
    return total;
  }

  function goalProgress(goal) {
    if (Moon.Model && Moon.Model.goalProgress) {
      var found = Moon.Model.goalProgress(goal);
      if (found) return found;
    }
    return { pct: null, remaining: 0, monthsLeft: null, perMonth: null, done: false, earlyDays: 0 };
  }

  /* A plain fill, not Moon.Charts.meter: a meter carries limit semantics (a pace
     mark, an overflow that breaks the right margin) and a savings goal has
     neither. The reading to the right is the whole measurement. */
  function goalBar(pct) {
    var width = util.clamp(typeof pct === "number" && isFinite(pct) ? Math.round(pct) : 0, 0, 100);
    return dom.el("div", { "class": "storage__bar" },
      dom.el("div", { "class": "storage__fill", style: { width: width + "%" } }));
  }

  /* A contribution is the most repeated act in this section, so it is a quick
     row too: type an amount, press Enter, the date stays and the caret comes
     back to the amount for the next one. */
  function contributionRow(goal, marks) {
    var mark = "contrib:" + goal.id;
    var api = Moon.UI.quickRow({
      labels: "visible",
      memoryKey: "plan.goals.contribute",
      submitLabelKey: "goals.contribute",
      keepOnSubmit: ["date"],
      fields: [
        Moon.UI.field({
          type: "date",
          name: "date",
          labelKey: "form.date",
          required: true,
          value: today()
        }),
        Moon.UI.field({
          type: "money",
          name: "amount",
          labelKey: "form.amount",
          required: true,
          currency: currencyCode(),
          value: ""
        })
      ],
      onSubmit: function (values) {
        var errors = {};
        var problem = amountProblem(values.amount);
        if (problem) errors.amount = problem;
        if (!values.date) errors.date = "err.required";
        if (Object.keys(errors).length) return { ok: false, errors: errors };

        var ok = Moon.Model.addContribution(goal.id, {
          date: values.date,
          amount: values.amount
        });
        if (!ok) return { ok: false, errors: { amount: "err.unknown" } };
        wants(GOALS_ID, mark);
        queueRepaint(GOALS_ID);
        return null;
      }
    });
    /* The amount, not the row: a contribution keeps its date, so the field that
       emptied is the amount and that is where the next one is typed. The quick
       row puts the caret there by itself, but the save brings a full rebuild and
       the row the reader is looking at afterwards is a NEW one — focusFirst()
       on it would land on the date it just kept and the second contribution
       would start one field too far left. */
    marks[mark] = api.fields.amount || api;
    return api.element;
  }

  function contributionHistory(goal) {
    var rows = (Array.isArray(goal.contributions) ? goal.contributions : []).filter(function (row) {
      return row && row.date;
    });
    if (!rows.length) return null;
    var ordered = util.sortBy(rows, function (row) { return String(row.date); }, true);

    return numbersBlock([
      { labelKey: "ledger.col.date", key: "date", type: "date" },
      { labelKey: "ledger.col.amount", key: "amount", type: "money" }
    ], ordered, {
      summaryKey: "goals.contributionCount",
      params: { count: ordered.length },
      currency: currencyCode(),
      rowHeader: false,
      emptyKey: "common.none"
    });
  }

  /* The target and the date are what a goal IS, so they are the visible row.
     The amount already put aside is only ever written once, when the goal is
     first entered, so it lives in the folded half of the new-goal row and
     nowhere else: an editor that let it be overwritten would put savedAmount
     and the contribution list it is the sum of into disagreement. */
  function goalFields(goal) {
    return [
      Moon.UI.field({
        type: "text",
        name: "name",
        labelKey: "form.name",
        required: true,
        maxLength: 200,
        value: goal ? goal.name : ""
      }),
      Moon.UI.field({
        type: "money",
        name: "targetAmount",
        labelKey: "goals.form.target",
        hintKey: "form.amount.hint",
        required: true,
        currency: currencyCode(),
        value: goal ? intOf(goal.targetAmount) : ""
      }),
      Moon.UI.field({
        type: "date",
        name: "dueDate",
        labelKey: "goals.form.dueDate",
        hintKey: "goals.form.dueDate.hint",
        value: goal && goal.dueDate ? goal.dueDate : ""
      })
    ];
  }

  function saveGoal(goal, values) {
    var errors = {};
    var problem = amountProblem(values.targetAmount, "err.badTarget");
    if (problem) errors.targetAmount = problem;

    var draft = {
      name: values.name,
      targetAmount: problem ? 0 : values.targetAmount,
      dueDate: values.dueDate || null
    };
    if (!goal && typeof values.savedAmount === "number") {
      if (values.savedAmount < 0) errors.savedAmount = "err.negativeAmount";
      else draft.savedAmount = values.savedAmount;
    }

    var check = Moon.Model.validateGoal(draft);
    if (!check.ok) mergeErrors(errors, check.errors);
    if (Object.keys(errors).length) return { ok: false, errors: errors };

    var ok = goal ? Moon.Model.updateGoal(goal.id, draft) : Moon.Model.addGoal(draft);
    if (!ok) return { ok: false, errors: { name: "err.unknown" } };
    return null;
  }

  function goalAddRow() {
    return addRow({
      memoryKey: "plan.goals",
      fields: goalFields(null),
      moreFields: [
        Moon.UI.field({
          type: "money",
          name: "savedAmount",
          /* Asked for as goals.form.saved; goals.contribute carries it until
             the catalogue grows the name (see the report). */
          labelKey: keyOf("goals.form.saved", "goals.contribute"),
          currency: currencyCode(),
          value: ""
        })
      ],
      keepOnSubmit: ["dueDate"],
      onSubmit: function (values) {
        var answer = saveGoal(null, values);
        if (answer) return answer;
        wants(GOALS_ID, "add");
        queueRepaint(GOALS_ID);
        return null;
      }
    });
  }

  function goalEditRow(goal) {
    return editRow({
      id: GOALS_ID,
      recordId: goal.id,
      memoryKey: "plan.goals.edit",
      fields: goalFields(goal),
      onSubmit: function (values) {
        var answer = saveGoal(goal, values);
        if (answer) return answer;
        editing[GOALS_ID] = null;
        setFlash(GOALS_ID, "goals.saved");
        wants(GOALS_ID, "open:" + goal.id);
        queueRepaint(GOALS_ID);
        return null;
      }
    });
  }

  function goalBlock(goal, marks) {
    var progress = goalProgress(goal);
    var saved = goalSaved(goal);
    var target = intOf(goal.targetAmount);
    var now = today();
    var overdue = !progress.done && goal.dueDate && now && goal.dueDate < now;

    var middle = [goalBar(progress.pct)];
    middle.push(line(t("goals.progress", {
      saved: fmtMoney(saved),
      remaining: fmtMoney(progress.remaining)
    }), "sm"));

    /* One measurement sentence, chosen in the order a reader needs it: filled,
       late, or how much a month closes the gap. No celebration, no scolding. */
    if (progress.done) {
      middle.push(line(t("goals.done", {
        amount: fmtMoney(saved),
        days: intOf(progress.earlyDays)
      }), "sm dim"));
    } else if (overdue) {
      middle.push(line(t("goals.overdue", { remaining: fmtMoney(progress.remaining) }), "sm dim"));
    } else if (progress.perMonth !== null && goal.dueDate) {
      middle.push(line(t("goals.perMonth", {
        amount: fmtMoney(progress.perMonth),
        date: fmtDate(goal.dueDate, "long")
      }), "sm dim"));
    }
    if (!progress.done && progress.monthsLeft !== null) {
      middle.push(line(t("goals.monthsLeft", { count: intOf(progress.monthsLeft) }), "sm dim"));
    }

    if (editing[GOALS_ID] === goal.id) {
      var editor = goalEditRow(goal);
      marks.edit = editor;
      middle.push(editor.element);
    } else {
      middle.push(contributionRow(goal, marks));
    }

    var history = contributionHistory(goal);
    if (history) middle.push(history);

    middle.push(actionRow([
      btn({
        labelKey: "common.delete",
        variant: "is-quiet",
        onClick: function () {
          removeWithUndo({
            id: GOALS_ID,
            bodyKey: "goals.delete.body",
            remove: function () { return Moon.Model.removeGoal(goal.id); },
            restore: function (record) { Moon.Model.addGoal(record); }
          });
        }
      })
    ]));

    var opener = rowOpener(GOALS_ID, goal.id, nameOf(goal));
    marks["open:" + goal.id] = opener;

    /* .meter is the row grid of this stylesheet: name, measurement, reading.
       Consecutive rows get their 1px rule from .meter + .meter, so everything
       belonging to one goal stays inside one .meter element. */
    return dom.el("div", { "class": "meter" }, [
      dom.el("span", { "class": "meter__name" }, opener),
      dom.el("div", { "class": "meter__scale" }, middle),
      dom.el("span", { "class": "meter__readout" }, [
        dom.el("span", { "class": "meter__pct" }, pctText(progress.pct)),
        dom.el("span", { "class": "meter__drift" }, t("goals.progress.short", {
          saved: fmtMoney(saved),
          target: fmtMoney(target)
        }))
      ])
    ]);
  }

  function emptyGoals() {
    return Moon.UI.emptyState({
      headingKey: "empty.goals.heading",
      bodyKey: "empty.goals.body"
    });
  }

  function renderGoals(root) {
    if (!root) return;
    mounted[GOALS_ID] = root;
    dom.clear(root);

    var marks = Object.create(null);

    var flash = flashNode(GOALS_ID);
    if (flash) root.appendChild(flash);

    /* Standing sentence: goals are outside the allowance and the limits. */
    root.appendChild(Moon.UI.notice({
      kind: "info",
      "class": "is-info",
      messageKey: "goals.note"
    }));

    /* Unfilled first, and inside that the nearest date first: a goal with a
       deadline is the one that needs money this month. */
    var goals = util.sortBy(records("goals"), function (goal) {
      var progress = goalProgress(goal);
      return (progress.done ? "1" : "0") + "|" + (goal.dueDate || "9999-12-31") + "|" + util.lower(nameOf(goal));
    });

    if (editing[GOALS_ID] && !goals.some(function (goal) {
      return goal.id === editing[GOALS_ID];
    })) {
      editing[GOALS_ID] = null;
    }

    var entry = goalAddRow();
    marks.add = entry;

    root.appendChild(Moon.UI.section({
      id: "plan-goals",
      titleKey: "goals.title",
      body: [
        entry.element,
        goals.length
          ? goals.map(function (goal) { return goalBlock(goal, marks); })
          : emptyGoals()
      ]
    }));

    applyIntent(GOALS_ID, root, marks);
  }

  /* --------------------------------------------------------------------------
     DEBTS (#borc)
     ----------------------------------------------------------------------- */

  var DEBTS_ID = "borc";
  var DEBT_OPEN_COLS = 5;
  var DEBT_SETTLED_COLS = 4;

  function debtTotals() {
    if (Moon.Model && Moon.Model.debtTotals) {
      var found = Moon.Model.debtTotals();
      if (found) return found;
    }
    return { owedToMe: 0, iOwe: 0, net: 0, openCount: 0 };
  }

  function settleRow(debt) {
    if (!Moon.Model || !Moon.Model.settleDebt) return;
    wants(DEBTS_ID, "settle:" + debt.id);
    var ok = Moon.Model.settleDebt(debt.id, today());
    report(DEBTS_ID, ok ? "debts.settledToast" : "err.unknown", null, ok ? "info" : "error");
  }

  function reopenRow(debt) {
    if (!Moon.Model || !Moon.Model.updateDebt) return;
    wants(DEBTS_ID, "settle:" + debt.id);
    var ok = Moon.Model.updateDebt(debt.id, { settled: false });
    report(DEBTS_ID, ok ? "debts.saved" : "err.unknown", null, ok ? "info" : "error");
  }

  function debtDeleteButton(debt) {
    return btn({
      labelKey: "common.delete",
      variant: "is-quiet",
      onClick: function () {
        removeWithUndo({
          id: DEBTS_ID,
          bodyKey: "debts.delete.body",
          remove: function () { return Moon.Model.removeDebt(debt.id); },
          restore: function (record) { Moon.Model.addDebt(record); }
        });
      }
    });
  }

  /* Overdue is said in two channels that are not colour: a bolder weight and
     the sentence itself. The row keeps the ink of every other row. */
  function dueCell(debt) {
    var cell = [line(debt.dueDate ? fmtDate(debt.dueDate) : t("common.none"), null)];
    if (!debt.dueDate) return cell;
    var left = daysFrom(today(), debt.dueDate);
    if (left === null) return cell;
    if (left < 0) {
      cell.push(dom.el("strong", { "class": "sm" }, t("debts.overdueBy", { count: -left })));
    } else {
      cell.push(line(t("debts.dueIn", { count: left }), "sm dim"));
    }
    return cell;
  }

  function debtParts(debt) {
    return {
      fields: [
        Moon.UI.field({
          type: "text",
          name: "person",
          labelKey: "debts.form.person",
          required: true,
          maxLength: 200,
          value: debt ? debt.person : ""
        }),
        Moon.UI.field({
          type: "money",
          name: "amount",
          labelKey: "form.amount",
          hintKey: "form.amount.hint",
          required: true,
          currency: currencyCode(),
          value: debt ? intOf(debt.amount) : ""
        }),
        Moon.UI.field({
          type: "select",
          name: "direction",
          labelKey: "debts.form.direction",
          value: debt
            ? (debt.direction === "iOwe" ? "iOwe" : "owedToMe")
            : stickyPick(DEBTS_ID, "direction", "owedToMe"),
          options: [
            { value: "owedToMe", labelKey: "debts.direction.owedToMe" },
            { value: "iOwe", labelKey: "debts.direction.iOwe" }
          ]
        })
      ],
      moreFields: [
        Moon.UI.field({
          type: "date",
          name: "date",
          labelKey: "form.date",
          value: debt ? debt.date : stickyPick(DEBTS_ID, "date", today())
        }),
        Moon.UI.field({
          type: "date",
          name: "dueDate",
          labelKey: "debts.form.dueDate",
          hintKey: "debts.form.dueDate.hint",
          value: debt && debt.dueDate ? debt.dueDate : ""
        }),
        Moon.UI.field({
          type: "text",
          name: "note",
          labelKey: "form.note",
          hintKey: "form.note.hint",
          params: { max: 200 },
          maxLength: 200,
          value: debt && debt.note ? debt.note : ""
        })
      ]
    };
  }

  function saveDebt(debt, values) {
    var errors = {};
    var problem = amountProblem(values.amount);
    if (problem) errors.amount = problem;

    var draft = {
      person: values.person,
      amount: problem ? 0 : values.amount,
      direction: values.direction,
      date: values.date || today(),
      dueDate: values.dueDate || null,
      note: values.note || ""
    };

    var check = Moon.Model.validateDebt(draft);
    if (!check.ok) mergeErrors(errors, check.errors);
    if (Object.keys(errors).length) return { ok: false, errors: errors };

    var ok = debt ? Moon.Model.updateDebt(debt.id, draft) : Moon.Model.addDebt(draft);
    if (!ok) return { ok: false, errors: { person: "err.unknown" } };
    return null;
  }

  function debtAddRow() {
    var parts = debtParts(null);
    return addRow({
      memoryKey: "plan.debts",
      fields: parts.fields,
      moreFields: parts.moreFields,
      /* A session of these is usually one side of the ledger on one day. */
      keepOnSubmit: ["direction", "date"],
      onSubmit: function (values) {
        var answer = saveDebt(null, values);
        if (answer) return answer;
        remember(DEBTS_ID, values, ["direction", "date"]);
        wants(DEBTS_ID, "add");
        queueRepaint(DEBTS_ID);
        return null;
      }
    });
  }

  function debtEditRow(debt) {
    var parts = debtParts(debt);
    return editRow({
      id: DEBTS_ID,
      recordId: debt.id,
      memoryKey: "plan.debts.edit",
      fields: parts.fields,
      moreFields: parts.moreFields,
      onSubmit: function (values) {
        var answer = saveDebt(debt, values);
        if (answer) return answer;
        editing[DEBTS_ID] = null;
        setFlash(DEBTS_ID, "debts.saved");
        wants(DEBTS_ID, "open:" + debt.id);
        queueRepaint(DEBTS_ID);
        return null;
      }
    });
  }

  /* The record date left the table: the date that governs a debt is its due
     date, and when it was written is detail — it is in the folded half of the
     editor, where the note is too. */
  function openDebtRow(debt, marks) {
    var tone = debt.direction === "iOwe" ? "is-out" : "is-in";
    var opener = rowOpener(DEBTS_ID, debt.id, personOf(debt));
    marks["open:" + debt.id] = opener;

    var settle = btn({
      labelKey: "debts.settle",
      variant: "is-quiet",
      onClick: function () { settleRow(debt); }
    });
    marks["settle:" + debt.id] = settle;

    return {
      onOpen: function () { openEditor(DEBTS_ID, debt.id); },
      cells: [
        rowHead(opener),
        td(amountCell(debt.amount, tone), true),
        td(dueCell(debt)),
        td(line(String(debt.note || ""), "sm dim")),
        td(actionRow([settle, debtDeleteButton(debt)]))
      ]
    };
  }

  function settledDebtRow(debt, marks) {
    var tone = debt.direction === "iOwe" ? "is-out" : "is-in";
    var opener = rowOpener(DEBTS_ID, debt.id, personOf(debt));
    marks["open:" + debt.id] = opener;

    var reopen = btn({
      labelKey: "debts.reopen",
      variant: "is-quiet",
      onClick: function () { reopenRow(debt); }
    });
    marks["settle:" + debt.id] = reopen;

    return {
      onOpen: function () { openEditor(DEBTS_ID, debt.id); },
      cells: [
        rowHead(opener),
        td(amountCell(debt.amount, tone), true),
        td([
          line(fmtDate(debt.date), null),
          line(t("debts.settled", { date: fmtDate(debt.settledDate || debt.date) }), "sm dim")
        ]),
        td(actionRow([reopen, debtDeleteButton(debt)]))
      ]
    };
  }

  /* One builder for both debt tables: a row, and under it its editor when that
     is the row the reader opened. */
  function debtRows(list, columns, build, marks) {
    var rows = [];
    list.forEach(function (debt) {
      rows.push(build(debt, marks));
      if (editing[DEBTS_ID] !== debt.id) return;
      var editor = debtEditRow(debt);
      marks.edit = editor;
      rows.push({ cells: editorCells(columns, editor.element) });
    });
    return rows;
  }

  function openDebtGroup(titleKey, list, marks) {
    if (!list.length) return null;
    return dom.frag([
      dom.el("h3", null, t(titleKey)),
      tableBlock([
        th("debts.form.person"),
        th("ledger.col.amount", true),
        th("debts.form.dueDate"),
        th("ledger.col.note"),
        th("a11y.rowActions")
      ], debtRows(list, DEBT_OPEN_COLS, openDebtRow, marks))
    ]);
  }

  function settledGroup(list, marks) {
    if (!list.length) return null;
    var details = dom.el("details", { "class": "numbers" });
    details.appendChild(dom.el("summary", null, t("ledger.count", { count: list.length })));
    details.appendChild(tableBlock([
      th("debts.form.person"),
      th("ledger.col.amount", true),
      th("ledger.col.date"),
      th("a11y.rowActions")
    ], debtRows(list, DEBT_SETTLED_COLS, settledDebtRow, marks)));
    return details;
  }

  function emptyDebts() {
    return Moon.UI.emptyState({
      headingKey: "empty.debts.heading",
      bodyKey: "empty.debts.body"
    });
  }

  function renderDebts(root) {
    if (!root) return;
    mounted[DEBTS_ID] = root;
    dom.clear(root);

    var marks = Object.create(null);

    var flash = flashNode(DEBTS_ID);
    if (flash) root.appendChild(flash);

    /* The sentence that has to stand above this section: these records are
       outside the daily allowance and outside every limit. */
    root.appendChild(Moon.UI.notice({
      kind: "info",
      "class": "is-info",
      messageKey: "debts.note"
    }));

    var all = records("debts");

    if (editing[DEBTS_ID] && !all.some(function (debt) {
      return debt && debt.id === editing[DEBTS_ID];
    })) {
      editing[DEBTS_ID] = null;
    }

    /* Nearest due date first, then the record date; unsettled only. */
    var order = function (debt) {
      return (debt.dueDate || "9999-12-31") + "|" + (debt.date || "") + "|" + util.lower(debt.person);
    };
    var owed = util.sortBy(all.filter(function (d) {
      return d && !d.settled && d.direction !== "iOwe";
    }), order);
    var owing = util.sortBy(all.filter(function (d) {
      return d && !d.settled && d.direction === "iOwe";
    }), order);
    var settled = util.sortBy(all.filter(function (d) {
      return d && d.settled;
    }), function (debt) { return String(debt.settledDate || debt.date || ""); }, true);

    var entry = debtAddRow();
    marks.add = entry;

    var body = [entry.element];
    if (!all.length) {
      body.push(emptyDebts());
    } else {
      var totals = debtTotals();
      body.push(line(t("debts.totals", {
        owedToMe: fmtMoney(totals.owedToMe),
        iOwe: fmtMoney(totals.iOwe),
        net: fmtMoney(totals.net)
      }), "mid"));
      body.push(line(t("debts.openCount", { count: intOf(totals.openCount) }), "sm dim"));
      body.push(openDebtGroup("debts.direction.owedToMe", owed, marks));
      body.push(openDebtGroup("debts.direction.iOwe", owing, marks));
      body.push(settledGroup(settled, marks));
    }

    root.appendChild(Moon.UI.section({
      id: "plan-debts",
      titleKey: "debts.title",
      body: body
    }));

    applyIntent(DEBTS_ID, root, marks);
  }

  /* --------------------------------------------------------------- exports */

  function forget(id) {
    mounted[id] = null;
    flashes[id] = null;
    editing[id] = null;
    intent[id] = null;
  }

  Moon.Views.recurring = {
    id: RECURRING_ID,
    titleKey: "nav.recurring",
    render: renderRecurring,
    /* Leaving the section ends the errand the detect block was opened for, so
       it comes back shut rather than standing open from a visit two days ago. */
    destroy: function () {
      detectOpen = false;
      forget(RECURRING_ID);
    }
  };

  Moon.Views.goals = {
    id: GOALS_ID,
    titleKey: "nav.goals",
    render: renderGoals,
    destroy: function () { forget(GOALS_ID); }
  };

  Moon.Views.debts = {
    id: DEBTS_ID,
    titleKey: "nav.debts",
    render: renderDebts,
    destroy: function () { forget(DEBTS_ID); }
  };

  VIEWS[RECURRING_ID] = Moon.Views.recurring;
  VIEWS[GOALS_ID] = Moon.Views.goals;
  VIEWS[DEBTS_ID] = Moon.Views.debts;
})(window);
