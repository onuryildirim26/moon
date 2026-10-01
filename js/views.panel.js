/* Moon — the panel (#panel), the first screen.
 *
 * One card, one strip and three sections, in reading order: the net-worth card
 * with its account chips, the measurement strip (hero), the limit scales, then
 * the two time charts. Everything on screen is derived by Moon.Model; this file
 * owns structure, labels and the keyboard readout line, and writes nothing
 * except when the reader presses the button on the pending-recurring band.
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

  /* charts.js draws a 24-unit meter, which holds one line of reading inside the
     bar's own readout column and leaves the drift sentence to an HTML node
     beside it. The panel's scales and the Limits screen's are the same drawing
     of the same rows, so this number is here to be handed over, never to differ
     from the one that screen uses. */
  var METER_HEIGHT = 24;

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

  /* -------------------------------------------------------------- net worth */

  /* §5.3: the card above the strip. It answers a different question from the
     hero — what there is in total, rather than what can be spent today — so it
     carries its own number and nothing below it moves.

     It is held to three short rows on purpose. The panel underneath is long,
     and a card that pushed the daily allowance off a 640px screen would have
     traded the reading taken every day for the one taken once a month. */

  var BLANK_WORTH = {
    cash: 0,
    investments: 0,
    owedToMe: 0,
    iOwe: 0,
    assets: 0,
    liabilities: 0,
    total: 0,
    measured: false,
    counts: { accounts: 0, investments: 0, debts: 0 }
  };

  /* The card's reading is 28px and .money fixes its own 15px — the same clash
     the hero has, and the same answer. The sign is kept here and dropped
     there: an allowance is never negative, because the overspent state prints
     its overrun as a positive number, but a net worth under water is exactly
     the reading its owner needs to see. */
  function worthMoney(minor) {
    var cell = moneyCell(minor);
    if (cell && cell.style) {
      cell.style.setProperty("font-size", "inherit");
      cell.style.setProperty("font-weight", "inherit");
      cell.style.setProperty("min-width", "0");
    }
    return cell;
  }

  function worthPart(figure) {
    return dom.el("span", { "class": "networth__part is-" + figure.side }, [
      dom.el("span", { text: t(figure.key) }),
      dom.el("span", { text: money(figure.amount) })
    ]);
  }

  /* The four figures the reading is made of, in the order they are summed, and
     only the ones somebody actually measured. A reader with two bank accounts
     and no holdings learns nothing from "Investments ₺0,00", and a row of four
     zeros on a clean install reads as a card that failed to load. A collection
     the reader does keep records in stays on the line even at zero, because a
     zero that was counted is a reading. */
  function worthFigures(worth) {
    var counts = worth.counts || {};
    var out = [];

    if (Number(counts.accounts) > 0 || worth.cash) {
      out.push({ key: "networth.cash", amount: worth.cash, side: "assets" });
    }
    if (Number(counts.investments) > 0 || worth.investments) {
      out.push({ key: "networth.investments", amount: worth.investments, side: "assets" });
    }
    if (worth.owedToMe) {
      out.push({ key: "networth.owedToMe", amount: worth.owedToMe, side: "assets" });
    }
    if (worth.iOwe) {
      out.push({ key: "networth.iOwe", amount: worth.iOwe, side: "liabilities" });
    }
    return out;
  }

  /* The two sums those four figures roll up into, each shown only if a figure
     landed on that side — so a reader who owes nothing is never told so with a
     zero. */
  function worthTotals(worth, figures) {
    function has(side) {
      return figures.some(function (figure) { return figure.side === side; });
    }
    var out = [];
    if (has("assets")) out.push({ key: "networth.assets", amount: worth.assets, side: "assets" });
    if (has("liabilities")) {
      out.push({ key: "networth.liabilities", amount: worth.liabilities, side: "liabilities" });
    }
    return out;
  }

  /* The card's first column measures 223px at 375px wide — the moon disc and
     the day count hold the other one — and a figure with its label is about
     130px of that, so the split takes one reading per line on a phone whatever
     is in it. Four of them is four lines, and every line comes straight off the
     bottom of the screen, where the daily allowance is.
     Two lines is therefore the ceiling. Two is also what the roll-up costs, so
     a reader with cash and holdings keeps the words that name them and only a
     fuller set is stated as the sums it adds to. On a wide screen the column is
     three times longer and all four fit on the one line. */
  function worthSplit(worth) {
    var figures = worthFigures(worth);
    if (narrow() && figures.length > 2) figures = worthTotals(worth, figures);
    if (!figures.length) return null;
    return dom.el("p", { "class": "networth__split" }, figures.map(function (figure) {
      return worthPart(figure);
    }));
  }

  /* The waxing moon, and the one reason it is allowed on a disciplined screen:
     the lit fraction IS the fraction of the period gone, so the disc is a
     reading rather than an ornament. 44px is the square moon.css reserves for
     it, and the chart declares that as its own max-width, so the two agree
     without this file restating a size in CSS. */
  function phaseNodes(progress) {
    if (!progress) return [];

    var ratio = typeof progress.ratio === "number" ? progress.ratio : 0;
    var label = t("a11y.disc", { pct: percent(ratio) });
    var disc = svgNode(Moon.Charts.moonDisc(ratio, {
      size: 44,
      ariaLabel: label,
      title: label,
      desc: label
    }), null);

    return [
      dom.el("div", { "class": "networth__phase" }, disc),
      dom.el("p", {
        "class": "networth__day",
        text: t("networth.day", { dayIndex: progress.dayIndex, days: progress.days })
      })
    ];
  }

  /* Every unarchived account, its balance, and the way to write the next one.
     ui.js owns the strip's keyboard — one tab stop, arrows between the chips —
     and the api it hands back is let go on purpose: both of its listeners are
     bound to the strip itself, so the next render's dom.clear takes them away
     with the nodes, and holding a reference would be the second thing this file
     has promised not to keep between draws. */
  function accountChips() {
    var list = safe(function () { return Moon.Model.accounts(); }, []) || [];
    var items = list.map(function (account) {
      return {
        id: account.id,
        name: account.name,
        icon: account.icon,
        value: safe(function () { return Moon.Model.accountBalance(account.id); }, 0),
        currency: account.currency,
        color: account.color,
        /* A balance is read here and changed on its own screen, so the chip is
           a link there rather than a control that does something different
           from the one standing next to it. */
        href: "#hesaplar"
      };
    });

    var strip = safe(function () {
      return Moon.UI.chips({ items: items, currency: currency(), addHref: "#hesaplar" });
    }, null);
    return strip && strip.element ? strip.element : null;
  }

  /* Answers a null element when the model cannot answer at all: a panel without
     the accounts half of the model is simply the panel as it was, which is a
     working screen, and an empty card claiming nothing was measured would be a
     different and less true statement.

     `phase` tells the caller whether the waxing moon and the day count went
     onto the card. §2.5 gives that reading one home, and the strip below has a
     badge that can hold the same two marks, so exactly one of them draws them
     and the answer has to travel between the two. */
  function netWorthCard(progress) {
    if (typeof Moon.Model.netWorth !== "function") return { element: null, phase: false };

    var worth = safe(function () { return Moon.Model.netWorth(); }, null) || BLANK_WORTH;
    var kids = [dom.el("p", { "class": "networth__label", text: t("networth.label") })];
    var phase = false;

    if (worth.measured) {
      kids.push(dom.el("p", { "class": "networth__value" }, worthMoney(worth.total)));
      var split = worthSplit(worth);
      if (split) kids.push(split);
      var marks = phaseNodes(progress);
      phase = marks.length > 0;
      marks.forEach(function (node) {
        kids.push(node);
      });
    } else {
      /* Nothing has been written down, so there is no number to print. The
         sentence takes the breakdown's row, where 13px and dim is the right
         weight for an invitation, and the reading row stays empty rather than
         holding a confident zero nobody measured.

         The phase steps aside here, and it is the only screen where it does.
         It reads the calendar rather than the money, so it has nothing to add
         to a card that is asking to be given something, and it holds the second
         column, which costs the sentence a wrapped line. The reading is not
         lost: `phase` stays false, and the strip's own badge draws the disc and
         the day count instead. */
      kids.push(dom.el("p", { "class": "networth__split", text: t("networth.empty") }));
    }

    var card = dom.el("div", { "class": "networth" }, kids);
    var chips = accountChips();
    /* The card and the strip are one block. `.view > * + *` hands 40px to every
       top-level child, which is the rhythm between sections — but these
       balances are the number above them broken out, not the next section, so
       an unclassed wrapper keeps them at the scroller's own 8px instead. */
    return {
      element: chips ? dom.el("div", null, [card, chips]) : card,
      phase: phase
    };
  }

  /* ------------------------------------------------------------------- hero */

  /* The badge in the strip's top corner, and the second reason it exists: when
     the period itself cannot be read it names the period instead of counting
     its days, which is the only place on the panel that sentence is printed.

     The first reason — the waxing moon and "day N of M" — belongs to the
     net-worth card by §2.5, and two discs a hundred pixels apart are one
     reading printed twice. So the badge draws them only when that card did not:
     on a clean install, where the card has no measured number for them to sit
     beside, and on a build whose model cannot answer netWorth at all. Answering
     null costs the strip nothing at any width — the badge is positioned
     absolutely, so no sibling moves into the space it leaves. */
  function heroAside(periodKey, progress, taken) {
    if (taken) return null;

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
        /* Only the press animates. These nodes are rebuilt on every redraw
           without the class, so opened detail that is merely redrawn sits
           still instead of blinking behind whatever the reader is doing. */
        if (!node.classList) return;
        if (detailsOpen) node.classList.add("is-revealed");
        else node.classList.remove("is-revealed");
      });
    }, false);

    if (bodyLine) {
      if (doc && doc.createTextNode) bodyLine.appendChild(doc.createTextNode(" "));
      bodyLine.appendChild(toggle);
      return null;
    }
    return dom.el("p", { "class": "hero__line" }, toggle);
  }

  function heroStrip(periodKey, allowance, summary, progress, phaseTaken) {
    var reading = heroReading(periodKey, allowance, summary);
    var kids = [];

    var aside = heroAside(periodKey, progress, phaseTaken);
    if (aside) kids.push(aside);
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

  /* Moon.Model.budgetRows answers with the money and nothing else, so a row's
     two marks are looked up on the category record where §3.4 keeps them. The
     store fills both in on every read, which makes this a lookup and never a
     default. */
  function categoryOf(categoryId) {
    if (!categoryId) return null;
    if (typeof Moon.Model.categoryById !== "function") return null;
    return safe(function () { return Moon.Model.categoryById(categoryId); }, null);
  }

  /* A record stores a plain hex, because an export has to mean the same colour
     next year and in somebody else's browser. A theme stores a token, because
     Dawn darkens all ten of the spectrum to clear contrast on white. Painting
     the hex straight onto the row would therefore show a reader on Dawn a
     different colour from the one they picked, so both ends go through Moon.UI,
     which pairs the token with the stored hex as its fallback. */
  function toneOf(dress) {
    if (!dress || !dress.color || typeof Moon.UI.tone !== "function") return "";
    return safe(function () { return Moon.UI.tone(dress.color); }, "") || "";
  }

  /* The card wears the category's colour down its leading edge whether or not
     it has a limit, so the tone is set where the row is built rather than
     beside the chart. */
  function rowAttrs(className, dress) {
    var attrs = { "class": className };
    var tone = toneOf(dress);
    if (tone) attrs.style = { "--tone": tone };
    return attrs;
  }

  /* The icon rides in front of the name, where a reader picking one row out of
     six finds it before they have read a word, and it is hidden from the
     accessibility tree because the scale beside it is already labelled with the
     category's name — read aloud it would only say the same thing twice. Its
     gap is inline: the stylesheet carries no class for a mark inside
     .meter__name and §10 forbids this file inventing one. */
  function nameCell(row, dress) {
    var kids = [];
    if (dress && dress.icon) {
      kids.push(dom.el("span", {
        "aria-hidden": "true",
        style: { "margin-right": "6px" }
      }, dress.icon));
    }
    kids.push(row.name);

    return dom.el("span", {
      "class": "meter__name" + (row.fixed ? " is-fixed" : ""),
      title: row.name
    }, kids);
  }

  /* One scale per category, in the stylesheet's own three columns: name, track,
     reading. The track and the percentage stay one SVG so an overrun can cross
     the end cap and reach into the reading column (G1) — `.meter__scale` is
     overflow:visible for exactly that — while the drift sentence is an HTML
     node in the third column, because a 24-unit meter has room for one line of
     text and the percentage is it. js/views.limits.js builds the same row the
     same way, and these two must not drift apart. */
  function meterRow(row) {
    var over = row.driftState === "over";
    var dress = categoryOf(row.categoryId);
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
      percentText: t("limits.pct", { pct: row.pct === null ? 0 : row.pct })
    }));

    var readout = dom.el("span", { "class": "meter__readout" });
    var drift = driftText(row);
    if (drift) readout.appendChild(dom.el("span", { "class": "meter__drift", text: drift }));

    return dom.el("div", rowAttrs(classes.join(" "), dress), [
      nameCell(row, dress),
      dom.el("div", { "class": "meter__scale" }, svgNode(markup, null)),
      readout
    ]);
  }

  /* A category with no limit is not a scale at zero: it is a number. It takes
     the track's column rather than the reading's, so the eye scanning the
     middle of the list for "how much" finds it where every bar ends. */
  function plainRow(row) {
    var dress = categoryOf(row.categoryId);
    return dom.el("div", rowAttrs("meter", dress), [
      nameCell(row, dress),
      dom.el("div", { "class": "meter__scale" }, moneyCell(row.spent, { dim: true, sign: false })),
      dom.el("span", { "class": "meter__readout" })
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

  function countOf(read) {
    var list = safe(read, null);
    return list && typeof list.length === "number" ? list.length : 0;
  }

  /* The whole store untouched: nothing written down, no account, no holding.
     The three ways in answer that one moment and no other. A reader who has
     already entered four accounts and six holdings has started — the net-worth
     card above them is printing a measured number — and all they are short of
     is entries; offering them the sample month there would read as an offer to
     put their own setup aside. */
  function untouched() {
    if (countOf(function () { return Moon.Model.entries({}); })) return false;
    if (countOf(function () { return Moon.Model.accounts({ all: true }); })) return false;
    if (countOf(function () { return Moon.Model.investments({ all: true }); })) return false;
    return true;
  }

  /* The row that writes an entry is already on this screen, a few lines up, so
     "write one expense" puts the caret in it rather than carrying the reader to
     another section to do the same thing there. Without the ledger's row there
     is nothing here to focus, and the section that owns it is the honest second
     answer. */
  function focusQuickEntry(root) {
    var field = root && root.querySelector
      ? root.querySelector('.quickrow [name="amount"]')
      : null;
    if (!field || typeof field.focus !== "function") {
      navigateTo("defter");
      return;
    }
    if (typeof field.scrollIntoView === "function") {
      safe(function () { return field.scrollIntoView({ block: "center" }); }, null);
    }
    field.focus();
  }

  /* G9: the ledger's rules are printed before any data exists, and the three
     ways in are full rows, not a row of buttons.

     One card in either state, because a screen that has nothing to show should
     not say so twice. A store with accounts or holdings in it but no entries is
     not a first run, so it gets the shorter sentence and no invitation to begin
     again; everything else about the panel above it already works. */
  function emptyPanel(root) {
    if (!untouched()) {
      return Moon.UI.emptyState({
        headingLevel: "h2",
        headingKey: "empty.panel.heading",
        bodyKey: "empty.panel.body"
      });
    }

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
          onClick: function () { focusQuickEntry(root); }
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

  /* Raised by whoever just wrote an entry, so the next render marks the hero
     figure — the number that entry changed. Writing raises state:change and the
     router answers it on the next tick, so marking at the moment of the write
     would only be undone; the flag asks whoever draws next to do it instead.
     Read once and cleared, so a redraw for any other reason is still. */
  var settleHero = false;

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
      root.appendChild(emptyPanel(root));
      applyCssHooks(root);
      return;
    }

    var allowance = safe(function () { return Moon.Model.dailyAllowance(periodKey); }, null) || BLANK;
    var summary = safe(function () { return Moon.Model.periodSummary(periodKey); }, null) || {
      spentTotal: 0, limitTotal: 0, limitVariable: 0, entryCount: 0
    };
    var progress = progressOf(periodKey);

    /* §5.3: what there is, above what can be spent. The two readings answer
       different questions and neither one explains the other, so the card goes
       first and the strip below it is untouched. */
    var worth = netWorthCard(progress);
    if (worth.element) root.appendChild(worth.element);

    root.appendChild(heroStrip(periodKey, allowance, summary, progress, worth.phase));
    markSettled(root);

    /* The six-field row that used to sit here is gone. Writing something down is
       still the thing done most often, which is why it moved to the button that
       is on every screen: tap, type the amount, tap a category, done. The row
       cost 219px of a 640px phone to say what two taps now say, and the owner's
       word for it was "teferruat". The detailed row still exists in the ledger,
       for the day someone wants a note and a date and a direction on one line. */

    var pending = safe(function () { return Moon.Model.pendingRecurring(periodKey); }, []) || [];
    if (pending.length) root.appendChild(pendingBand(periodKey, pending));

    /* An empty ledger gets the notebook's first page, not four empty sections.
       The strip stays: it is the CSV target in every state (G11). */
    var total = countOf(function () { return Moon.Model.entries({}); });
    if (!total) {
      root.appendChild(emptyPanel(root));
      applyCssHooks(root);
      return;
    }

    root.appendChild(limitsSection(periodKey, summary));
    root.appendChild(flowSection(periodKey));
    root.appendChild(cumulativeSection(periodKey));
    applyCssHooks(root);
  }

  /* The figure the entry just moved, redrawn in front of the reader. One mark,
     one render: the flag is cleared whether or not the strip was drawn, so it
     can never spill onto a later redraw that nobody asked for. */
  function markSettled(root) {
    if (!settleHero) return;
    settleHero = false;
    ["hero__value", "hero__trail"].forEach(function (name) {
      var node = root.querySelector("." + name);
      if (node && node.classList) safe(function () { node.classList.add("is-settled"); }, null);
    });
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
    destroy: destroy,
    /* Called by whoever writes an entry from outside this file -- the quick
       sheet does -- so the hero figure is marked on the redraw that follows.
       Without it the number the entry just changed would simply be different
       the next time the reader looked, with nothing saying it moved. */
    markWrite: function () { settleHero = true; }
  };
})(window);
