/* Moon — the panel (#panel), the first screen.
 *
 * One strip and three sections, in reading order: the measurement strip
 * (hero), the limit scales, then the two time charts. Everything on screen is
 * derived by Moon.Model; this file owns structure, labels and the keyboard
 * readout line, and writes nothing except when the reader presses the button
 * on the pending-recurring band.
 *
 * Four rules shape the code below:
 *   - Idempotent. The router re-renders on state:change and lang:change, so
 *     render() clears its root and rebuilds; no state survives between draws
 *     except the one drag timer that destroy() clears.
 *   - No sentence is built here. Every user-visible string comes from
 *     Moon.I18n.t, including the percent sign, which lives inside the keys.
 *   - Nothing is assumed to exist. Moon.App, Moon.Views.data and Moon.Sample
 *     are written by other agents; a missing one degrades the screen, never
 *     breaks it.
 *   - Empty data, a single entry, five hundred entries and a setup with no
 *     limits at all are four ordinary cases, not error paths.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var dom = Moon.dom;
  var util = Moon.util;
  var doc = global.document;

  /* The hero trace: 620x48 on a desk, 320x40 on a phone (E4, design §graphs). */
  var TRAIL = { w: 620, h: 48 };
  var TRAIL_NARROW = { w: 320, h: 40 };

  /* Track and readout are one ratio, not two numbers (E4): the overrun is only
     allowed to spill into the readout column because these two agree. */
  var METER_TRACK = 240;
  var METER_READOUT = 132;
  var METER_HEIGHT = 44;

  /* The panel shows the worst few scales and links to the rest. */
  var METER_LIMIT = 6;

  /* Below this width the Turkish sentences need their .short variants (A11). */
  var NARROW = "(max-width: 480px)";

  /* A chart needs a week of days before it says anything (design §empty). */
  var CHART_MIN_DAYS = 7;

  var dragTimer = null;

  /* Progressive disclosure of the strip (sadeleştirme §6). The strip carries
     three things at every width — the reading, the trace, one status sentence —
     and parks the three supporting sentences behind a quiet key.

     The flag is module level on purpose. The router redraws this view on every
     state:change and lang:change, so a flag living on the node would fold the
     sheet back under the reader each time an entry was saved. It is just as
     deliberately NOT written to the store: the sheet is remembered for this
     session, and a view does not write settings. */
  var detailsOpen = false;

  /* ---------------------------------------------------------------- plumbing */

  function log(error, where) {
    if (global.console) global.console.error("Moon.Views.panel" + (where ? " " + where : ""), error);
  }

  /* Model and Dates are pure reads, but a corrupt record must not take the
     whole screen down with it. */
  function safe(fn, fallback) {
    try {
      var value = fn();
      return value === undefined ? fallback : value;
    } catch (error) {
      log(error, "read");
      return fallback;
    }
  }

  function t(key, params) {
    var I18n = Moon.I18n;
    if (!key) return "";
    if (I18n && typeof I18n.t === "function") {
      return safe(function () { return I18n.t(key, params); }, String(key));
    }
    return String(key);
  }

  function has(key) {
    var I18n = Moon.I18n;
    if (!I18n || typeof I18n.has !== "function") return false;
    return safe(function () { return I18n.has(key); }, false) === true;
  }

  function lang() {
    var I18n = Moon.I18n;
    return (I18n && I18n.lang) || "tr";
  }

  function narrow() {
    try {
      if (global.matchMedia) return global.matchMedia(NARROW).matches;
    } catch (error) { /* no matchMedia: fall back to the viewport width */ }
    return (global.innerWidth || 1024) <= 480;
  }

  /* Not every sentence has a .short twin, so ask before reaching for one. */
  function sentence(key, params) {
    if (narrow() && has(key + ".short")) return t(key + ".short", params);
    return t(key, params);
  }

  function settings() {
    var store = Moon.Store;
    var state = store && store.state ? store.state : null;
    return (state && state.settings) || {};
  }

  function currency() {
    return settings().currency || "TRY";
  }

  function overflowMark() {
    return settings().overflowMark === "flare" ? "flare" : "pigment";
  }

  function monthStartDay() {
    var day = Number(settings().monthStartDay);
    return day >= 1 && day <= 28 ? Math.round(day) : 1;
  }

  /* The period selector lives in the header and belongs to app.js; the view
     only reads it, and works out a sensible default before app.js boots. */
  function activePeriod() {
    var app = Moon.App;
    if (app && app.period) return app.period;
    var Dates = Moon.Dates;
    if (Dates && Dates.periodKey && Dates.today) {
      return safe(function () { return Dates.periodKey(Dates.today(), monthStartDay()); }, null);
    }
    return null;
  }

  function progressOf(periodKey) {
    var Dates = Moon.Dates;
    if (!Dates || !Dates.periodProgress || !periodKey) return null;
    /* periodProgress returns null on bad input (E2) — never read .days blind. */
    return safe(function () {
      return Dates.periodProgress(periodKey, monthStartDay(), Dates.today());
    }, null);
  }

  function money(minor, withSymbol) {
    var Money = Moon.Money;
    var value = typeof minor === "number" && isFinite(minor) ? Math.round(minor) : 0;
    if (Money && typeof Money.format === "function") {
      return safe(function () {
        return Money.format(value, {
          lang: lang(),
          currency: currency(),
          symbol: withSymbol !== false
        });
      }, String(value));
    }
    return String(value);
  }

  function dateText(date, style) {
    var Dates = Moon.Dates;
    if (!date) return "";
    if (Dates && typeof Dates.formatDate === "function") {
      return safe(function () { return Dates.formatDate(date, lang(), style || "short"); }, String(date));
    }
    return String(date);
  }

  function periodText(periodKey) {
    var Dates = Moon.Dates;
    if (Dates && typeof Dates.formatPeriod === "function") {
      return safe(function () { return Dates.formatPeriod(periodKey, lang()); }, String(periodKey || ""));
    }
    return String(periodKey || "");
  }

  /* Percent values are numbers; the sign itself is part of the sentence. */
  function percent(ratio) {
    var n = Number(ratio);
    return isFinite(n) ? Math.round(n * 100) : 0;
  }

  /* -------------------------------------------------------------- css hooks */

  /* moon.css names its states `is-*` and calls the chart twin `.numbers`
     `.table`, while Moon.UI emits BEM modifiers and its own names. The panel
     bridges the two on its own subtree so the first screen matches the design
     without a single edit to ui.js. */
  var ALIAS = {
    empty__heading: "empty__title",
    empty__action: "btn is-row",
    notice__text: "notice__body",
    datatable: "numbers",
    datatable__table: "table",
    datatable__summary: "sm"
  };

  function applyCssHooks(root) {
    dom.qsa("[class]", root).forEach(function (node) {
      if (!node.classList) return;
      var names = String(node.getAttribute("class") || "").split(/\s+/);
      var add = [];
      names.forEach(function (name) {
        if (!name) return;
        var cut = name.indexOf("--");
        if (cut > 0) add.push("is-" + name.slice(cut + 2));
        if (ALIAS[name]) add.push(ALIAS[name]);
      });
      add.forEach(function (chunk) {
        chunk.split(" ").forEach(function (one) {
          if (one) node.classList.add(one);
        });
      });
    });
  }

  /* ------------------------------------------------------------------ pieces */

  /* Charts hand back SVG strings (E4). The class they carry is replaced here:
     a node classed `.chart` or `.meter` would inherit a section margin or a
     grid meant for its wrapper. */
  function svgNode(markup, className) {
    var node = dom.svg(markup);
    if (!node || typeof node.setAttribute !== "function") return node;
    if (className) node.setAttribute("class", className);
    else node.removeAttribute("class");
    return node;
  }

  /* Money.parts defaults to the Turkish layout when no language is handed over,
     so the language travels with every cell — otherwise the strip would print
     TR grouping next to an EN sentence. */
  function moneyCell(minor, opts) {
    var spec = { lang: lang(), currency: currency() };
    Object.keys(opts || {}).forEach(function (key) {
      spec[key] = opts[key];
    });
    var cell = Moon.UI.moneyCell(minor, spec);
    /* moon.css puts a leading symbol in place through .is-sym-first; ui.js
       prints the span but not the flag, so EN would show the symbol last. */
    if (cell && cell.querySelector && cell.classList) {
      var first = cell.querySelector(".m-sym, .m-whole");
      if (first && first.getAttribute("class") === "m-sym") cell.classList.add("is-sym-first");
    }
    return cell;
  }

  /* The hero reading is 52px and .money fixes its own 15px, so the cell
     inherits from .hero__value rather than carrying a second size. */
  function heroMoney(minor) {
    var cell = moneyCell(minor, { sign: false });
    if (cell && cell.style) {
      cell.style.setProperty("font-size", "inherit");
      cell.style.setProperty("font-weight", "inherit");
      cell.style.setProperty("min-width", "0");
    }
    return cell;
  }

  function line(text, dim) {
    if (!text) return null;
    return dom.el("p", { "class": "hero__line" + (dim ? " is-dim" : ""), text: text });
  }

  /* Both formatters are mandatory on every chart call (E4): without them the
     axis ends print bare unseparated numerals. */
  function chartOpts(extra) {
    var opts = {
      formatValue: function (minor) { return money(minor, false); },
      formatDate: function (date) { return dateText(date); }
    };
    Object.keys(extra || {}).forEach(function (key) {
      opts[key] = extra[key];
    });
    return opts;
  }

  /* The reading lives in one line of text above the chart; no tooltip ever
     appears (design §graphs). The chart calls back with an index only. */
  function readoutLine() {
    return dom.el("p", { "class": "chart__read" });
  }

  function setReadout(node, date, minor) {
    if (!node) return;
    node.textContent = t("panel.chart.reading", {
      date: dateText(date),
      amount: money(minor)
    });
  }

  /* Every chart carries the same numbers as a real table (design §graphs). */
  function numbers(columns, rows, captionKey) {
    return Moon.UI.dataTable(columns, rows, {
      summaryKey: "a11y.showTable",
      captionKey: captionKey,
      currency: currency(),
      dateStyle: "short"
    });
  }

  /* The trace's twin. It is the one chart whose table sits inside the strip, so
     two things are true at once: it arrives shut, which costs the strip a
     single 13px summary row (A11 watches the strip's height), and the sentence
     that explains the trace rides inside it instead of taking a line of its
     own. Print opens .numbers, so paper gets the sentence and the thirty days
     the trace draws — which is the whole point of the twin. */
  function trailNumbers(trail) {
    var node = numbers(
      [
        { labelKey: "ledger.col.date", type: "date" },
        { labelKey: "ledger.col.amount", type: "money" }
      ],
      trail.map(function (point) {
        return [point.date, Number(point && point.perDay) || 0];
      }),
      "panel.chart.trail.title"
    );

    var body = dom.el("p", { "class": "sm dim", text: t("panel.chart.trail.body") });
    /* Before applyCssHooks runs, so the class is still ui.js's own name. */
    var table = node.querySelector ? node.querySelector(".datatable__table") : null;
    if (table) node.insertBefore(body, table);
    else node.appendChild(body);
    return node;
  }

  /* ------------------------------------------------------------------- hero */

  function heroAside(periodKey, progress) {
    var ratio = progress && typeof progress.ratio === "number" ? progress.ratio : 0;
    var label = t("a11y.disc", { pct: percent(ratio) });
    var disc = svgNode(Moon.Charts.moonDisc(ratio, {
      size: 28,
      ariaLabel: label,
      title: label,
      desc: label
    }), "disc");

    var days = progress
      ? t("panel.dayCount", { dayIndex: progress.dayIndex, days: progress.days })
      : periodText(periodKey);

    return dom.el("div", { "class": "hero__aside" }, [
      disc,
      dom.el("span", { text: days })
    ]);
  }

  /* The five states of the hero reading (jury A2). Each one has its own label,
     its own number and its own sentence; none of them is a fallback. */
  function heroReading(periodKey, allowance, summary) {
    var state = allowance.state || "ok";
    var out = { label: "", value: 0, body: "", action: null };

    if (state === "noLimits") {
      /* The default state of a clean install, so it is the most-seen screen:
         the reading becomes what was spent, and the invitation is real. */
      out.label = t("panel.state.noLimits.label");
      out.value = summary.spentTotal || 0;
      out.body = sentence("panel.state.noLimits.body");
      out.action = dom.el("a", {
        "class": "btn is-primary",
        href: "#limitler"
      }, t("panel.state.noLimits.action"));
      return out;
    }

    if (state === "overspent") {
      var over = -(allowance.remainingAmount || 0);
      out.label = t("panel.state.overspent.label");
      out.value = over;
      out.body = sentence("panel.state.overspent.body", {
        amount: money(over),
        days: allowance.remainingDays
      });
      return out;
    }

    if (state === "lastDay") {
      out.label = t("panel.state.lastDay.label");
      out.value = allowance.perDay || 0;
      out.body = sentence("panel.state.lastDay.body", {
        amount: money(allowance.remainingAmount || 0)
      });
      return out;
    }

    if (state === "pastPeriod") {
      var used = null;
      if (Moon.Money && Moon.Money.pct) {
        used = safe(function () {
          return Moon.Money.pct(summary.spentTotal, summary.limitTotal);
        }, null);
      }
      out.label = t("panel.state.pastPeriod.label");
      out.value = summary.spentTotal || 0;
      out.body = sentence("panel.state.pastPeriod.body", {
        period: periodText(periodKey),
        pct: used === null ? 0 : used
      });
      return out;
    }

    out.label = t("panel.state.ok.label");
    out.value = allowance.perDay || 0;
    out.body = sentence("panel.state.ok.body", {
      days: allowance.remainingDays,
      amount: money(allowance.remainingAmount || 0)
    });
    return out;
  }

  /* Returns the trace, the one line of text the chart writes its reading into,
     and the table that carries the same numbers.

     The reading line is printed at every width. charts.js gives every trace a
     tabindex and binds the arrow keys whatever size it is drawn at (E4 has no
     switch for that, and charts.js is not this agent's file), so dropping the
     line on a phone left a focus stop that moved a cursor and said nothing —
     a silent trap for anyone on a keyboard, a switch or an external keyboard.
     One 13px line costs the strip less than a dead stop costs the reader.

     The line opens on the latest day rather than empty, so a focusable chart is
     never a dead end and the strip never shows a blank row waiting to be used. */
  function trailNodes(periodKey, allowance) {
    var trail = safe(function () { return Moon.Model.allowanceTrail(periodKey); }, []) || [];
    /* With no limits there is no allowance to trace, and the invitation takes
       the trace's place rather than an empty frame sitting under it. */
    if (allowance.state === "noLimits") return [];

    var size = narrow() ? TRAIL_NARROW : TRAIL;
    var read = readoutLine();
    var min = null;
    var max = null;
    var reference = null;
    trail.forEach(function (point) {
      var value = Number(point && point.perDay);
      if (!isFinite(value)) return;
      if (min === null || value < min) min = value;
      if (max === null || value > max) max = value;
      if (reference === null && isFinite(Number(point.reference))) reference = Number(point.reference);
    });

    var markup = Moon.Charts.allowanceTrail(trail, chartOpts({
      width: size.w,
      height: size.h,
      compact: true,
      title: t("panel.chart.trail.title"),
      desc: t("a11y.chart.trail.desc", {
        min: money(min || 0),
        max: money(max || 0),
        reference: money(reference || 0)
      }),
      emptyText: t("empty.panel.body"),
      onReadout: function (index) {
        var point = trail[index];
        if (point) setReadout(read, point.date, point.perDay);
      }
    }));

    var out = [dom.el("div", { "class": "hero__trail" }, svgNode(markup, "chart--trail"))];
    var last = trail.length ? trail[trail.length - 1] : null;
    if (last) setReadout(read, last.date, last.perDay);
    out.push(read);
    /* No days, no table: the trace already prints its own empty sentence, and
       a "show the numbers" row that opens on nothing is a worse answer. */
    if (trail.length) out.push(trailNumbers(trail));
    return out;
  }

  /* G11: the whole strip is the CSV target, in every state. The sentence under
     it changes while a file hovers; the dashed outline is ui.js's business. */
  function dropLine() {
    var node = line(t("panel.dropHint"), true);
    if (!node) return null;

    function restore() {
      node.textContent = t("panel.dropHint");
    }
    function active() {
      if (dragTimer) {
        global.clearTimeout(dragTimer);
        dragTimer = null;
      }
      node.textContent = t("panel.dropActive");
    }
    /* dragleave fires on every child crossing, so the restore waits one beat
       and the next dragover cancels it. */
    function leave() {
      if (dragTimer) global.clearTimeout(dragTimer);
      dragTimer = global.setTimeout(function () {
        dragTimer = null;
        restore();
      }, 120);
    }

    node.moonDrag = { active: active, leave: leave };
    return node;
  }

  function onFiles(files) {
    var app = Moon.App;
    if (app && typeof app.go === "function") safe(function () { return app.go("veri"); }, null);
    var data = Moon.Views ? Moon.Views.data : null;
    /* The data agent owns the wizard; without it, landing on the section is
       still the honest outcome. */
    if (data && typeof data.startImport === "function") {
      safe(function () { return data.startImport(files); }, null);
    }
  }

  /* The folded lines stay DIRECT children of .hero instead of moving into a
     wrapper. The strip's vertical rhythm comes from one rule, `.hero > * + *`,
     and p margins are zeroed in moon.css — a wrapper would print the three
     sentences as one solid block. `[hidden]` is display:none !important here,
     so a folded line costs no box and no margin, which is the whole point of
     the fold; and aria-controls takes the id list ARIA allows for exactly
     this shape.

     The key rides at the end of the status sentence rather than taking a line
     of its own. A key on its own row would cost the strip the button's full
     height plus the rhythm gap (52px on a phone) and hand back 81px, which is
     most of the fold's saving spent on the handle; sharing the sentence's line
     box costs 25px instead. A button is phrasing content, so the paragraph
     stays valid; a text node keeps the words apart for a reader whose screen
     reader runs inline siblings together. */
  function disclose(lines, bodyLine) {
    var ids = [];
    lines.forEach(function (node, index) {
      var id = "panel-hero-more-" + (index + 1);
      node.id = id;
      node.hidden = !detailsOpen;
      ids.push(id);
    });

    var toggle = dom.el("button", {
      "class": "btn is-quiet",
      type: "button",
      "aria-expanded": detailsOpen ? "true" : "false",
      "aria-controls": ids.join(" ")
    }, t("common.details"));

    toggle.addEventListener("click", function () {
      detailsOpen = !detailsOpen;
      toggle.setAttribute("aria-expanded", detailsOpen ? "true" : "false");
      lines.forEach(function (node) {
        node.hidden = !detailsOpen;
      });
    }, false);

    if (bodyLine) {
      if (doc && doc.createTextNode) bodyLine.appendChild(doc.createTextNode(" "));
      bodyLine.appendChild(toggle);
      return null;
    }
    return dom.el("p", { "class": "hero__line" }, toggle);
  }

  function heroStrip(periodKey, allowance, summary, progress) {
    var reading = heroReading(periodKey, allowance, summary);
    var kids = [];

    kids.push(heroAside(periodKey, progress));
    kids.push(dom.el("p", { "class": "hero__label", text: reading.label }));
    kids.push(dom.el("p", { "class": "hero__value" }, heroMoney(reading.value)));

    trailNodes(periodKey, allowance).forEach(function (node) {
      kids.push(node);
    });

    /* Always on screen (§6): the reading, the trace, and this one sentence —
       whichever of the five states the period is in. */
    var bodyLine = reading.body ? line(reading.body) : null;
    if (bodyLine) kids.push(bodyLine);
    if (reading.action) kids.push(dom.el("p", { "class": "hero__line" }, reading.action));

    /* One click away (§6): today's spend, the pace comparison, the
       fixed-payment summary. Every one of them is extra information about a
       measurement already on screen, never a warning and never an overrun —
       those have their own bands below and are not folded anywhere. */
    var more = [];

    /* Today's reading only exists while the period holds today and there is an
       allowance to have a remainder of. */
    if (allowance.perDayLeftToday !== null && allowance.perDayLeftToday !== undefined) {
      more.push(line(sentence("panel.spentToday", {
        spent: money(allowance.spentToday || 0),
        left: money(allowance.perDayLeftToday)
      })));
    }

    /* G7: two ratios next to each other. One number lies about pace; the
       difference between these two cannot. */
    if (allowance.state !== "noLimits") {
      more.push(line(sentence("panel.paceLine", {
        periodPct: percent(allowance.periodRatio),
        spentPct: percent(allowance.spentRatio)
      }), true));
    }

    /* A3: fixed payments are reserved, not part of the daily pool, so they are
         reported on their own line instead of distorting the hero number. */
    if (allowance.fixedCount) {
      more.push(line(sentence("panel.fixedReserved", {
        count: allowance.fixedCount,
        amount: money(allowance.fixedReserved || 0)
      }), true));
    }

    /* line() answers null for an empty sentence, and a key with no text must
       not earn an id or a slot behind the fold. */
    var folded = more.filter(function (node) { return !!node; });
    if (folded.length) {
      var own = disclose(folded, bodyLine);
      if (own) kids.push(own);
      folded.forEach(function (node) {
        kids.push(node);
      });
    }

    /* The strip stays a drop target whatever it says (G11), but the sentence
       announcing that is only worth its line while the ledger is still thin.
       Once a month of entries is in, it is the reader who has the fewest lines
       to read that can see the measurement, so the hint steps back and the
       dashed outline on dragover does the telling. */
    var drop = (narrow() || summary.entryCount > 8) ? null : dropLine();
    if (drop) kids.push(drop);

    var node = Moon.UI.hero({ children: kids, onFiles: onFiles });
    if (drop && drop.moonDrag) {
      node.addEventListener("dragover", drop.moonDrag.active, false);
      node.addEventListener("dragleave", drop.moonDrag.leave, false);
      node.addEventListener("drop", drop.moonDrag.leave, false);
    }
    return node;
  }

  /* --------------------------------------------------------------- pending */

  /* E6: nothing is written on load. The band counts what is due and the reader
     presses the button; Model.generateRecurring writes only then. */
  function pendingBand(periodKey, pending) {
    var total = 0;
    pending.forEach(function (row) {
      total += Number(row && row.amount) || 0;
    });

    return Moon.UI.notice({
      kind: "info",
      messageKey: "panel.pending",
      params: { count: pending.length, amount: money(total) },
      actions: [
        {
          labelKey: "panel.pending.action",
          kind: "primary",
          onClick: function () {
            /* The write raises state:change and the router redraws this view,
               which is the confirmation the reader needs. */
            safe(function () { return Moon.Model.generateRecurring(periodKey); }, 0);
          }
        },
        { labelKey: "panel.pending.review", kind: "quiet", href: "#tekrar" }
      ]
    });
  }

  /* ---------------------------------------------------------------- limits */

  function driftText(row) {
    if (row.driftState === "over") {
      return t("limits.reading.over", { amount: money(row.spent - row.limit) });
    }
    if (row.driftState === "done") return t("limits.reading.done");
    if (row.driftState === "ahead") {
      return t("limits.reading.ahead", { amount: money(Math.abs(row.drift || 0)) });
    }
    if (row.driftState === "behind") {
      return t("limits.reading.behind", { amount: money(Math.abs(row.drift || 0)) });
    }
    return "";
  }

  function nameCell(row) {
    return dom.el("span", {
      "class": "meter__name" + (row.fixed ? " is-fixed" : ""),
      text: row.name,
      title: row.name
    });
  }

  /* One scale per category. The name is HTML, the track and its readout are one
     SVG so the overrun can cross the end cap into the reading column (G1);
     the row grid is held to two columns for the same reason. */
  function meterRow(row) {
    var over = row.driftState === "over";
    var classes = ["meter"];
    if (over) classes.push("is-over");
    if (over && overflowMark() === "flare") classes.push("is-flare");

    var ariaLabel = over
      ? t("limits.aria.over", { name: row.name, amount: money(row.spent - row.limit) })
      : t("limits.aria.meter", {
          name: row.name,
          pct: row.pct === null ? 0 : row.pct,
          pace: percent(row.paceRatio)
        });

    var markup = Moon.Charts.meter(row, chartOpts({
      trackWidth: METER_TRACK,
      readoutWidth: METER_READOUT,
      height: METER_HEIGHT,
      overflowMark: overflowMark(),
      ariaLabel: ariaLabel,
      title: ariaLabel,
      desc: t("limits.aria.pace", { pace: percent(row.paceRatio) }),
      percentText: t("limits.pct", { pct: row.pct === null ? 0 : row.pct }),
      driftText: driftText(row)
    }));

    return dom.el("div", {
      "class": classes.join(" "),
      style: { "grid-template-columns": "var(--meter-name) minmax(0, 1fr)" }
    }, [
      nameCell(row),
      dom.el("div", { "class": "meter__scale" }, svgNode(markup, null))
    ]);
  }

  /* A category with no limit is not a scale at zero: it is a number. */
  function plainRow(row) {
    return dom.el("div", {
      "class": "meter",
      style: { "grid-template-columns": "var(--meter-name) minmax(0, 1fr)" }
    }, [
      nameCell(row),
      dom.el("div", { "class": "meter__readout" }, moneyCell(row.spent, { dim: true, sign: false }))
    ]);
  }

  function limitsSection(periodKey, summary) {
    var rows = safe(function () { return Moon.Model.budgetRows(periodKey); }, []) || [];
    var body = [];

    if (!rows.length) {
      body.push(Moon.UI.emptyState({
        headingKey: "empty.limits.heading",
        bodyKey: "empty.limits.body",
        actions: [{ labelKey: "panel.state.noLimits.action", href: "#limitler" }]
      }));
    } else {
      /* The Limits section's own rows, with the figure you can type into and the
         cap you can drag. Seeing what went and pulling the limit to meet it is
         one gesture, on one screen, which is the order the work actually
         happens in. If that section cannot be reached the panel still draws its
         read-only scales rather than nothing. */
      var live = scaleRows(METER_LIMIT);
      if (live && live.element) {
        body.push(live.element);
      } else {
        rows.slice(0, METER_LIMIT).forEach(function (row) {
          body.push(row.pct === null ? plainRow(row) : meterRow(row));
        });
      }

      var extra = rows.length - METER_LIMIT;
      /* The whole list lives in its own section; this is the way there. */
      body.push(dom.el("p", { "class": "sm" }, dom.el("a", {
        href: "#limitler",
        text: extra > 0 ? t("panel.moreCategories", { count: extra }) : t("limits.title")
      })));

      if (rows.some(function (row) { return row.driftState === "over"; })) {
        body.push(dom.el("p", { "class": "sm dim", text: t("limits.overflow.note") }));
      }
    }

    var asideKey = summary.limitVariable > 0 ? "limits.variableTotal" : "limits.total";
    return Moon.UI.section({
      id: "panel-limits",
      titleKey: "limits.title",
      asideKey: asideKey,
      asideParams: {
        amount: money(summary.limitVariable > 0 ? summary.limitVariable : summary.limitTotal)
      },
      body: body
    });
  }

  /* ---------------------------------------------------------------- charts */

  /* Seven days of records before a chart is allowed to speak (design §empty).
     Days, not entries: three entries on one day still draw one bar. */
  function dayCount(flow) {
    var count = 0;
    flow.forEach(function (day) {
      if ((day.inAmount || 0) !== 0 || (day.outAmount || 0) !== 0) count += 1;
    });
    return count;
  }

  function notEnough(days) {
    return Moon.UI.emptyState({
      headingKey: "empty.chart.heading",
      bodyKey: "empty.chart.body",
      params: { days: days }
    });
  }

  function flowSection(periodKey) {
    var flow = safe(function () { return Moon.Model.dailyFlow(periodKey); }, []) || [];
    var days = dayCount(flow);
    var body = [dom.el("p", { "class": "sm dim", text: t("panel.chart.flow.body") })];

    if (days < CHART_MIN_DAYS) {
      body.push(notEnough(days));
      return Moon.UI.section({
        id: "panel-flow",
        titleKey: "panel.chart.flow.title",
        body: body
      });
    }

    var income = 0;
    var spend = 0;
    flow.forEach(function (day) {
      income += Number(day.inAmount) || 0;
      spend += Number(day.outAmount) || 0;
    });

    /* The reading line opens on the last day instead of blank: the chart is
       focusable, and a reserved empty row reads as a layout fault. */
    var read = readoutLine();
    var newest = flow[flow.length - 1];
    if (newest) {
      setReadout(read, newest.date, (Number(newest.inAmount) || 0) - (Number(newest.outAmount) || 0));
    }

    var markup = Moon.Charts.dayFlow(flow, chartOpts({
      title: t("panel.chart.flow.title"),
      desc: t("a11y.chart.flow.desc", { "in": money(income), out: money(spend) }),
      inLabel: t("common.income"),
      outLabel: t("common.expense"),
      emptyText: t("empty.chart.heading"),
      onReadout: function (index) {
        var day = flow[index];
        if (!day) return;
        /* One line, one number: the day's net movement. The table under the
           chart carries the two columns it is made of. */
        setReadout(read, day.date, (Number(day.inAmount) || 0) - (Number(day.outAmount) || 0));
      }
    }));

    body.push(read);
    body.push(dom.el("div", { "class": "chart" }, svgNode(markup, "chart--flow")));
    body.push(numbers(
      [
        { labelKey: "ledger.col.date", type: "date" },
        { labelKey: "common.income", type: "money" },
        { labelKey: "common.expense", type: "money" }
      ],
      flow.map(function (day) {
        return [day.date, day.inAmount || 0, day.outAmount || 0];
      }),
      "panel.chart.flow.title"
    ));

    return Moon.UI.section({
      id: "panel-flow",
      titleKey: "panel.chart.flow.title",
      body: body
    });
  }

  function cumulativeSection(periodKey) {
    var data = safe(function () { return Moon.Model.cumulative(periodKey); }, null) ||
      { points: [], pace: [], crossedOn: null, ghost: null };
    var points = data.points || [];
    var body = [dom.el("p", { "class": "sm dim", text: t("panel.chart.cumulative.body") })];

    if (points.length < CHART_MIN_DAYS) {
      body.push(notEnough(points.length));
      return Moon.UI.section({
        id: "panel-cumulative",
        titleKey: "panel.chart.cumulative.title",
        body: body
      });
    }

    var last = points[points.length - 1];
    var paceByDate = Object.create(null);
    (data.pace || []).forEach(function (row) {
      if (row && row.date) paceByDate[row.date] = row.total;
    });
    var paceHere = paceByDate[last.date];

    var read = readoutLine();
    setReadout(read, last.date, last.total);

    var markup = Moon.Charts.cumulative(data, chartOpts({
      title: t("panel.chart.cumulative.title"),
      desc: t("a11y.chart.cumulative.desc", {
        total: money(last.total || 0),
        pace: money(paceHere === undefined ? 0 : paceHere)
      }),
      seriesLabel: t("common.expense"),
      crossedLabel: data.crossedOn
        ? t("panel.chart.cumulative.crossed", { date: dateText(data.crossedOn) })
        : "",
      emptyText: t("empty.chart.heading"),
      onReadout: function (index) {
        var point = points[index];
        if (point) setReadout(read, point.date, point.total);
      }
    }));

    body.push(read);
    body.push(dom.el("div", { "class": "chart" }, svgNode(markup, "chart--cumulative")));
    body.push(numbers(
      [
        { labelKey: "ledger.col.date", type: "date" },
        { labelKey: "ledger.col.amount", type: "money" }
      ],
      points.map(function (point) {
        return [point.date, point.total || 0];
      }),
      "panel.chart.cumulative.title"
    ));

    if (data.crossedOn) {
      body.push(dom.el("p", {
        "class": "sm dim",
        text: t("panel.chart.cumulative.crossed", { date: dateText(data.crossedOn) })
      }));
    }

    return Moon.UI.section({
      id: "panel-cumulative",
      titleKey: "panel.chart.cumulative.title",
      body: body
    });
  }

  /* ----------------------------------------------------------- empty state */

  function navigateTo(hash) {
    var app = Moon.App;
    if (app && typeof app.go === "function") safe(function () { return app.go(hash); }, null);
    else if (global.location) global.location.hash = "#" + hash;
  }

  /* G9: the ledger's rules are printed before any data exists, and the three
     ways in are full rows, not a row of buttons. */
  function emptyPanel() {
    return Moon.UI.emptyState({
      ghost: 3,
      columns: 3,
      headingLevel: "h2",
      headingKey: "empty.panel.heading",
      bodyKey: "empty.ledger.body",
      footKey: "empty.ledger.footer",
      actions: [
        {
          labelKey: "empty.ledger.action1",
          onClick: function () { navigateTo("defter"); }
        },
        {
          labelKey: "empty.ledger.action2",
          onClick: function () { navigateTo("veri"); }
        },
        {
          labelKey: "empty.ledger.action3",
          onClick: function () {
            /* The sample month is the one action that writes from this screen,
               and it is the reader's own press that does it. */
            if (Moon.Sample && typeof Moon.Sample.apply === "function") {
              safe(function () { return Moon.Sample.apply(); }, 0);
            } else {
              navigateTo("veri");
            }
          }
        }
      ]
    });
  }

  /* ---------------------------------------------------------------- render */

  var BLANK = {
    state: "noLimits",
    perDay: null,
    remainingAmount: 0,
    remainingDays: 0,
    fixedReserved: 0,
    fixedCount: 0,
    spentToday: 0,
    perDayLeftToday: null,
    spentRatio: 0,
    periodRatio: 0
  };

  /* Set when a row has just been written: the next render hands the caret back
     to the amount field, so a run of entries never needs the mouse. */
  var focusAmountNext = false;

  /* Both of these come from the sections that own them. The panel composes;
     it does not keep a second copy of how an entry is written or how a limit is
     pulled, because a second copy is a thing that drifts. */
  function entryRow(root) {
    var ledger = Moon.Views && Moon.Views.ledger;
    if (!ledger || typeof ledger.quickEntry !== "function") return null;

    var api = safe(function () {
      return ledger.quickEntry({
        memoryKey: "panel.quick",
        onSaved: function () {
          /* Writing raises state:change and the router answers it on the next
             tick, so drawing here would only be undone a moment later — and
             with it the caret. Ask instead: whoever draws next puts the caret
             back where the following amount goes. */
          focusAmountNext = true;
        }
      });
    }, null);

    return api && api.element ? api.element : null;
  }

  function scaleRows(max) {
    var limits = Moon.Views && Moon.Views.limits;
    if (!limits || typeof limits.scales !== "function") return null;
    return safe(function () { return limits.scales({ limit: max }); }, null);
  }

  function render(root) {
    if (!root) return;
    dom.clear(root);
    if (!Moon.Model || !Moon.UI || !Moon.Charts) return;

    var periodKey = activePeriod();
    if (!periodKey) {
      /* No usable period means no measurement; say so instead of drawing a
         strip full of zeros. */
      root.appendChild(emptyPanel());
      applyCssHooks(root);
      return;
    }

    var allowance = safe(function () { return Moon.Model.dailyAllowance(periodKey); }, null) || BLANK;
    var summary = safe(function () { return Moon.Model.periodSummary(periodKey); }, null) || {
      spentTotal: 0, limitTotal: 0, limitVariable: 0, entryCount: 0
    };
    var progress = progressOf(periodKey);

    root.appendChild(heroStrip(periodKey, allowance, summary, progress));

    /* Writing something down is the thing done most often, so it belongs on the
       screen that opens, under the number it changes. The row is the ledger's
       own — same fields, same submit path — so the two cannot drift apart. */
    var entry = entryRow(root);
    if (entry) root.appendChild(entry);

    var pending = safe(function () { return Moon.Model.pendingRecurring(periodKey); }, []) || [];
    if (pending.length) root.appendChild(pendingBand(periodKey, pending));

    /* An empty ledger gets the notebook's first page, not four empty sections.
       The strip stays: it is the CSV target in every state (G11). */
    var total = safe(function () { return Moon.Model.entries({}).length; }, 0);
    if (!total) {
      root.appendChild(emptyPanel());
      applyCssHooks(root);
      return;
    }

    root.appendChild(limitsSection(periodKey, summary));
    root.appendChild(flowSection(periodKey));
    root.appendChild(cumulativeSection(periodKey));
    applyCssHooks(root);
    restoreCaret(root);
  }

  function restoreCaret(root) {
    if (!focusAmountNext) return;
    focusAmountNext = false;
    var field = root.querySelector('.quickrow [name="amount"]');
    if (!field || typeof field.focus !== "function") return;
    field.focus();
    if (typeof field.select === "function") safe(function () { field.select(); }, null);
  }

  function destroy() {
    if (dragTimer) {
      global.clearTimeout(dragTimer);
      dragTimer = null;
    }
  }

  Moon.Views = Moon.Views || {};
  Moon.Views.panel = {
    id: "panel",
    titleKey: "nav.panel",
    render: render,
    destroy: destroy
  };
})(window);
