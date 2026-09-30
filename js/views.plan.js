/* Moon — plan views: recurring payments, goals, debts (contract §13, addendum E6/E10).
 *
 * Three sections in one file because they share one shape: a list of standing
 * records, a dialog that edits exactly one of them, and a delete that leaves an
 * undo band behind. The shared helpers sit at the top; each view keeps its own
 * render, its own empty sentence and its own id.
 *
 * Three facts govern everything below:
 *
 *   - Nothing here writes. Reads come from Moon.Store.state (never mutated) and
 *     from Moon.Model; every change goes through a Moon.Model call.
 *   - render() runs again on state:change and lang:change, so it rebuilds from
 *     scratch and keeps no DOM across runs. The one thing that must survive a
 *     rebuild is a short confirmation sentence, so that sentence is parked in a
 *     module-level slot BEFORE the re-render it belongs to, then consumed once.
 *   - Recurring payments are never written on their own (E6). The pending band
 *     counts what is due and waits for the button.
 *
 * Goals and debts are deliberately outside the allowance and limit arithmetic,
 * and both sections say so in a standing sentence rather than in a footnote:
 * a reader who does not know that reads every other number on the panel wrong.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

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

  function categoriesOf(kind) {
    if (!Moon.Model || !Moon.Model.categories) return [];
    var rows = Moon.Model.categories(kind ? { kind: kind } : null);
    return Array.isArray(rows) ? rows : [];
  }

  function categoryLabel(id) {
    if (Moon.Model && Moon.Model.categoryName) return Moon.Model.categoryName(id);
    return t("common.unclassified");
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

  /* .preview gives the table its own horizontal scroll, so a phone never has
     to squeeze eight columns into 320px. */
  function tableBlock(headCells, bodyRows) {
    var body = dom.el("tbody");
    bodyRows.forEach(function (cells) {
      body.appendChild(dom.el("tr", null, cells));
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

  /* ------------------------------------------------- flash + re-render slot */

  var VIEWS = Object.create(null);
  var mounted = Object.create(null);
  var flashes = Object.create(null);

  function setFlash(id, key, params, kind) {
    flashes[id] = key ? { key: key, params: params || null, kind: kind || "info" } : null;
  }

  function flashNode(id) {
    var current = flashes[id];
    flashes[id] = null;
    if (!current) return null;
    return Moon.UI.notice({
      kind: current.kind,
      "class": "is-" + current.kind,
      messageKey: current.key,
      params: current.params,
      dismissible: true,
      dismissKey: "common.close"
    });
  }

  /* The router redraws on state:change, which happens inside the Model call —
     that is, before the caller can park its sentence. So the caller parks the
     sentence and asks for one more draw; render() is idempotent, so the extra
     draw costs a rebuild and nothing else. */
  function repaint(id) {
    var view = VIEWS[id];
    var root = mounted[id];
    if (!view || !root) return;
    var doc = root.ownerDocument;
    if (doc && doc.contains && !doc.contains(root)) return;
    view.render(root);
  }

  function report(id, key, params, kind) {
    setFlash(id, key, params, kind);
    repaint(id);
  }

  /* --------------------------------------------------------------- deleting */

  /* remove* hands the record back (E5), so undo is a re-add of the same data.
     The band sentence is the delete body: the catalogue has no past-tense
     "deleted" sentence for these three record kinds (see the report). */
  function removeWithUndo(spec) {
    Moon.UI.confirm({
      titleKey: spec.titleKey,
      bodyKey: spec.bodyKey,
      confirmKey: "common.delete",
      danger: true
    }).then(function (yes) {
      if (!yes) return;
      var record = spec.remove();
      if (!record) {
        report(spec.id, "err.unknown", null, "error");
        return;
      }
      /* The router redraws on its own, but a view that also asks for it stays
         correct if it is ever rendered without one. */
      repaint(spec.id);
      Moon.UI.undoStrip({
        messageKey: spec.bodyKey,
        dismissKey: "common.close",
        onUndo: function () {
          spec.restore(record);
          repaint(spec.id);
        }
      });
    });
  }

  /* ------------------------------------------------------------ form shells */

  function summaryBlock() {
    var title = dom.el("p", null, "");
    var body = dom.el("p", { "class": "sm dim" }, "");
    var node = dom.el("div", { "class": "form__summary", hidden: true }, [title, body]);
    node.show = function (titleKey, bodyKey, params) {
      if (!titleKey) {
        node.hidden = true;
        return;
      }
      title.textContent = t(titleKey);
      body.textContent = bodyKey ? t(bodyKey, params) : "";
      node.hidden = false;
    };
    return node;
  }

  /* A dialog whose body is one Moon.UI.form. The submit handler gets the values,
     the form api, the error summary and a close(). */
  function openForm(spec) {
    var box = null;
    var summary = summaryBlock();

    var form = Moon.UI.form({
      fields: spec.fields,
      actions: [
        { labelKey: spec.submitKey, type: "submit", "class": "is-primary" },
        {
          labelKey: "common.cancel",
          "class": "is-quiet",
          onClick: function () {
            if (box) box.close();
          }
        }
      ],
      onSubmit: function (values, api) {
        spec.onSubmit(values, api, summary, function () {
          if (box) box.close();
        });
      }
    });

    /* .form__fields carries no rules of its own; .form__row is the grid that
       puts two short fields on one line and lets a long one take the row. */
    var fields = dom.qs(".form__fields", form.element);
    if (fields) {
      if (fields.classList) fields.classList.add("form__row");
      if (fields.parentNode) fields.parentNode.insertBefore(summary, fields);
    }

    box = Moon.UI.dialog({ titleKey: spec.titleKey, body: form.element });
    box.open();
    return form;
  }

  function rawValue(api, name) {
    var entry = api && api.fields ? api.fields[name] : null;
    if (!entry || !entry.control) return "";
    return String(entry.control.value === undefined ? "" : entry.control.value).trim();
  }

  /* Amounts arrive SIGNED from Moon.Money.parse (E1) while the schema keeps them
     positive. Empty, unreadable, zero and negative each get their own sentence
     instead of one blunt "bad amount". */
  function amountError(api, name, zeroKey) {
    var raw = rawValue(api, name);
    if (!raw) return "err.required";
    var entry = api.fields[name];
    var value = entry ? entry.read() : null;
    if (value === null) return "money.invalid";
    if (value < 0) return "err.negativeAmount";
    if (value === 0) return zeroKey || "err.zeroAmount";
    return null;
  }

  function merge(target, source) {
    Object.keys(source || {}).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(target, key)) target[key] = source[key];
    });
    return target;
  }

  function failForm(api, summary, errors) {
    var count = Object.keys(errors).length;
    api.setErrors(errors);
    if (summary) summary.show("form.errors.title", "form.errors.body", { count: count });
    api.focusFirstError();
  }

  /* --------------------------------------------------------------------------
     RECURRING (#tekrar)
     ----------------------------------------------------------------------- */

  var RECURRING_ID = "tekrar";

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
    if (written > 0) report(RECURRING_ID, "recurring.writtenCount", { count: written });
    else if (count > 0) report(RECURRING_ID, "err.unknown", null, "error");
  }

  function toggleRule(rule) {
    if (!Moon.Model || !Moon.Model.toggleRecurring) return;
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

  function ruleRow(rule, pendingDates) {
    var next = nextOccurrence(rule);
    var nameCell = [line(nameOf(rule), null)];
    if (rule.fixed) nameCell.push(line(t("common.fixed"), "sm dim"));
    else nameCell.push(line(t("common.variable"), "sm dim"));
    if (!rule.active) nameCell.push(line(t("recurring.paused"), "sm dim"));

    var amount = [amountCell(rule.amount, rule.direction === "in" ? "is-in" : "is-out")];
    amount.push(line(t(rule.direction === "in" ? "form.direction.in" : "form.direction.out"), "sm dim"));

    var nextCell = [line(next ? fmtDate(next) : t("common.none"), null)];
    if (next && pendingDates[rule.id]) {
      nextCell.push(line(t("recurring.pendingSince", { date: fmtDate(next) }), "sm dim"));
    }

    return [
      rowHead(nameCell),
      td(line(categoryLabel(rule.categoryId), "sm dim")),
      td(amount, true),
      td(String(util.clamp(intOf(rule.dayOfMonth) || 1, 1, 31)), true),
      td(nextCell),
      td(rule.startDate ? fmtDate(rule.startDate) : t("common.none")),
      td(rule.endDate ? fmtDate(rule.endDate) : t("common.none")),
      td(actionRow([
        btn({
          labelKey: rule.active ? "recurring.pause" : "recurring.resume",
          variant: "is-quiet",
          pressed: !rule.active,
          onClick: function () { toggleRule(rule); }
        }),
        btn({
          labelKey: "common.edit",
          variant: "is-quiet",
          onClick: function () { openRecurringForm(rule); }
        }),
        btn({
          labelKey: "common.delete",
          variant: "is-quiet",
          onClick: function () {
            removeWithUndo({
              id: RECURRING_ID,
              titleKey: "recurring.delete.title",
              bodyKey: "recurring.delete.body",
              remove: function () { return Moon.Model.removeRecurring(rule.id); },
              restore: function (record) { Moon.Model.addRecurring(record); }
            });
          }
        })
      ]))
    ];
  }

  function rulesTable(rules, pending) {
    var pendingDates = Object.create(null);
    pending.forEach(function (row) {
      if (row && row.recurring) pendingDates[row.recurring.id] = row.date;
    });

    return tableBlock([
      th("form.name"),
      th("ledger.col.category"),
      th("ledger.col.amount", true),
      th("recurring.form.dayOfMonth", true),
      th("ledger.col.date"),
      th("form.startDate"),
      th("form.endDate"),
      th("a11y.rowActions")
    ], rules.map(function (rule) {
      return ruleRow(rule, pendingDates);
    }));
  }

  function openRecurringForm(rule) {
    var editing = !!rule;
    var fixedTouched = false;

    var startDefault = editing ? rule.startDate : today();
    var directionDefault = editing && rule.direction === "in" ? "in" : "out";
    var kindOf = function (direction) { return direction === "in" ? "income" : "expense"; };

    var fixedField = Moon.UI.field({
      type: "switch",
      name: "fixed",
      labelKey: "form.fixed",
      hintKey: "recurring.form.fixedHint",
      value: editing ? !!rule.fixed : false,
      onChange: function () { fixedTouched = true; }
    });

    var categoryField = Moon.UI.field({
      type: "select",
      name: "categoryId",
      labelKey: "form.category",
      required: true,
      value: editing ? rule.categoryId : "",
      options: categoriesOf(kindOf(directionDefault)).map(function (cat) {
        return { value: cat.id, label: cat.name };
      }),
      onChange: function (value) {
        if (fixedTouched) return;
        var cat = Moon.Model && Moon.Model.categoryById ? Moon.Model.categoryById(value) : null;
        fixedField.moonField.control.checked = !!(cat && cat.fixed);
      }
    });

    /* Direction and category must agree: an income rule that writes into an
       expense category would produce an entry the ledger cannot validate. */
    var directionField = Moon.UI.field({
      type: "select",
      name: "direction",
      labelKey: "form.direction",
      required: true,
      value: directionDefault,
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
        if (!fixedTouched) {
          var cat = Moon.Model && Moon.Model.categoryById
            ? Moon.Model.categoryById(select.value)
            : null;
          fixedField.moonField.control.checked = !!(cat && cat.fixed);
        }
      }
    });

    openForm({
      titleKey: editing ? "recurring.form.title.edit" : "recurring.form.title.new",
      submitKey: "common.save",
      fields: [
        Moon.UI.field({
          type: "text",
          name: "name",
          labelKey: "form.name",
          required: true,
          autofocus: true,
          maxLength: 200,
          value: editing ? rule.name : ""
        }),
        Moon.UI.field({
          type: "money",
          name: "amount",
          labelKey: "form.amount",
          hintKey: "form.amount.hint",
          required: true,
          currency: currencyCode(),
          value: editing ? intOf(rule.amount) : ""
        }),
        directionField,
        categoryField,
        Moon.UI.field({
          type: "number",
          name: "dayOfMonth",
          labelKey: "recurring.form.dayOfMonth",
          hintKey: "recurring.form.dayOfMonth.hint",
          required: true,
          min: 1,
          max: 31,
          step: 1,
          value: editing ? intOf(rule.dayOfMonth) : 1
        }),
        fixedField,
        Moon.UI.field({
          type: "date",
          name: "startDate",
          labelKey: "form.startDate",
          required: true,
          value: startDefault
        }),
        Moon.UI.field({
          type: "date",
          name: "endDate",
          labelKey: "form.endDate",
          hintKey: "form.endDate.hint",
          value: editing ? rule.endDate : ""
        })
      ],
      onSubmit: function (values, api, summary, close) {
        var errors = {};
        var amountKey = amountError(api, "amount");
        if (amountKey) errors.amount = amountKey;

        var draft = {
          name: values.name,
          amount: amountKey ? 0 : values.amount,
          direction: values.direction,
          categoryId: values.categoryId,
          dayOfMonth: values.dayOfMonth,
          fixed: !!values.fixed,
          startDate: values.startDate,
          endDate: values.endDate || null
        };

        merge(errors, api.fieldErrors());
        var check = Moon.Model.validateRecurring(draft);
        if (!check.ok) merge(errors, check.errors);
        if (Object.keys(errors).length) {
          failForm(api, summary, errors);
          return;
        }

        var ok = editing
          ? Moon.Model.updateRecurring(rule.id, draft)
          : Moon.Model.addRecurring(draft);
        if (!ok) {
          summary.show("form.errors.title", "err.unknown");
          return;
        }
        close();
        report(RECURRING_ID, "recurring.saved");
      }
    });
  }

  function emptyRecurring() {
    return Moon.UI.emptyState({
      headingKey: "empty.recurring.heading",
      bodyKey: "empty.recurring.body",
      actions: [btn({
        labelKey: "recurring.form.title.new",
        variant: "is-row",
        onClick: function () { openRecurringForm(null); }
      })]
    });
  }

  function renderRecurring(root) {
    if (!root) return;
    mounted[RECURRING_ID] = root;
    dom.clear(root);

    var flash = flashNode(RECURRING_ID);
    if (flash) root.appendChild(flash);

    var pending = pendingRecurring(periodOf());
    if (pending.length) root.appendChild(pendingBand(pending));

    /* Day of the month first, name second: that is the order a reader scans a
       standing-order list in. */
    var rules = util.sortBy(records("recurring"), function (rule) {
      return util.pad2(util.clamp(intOf(rule.dayOfMonth) || 1, 1, 31)) + "|" + util.lower(nameOf(rule));
    });

    root.appendChild(Moon.UI.section({
      id: "plan-recurring",
      titleKey: "recurring.title",
      aside: btn({
        labelKey: "recurring.form.title.new",
        variant: "is-primary",
        onClick: function () { openRecurringForm(null); }
      }),
      body: rules.length ? rulesTable(rules, pending) : emptyRecurring()
    }));
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

  function contributionForm(goal) {
    var form = Moon.UI.form({
      fields: [
        Moon.UI.field({ type: "date", name: "date", labelKey: "form.date", required: true, value: today() }),
        Moon.UI.field({
          type: "money",
          name: "amount",
          labelKey: "form.amount",
          required: true,
          currency: currencyCode()
        })
      ],
      actions: [{ labelKey: "goals.contribute", type: "submit", "class": "is-primary" }],
      onSubmit: function (values, api) {
        var errors = {};
        var amountKey = amountError(api, "amount");
        if (amountKey) errors.amount = amountKey;
        if (!values.date) errors.date = "err.required";
        merge(errors, api.fieldErrors());
        if (Object.keys(errors).length) {
          failForm(api, null, errors);
          return;
        }
        var ok = Moon.Model.addContribution(goal.id, { date: values.date, amount: values.amount });
        if (!ok) {
          api.setErrors({ amount: "err.unknown" });
          return;
        }
        report(GOALS_ID, "goals.contributionAdded");
      }
    });

    var fields = dom.qs(".form__fields", form.element);
    if (fields && fields.classList) fields.classList.add("form__row");
    return form.element;
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

  function goalBlock(goal) {
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

    middle.push(contributionForm(goal));

    var history = contributionHistory(goal);
    if (history) middle.push(history);

    middle.push(actionRow([
      btn({
        labelKey: "common.edit",
        variant: "is-quiet",
        onClick: function () { openGoalForm(goal); }
      }),
      btn({
        labelKey: "common.delete",
        variant: "is-quiet",
        onClick: function () {
          removeWithUndo({
            id: GOALS_ID,
            titleKey: "goals.delete.title",
            bodyKey: "goals.delete.body",
            remove: function () { return Moon.Model.removeGoal(goal.id); },
            restore: function (record) { Moon.Model.addGoal(record); }
          });
        }
      })
    ]));

    /* .meter is the row grid of this stylesheet: name, measurement, reading.
       Consecutive rows get their 1px rule from .meter + .meter, so everything
       belonging to one goal stays inside one .meter element. */
    return dom.el("div", { "class": "meter" }, [
      dom.el("span", { "class": "meter__name" }, nameOf(goal)),
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

  function openGoalForm(goal) {
    var editing = !!goal;
    openForm({
      titleKey: editing ? "goals.form.title.edit" : "goals.form.title.new",
      submitKey: "common.save",
      fields: [
        Moon.UI.field({
          type: "text",
          name: "name",
          labelKey: "form.name",
          required: true,
          autofocus: true,
          maxLength: 200,
          value: editing ? goal.name : ""
        }),
        Moon.UI.field({
          type: "money",
          name: "targetAmount",
          labelKey: "goals.form.target",
          hintKey: "form.amount.hint",
          required: true,
          currency: currencyCode(),
          value: editing ? intOf(goal.targetAmount) : ""
        }),
        Moon.UI.field({
          type: "date",
          name: "dueDate",
          labelKey: "goals.form.dueDate",
          hintKey: "goals.form.dueDate.hint",
          value: editing ? goal.dueDate : ""
        })
      ],
      onSubmit: function (values, api, summary, close) {
        var errors = {};
        var amountKey = amountError(api, "targetAmount", "err.badTarget");
        if (amountKey) errors.targetAmount = amountKey;

        var draft = {
          name: values.name,
          targetAmount: amountKey ? 0 : values.targetAmount,
          dueDate: values.dueDate || null
        };

        merge(errors, api.fieldErrors());
        var check = Moon.Model.validateGoal(draft);
        if (!check.ok) merge(errors, check.errors);
        if (Object.keys(errors).length) {
          failForm(api, summary, errors);
          return;
        }

        var ok = editing ? Moon.Model.updateGoal(goal.id, draft) : Moon.Model.addGoal(draft);
        if (!ok) {
          summary.show("form.errors.title", "err.unknown");
          return;
        }
        close();
        report(GOALS_ID, "goals.saved");
      }
    });
  }

  function emptyGoals() {
    return Moon.UI.emptyState({
      headingKey: "empty.goals.heading",
      bodyKey: "empty.goals.body",
      actions: [btn({
        labelKey: "goals.form.title.new",
        variant: "is-row",
        onClick: function () { openGoalForm(null); }
      })]
    });
  }

  function renderGoals(root) {
    if (!root) return;
    mounted[GOALS_ID] = root;
    dom.clear(root);

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

    root.appendChild(Moon.UI.section({
      id: "plan-goals",
      titleKey: "goals.title",
      aside: btn({
        labelKey: "goals.form.title.new",
        variant: "is-primary",
        onClick: function () { openGoalForm(null); }
      }),
      body: goals.length ? goals.map(goalBlock) : emptyGoals()
    }));
  }

  /* --------------------------------------------------------------------------
     DEBTS (#borc)
     ----------------------------------------------------------------------- */

  var DEBTS_ID = "borc";

  function debtTotals() {
    if (Moon.Model && Moon.Model.debtTotals) {
      var found = Moon.Model.debtTotals();
      if (found) return found;
    }
    return { owedToMe: 0, iOwe: 0, net: 0, openCount: 0 };
  }

  function settleRow(debt) {
    if (!Moon.Model || !Moon.Model.settleDebt) return;
    var ok = Moon.Model.settleDebt(debt.id, today());
    report(DEBTS_ID, ok ? "debts.settledToast" : "err.unknown", null, ok ? "info" : "error");
  }

  function reopenRow(debt) {
    if (!Moon.Model || !Moon.Model.updateDebt) return;
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
          titleKey: "debts.delete.title",
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

  function openDebtRow(debt) {
    var tone = debt.direction === "iOwe" ? "is-out" : "is-in";
    return [
      rowHead(String(debt.person || "")),
      td(amountCell(debt.amount, tone), true),
      td(fmtDate(debt.date)),
      td(dueCell(debt)),
      td(line(String(debt.note || ""), "sm dim")),
      td(actionRow([
        btn({
          labelKey: "debts.settle",
          variant: "is-quiet",
          onClick: function () { settleRow(debt); }
        }),
        btn({
          labelKey: "common.edit",
          variant: "is-quiet",
          onClick: function () { openDebtForm(debt); }
        }),
        debtDeleteButton(debt)
      ]))
    ];
  }

  function settledDebtRow(debt) {
    var tone = debt.direction === "iOwe" ? "is-out" : "is-in";
    return [
      rowHead(String(debt.person || "")),
      td(amountCell(debt.amount, tone), true),
      td([
        line(fmtDate(debt.date), null),
        line(t("debts.settled", { date: fmtDate(debt.settledDate || debt.date) }), "sm dim")
      ]),
      td(line(String(debt.note || ""), "sm dim")),
      td(actionRow([
        btn({
          labelKey: "debts.reopen",
          variant: "is-quiet",
          onClick: function () { reopenRow(debt); }
        }),
        debtDeleteButton(debt)
      ]))
    ];
  }

  function openDebtGroup(titleKey, rows) {
    if (!rows.length) return null;
    return dom.frag([
      dom.el("h3", null, t(titleKey)),
      tableBlock([
        th("debts.form.person"),
        th("ledger.col.amount", true),
        th("ledger.col.date"),
        th("debts.form.dueDate"),
        th("ledger.col.note"),
        th("a11y.rowActions")
      ], rows.map(openDebtRow))
    ]);
  }

  function settledGroup(rows) {
    if (!rows.length) return null;
    var details = dom.el("details", { "class": "numbers" });
    details.appendChild(dom.el("summary", null, t("ledger.count", { count: rows.length })));
    details.appendChild(tableBlock([
      th("debts.form.person"),
      th("ledger.col.amount", true),
      th("ledger.col.date"),
      th("ledger.col.note"),
      th("a11y.rowActions")
    ], rows.map(settledDebtRow)));
    return details;
  }

  function openDebtForm(debt) {
    var editing = !!debt;
    openForm({
      titleKey: editing ? "debts.form.title.edit" : "debts.form.title.new",
      submitKey: "common.save",
      fields: [
        Moon.UI.field({
          type: "text",
          name: "person",
          labelKey: "debts.form.person",
          required: true,
          autofocus: true,
          maxLength: 200,
          value: editing ? debt.person : ""
        }),
        Moon.UI.field({
          type: "money",
          name: "amount",
          labelKey: "form.amount",
          hintKey: "form.amount.hint",
          required: true,
          currency: currencyCode(),
          value: editing ? intOf(debt.amount) : ""
        }),
        Moon.UI.field({
          type: "select",
          name: "direction",
          labelKey: "debts.form.direction",
          required: true,
          value: editing ? debt.direction : "owedToMe",
          options: [
            { value: "owedToMe", labelKey: "debts.direction.owedToMe" },
            { value: "iOwe", labelKey: "debts.direction.iOwe" }
          ]
        }),
        Moon.UI.field({
          type: "date",
          name: "date",
          labelKey: "form.date",
          required: true,
          value: editing ? debt.date : today()
        }),
        Moon.UI.field({
          type: "date",
          name: "dueDate",
          labelKey: "debts.form.dueDate",
          hintKey: "debts.form.dueDate.hint",
          value: editing ? debt.dueDate : ""
        }),
        Moon.UI.field({
          type: "textarea",
          name: "note",
          labelKey: "form.note",
          hintKey: "form.note.hint",
          params: { max: 200 },
          maxLength: 200,
          value: editing ? debt.note : ""
        })
      ],
      onSubmit: function (values, api, summary, close) {
        var errors = {};
        var amountKey = amountError(api, "amount");
        if (amountKey) errors.amount = amountKey;

        var draft = {
          person: values.person,
          amount: amountKey ? 0 : values.amount,
          direction: values.direction,
          date: values.date,
          dueDate: values.dueDate || null,
          note: values.note || ""
        };

        merge(errors, api.fieldErrors());
        var check = Moon.Model.validateDebt(draft);
        if (!check.ok) merge(errors, check.errors);
        if (Object.keys(errors).length) {
          failForm(api, summary, errors);
          return;
        }

        var ok = editing ? Moon.Model.updateDebt(debt.id, draft) : Moon.Model.addDebt(draft);
        if (!ok) {
          summary.show("form.errors.title", "err.unknown");
          return;
        }
        close();
        report(DEBTS_ID, "debts.saved");
      }
    });
  }

  function emptyDebts() {
    return Moon.UI.emptyState({
      headingKey: "empty.debts.heading",
      bodyKey: "empty.debts.body",
      actions: [btn({
        labelKey: "debts.form.title.new",
        variant: "is-row",
        onClick: function () { openDebtForm(null); }
      })]
    });
  }

  function renderDebts(root) {
    if (!root) return;
    mounted[DEBTS_ID] = root;
    dom.clear(root);

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

    var body;
    if (!all.length) {
      body = emptyDebts();
    } else {
      var totals = debtTotals();
      body = [
        line(t("debts.totals", {
          owedToMe: fmtMoney(totals.owedToMe),
          iOwe: fmtMoney(totals.iOwe),
          net: fmtMoney(totals.net)
        }), "mid"),
        line(t("debts.openCount", { count: intOf(totals.openCount) }), "sm dim"),
        openDebtGroup("debts.direction.owedToMe", owed),
        openDebtGroup("debts.direction.iOwe", owing),
        settledGroup(settled)
      ];
    }

    root.appendChild(Moon.UI.section({
      id: "plan-debts",
      titleKey: "debts.title",
      aside: btn({
        labelKey: "debts.form.title.new",
        variant: "is-primary",
        onClick: function () { openDebtForm(null); }
      }),
      body: body
    }));
  }

  /* --------------------------------------------------------------- exports */

  function forget(id) {
    mounted[id] = null;
    flashes[id] = null;
  }

  Moon.Views.recurring = {
    id: RECURRING_ID,
    titleKey: "nav.recurring",
    render: renderRecurring,
    destroy: function () { forget(RECURRING_ID); }
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
