/* Moon — the Data section (#veri): import, backup, sample, settings.
 *
 * Four jobs share one screen because they are one subject: where the data comes
 * from and where it can go. The CSV wizard (contract §9, jury A8) is the bulk of
 * the file; backup/restore, the sample month and the settings follow.
 *
 * Three rules shape the code:
 *
 *  - The router re-renders this view on every state:change and lang:change, so
 *    render() is a pure redraw of module state. Nothing is kept in the DOM that
 *    is not also kept in `wiz` / `rst` / `bak`, which is what lets a language
 *    switch happen in the middle of step 2 without losing the file.
 *  - Nothing writes to Moon.Store.state. Entries go through Moon.Model, the
 *    sample through Moon.Sample, and the five settings fields through
 *    Moon.Store.update — the only write path the base layer exposes for them.
 *  - Every sentence comes from Moon.I18n.t. The only literals here are the
 *    non-linguistic ones (a unit symbol, a glyph), and error codes travelling
 *    up from CSV/Importer/Store are passed to t() as-is: i18n.js aliases them
 *    onto the reader-facing sentence, so an unknown code is never swallowed.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;
  Moon.Views = Moon.Views || {};

  var doc = global.document;
  var dom = Moon.dom;
  var util = Moon.util;

  var VIEW_ID = "veri";
  var WIZARD_STEPS = 4;
  var PREVIEW_ROWS = 8;
  var SAMPLE_VALUES = 200;              /* column values read per redraw */
  var NUDGE_AT = 40;                    /* contract §14 step 8 */
  var BIG_FILE = 1024 * 1024;           /* "this may take a moment" threshold */
  var STORAGE_BUDGET = 5 * 1024 * 1024; /* what browsers give localStorage */

  /* Column roles the reader can choose from. "balance" is a real role inside
     Moon.Importer but has no sentence in the catalogue, so a detected balance
     column arrives here as "ignore" — which is exactly what it means to us. */
  var ROLES = ["date", "note", "amount", "debit", "credit", "category", "ignore"];
  var MAPPED_ROLES = ["date", "note", "amount", "debit", "credit", "category"];

  var DELIMITERS = [
    { value: ";", labelKey: "csv.delimiter.semicolon" },
    { value: ",", labelKey: "csv.delimiter.comma" },
    { value: "\t", labelKey: "csv.delimiter.tab" },
    { value: "|", labelKey: "csv.delimiter.pipe" }
  ];

  var ENCODINGS = [
    { value: "utf-8", labelKey: "csv.encoding.utf8" },
    { value: "windows-1254", labelKey: "csv.encoding.w1254" },
    { value: "utf-16le", labelKey: "csv.encoding.utf16le" }
  ];

  var CURRENCIES = ["TRY", "USD", "EUR", "GBP"];
  var THEMES = ["system", "dial", "paper"];

  /* ------------------------------------------------------------- module state */

  var mounted = false;
  var rootRef = null;
  var flash = null;            /* {key, params} shown on the next draw, once */
  var storeError = null;       /* last store:error payload — kept, not dismissed */
  var pendingFile = null;      /* handed over by startImport before render */

  function freshWizard() {
    return {
      step: 1,
      busy: false,
      errorKey: null,
      errorParams: null,
      file: null,
      bytes: null,
      text: null,
      encoding: null,
      warnings: [],
      sniffed: false,          /* the automatic delimiter/header read happens once */
      delimiter: ";",
      headerRow: 0,
      guess: null,
      colRoles: [],
      dateOrder: "dmy",
      decimal: ",",
      signRule: "negativeIsExpense",
      parsed: null,
      built: null,
      defaultCategoryId: null,
      skipLines: null,         /* null until the first build fills the defaults */
      written: null            /* {count} after step 4 */
    };
  }

  var wiz = freshWizard();

  var rst = { name: null, text: null, mode: "replace", errorKey: null, done: null, busy: false };
  var bak = { fallbackText: null, doneFile: null };

  /* -------------------------------------------------------------- plumbing */

  function t(key, params) {
    var I18n = Moon.I18n;
    if (key === null || key === undefined) return "";
    if (I18n && typeof I18n.t === "function") return I18n.t(key, params);
    return String(key);
  }

  function lang() {
    var I18n = Moon.I18n;
    return (I18n && I18n.lang) || "tr";
  }

  function el(tag, attrs, children) {
    return dom.el(tag, attrs, children);
  }

  function store() {
    return Moon.Store || null;
  }

  function model() {
    return Moon.Model || null;
  }

  function settings() {
    var st = store();
    var state = st ? st.state : null;
    return (state && state.settings) || {};
  }

  function monthStartDay() {
    var day = settings().monthStartDay;
    return typeof day === "number" && day >= 1 && day <= 28 ? day : 1;
  }

  function entryCount() {
    var m = model();
    if (!m || typeof m.entries !== "function") return 0;
    try {
      return (m.entries({}) || []).length;
    } catch (error) {
      return 0;
    }
  }

  function categoryOptions(kind) {
    var m = model();
    if (!m || typeof m.categories !== "function") return [];
    var list = [];
    try {
      list = m.categories(kind ? { kind: kind } : {}) || [];
    } catch (error) {
      list = [];
    }
    return list.map(function (cat) {
      return { value: cat.id, label: cat.name };
    });
  }

  function fmtMoney(minor) {
    var Money = Moon.Money;
    if (!Money || typeof Money.format !== "function") return String(minor);
    return Money.format(minor, { currency: settings().currency || "TRY", lang: lang(), symbol: true });
  }

  function fmtDate(date, style) {
    var Dates = Moon.Dates;
    if (!Dates || typeof Dates.formatDate !== "function") return String(date || "");
    return Dates.formatDate(date, lang(), style || "long");
  }

  /* A byte count as "4,8 MB". The unit symbol is not a translated word, so Intl
     carries it when present and a bare symbol is the fallback. */
  function fmtBytes(bytes) {
    var n = typeof bytes === "number" && isFinite(bytes) ? Math.max(0, bytes) : 0;
    var mega = n >= 1024 * 1024;
    var value = mega ? n / (1024 * 1024) : n / 1024;
    var rounded = mega ? Math.round(value * 10) / 10 : Math.round(value);
    var tag = lang() === "en" ? "en-US" : "tr-TR";
    try {
      return new global.Intl.NumberFormat(tag, {
        style: "unit",
        unit: mega ? "megabyte" : "kilobyte",
        unitDisplay: "short",
        maximumFractionDigits: mega ? 1 : 0
      }).format(rounded);
    } catch (error) { /* no unit styles in this engine */ }
    try {
      return new global.Intl.NumberFormat(tag, { maximumFractionDigits: mega ? 1 : 0 })
        .format(rounded) + " " + (mega ? "MB" : "KB");
    } catch (error2) {
      return rounded + " " + (mega ? "MB" : "KB");
    }
  }

  function addClass(node, name) {
    if (node && name && node.classList) node.classList.add(name);
    return node;
  }

  /* Another section may own #view by now — an async read finishing after the
     reader navigated away, or a router that never calls destroy(). The hash is
     the cheapest honest test of "are we still on screen". */
  function isActive() {
    if (!mounted || !rootRef || !doc.contains(rootRef)) return false;
    var hash = "";
    try {
      hash = String(global.location.hash || "").replace(/^#/, "");
    } catch (error) {
      return true;              /* no location: trust `mounted` */
    }
    return !hash || hash === VIEW_ID;
  }

  function redraw() {
    if (!isActive()) return;
    render(rootRef);
  }

  function say(key, params) {
    flash = { key: key, params: params || null };
  }

  /* -------------------------------------------------------------- elements */

  function button(labelText, kind, onClick, opts) {
    var classes = ["btn"];
    if (kind) classes.push("is-" + kind);
    var attrs = { type: "button", "class": classes.join(" ") };
    if (opts && opts.disabled) attrs.disabled = true;
    var node = el("button", attrs, labelText);
    node.addEventListener("click", function (event) {
      if (typeof onClick === "function") onClick(event);
    });
    return node;
  }

  function actions(list) {
    var row = el("div", { "class": "form__actions" });
    (list || []).forEach(function (node) {
      if (node) row.appendChild(node);
    });
    return row;
  }

  /* A vertical stack inside a section. `.form` is the one gap-bearing grid in
     moon.css, and its 520px measure is the prose measure the design asks for —
     so it is reused as the stack, form or not. */
  function stack(children) {
    return el("div", { "class": "form" }, children);
  }

  function prose(text) {
    return el("p", { "class": "prose", text: text });
  }

  function small(text) {
    return el("p", { "class": "sm dim", text: text });
  }

  /* Moon.UI.notice emits .notice--kind; moon.css styles .notice.is-kind. Both
     hooks are set so neither file has to be touched. */
  function band(spec) {
    var UI = Moon.UI;
    if (!UI || typeof UI.notice !== "function") {
      return small(spec.messageKey ? t(spec.messageKey, spec.params) : "");
    }
    var node = UI.notice(spec);
    addClass(node, "is-" + (spec.kind || "info"));
    return node;
  }

  function fieldOf(spec) {
    var UI = Moon.UI;
    if (!UI || typeof UI.field !== "function") return null;
    return UI.field(spec);
  }

  /* A radio group: <fieldset> with a dim legend and one .switch row per option,
     which is how moon.css already dresses a label beside a control. */
  function radioGroup(spec) {
    var name = util.id("r");
    var box = el("fieldset", { "class": "field" });
    box.appendChild(el("legend", { "class": "field__label", text: t(spec.labelKey) }));

    (spec.options || []).forEach(function (option) {
      var id = util.id("o");
      var input = el("input", {
        type: "radio",
        name: name,
        id: id,
        value: option.value
      });
      input.checked = option.value === spec.value;
      input.addEventListener("change", function () {
        if (input.checked && typeof spec.onChange === "function") spec.onChange(option.value);
      });
      box.appendChild(el("label", { "class": "switch", "for": id }, [
        input,
        el("span", { text: t(option.labelKey) })
      ]));
    });

    if (spec.hintKey) box.appendChild(el("p", { "class": "field__hint", text: t(spec.hintKey) }));
    return box;
  }

  function section(spec) {
    var UI = Moon.UI;
    if (UI && typeof UI.section === "function") return UI.section(spec);
    /* Should never happen; a bare <section> still keeps the heading order. */
    return el("section", { "class": "section" }, [
      el("h2", { "class": "section__title", text: t(spec.titleKey) }),
      el("div", { "class": "section__body" }, spec.body)
    ]);
  }

  /* ------------------------------------------------------------- downloads */

  /* Hands the reader a file without a server. Returns false when the browser
     refused, and the caller then shows the text instead (data.backup.fallback). */
  function download(filename, text, mime) {
    var url = null;
    var revoke = false;
    try {
      if (typeof global.Blob === "function" && global.URL && typeof global.URL.createObjectURL === "function") {
        url = global.URL.createObjectURL(new global.Blob([text], { type: mime || "application/json" }));
        revoke = true;
      } else {
        url = "data:" + (mime || "application/json") + ";charset=utf-8," + global.encodeURIComponent(text);
      }
      var anchor = el("a", { href: url, download: filename, "class": "sr" });
      doc.body.appendChild(anchor);
      anchor.click();
      doc.body.removeChild(anchor);
      return true;
    } catch (error) {
      if (global.console) global.console.error("Moon.Views.data download", error);
      return false;
    } finally {
      if (revoke && url) {
        /* Released on the next turn: revoking inside the click handler cancels
           the download in some engines. */
        global.setTimeout(function () {
          try {
            global.URL.revokeObjectURL(url);
          } catch (error) { /* already gone */ }
        }, 0);
      }
    }
  }

  function exportText() {
    var st = store();
    if (!st || typeof st.exportJson !== "function") return null;
    try {
      return st.exportJson();
    } catch (error) {
      if (global.console) global.console.error("Moon.Views.data exportJson", error);
      return null;
    }
  }

  function exportName() {
    var st = store();
    if (st && typeof st.exportFilename === "function") {
      try {
        return st.exportFilename();
      } catch (error) { /* fall through */ }
    }
    return "moon.json";
  }

  function markBackupTaken() {
    var st = store();
    if (!st || typeof st.update !== "function") return;
    var today = Moon.Dates && typeof Moon.Dates.today === "function" ? Moon.Dates.today() : null;
    /* countsAsChange:false — taking a backup is not a change to back up (E7). */
    st.update(function (draft) {
      if (!draft.settings) draft.settings = {};
      draft.settings.lastBackup = today;
      draft.settings.changesSinceBackup = 0;
    }, { reason: "data:backup", immediate: true, countsAsChange: false });
  }

  function takeBackup() {
    var text = exportText();
    if (text === null) {
      say("err.unknown");
      redraw();
      return;
    }
    var name = exportName();
    bak.fallbackText = null;
    bak.doneFile = null;
    if (download(name, text, "application/json")) {
      bak.doneFile = name;
      markBackupTaken();          /* redraws through state:change */
      redraw();
      return;
    }
    bak.fallbackText = text;
    redraw();
  }

  /* The A9 escape hatch: one click that gets the data out of a browser that can
     no longer store it. Deliberately does NOT reset the nudge counter, because a
     quota-blocked session may not have persisted what it just exported. */
  function emergencyExport() {
    var text = exportText();
    if (text === null) return;
    if (!download(exportName(), text, "application/json")) {
      bak.fallbackText = text;
      redraw();
    }
  }

  /* ----------------------------------------------------------- CSV wizard */

  function resetWizard() {
    wiz = freshWizard();
  }

  function wizardError(key, params) {
    wiz.busy = false;
    wiz.errorKey = key || "err.unknown";
    wiz.errorParams = params || null;
    redraw();
  }

  function acceptableName(file) {
    return /\.(csv|txt)$/i.test(String((file && file.name) || ""));
  }

  function pickFile(files) {
    var list = files && files.length ? Array.prototype.slice.call(files) : [];
    for (var i = 0; i < list.length; i += 1) {
      if (acceptableName(list[i])) return list[i];
    }
    return list.length ? list[0] : null;
  }

  /* Step 1 -> step 2. Reads bytes once; every later override re-decodes the
     bytes we already hold rather than touching the file again. */
  function beginRead(file) {
    var CSV = Moon.CSV;
    if (!file) return;
    if (!CSV || typeof CSV.read !== "function") {
      wizardError("err.unknown");
      return;
    }
    if (!acceptableName(file)) {
      wizardError("csv.err.notCsv");
      return;
    }
    if (typeof file.size === "number" && CSV.MAX_BYTES && file.size > CSV.MAX_BYTES) {
      wizardError("csv.err.tooBig", { size: fmtBytes(file.size) });
      return;
    }

    resetWizard();
    wiz.file = file;
    wiz.busy = true;
    wiz.errorKey = null;
    redraw();

    CSV.read(file).then(function (result) {
      wiz.busy = false;
      wiz.bytes = result.bytes || null;
      wiz.text = result.text || "";
      wiz.encoding = result.encoding || "utf-8";
      wiz.warnings = result.warnings || [];
      reparse({ reguess: true });
      wiz.step = 2;
      redraw();
    }, function (error) {
      var key = error && error.key ? error.key : "csv.err.readFailed";
      var params = null;
      if (key === "csv.tooLarge") {
        params = { size: fmtBytes((file && file.size) || 0) };
      }
      wizardError(key, params);
    });
  }

  /* Re-reads the table from the bytes we already hold.
       opts.decode  — the encoding changed, so the text must be rebuilt
       opts.reguess — the columns changed meaning, so the roles must be re-read
     The delimiter and the header row are sniffed exactly once, on the first
     read: after that they belong to the reader, and a re-decode must not
     quietly undo a choice they made. */
  function reparse(opts) {
    var CSV = Moon.CSV;
    var options = opts || {};
    if (!CSV || typeof CSV.parse !== "function") return;

    if (options.decode && wiz.bytes && typeof CSV.decode === "function") {
      try {
        var decoded = CSV.decode(wiz.bytes, wiz.encoding);
        wiz.text = decoded.text;
        wiz.encoding = decoded.encoding;
        wiz.warnings = decoded.warnings || [];
      } catch (error) {
        wiz.errorKey = (error && error.key) || "csv.err.readFailed";
        wiz.parsed = null;
        return;
      }
    }

    if (!wiz.sniffed && typeof CSV.sniff === "function") {
      var sniffed = CSV.sniff(wiz.text);
      wiz.delimiter = sniffed.delimiter || ";";
      wiz.headerRow = typeof sniffed.headerRow === "number" ? sniffed.headerRow : 0;
      wiz.sniffed = true;
    }

    try {
      wiz.parsed = CSV.parse(wiz.text, { delimiter: wiz.delimiter, headerRow: wiz.headerRow });
      wiz.errorKey = null;
    } catch (error) {
      wiz.parsed = null;
      wiz.errorKey = (error && error.key) || "csv.err.readFailed";
      return;
    }

    if (options.reguess) {
      var Importer = Moon.Importer;
      var guess = null;
      if (Importer && typeof Importer.guessRoles === "function") {
        guess = Importer.guessRoles(wiz.parsed.headers, wiz.parsed.rows, { delimiter: wiz.delimiter });
      }
      wiz.guess = guess;
      wiz.colRoles = rolesFrom(guess, columnCount());
      if (guess) {
        wiz.dateOrder = guess.dateOrder === "mdy" ? "mdy" : "dmy";
        wiz.decimal = guess.decimal === "." ? "." : ",";
        wiz.signRule = guess.signRule === "debitCredit" ? "debitCredit" : "negativeIsExpense";
      }
      if (!wiz.defaultCategoryId) wiz.defaultCategoryId = defaultCategoryGuess();
    }
    /* Any of these invalidates the review: the drafts and the per-row duplicate
       decisions were made against a table that no longer exists. */
    wiz.built = null;
    wiz.skipLines = null;
  }

  function columnCount() {
    if (!wiz.parsed) return 0;
    var width = wiz.parsed.headers.length;
    wiz.parsed.rows.forEach(function (row) {
      if (row && row.length > width) width = row.length;
    });
    return width;
  }

  function rolesFrom(guess, width) {
    var cols = [];
    var i;
    for (i = 0; i < width; i += 1) cols.push("ignore");
    MAPPED_ROLES.forEach(function (role) {
      var index = guess ? guess[role] : null;
      if (typeof index === "number" && index >= 0 && index < width) cols[index] = role;
    });
    return cols;
  }

  function mapping() {
    var map = {
      date: null, note: null, amount: null, debit: null, credit: null, category: null,
      dateOrder: wiz.dateOrder, decimal: wiz.decimal, signRule: wiz.signRule
    };
    wiz.colRoles.forEach(function (role, index) {
      if (MAPPED_ROLES.indexOf(role) !== -1 && map[role] === null) map[role] = index;
    });
    return map;
  }

  /* One column per role: handing "date" to another column releases the old one. */
  function setRole(index, role) {
    if (role !== "ignore") {
      wiz.colRoles = wiz.colRoles.map(function (current, i) {
        return i !== index && current === role ? "ignore" : current;
      });
    }
    wiz.colRoles[index] = role;
    wiz.built = null;
    wiz.skipLines = null;
    redraw();
  }

  /* A sample, not the column: this runs on every draw, and a 50 000 row file
     must not pay for it. Two hundred values settle any question asked here. */
  function columnValues(index) {
    var out = [];
    if (!wiz.parsed || index === null || index === undefined || index < 0) return out;
    var rows = wiz.parsed.rows;
    for (var i = 0; i < rows.length && out.length < SAMPLE_VALUES; i += 1) {
      var value = rows[i] ? rows[i][index] : null;
      if (value !== null && value !== undefined && /\S/.test(String(value))) out.push(String(value));
    }
    return out;
  }

  /* An expense category to fall back on, preferring the catalogue's "other" by
     name. Category names are stored as plain text at setup, so a name match is
     the only link back to the key — a miss just takes the last loose category. */
  function defaultCategoryGuess() {
    var m = model();
    if (!m || typeof m.categories !== "function") return null;
    var list = [];
    try {
      list = m.categories({ kind: "expense" }) || [];
    } catch (error) {
      return null;
    }
    if (!list.length) return null;

    var wanted = util.searchKey(t("cat.other"));
    var loose = null;
    var i;
    for (i = 0; i < list.length; i += 1) {
      if (wanted && util.searchKey(list[i].name) === wanted) return list[i].id;
      if (!list[i].fixed) loose = list[i].id;
    }
    return loose || list[0].id;
  }

  function buildDrafts() {
    var Importer = Moon.Importer;
    if (!Importer || typeof Importer.build !== "function" || !wiz.parsed) return null;
    /* skipDuplicates:false so every row reaches `drafts`; which duplicates are
       actually written is the reader's per-row decision below. */
    var built = Importer.build(wiz.parsed, mapping(), {
      monthStartDay: monthStartDay(),
      defaultCategoryId: wiz.defaultCategoryId,
      skipDuplicates: false
    });
    if (wiz.skipLines === null) {
      wiz.skipLines = {};
      (built.duplicates || []).forEach(function (dup) {
        /* Already in the ledger: skip by default. Repeated inside this one file:
           keep by default, because two identical real payments do happen. */
        if (!dup.inFile) wiz.skipLines[dup.line] = true;
      });
    }
    return built;
  }

  function ensureBuilt() {
    if (!wiz.built) wiz.built = buildDrafts();
    return wiz.built;
  }

  function selectedDrafts() {
    var built = wiz.built;
    if (!built || built.error) return [];
    var lines = built.draftLines || [];
    var out = [];
    (built.drafts || []).forEach(function (draft, i) {
      var line = lines[i];
      if (wiz.skipLines && wiz.skipLines[line]) return;
      out.push(draft);
    });
    return out;
  }

  /* Model.validateEntry requires a real category, so a draft without one would
     be dropped in silence by addEntries. Every draft gets one here. */
  function withCategory(draft) {
    var m = model();
    if (!m) return null;
    var id = draft.categoryId;
    var kind = draft.direction === "in" ? "income" : "expense";
    var cat = id && typeof m.categoryById === "function" ? m.categoryById(id) : null;

    if (!cat || cat.kind !== kind) {
      cat = null;
      var chosen = wiz.defaultCategoryId && typeof m.categoryById === "function"
        ? m.categoryById(wiz.defaultCategoryId) : null;
      if (chosen && chosen.kind === kind) cat = chosen;
      if (!cat) {
        var pool = [];
        try {
          pool = m.categories({ kind: kind }) || [];
        } catch (error) {
          pool = [];
        }
        cat = pool.length ? pool[0] : null;
      }
    }
    if (!cat) return null;

    return {
      date: draft.date,
      amount: draft.amount,
      direction: draft.direction,
      categoryId: cat.id,
      note: draft.note,
      fixed: !!cat.fixed,
      source: "csv",
      confirmed: false,
      recurringId: null
    };
  }

  function writeDrafts() {
    var m = model();
    if (!m || typeof m.addEntries !== "function") {
      wizardError("err.unknown");
      return;
    }
    ensureBuilt();
    var chosen = selectedDrafts();
    var rows = [];
    chosen.forEach(function (draft) {
      var ready = withCategory(draft);
      if (ready) rows.push(ready);
    });
    if (!rows.length) {
      /* Two different dead ends: nothing was selected, or nothing could be
         filed because this browser has no category of the needed kind left. */
      wizardError(chosen.length ? "err.badCategory" : "csv.err.empty");
      return;
    }
    /* One call, one write, one state:change — that is the contract for §9 step 4. */
    var ids = m.addEntries(rows) || [];
    wiz.written = { count: ids.length };
    wiz.step = 4;
    redraw();
  }

  /* ------------------------------------------------------- wizard rendering */

  function stepsBar() {
    var bar = el("div", { "class": "steps" });
    var titles = ["csv.step1.title", "csv.step2.title", "csv.step3.title", "csv.step4.title"];
    titles.forEach(function (key, index) {
      var isActive = wiz.step === index + 1;
      var item = el("span", {
        "class": "steps__item" + (isActive ? " is-active" : ""),
        text: t(key)
      });
      if (isActive) item.setAttribute("aria-current", "step");
      bar.appendChild(item);
    });
    return bar;
  }

  function stepOne() {
    var input = null;
    var id = util.id("csvfile");
    var zone = el("div", { "class": "dropzone" });

    zone.appendChild(prose(t("csv.step1.body")));

    var picker = el("div", { "class": "field" }, [
      el("label", { "class": "field__label", "for": id, text: t("csv.step1.choose") }),
      (function () {
        input = el("input", {
          type: "file",
          id: id,
          "class": "field__input",
          accept: ".csv,.txt,text/csv,text/plain"
        });
        input.addEventListener("change", function () {
          var file = pickFile(input.files);
          if (file) beginRead(file);
        });
        return input;
      })(),
      el("p", { "class": "field__hint", text: t("csv.step1.accept") })
    ]);
    zone.appendChild(picker);

    if (Moon.UI && typeof Moon.UI.dropZone === "function") {
      Moon.UI.dropZone(zone, function (files) {
        var file = pickFile(files);
        if (file) beginRead(file);
      });
    }

    var body = [zone];
    if (wiz.busy) body.push(small(t("common.loading")));
    if (wiz.file && typeof wiz.file.size === "number" && wiz.file.size > BIG_FILE) {
      body.push(small(t("csv.step1.big", { size: fmtBytes(wiz.file.size) })));
    }
    return body;
  }

  function overrideFields() {
    var rows = [];

    var delimiterField = fieldOf({
      type: "select",
      name: "delimiter",
      labelKey: "csv.delimiter",
      value: wiz.delimiter,
      options: DELIMITERS,
      onChange: function (value) {
        if (!value || value === wiz.delimiter) return;
        wiz.delimiter = value;
        /* A different delimiter is a different table: the roles are re-read. */
        reparse({ reguess: true });
        redraw();
      }
    });

    var encodingField = fieldOf({
      type: "select",
      name: "encoding",
      labelKey: "csv.encoding",
      value: wiz.encoding,
      options: ENCODINGS,
      onChange: function (value) {
        if (!value || value === wiz.encoding) return;
        wiz.encoding = value;
        /* Decodes the bytes we already hold — the file is never read twice. */
        reparse({ decode: true, reguess: true });
        redraw();
      }
    });

    var headerField = fieldOf({
      type: "number",
      name: "headerRow",
      labelKey: "csv.headerRow",
      hintKey: "csv.headerRow.hint",
      /* Shown one-based: the reader counts lines in their file, not indexes. */
      value: wiz.headerRow + 1,
      min: 1,
      step: 1,
      onChange: function (value) {
        var next = typeof value === "number" && value >= 1 ? Math.floor(value) - 1 : 0;
        if (next === wiz.headerRow) return;
        wiz.headerRow = next;
        reparse({ reguess: true });
        redraw();
      }
    });

    var orderField = fieldOf({
      type: "select",
      name: "dateOrder",
      labelKey: "csv.dateOrder",
      value: wiz.dateOrder,
      options: [
        { value: "dmy", labelKey: "csv.dateOrder.dmy" },
        { value: "mdy", labelKey: "csv.dateOrder.mdy" }
      ],
      onChange: function (value) {
        wiz.dateOrder = value === "mdy" ? "mdy" : "dmy";
        wiz.built = null;
        wiz.skipLines = null;
        redraw();
      }
    });

    var decimalField = fieldOf({
      type: "select",
      name: "decimal",
      labelKey: "csv.decimal",
      value: wiz.decimal,
      options: [
        { value: ",", labelKey: "csv.decimal.comma" },
        { value: ".", labelKey: "csv.decimal.dot" }
      ],
      onChange: function (value) {
        wiz.decimal = value === "." ? "." : ",";
        wiz.built = null;
        wiz.skipLines = null;
        redraw();
      }
    });

    var signField = fieldOf({
      type: "select",
      name: "signRule",
      labelKey: "csv.signRule",
      value: wiz.signRule,
      options: [
        { value: "negativeIsExpense", labelKey: "csv.signRule.negativeIsExpense" },
        { value: "debitCredit", labelKey: "csv.signRule.debitCredit" }
      ],
      onChange: function (value) {
        wiz.signRule = value === "debitCredit" ? "debitCredit" : "negativeIsExpense";
        wiz.built = null;
        wiz.skipLines = null;
        redraw();
      }
    });

    rows.push(el("div", { "class": "form__row" }, [delimiterField, encodingField, headerField]));
    rows.push(el("div", { "class": "form__row" }, [orderField, decimalField, signField]));
    return rows;
  }

  function confidenceFor(index) {
    if (!wiz.guess || !wiz.guess.scores) return null;
    var role = wiz.colRoles[index];
    var score = null;
    if (role === "date" && wiz.guess.date === index) score = wiz.guess.scores.date;
    if (role === "amount" && wiz.guess.amount === index) score = wiz.guess.scores.amount;
    if (typeof score !== "number" || !isFinite(score) || score <= 0) return null;
    return Math.round(util.clamp(score, 0, 1) * 100);
  }

  function roleSelect(index) {
    var id = util.id("role");
    var select = el("select", { id: id, "class": "field__input" });
    ROLES.forEach(function (role) {
      var attrs = { value: role };
      if (wiz.colRoles[index] === role) attrs.selected = true;
      select.appendChild(el("option", attrs, t("csv.role." + role)));
    });
    select.addEventListener("change", function () {
      setRole(index, select.value);
    });
    return dom.frag([
      el("label", { "class": "sr", "for": id, text: t("csv.role") }),
      select
    ]);
  }

  function previewTable() {
    var width = columnCount();
    var rows = wiz.parsed ? wiz.parsed.rows.slice(0, PREVIEW_ROWS) : [];
    var table = el("table", { "class": "table" });

    var headRow = el("tr");
    var i;
    for (i = 0; i < width; i += 1) {
      var head = el("th", { scope: "col" });
      var headerText = (wiz.parsed && wiz.parsed.headers[i]) || "";
      head.appendChild(el("span", { "class": "dim", text: headerText }));
      head.appendChild(roleSelect(i));
      var pct = confidenceFor(i);
      if (pct !== null) {
        head.appendChild(el("span", { "class": "tick", text: t("csv.role.confidence", { pct: pct }) }));
      }
      headRow.appendChild(head);
    }

    var body = el("tbody");
    rows.forEach(function (row) {
      var tr = el("tr");
      for (var c = 0; c < width; c += 1) {
        var value = row && row[c] !== undefined && row[c] !== null ? String(row[c]) : "";
        tr.appendChild(el("td", { text: value }));
      }
      body.appendChild(tr);
    });

    table.appendChild(el("thead", null, headRow));
    table.appendChild(body);
    return el("div", { "class": "preview" }, table);
  }

  function dateSampleLine() {
    var map = mapping();
    if (map.date === null) return null;
    var values = columnValues(map.date);
    if (!values.length) return null;
    var raw = values[0];
    var Dates = Moon.Dates;
    if (!Dates || typeof Dates.parseFlexible !== "function") return null;
    var iso = Dates.parseFlexible(raw, { order: wiz.dateOrder });
    if (!iso) return null;
    return small(t("csv.dateSample", { raw: raw, parsed: fmtDate(iso, "long") }));
  }

  function stepTwoNotices() {
    var out = [];
    var map = mapping();

    (wiz.warnings || []).forEach(function (key) {
      out.push(band({ kind: "warn", messageKey: key }));
    });

    if (map.date === null) {
      out.push(band({ kind: "warn", messageKey: "csv.err.noDate" }));
    } else {
      var Dates = Moon.Dates;
      var samples = columnValues(map.date).slice(0, 40);
      if (Dates && typeof Dates.guessOrder === "function" && samples.length &&
          Dates.guessOrder(samples) === null) {
        out.push(band({ kind: "info", messageKey: "csv.err.ambiguousDate" }));
      }
    }

    if (map.amount === null && map.debit === null && map.credit === null) {
      out.push(band({ kind: "warn", messageKey: "csv.err.noAmount" }));
    } else {
      var numeric = [];
      [map.amount, map.debit, map.credit].forEach(function (index) {
        if (index !== null) numeric = numeric.concat(columnValues(index));
      });
      var CSV = Moon.CSV;
      if (numeric.length && CSV && typeof CSV.detectDecimal === "function" &&
          CSV.detectDecimal(numeric) === null) {
        out.push(band({
          kind: "info",
          messageKey: "csv.err.ambiguousDecimal",
          params: { sample: numeric[0] }
        }));
      }
    }
    return out;
  }

  function stepTwo() {
    var body = [];
    if (!wiz.parsed) {
      body.push(small(t("csv.err.empty")));
      return body;
    }

    body.push(prose(t("csv.step2.body")));
    stepTwoNotices().forEach(function (node) {
      body.push(node);
    });
    overrideFields().forEach(function (row) {
      body.push(row);
    });

    var sample = dateSampleLine();
    if (sample) body.push(sample);

    body.push(small(t("csv.preview", {
      count: Math.min(PREVIEW_ROWS, wiz.parsed.rows.length)
    })));
    body.push(previewTable());
    return body;
  }

  function reasonText(kind) {
    return t("csv.reason." + kind);
  }

  function duplicatesBlock(built) {
    var list = built.duplicates || [];
    if (!list.length) return null;

    var box = el("details", { "class": "numbers" });
    box.appendChild(el("summary", null, t("csv.duplicates.title")));
    box.appendChild(el("p", { "class": "prose sm", text: t("csv.duplicates.body") }));

    var items = el("ul");
    list.forEach(function (dup) {
      var id = util.id("dup");
      var input = el("input", { type: "checkbox", id: id });
      input.checked = !!(wiz.skipLines && wiz.skipLines[dup.line]);
      input.addEventListener("change", function () {
        if (!wiz.skipLines) wiz.skipLines = {};
        if (input.checked) wiz.skipLines[dup.line] = true;
        else delete wiz.skipLines[dup.line];
        redraw();
      });
      items.appendChild(el("li", null, el("label", { "class": "switch", "for": id }, [
        input,
        el("span", {
          text: t("csv.duplicates.row", {
            line: dup.line,
            date: fmtDate(dup.draft.date, "long"),
            amount: fmtMoney(dup.draft.amount)
          })
        })
      ])));
    });
    box.appendChild(items);
    return box;
  }

  /* csv.js drops two kinds of row before the importer ever sees them: a header
     repeated at a page break and a TOPLAM line. They never reach `summary`, so
     they are added to both sides of the arithmetic — otherwise the sentence and
     the list below it disagree. A ragged row or an unclosed quote is NOT in this
     set: those rows were kept, and they show up as imported or as a rejection
     with their own reason. */
  function droppedKinds() {
    var out = [];
    if (!wiz.parsed) return out;
    (wiz.parsed.issues || []).forEach(function (issue) {
      if (issue.kind === "repeatedHeader" || issue.kind === "summaryRow") out.push(issue);
    });
    return out;
  }

  function skippedBlock(built) {
    var list = [];
    (built.rejected || []).forEach(function (row) {
      list.push({ line: row.line, reason: reasonText(row.reason) });
    });
    droppedKinds().forEach(function (issue) {
      list.push({ line: issue.line, reason: reasonText(issue.kind) });
    });
    if (!list.length) return null;

    list = util.sortBy(list, function (row) {
      return typeof row.line === "number" ? row.line : 0;
    });

    var box = el("details", { "class": "numbers" });
    box.appendChild(el("summary", null, t("csv.skipped.title")));
    box.appendChild(el("p", { "class": "prose sm", text: t("csv.skipped.body") }));
    var items = el("ul");
    list.forEach(function (row) {
      items.appendChild(el("li", {
        "class": "sm",
        text: t("csv.skipped.row", { line: row.line, reason: row.reason })
      }));
    });
    box.appendChild(items);
    return box;
  }

  /* One sentence, one arithmetic: read = importable + duplicate + skipped. */
  function summarySentence(built) {
    var summary = built.summary || {};
    var dropped = droppedKinds().length;
    return t("csv.step3.summary", {
      total: (summary.total || 0) + dropped,
      ok: selectedDrafts().length,
      duplicate: summary.duplicate || 0,
      rejected: (summary.rejected || 0) + dropped
    });
  }

  function stepThree() {
    var body = [];
    var built = ensureBuilt();

    if (!built) {
      body.push(small(t("err.unknown")));
      return body;
    }
    /* A build error means `drafts` is empty and the summary would lie (§9). */
    if (built.error) {
      body.push(band({ kind: "warn", messageKey: built.error }));
      return body;
    }

    var summary = built.summary || {};
    var lines = el("div", { "class": "form__summary" });
    lines.appendChild(el("p", { text: summarySentence(built) }));
    if (summary.dateRange && summary.dateRange[0] && summary.dateRange[1]) {
      lines.appendChild(el("p", {
        text: t("csv.step3.range", {
          from: fmtDate(summary.dateRange[0], "long"),
          to: fmtDate(summary.dateRange[1], "long")
        })
      }));
    }
    lines.appendChild(el("p", {
      text: t("csv.step3.sums", {
        out: fmtMoney(summary.sumOut || 0),
        "in": fmtMoney(summary.sumIn || 0)
      })
    }));
    body.push(lines);

    var categoryField = fieldOf({
      type: "select",
      name: "defaultCategory",
      labelKey: "csv.defaultCategory",
      hintKey: "csv.defaultCategory.hint",
      value: wiz.defaultCategoryId,
      options: categoryOptions(null),
      onChange: function (value) {
        wiz.defaultCategoryId = value || null;
        wiz.built = null;
        redraw();
      }
    });
    if (categoryField) body.push(categoryField);

    var dups = duplicatesBlock(built);
    if (dups) body.push(dups);
    var skipped = skippedBlock(built);
    if (skipped) body.push(skipped);

    return body;
  }

  function stepFour() {
    var body = [];

    if (wiz.written) {
      body.push(band({
        kind: "info",
        messageKey: "csv.done",
        params: { count: wiz.written.count },
        body: prose(t("csv.done.body"))
      }));
      return body;
    }

    var built = ensureBuilt();
    if (!built || built.error) {
      body.push(band({ kind: "warn", messageKey: (built && built.error) || "err.unknown" }));
      return body;
    }
    body.push(prose(summarySentence(built)));
    return body;
  }

  function wizardNav() {
    var list = [];

    if (wiz.step > 1 && !wiz.written) {
      list.push(button(t("csv.back"), "quiet", function () {
        wiz.step = wiz.step - 1;
        redraw();
      }));
    }

    if (wiz.step === 2) {
      var map = mapping();
      var ready = map.date !== null && (map.amount !== null || map.debit !== null || map.credit !== null);
      list.push(button(t("csv.next"), "primary", function () {
        wiz.step = 3;
        wiz.built = null;
        redraw();
      }, { disabled: !ready }));
    }

    if (wiz.step === 3) {
      var built = ensureBuilt();
      var can = !!built && !built.error && selectedDrafts().length > 0;
      list.push(button(t("csv.next"), "primary", function () {
        wiz.step = 4;
        redraw();
      }, { disabled: !can }));
    }

    if (wiz.step === 4 && !wiz.written) {
      var can4 = (function () {
        var b = ensureBuilt();
        return !!b && !b.error && selectedDrafts().length > 0;
      })();
      list.push(button(t("csv.step4.action"), "primary", writeDrafts, { disabled: !can4 }));
    }

    if (wiz.written || wiz.errorKey) {
      list.push(button(t("common.close"), "quiet", function () {
        resetWizard();
        redraw();
      }));
    }

    return list.length ? actions(list) : null;
  }

  function wizardSection() {
    var body = [stepsBar()];

    if (wiz.errorKey) {
      body.push(band({ kind: "error", messageKey: wiz.errorKey, params: wiz.errorParams }));
    }

    var stepBody;
    if (wiz.step === 2) stepBody = stepTwo();
    else if (wiz.step === 3) stepBody = stepThree();
    else if (wiz.step === 4) stepBody = stepFour();
    else stepBody = stepOne();

    stepBody.forEach(function (node) {
      if (node) body.push(node);
    });

    var nav = wizardNav();
    if (nav) body.push(nav);

    return section({
      id: "veri-csv",
      titleKey: "csv.title",
      asideKey: "csv.step",
      asideParams: { step: wiz.step, total: WIZARD_STEPS },
      body: stack(body)
    });
  }

  /* --------------------------------------------------------------- backup */

  function backupSection() {
    var body = [];
    var s = settings();
    var count = entryCount();

    if (!count) {
      body.push(Moon.UI && Moon.UI.emptyState
        ? Moon.UI.emptyState({ headingKey: "empty.data.heading", bodyKey: "empty.data.body" })
        : prose(t("empty.data.body")));
      return section({ id: "veri-yedek", titleKey: "data.backup.title", body: stack(body) });
    }

    body.push(prose(t("data.backup.body")));

    var changes = typeof s.changesSinceBackup === "number" ? s.changesSinceBackup : 0;
    if (!s.lastBackup) {
      body.push(band({ kind: "warn", messageKey: "data.backup.nudge.never" }));
    } else {
      body.push(small(t("data.backup.last", { date: fmtDate(s.lastBackup, "long") })));
      if (changes >= NUDGE_AT) {
        body.push(band({ kind: "warn", messageKey: "data.backup.nudge", params: { count: changes } }));
      }
    }

    if (bak.doneFile) {
      body.push(band({
        kind: "info",
        messageKey: "data.backup.done",
        params: { file: bak.doneFile }
      }));
    }

    body.push(actions([button(t("data.backup.action"), "primary", takeBackup)]));

    if (bak.fallbackText !== null) {
      body.push(band({ kind: "warn", messageKey: "data.backup.fallback" }));
      var area = el("textarea", {
        "class": "field__input",
        rows: 8,
        readonly: true,
        spellcheck: "false",
        "aria-label": t("data.backup.copy")
      });
      area.value = bak.fallbackText;
      body.push(area);
      body.push(actions([button(t("data.backup.copy"), "quiet", function () {
        try {
          area.focus();
          area.select();
        } catch (error) { /* a read-only textarea that refuses to select */ }
      })]));
      /* Selected on arrival: one Ctrl+C and the backup is in the clipboard. */
      global.setTimeout(function () {
        try {
          area.focus();
          area.select();
        } catch (error) { /* no focus available */ }
      }, 0);
    }

    return section({ id: "veri-yedek", titleKey: "data.backup.title", body: stack(body) });
  }

  /* -------------------------------------------------------------- restore */

  function readRestoreFile(file) {
    if (!file) return;
    rst.name = file.name || null;
    rst.text = null;
    rst.errorKey = null;
    rst.done = null;
    rst.busy = true;
    redraw();

    if (typeof global.FileReader !== "function") {
      rst.busy = false;
      rst.errorKey = "err.readFailed";
      redraw();
      return;
    }
    var reader = new global.FileReader();
    reader.onerror = function () {
      rst.busy = false;
      rst.errorKey = "err.readFailed";
      redraw();
    };
    reader.onload = function () {
      rst.busy = false;
      rst.text = String(reader.result === null || reader.result === undefined ? "" : reader.result);
      redraw();
    };
    try {
      reader.readAsText(file, "utf-8");
    } catch (error) {
      rst.busy = false;
      rst.errorKey = "err.readFailed";
      redraw();
    }
  }

  function runRestore() {
    var st = store();
    if (!st || typeof st.importJson !== "function" || rst.text === null) return;
    var UI = Moon.UI;
    var ask = UI && typeof UI.confirm === "function"
      ? UI.confirm({
        titleKey: "data.restore.confirm.title",
        bodyKey: "data.restore.confirm.body",
        confirmKey: "data.restore.title",
        danger: true
      })
      : global.Promise.resolve(true);

    ask.then(function (yes) {
      if (!yes) return;
      /* The mode travels explicitly (E7): the default is not the reader's choice. */
      var result = st.importJson(rst.text, { mode: rst.mode });
      if (!result || !result.ok) {
        rst.errorKey = (result && result.reason === "newerSchema")
          ? "err.importNewer"
          : ((result && result.error) || "err.importBadFile");
        rst.done = null;
      } else {
        rst.errorKey = null;
        rst.done = {
          entries: (result.counts && result.counts.entries) || 0,
          categories: (result.counts && result.counts.categories) || 0,
          skipped: (result.counts && result.counts.skipped) || 0
        };
        rst.text = null;
        rst.name = null;
      }
      redraw();
    });
  }

  function restoreSection() {
    var body = [prose(t("data.restore.body"))];
    var id = util.id("restore");

    var input = el("input", {
      type: "file",
      id: id,
      "class": "field__input",
      accept: ".json,application/json"
    });
    input.addEventListener("change", function () {
      if (input.files && input.files.length) readRestoreFile(input.files[0]);
    });
    body.push(el("div", { "class": "field" }, [
      el("label", { "class": "field__label", "for": id, text: t("data.restore.action") }),
      input
    ]));

    if (rst.busy) body.push(small(t("common.loading")));
    if (rst.errorKey) body.push(band({ kind: "error", messageKey: rst.errorKey }));

    if (rst.done) {
      body.push(band({
        kind: "info",
        messageKey: "data.restore.done",
        params: { entries: rst.done.entries, categories: rst.done.categories }
      }));
      if (rst.done.skipped) {
        body.push(small(t("data.restore.skipped", { count: rst.done.skipped })));
      }
    }

    if (rst.text !== null) {
      body.push(radioGroup({
        labelKey: "data.restore.mode",
        value: rst.mode,
        options: [
          { value: "replace", labelKey: "data.restore.mode.replace" },
          { value: "merge", labelKey: "data.restore.mode.merge" }
        ],
        onChange: function (value) {
          rst.mode = value === "merge" ? "merge" : "replace";
        }
      }));
      body.push(actions([
        button(t("data.restore.title"), "primary", runRestore),
        button(t("common.cancel"), "quiet", function () {
          rst.text = null;
          rst.name = null;
          redraw();
        })
      ]));
    }

    return section({ id: "veri-geri", titleKey: "data.restore.title", body: stack(body) });
  }

  /* --------------------------------------------------------------- sample */

  function sampleSection() {
    var Sample = Moon.Sample;
    var on = !!(Sample && typeof Sample.isOn === "function" && Sample.isOn());
    var body = [];

    if (on) {
      body.push(band({ kind: "sample", messageKey: "data.sample.strip" }));
    }
    body.push(prose(t("data.sample.body")));

    if (on) {
      body.push(actions([button(t("data.sample.off"), "quiet", function () {
        if (Sample && typeof Sample.clear === "function") Sample.clear();
        say("data.sample.cleared");
        redraw();
      })]));
    } else {
      body.push(actions([button(t("data.sample.on"), "primary", function () {
        if (Sample && typeof Sample.apply === "function") Sample.apply();
        redraw();
      })]));
    }

    return section({ id: "veri-ornek", titleKey: "data.sample.title", body: stack(body) });
  }

  /* ------------------------------------------------------------- settings */

  function writeSetting(patch, reason) {
    var st = store();
    if (!st || typeof st.update !== "function") return;
    st.update(function (draft) {
      if (!draft.settings) draft.settings = {};
      Object.keys(patch).forEach(function (name) {
        draft.settings[name] = patch[name];
      });
    }, { reason: reason, immediate: true });
  }

  /* The theme lives on <html data-theme>; app.js owns the header control, so the
     change is announced as well as applied. */
  function applyTheme(theme) {
    try {
      var html = doc.documentElement;
      if (theme === "dial" || theme === "paper") html.setAttribute("data-theme", theme);
      else html.removeAttribute("data-theme");
    } catch (error) { /* no documentElement: the setting is still stored */ }
    if (Moon.bus && typeof Moon.bus.emit === "function") {
      Moon.bus.emit("theme:change", { theme: theme });
    }
  }

  function settingsSection() {
    var s = settings();
    var fields = [];

    var langField = fieldOf({
      type: "select",
      name: "lang",
      labelKey: "common.language",
      value: lang(),
      options: [
        { value: "tr", labelKey: "common.lang.tr" },
        { value: "en", labelKey: "common.lang.en" }
      ],
      onChange: function (value) {
        var I18n = Moon.I18n;
        if (I18n && typeof I18n.setLang === "function") I18n.setLang(value);
      }
    });

    var currencyField = fieldOf({
      type: "select",
      name: "currency",
      labelKey: "common.currency",
      hintKey: "data.settings.currency.hint",
      value: s.currency || "TRY",
      options: CURRENCIES.map(function (code) {
        return { value: code, label: code };
      }),
      onChange: function (value) {
        if (CURRENCIES.indexOf(value) === -1) return;
        writeSetting({ currency: value }, "settings:currency");
      }
    });

    var themeField = fieldOf({
      type: "select",
      name: "theme",
      labelKey: "common.theme",
      value: THEMES.indexOf(s.theme) === -1 ? "system" : s.theme,
      options: [
        { value: "system", labelKey: "common.theme.system" },
        { value: "dial", labelKey: "common.theme.dial" },
        { value: "paper", labelKey: "common.theme.paper" }
      ],
      onChange: function (value) {
        if (THEMES.indexOf(value) === -1) return;
        applyTheme(value);
        writeSetting({ theme: value }, "settings:theme");
      }
    });

    var dayField = fieldOf({
      type: "number",
      name: "monthStartDay",
      labelKey: "data.settings.monthStartDay",
      hintKey: "data.settings.monthStartDay.hint",
      value: monthStartDay(),
      min: 1,
      max: 28,
      step: 1,
      onChange: function (value, event, entry) {
        /* Validated here: the base layer has no settings validator, and the
           upper bound of 28 is what keeps short months from shifting a period. */
        var ok = typeof value === "number" && isFinite(value) && value >= 1 && value <= 28;
        if (!ok) {
          if (entry && entry.setError) entry.setError("err.badMonthStartDay");
          return;
        }
        if (entry && entry.setError) entry.setError(null);
        if (Math.floor(value) === monthStartDay()) return;
        writeSetting({ monthStartDay: Math.floor(value) }, "settings:monthStartDay");
      }
    });

    if (langField) fields.push(langField);
    if (currencyField) fields.push(currencyField);
    if (themeField) fields.push(themeField);
    if (dayField) fields.push(dayField);

    var body = fields.slice();

    body.push(radioGroup({
      labelKey: "data.settings.overflowMark",
      hintKey: "data.settings.overflowMark.hint",
      value: s.overflowMark === "flare" ? "flare" : "pigment",
      options: [
        { value: "pigment", labelKey: "data.settings.overflowMark.pigment" },
        { value: "flare", labelKey: "data.settings.overflowMark.flare" }
      ],
      onChange: function (value) {
        writeSetting({ overflowMark: value === "flare" ? "flare" : "pigment" }, "settings:overflowMark");
      }
    }));

    return section({ id: "veri-ayarlar", titleKey: "data.settings.title", body: stack(body) });
  }

  /* -------------------------------------------------------------- storage */

  function storageSection() {
    var st = store();
    var used = 0;
    if (st && typeof st.usage === "function") {
      try {
        used = st.usage().bytes || 0;
      } catch (error) {
        used = 0;
      }
    }
    var ratio = util.clamp(used / STORAGE_BUDGET, 0, 1);

    var meter = el("div", { "class": "storage" }, [
      el("p", {
        "class": "storage__read",
        /* "kayıt" in this app means an entry, so that is what is counted. */
        text: t("data.storage.usage", { used: fmtBytes(used), count: entryCount() })
      }),
      el("div", { "class": "storage__bar", "aria-hidden": "true" },
        el("div", { "class": "storage__fill", style: { width: (ratio * 100) + "%" } }))
    ]);

    return section({ id: "veri-depolama", titleKey: "data.storage.title", body: [meter] });
  }

  /* ----------------------------------------------------------------- wipe */

  function wipeSection() {
    var body = [prose(t("data.wipe.body"))];
    body.push(actions([button(t("data.wipe.action"), "danger", function () {
      var UI = Moon.UI;
      var ask = UI && typeof UI.confirm === "function"
        ? UI.confirm({
          titleKey: "data.wipe.confirm.title",
          bodyKey: "data.wipe.confirm.body",
          confirmKey: "data.wipe.action",
          danger: true
        })
        : global.Promise.resolve(false);
      ask.then(function (yes) {
        if (!yes) return;
        var st = store();
        resetWizard();
        rst = { name: null, text: null, mode: "replace", errorKey: null, done: null, busy: false };
        bak = { fallbackText: null, doneFile: null };
        if (st && typeof st.wipe === "function") st.wipe();
        say("data.wipe.done");
        redraw();
      });
    })]));

    return section({ id: "veri-sil", titleKey: "data.wipe.title", body: stack(body) });
  }

  /* ---------------------------------------------------------------- about */

  function aboutSection() {
    return section({
      id: "veri-hakkinda",
      titleKey: "about.title",
      body: stack([prose(t("about.body1")), prose(t("about.body2")), prose(t("about.body3"))])
    });
  }

  /* ---------------------------------------------------------- store errors */

  /* A9 made visible: a write that did not happen gets a standing band in this
     section — the one place the reader can act on it — plus the one action that
     rescues the data. The band is keyed on the payload's messageKey, never on a
     switch over `kind`, so a kind this file has never heard of still speaks. */
  function storeErrorBand() {
    if (!storeError) return null;
    var isQuota = storeError.kind === "quota";
    var spec = {
      kind: "error",
      messageKey: isQuota ? "data.quota.title" : (storeError.messageKey || "err.unknown"),
      actions: [{
        labelKey: "data.quota.action",
        kind: "primary",
        "class": "is-primary",
        onClick: emergencyExport
      }]
    };
    if (isQuota) spec.body = el("div", { "class": "notice__body" }, prose(t("data.quota.body")));
    return band(spec);
  }

  /* ---------------------------------------------------------------- render */

  function render(root) {
    if (!root) return;
    mounted = true;
    rootRef = root;
    dom.clear(root);

    /* A file dropped on the panel strip arrives before this view exists. */
    if (pendingFile) {
      var file = pendingFile;
      pendingFile = null;
      beginRead(file);
      return;
    }

    var errorBand = storeErrorBand();
    if (errorBand) root.appendChild(errorBand);

    if (flash) {
      var note = band({ kind: "info", messageKey: flash.key, params: flash.params });
      flash = null;           /* shown once, then it is history */
      root.appendChild(note);
    }

    root.appendChild(wizardSection());
    root.appendChild(backupSection());
    root.appendChild(restoreSection());
    root.appendChild(sampleSection());
    root.appendChild(settingsSection());
    root.appendChild(storageSection());
    root.appendChild(wipeSection());
    root.appendChild(aboutSection());
  }

  function destroy() {
    mounted = false;
    rootRef = null;
  }

  /* Called by the panel strip (G11) when a CSV lands there. Safe before the
     first render: the file is parked and the router is asked for this section. */
  function startImport(files) {
    var file = pickFile(files);
    if (!file) return;
    if (isActive()) {
      beginRead(file);
      return;
    }
    /* Parked, not read: the reader must see the wizard for the read to mean
       anything, and render() picks the file up as its first act. */
    pendingFile = file;
    if (Moon.App && typeof Moon.App.go === "function") Moon.App.go(VIEW_ID);
  }

  /* Subscribed once at load, not per render: an error raised while another
     section was open must still be waiting here when the reader arrives. */
  if (Moon.bus && typeof Moon.bus.on === "function") {
    Moon.bus.on("store:error", function (payload) {
      storeError = payload || { kind: "write", messageKey: "err.unknown" };
      /* Out of the emitter's turn: Store is mid-write when this fires. */
      global.setTimeout(redraw, 0);
    });
  }

  Moon.Views.data = {
    id: VIEW_ID,
    titleKey: "nav.data",
    render: render,
    destroy: destroy,
    startImport: startImport
  };
})(window);
