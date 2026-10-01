/* Moon — the Investments section (#yatirim; spec §5.2, class contract §10).
 *
 * A portfolio is read by comparing its lines, so this screen is a list and
 * never a deck of cards: one summary card at the top, one value trail, one
 * share bar, and under them a single .holdings card whose rows carry an icon,
 * a name and a gain on the first line and the quantity and the value on the
 * second. Everything else a holding carries — what it cost, when its price was
 * last typed, the note on it, and the controls that correct its name, its kind,
 * its quantity, its unit cost and its price — lives inside the row and opens
 * where it stands. That is the whole reason there is no dialog in this file
 * except the one question before a delete: these are figures the reader changes
 * over and over, and paying a modal for four digits is the most expensive way
 * to type them.
 *
 * Four readings, in reading order:
 *   1. the summary (.invsum): what the holdings are worth, what they cost, and
 *      the gain in money and per cent, tinted by its sign. A gain measured
 *      against no cost is not a gain, so when the cost is zero the card says
 *      so in words instead of printing a confident percentage.
 *   2. the value trail (Charts.valueSeries over Moon.Model.investmentSeries).
 *      Two prices make a trend; one makes a dot, and a dot stretched into a
 *      flat line would claim a year of standing still — so a single price gets
 *      the catalogue's sentence and no drawing at all.
 *   3. the share bar (Charts.stackedBar over investmentTotals().kinds). §2.6
 *      bans the pie and the donut; nobody reads an angle.
 *   4. the holdings themselves, value first, with the adder below them.
 *
 * The view only reads. Every change goes through Moon.Model, never through
 * Moon.Store, and the router re-renders this whole file on state:change and
 * lang:change — so render() clears its root, keeps no DOM between calls and may
 * run any number of times. That redraw is also why the reader's own answers
 * live at module level and not in the DOM: WHICH row is open and the ranking
 * that row is holding still, the refusal a mistyped quantity earned, the
 * sentence the last action left behind, and where the caret belongs. A write
 * destroys the control that made it, so "focus this once" would be spent by the
 * first of the two redraws one click can cause.
 *
 * Three seams, each documented where it is used:
 *   - ui.js and moon.css were written in parallel and spell a few names
 *     differently. Neither file is ours to edit, so the stylesheet's spelling
 *     is added to the nodes Moon.UI hands back.
 *   - moon.css belongs to another hand this round, and §10 forbids a view to
 *     invent a class that paints. Where the row's own measurements had to move
 *     — the name needs the full width, --amount-col reserves a ledger column
 *     the holdings list does not use — the nodes are placed with inline style
 *     instead, and nothing inline here carries a colour, a weight or a size.
 *   - the catalogue names a few labels this screen wants and does not carry
 *     yet (an archive verb of its own, a word for a colour, the reading each
 *     inline control should announce). Each is asked for first, so a later
 *     catalogue wins by itself, and falls back to a key that already says the
 *     same thing. Nothing is hard-coded.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var dom = Moon.dom;

  /* How many periods of price history the trail reads. The model's own default
     is the same number; it is written here because the chart's x axis is this
     view's reading, not the model's. */
  var TRAIL_MONTHS = 12;

  /* What the summary and a row read when the model cannot answer. Zeros, not
     nulls: every caller below prints them, and an empty portfolio is worth
     nothing rather than unknown. A null gainRatio is the one honest unknown —
     it means there was no cost to measure the gain against. */
  var BLANK_READING = { value: 0, cost: 0, gain: 0, gainRatio: null };
  var BLANK_TOTALS = { value: 0, cost: 0, gain: 0, gainRatio: null, kinds: [], count: 0 };

  /* Which holding is open. It survives the redraw every write brings with it,
     or correcting a price would fold the row that was being corrected. */
  var openId = null;

  /* The sentence the last action left behind, read by the next render and kept
     until the reader dismisses it or acts again: app.js answers state:change on
     a timer, so a slot emptied on sight is empty again a tick later and the
     sentence never reaches the screen. */
  var flash = null;

  /* Where the caret belongs after the next render, as a data-focus stamp this
     render also publishes. */
  var pendingFocus = null;

  /* Which holding held the list's single tab stop. Kept as an id rather than as
     a position, because the list is ranked by value: correcting a price can
     move the row that was just worked on past the one above it, and a
     remembered index would then hand the keyboard to its neighbour. */
  var rowId = null;

  /* The ranking the list is drawn in, newest draw last, and the copy of it that
     is held while a row is open.

     Value is the right order for a list nobody is touching, and the wrong one
     for the row somebody is working in: typing a corrected price can lift that
     row past the one above it, and the panel the reader is reading slides out
     from under their hand mid-sentence. So the order is frozen the moment a row
     opens and let go the moment it closes — the list re-ranks itself on the
     next draw, when the reader is looking at the list again rather than at one
     line of it. */
  var lastOrder = [];
  var frozenOrder = null;

  /* The refusal a corrected quantity left behind, as {id, key}. inlineValue
     paints one sentence of its own when a save is refused, and the three ways
     a quantity can be wrong — unreadable, too precise, negative — are three
     different sentences a reader needs by name. So the code is kept here and
     the control is told to show it as the next draw builds it. */
  var quantityError = null;

  /* The kind the adder was last used with. keepOnSubmit holds a field within
     one quickRow; this holds it across the redraw that every write causes, so
     entering four funds in a row is four names and four Enters. */
  var addMemory = { kind: "stock" };

  var lastRoot = null;
  var roving = null;

  /* The two pickers in the adder's folded half. They are nodes, not fields, so
     quickRow neither reads nor clears them and this file holds their apis. */
  var pickers = { color: null, icon: null };

  /* ---------------------------------------------------------------- basics */

  function log(error) {
    if (global.console && global.console.error) {
      global.console.error("Moon.Views.investments", error);
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
    var I18n = Moon.I18n;
    if (key === null || key === undefined || key === "") return "";
    if (I18n && typeof I18n.t === "function") {
      try {
        return I18n.t(key, params);
      } catch (error) {
        log(error);
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

  /* The key this file asks for if the catalogue can answer it, otherwise the
     existing key that carries the same sentence. */
  function keyOf(wanted, fallback) {
    return has(wanted) ? wanted : fallback;
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

  function lang() {
    var I18n = Moon.I18n;
    return (I18n && I18n.lang) || "tr";
  }

  function currency() {
    return settings().currency || "TRY";
  }

  function store() {
    return Moon.Store || {};
  }

  /* A read-only constant from the store, for the kind picker and the icon a
     record arrives without. A missing store must not blank the screen. */
  function constant(name, fallback) {
    var value = store()[name];
    return value === null || value === undefined ? fallback : value;
  }

  /* ----------------------------------------------------------------- money */

  function money(minor, opts) {
    var Money = Moon.Money;
    var value = typeof minor === "number" && isFinite(minor) ? Math.round(minor) : 0;
    if (Money && typeof Money.format === "function") {
      try {
        var text = Money.format(value, {
          currency: currency(),
          lang: lang(),
          symbol: true,
          sign: !!(opts && opts.sign)
        });
        if (text) return String(text);
      } catch (error) {
        log(error);
      }
    }
    return String(value);
  }

  /* English puts the currency symbol in front of the digits and moon.css moves
     it there by grid column, so the cell has to say which language it is in —
     ui.js adds .is-sym-first itself once it is given the currency and the
     language, which is why neither is omitted here. */
  function moneyCell(minor, extra) {
    var UI = Moon.UI;
    if (UI && typeof UI.moneyCell === "function") {
      try {
        return UI.moneyCell(minor, {
          currency: currency(),
          lang: lang(),
          sign: false,
          "class": extra || null
        });
      } catch (error) {
        log(error);
      }
    }
    return dom.el("span", { "class": extra ? "money " + extra : "money", text: money(minor) });
  }

  /* A holding is counted in units, not in money: half a coin, 1.250,75 grams.
     Both directions go through Moon.Money so the field and the reading cannot
     disagree about where the decimal mark is. */
  function quantityText(value) {
    var Money = Moon.Money;
    if (Money && typeof Money.formatQuantity === "function") {
      try {
        var text = Money.formatQuantity(value, { lang: lang() });
        if (text) return String(text);
      } catch (error) {
        log(error);
      }
    }
    return String(value === null || value === undefined ? "" : value);
  }

  function readQuantity(text) {
    var Money = Moon.Money;
    if (!Money || typeof Money.parseQuantity !== "function") {
      return { ok: false, value: null, error: "err.quantityInvalid" };
    }
    try {
      return Money.parseQuantity(text);
    } catch (error) {
      log(error);
      return { ok: false, value: null, error: "err.quantityInvalid" };
    }
  }

  /* ----------------------------------------------------------------- dates */

  function formatDay(date) {
    var Dates = Moon.Dates;
    if (!date) return "";
    if (Dates && typeof Dates.formatDate === "function") {
      try {
        var text = Dates.formatDate(date, lang(), "short");
        if (text) return String(text);
      } catch (error) {
        log(error);
      }
    }
    return String(date);
  }

  /* ------------------------------------------------------------ model reads */

  function model() {
    return Moon.Model;
  }

  /* One bad record must not blank the section, so every reading comes through
     here and a throw becomes the fallback rather than an empty screen. */
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

  function holdings(all) {
    var rows = read("investments", all ? { all: true } : undefined, []);
    return Object.prototype.toString.call(rows) === "[object Array]" ? rows : [];
  }

  function readingOf(record) {
    return read("investmentValue", record, BLANK_READING) || BLANK_READING;
  }

  function nameOf(record) {
    var name = record && record.name ? String(record.name).replace(/^\s+|\s+$/g, "") : "";
    return name || t("common.unclassified");
  }

  function kindOf(record) {
    var kinds = constant("INVESTMENT_KINDS", []);
    var kind = record && record.kind ? String(record.kind) : "";
    return kinds.indexOf(kind) === -1 ? "other" : kind;
  }

  /* Named from the list the store keeps rather than from the record, so a kind
     a hand-edited file invented prints "Other" instead of its own raw key. */
  function kindLabel(kind) {
    var kinds = constant("INVESTMENT_KINDS", []);
    var name = kind && kinds.indexOf(String(kind)) !== -1 ? String(kind) : "other";
    return t("investments.kind." + name);
  }

  function iconOf(record) {
    if (record && record.icon) return String(record.icon);
    var byKind = constant("ICON_BY_INVESTMENT_KIND", {});
    return byKind[kindOf(record)] || constant("FALLBACK_ICON", "•");
  }

  function hexOf(record) {
    var value = record && record.color ? String(record.color).trim() : "";
    return /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : null;
  }

  /* What a row may write into style="--tone: …", which is never the stored hex.
     A record keeps a hex because that is what an export has to mean the same
     thing next year; Dawn darkens all ten spectrum colours so they clear 4.5:1
     on white, so painting the hex would show a reader on Dawn a different
     colour from the one they picked. Moon.UI.tone answers the theme's token
     with the hex as its fallback, which is also what keeps a colour from
     outside the ten painting exactly as written. */
  function toneOf(record) {
    var UI = Moon.UI;
    var hex = hexOf(record);
    if (!hex) return null;
    if (!UI || typeof UI.tone !== "function") return hex;
    try {
      return UI.tone(hex) || hex;
    } catch (error) {
      log(error);
      return hex;
    }
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

  function small(children, extra) {
    return dom.el("p", { "class": extra ? "sm " + extra : "sm" }, children);
  }

  /* A label and the figure it names, as two inline nodes rather than one
     joined string: Turkish and English put the currency symbol on different
     sides of the digits and neither language survives string addition. */
  function reading(labelKey, text, extra) {
    return small([dom.el("span", { text: t(labelKey) }), " ", dom.el("span", { text: text })], extra);
  }

  function tag(text) {
    return dom.el("span", { "class": "tag", text: text });
  }

  function actionRow(children) {
    return dom.el("div", { "class": "form__actions" }, children);
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
      return UI.dataTable(columns, rows, opts);
    } catch (error) {
      log(error);
      return null;
    }
  }

  /* Where a chart stands. The wrapper is what gives the slot its rhythm and
     lets a drawing overflow its own box (a legend entry may reach past the
     viewBox), and it is also where the sentence goes when there is not enough
     price history to draw anything — so the slot is in the same place whether
     or not there is a chart in it. */
  function chartSlot(children) {
    return dom.el("div", { "class": "chart" }, children);
  }

  function svgOf(markup) {
    if (!markup) return null;
    try {
      return dom.svg(markup);
    } catch (error) {
      log(error);
      return null;
    }
  }

  /* ---------------------------------------------------------- focus stamps */

  function focusTag(kind, id) {
    return kind + ":" + (id === null || id === undefined ? "" : String(id));
  }

  function stamp(node, mark) {
    if (node && typeof node.setAttribute === "function") node.setAttribute("data-focus", mark);
    return node;
  }

  /* Compared rather than selected: a holding id is generated text, and building
     a selector out of it would be one escaping bug waiting to happen. */
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

  /* ------------------------------------------------------- saying something */

  function say(key, params, kind) {
    flash = key ? { key: key, params: params || null, kind: kind || "info" } : null;
  }

  function flashBand() {
    var UI = Moon.UI;
    var current = flash;
    if (!current || !UI || typeof UI.notice !== "function") return null;
    var node;
    try {
      node = UI.notice({
        /* .notice.is-<kind> is what moon.css colours the left rule with, and
           ui.js writes that class from `kind` itself — passing it again as a
           class would put the same word on the node twice. */
        kind: current.kind,
        messageKey: current.key,
        params: current.params,
        dismissible: true,
        dismissKey: "common.close",
        /* Without this the next redraw brings the same sentence straight back
           and the close button reads as broken. */
        onDismiss: function () {
          if (flash === current) flash = null;
        }
      });
    } catch (error) {
      log(error);
      return null;
    }
    addClass(dom.qs(".notice__text", node), "notice__body");
    return node;
  }

  /* A redraw this view asks for itself, for the paths where nothing in the
     store changed — a refused write, a dismissed question. render() is
     idempotent, so an extra draw costs a rebuild and nothing else. */
  function redraw() {
    if (!lastRoot) return;
    var doc = lastRoot.ownerDocument;
    if (doc && doc.contains && !doc.contains(lastRoot)) return;
    try {
      render(lastRoot);
    } catch (error) {
      log(error);
    }
  }

  /* Shutting the open row is three facts, not one: nothing is open, the ranking
     is free to sort itself again, and the refusal that belonged to a control
     inside that row has nowhere left to be shown. */
  function closeRow() {
    openId = null;
    frozenOrder = null;
    quantityError = null;
  }

  /* The same redraw, after the control that asked for it has finished its own
     work. inlineValue goes on painting its button and moving the caret after
     onSave answers, and a redraw from inside that answer would hand it a node
     that is no longer in the document. */
  function queueRedraw() {
    if (!global.setTimeout) {
      redraw();
      return;
    }
    global.setTimeout(function () {
      redraw();
    }, 0);
  }

  /* --------------------------------------------------------- the summary */

  /* The gain in money over the per cent under it, rather than the catalogue's
     one-line reading: the cell is the narrow column of a two-column card, and
     a whole sentence set at 20px/700 there squeezes the big number beside it
     down to nothing. The sentence itself is used where it has room — inside an
     open row. */
  function gainBlock(total) {
    /* A gain measured against no cost is not a gain — it is the whole value
       reported as profit. The model says so by answering null, and the card
       says it in words rather than printing a percentage nobody measured. */
    if (total.gainRatio === null || total.gainRatio === undefined) {
      return dom.el("div", { "class": "invsum__gain" }, [
        dom.el("p", { text: t("investments.gain") }),
        dom.el("p", { "class": "sm", text: t("common.none") })
      ]);
    }

    var classes = ["invsum__gain"];
    if (total.gain > 0) classes.push("is-up");
    else if (total.gain < 0) classes.push("is-down");

    return dom.el("div", { "class": classes.join(" ") }, [
      dom.el("p", { text: money(total.gain, { sign: true }) }),
      dom.el("p", { "class": "sm", text: t("investments.gainPct", { pct: total.gainRatio }) })
    ]);
  }

  function summaryCard(total) {
    /* Plain text, not a money cell: the cell's grid exists so that a column of
       amounts puts every decimal mark on the same pixel, and it reserves a
       fixed 6px for the separator to do it. At 28px that track clips the comma,
       and one number has no column to agree with anyway. */
    var value = dom.el("p", { "class": "invsum__value", text: money(total.value) });
    var cost = reading(
      "investments.cost",
      total.cost > 0 ? money(total.cost) : t("common.none"),
      "invsum__cost"
    );
    return dom.el("div", { "class": "invsum" }, [value, cost, gainBlock(total)]);
  }

  /* ------------------------------------------------------- the value trail */

  function trailBlock() {
    var Charts = Moon.Charts;
    var points = read("investmentSeries", TRAIL_MONTHS, []);
    if (Object.prototype.toString.call(points) !== "[object Array]") points = [];

    /* §5.2: two prices make a trend. Below that the catalogue's sentence says
       what is missing and the slot stays empty rather than carrying a flat line
       that would claim a year of standing still. */
    if (points.length < 2 || !Charts || typeof Charts.valueSeries !== "function") {
      return [chartSlot(small(t("investments.chart.none"), "dim"))];
    }

    var last = points[points.length - 1];
    var markup = null;
    try {
      markup = Charts.valueSeries(points, {
        title: t("investments.value"),
        /* The trail's own description. The newest reading is what a chart of
           value answers, so that is what the <desc> states; a key written for
           this drawing wins by itself the moment the catalogue carries one. */
        desc: t(keyOf("a11y.chart.value.desc", "a11y.chart.point"), {
          date: formatDay(last.date),
          amount: money(last.value)
        }),
        emptyText: t("investments.chart.none"),
        formatValue: function (minor) { return money(minor); },
        formatDate: formatDay
      });
    } catch (error) {
      log(error);
    }

    var nodes = [chartSlot(svgOf(markup) || small(t("investments.chart.none"), "dim"))];
    /* Every chart in this app carries the same numbers as a real table: it is
       the printable and screen-readable twin, and it is closed until asked for. */
    var table = dataTable(
      [{ labelKey: "form.date", type: "date" }, { labelKey: "investments.value", type: "money" }],
      points.map(function (point) { return [point.date, point.value]; }),
      { currency: currency() }
    );
    if (table) nodes.push(table);
    return nodes;
  }

  /* --------------------------------------------------------- the share bar */

  function kindBar(total) {
    var Charts = Moon.Charts;
    var kinds = Object.prototype.toString.call(total.kinds) === "[object Array]" ? total.kinds : [];
    /* A share bar divides something. A portfolio of holdings nobody has priced
       yet has nothing to divide, so there is no bar rather than an empty frame
       where one should be. */
    if (!kinds.length || !(total.value > 0)) return [];
    if (!Charts || typeof Charts.stackedBar !== "function") return [];

    var biggest = kinds[0];
    var markup = null;
    try {
      markup = Charts.stackedBar(kinds.map(function (group) {
        /* The kind's name alone. charts.js clips a segment label to 24
           characters, which is shorter than the catalogue's own byKind sentence
           in either language — and a legend that reads "Hisse, 42.000,00 ₺,
           topl…" is worse than no figures at all. The figures are in the bar's
           own geometry and in the table under it; the legend is here to say
           which colour is which. */
        return { label: kindLabel(group.kind), value: group.value };
      }), {
        title: t("investments.byKind"),
        /* The dominant share, said in full. A <desc> is not clipped, so this is
           the one place the catalogue's byKind sentence fits as written. */
        desc: t("investments.byKind.row", {
          name: kindLabel(biggest.kind),
          amount: money(biggest.value),
          pct: biggest.share === null || biggest.share === undefined ? 0 : biggest.share
        })
      });
    } catch (error) {
      log(error);
    }

    var svg = svgOf(markup);
    if (!svg) return [];

    var nodes = [chartSlot([
      dom.el("h3", { text: t("investments.byKind") }),
      svg
    ])];
    var table = dataTable(
      [
        { labelKey: "investments.byKind" },
        { labelKey: "investments.value", type: "money" },
        { labelKey: "investments.gain", type: "money" }
      ],
      kinds.map(function (group) {
        return [kindLabel(group.kind), group.value, group.gain];
      }),
      { currency: currency() }
    );
    if (table) nodes.push(table);
    return nodes;
  }

  /* ----------------------------------------------------------- the writes */

  /* Correcting a holding in place.
   *
   * Everything a holding carries was typed by hand, so everything a hand can
   * mistype is correctable where it stands. Before this, only the price was:
   * a name, a kind, a quantity or a unit cost entered wrong could be mended
   * only by deleting the holding and writing it again — which also threw away
   * every price ever recorded against it, the one thing in the record that
   * cannot be typed back.
   *
   * Four controls, no dialog, each writing through Moon.Model.updateInvestment
   * the moment it is left. They live in the detail rather than in the row,
   * because a closed row is a reading and an open one is the workbench.
   */

  /* moon.css aligns an inlineValue to the right, which is the only sane place
     for a figure and the wrong one for a name. */
  function leftAlign(element) {
    dom.qsa(".inlinevalue__btn, .inlinevalue__input", element).forEach(function (half) {
      css(half, "text-align", "left");
    });
    return element;
  }

  /* A label and the control it names on one line. The label is a word, not a
     sentence, so it sits beside the figure rather than above it: the detail is
     already four readings deep and four stacked field labels would make the
     open row taller than the screen on a phone. */
  function editRow(labelKey, control) {
    if (!control) return null;
    return small([dom.el("span", { text: t(labelKey) }), " ", control]);
  }

  function inlineValue(spec) {
    var UI = Moon.UI;
    if (!UI || typeof UI.inlineValue !== "function") return null;
    try {
      return UI.inlineValue(spec);
    } catch (error) {
      log(error);
      return null;
    }
  }

  /* One writer for all four corrections, so a mended name and a mended quantity
     cannot disagree about what saving means. It answers the way inlineValue
     asks: false puts the old reading back and makes the control say so. */
  function writeHolding(record, patch, tag) {
    var Model = model();
    if (!Model || typeof Model.updateInvestment !== "function") return false;
    pendingFocus = tag;
    if (!Model.updateInvestment(record.id, patch)) {
      pendingFocus = null;
      return false;
    }
    /* A refusal is an answer to one attempt. Once anything about the holding
       has been written, the sentence beside the quantity is complaining about
       something the reader has already moved on from. */
    quantityError = null;
    say("investments.saved");
    return true;
  }

  function nameControl(record) {
    var tag = focusTag("name", record.id);
    /* The stored name, not nameOf()'s stand-in for a nameless record: the box
       is what the reader will type over, and starting them off with the word
       Moon uses for "this arrived without a name" would write that word into
       the record the moment they pressed Enter. */
    var current = String(record && record.name ? record.name : "").replace(/^\s+|\s+$/g, "");
    var api = inlineValue({
      value: current,
      type: "text",
      maxLength: constant("INVESTMENT_NAME_MAX", 80),
      /* inlineValue turns a labelKey into an aria-label, which stands in place
         of the text under it rather than adding to it — so the key asked for
         here carries the reading as well as the job. Until the catalogue has
         one, the plain field label stands and the reader at least hears what
         the control is. */
      labelKey: keyOf("investments.name.edit", "investments.name"),
      labelParams: function (value) {
        return { name: value === null || value === undefined ? "" : String(value) };
      },
      onSave: function (value) {
        var name = String(value === null || value === undefined ? "" : value)
          .replace(/^\s+|\s+$/g, "");
        /* A holding with no name cannot be told from the next nameless one, so
           an emptied name is the one text this control refuses. */
        if (!name) return false;
        if (name === current) return true;
        return writeHolding(record, { name: name }, tag);
      }
    });
    if (!api) return null;
    stamp(dom.qs(".inlinevalue__btn", api.element), tag);
    return leftAlign(api.element);
  }

  /* The kind is a choice from a closed list, so it is the one correction that
     is a select rather than a typed value. It writes on change: an Apply button
     beside it would make the detail a form, and this screen has none. */
  function kindControl(record) {
    var UI = Moon.UI;
    if (!UI || typeof UI.field !== "function") return null;
    var current = kindOf(record);
    var node;
    try {
      node = UI.field({
        type: "select",
        name: "kind",
        labelKey: "form.kind",
        value: current,
        options: kindOptions(),
        onChange: function (value) {
          if (!value || value === current) return;
          if (writeHolding(record, { kind: value }, focusTag("kind", record.id))) return;
          /* The select is still handling its own change event, so the draw that
             puts the old kind back waits for it to finish with the node. */
          say("err.unknown", null, "error");
          queueRedraw();
        }
      });
    } catch (error) {
      log(error);
      return null;
    }
    stamp(node.moonField ? node.moonField.control : null, focusTag("kind", record.id));
    return node;
  }

  /* §3.3 keeps a quantity as an integer at ×10⁴, and Moon.Money.parseQuantity
     is the only thing in the app that reads one. A fifth decimal place is
     refused rather than rounded, because only the reader who typed it knows
     what they meant by it — so this control never writes a number the reader
     did not actually type, and names which of the three refusals it was. */
  function quantityControl(record) {
    var tag = focusTag("quantity", record.id);
    var api = inlineValue({
      /* Text, not money and not number: a quantity has four decimal places
         where an amount has two, and a number box would also put a spinner on
         a figure nobody steps by one. */
      type: "text",
      value: quantityText(record.quantity),
      labelKey: keyOf("investments.quantity.edit", "investments.quantity"),
      labelParams: function (value) {
        return { quantity: value === null || value === undefined ? "" : String(value) };
      },
      onSave: function (value) {
        var typed = String(value === null || value === undefined ? "" : value)
          .replace(/^\s+|\s+$/g, "");
        /* An emptied box is not a holding of nothing, it is a reader who
           changed their mind, so the stored quantity comes back. */
        if (!typed) return false;
        var read = readQuantity(typed);
        if (!read.ok) {
          quantityError = { id: record.id, key: read.error || "err.quantityInvalid" };
          pendingFocus = tag;
          queueRedraw();
          return false;
        }
        quantityError = null;
        if (read.value === record.quantity) return true;
        return writeHolding(record, { quantity: read.value }, tag);
      }
    });
    if (!api) return null;
    stamp(dom.qs(".inlinevalue__btn", api.element), tag);
    /* The refusal the last attempt earned, put back on the control the draw
       that follows it builds. */
    if (quantityError && quantityError.id === record.id && typeof api.setError === "function") {
      api.setError(quantityError.key);
    }
    return api.element;
  }

  function unitCostControl(record) {
    var tag = focusTag("unitCost", record.id);
    var cost = typeof record.unitCost === "number" ? record.unitCost : 0;
    var api = inlineValue({
      value: cost,
      type: "money",
      currency: currency(),
      labelKey: keyOf("investments.unitCost.edit", "investments.unitCost"),
      labelParams: function (value) {
        return { amount: money(value) };
      },
      onSave: function (next) {
        /* An emptied box has no honest reading: a unit cost of nothing says the
           holding was free, which is a different claim from "I have not said".
           §3.3 already stores an unsaid cost as zero, so the reader who means
           free types a zero. */
        if (typeof next !== "number" || !isFinite(next)) return false;
        var wanted = Math.round(next);
        if (wanted < 0) return false;
        if (wanted === cost) return true;
        return writeHolding(record, { unitCost: wanted }, tag);
      }
    });
    if (!api) return null;
    stamp(dom.qs(".inlinevalue__btn", api.element), tag);
    return api.element;
  }

  /* The price is the one figure on this screen that changes often, so it is the
     one with a field of its own. setInvestmentPrice appends a row to the
     holding's history (or replaces today's), which is what the trail reads —
     the chart appears by itself once a second price has been typed. */
  function priceRow(record) {
    var UI = Moon.UI;
    var Model = model();
    if (!UI || typeof UI.quickRow !== "function" || !Model) return null;

    var api;
    try {
      api = UI.quickRow({
        id: "yatirim-fiyat-" + record.id,
        labels: "visible",
        submitLabelKey: "investments.updatePrice",
        /* The typed figure stays until the redraw replaces the whole row: a
           price box that blanks itself on save reads as a price that was lost. */
        keepOnSubmit: ["unitPrice"],
        fields: [{
          type: "money",
          name: "unitPrice",
          labelKey: "investments.unitPrice",
          hintKey: "investments.unitPrice.hint",
          currency: currency(),
          value: record.unitPrice,
          required: true
        }],
        onSubmit: function (values) {
          var price = values.unitPrice;
          if (price === null || price === undefined) {
            return { ok: false, errors: { unitPrice: "err.priceRequired" } };
          }
          if (price < 0) return { ok: false, errors: { unitPrice: "err.badAmount" } };
          pendingFocus = focusTag("price", record.id);
          if (!Model.setInvestmentPrice(record.id, price)) {
            pendingFocus = null;
            return { ok: false, errors: { unitPrice: "err.unknown" } };
          }
          /* Not an undo offer: putting a replaced price back would mean writing
             a history row for a day the reader never typed one on. The write is
             reported, and the figure is editable in the same box it came from. */
          say("investments.priceSaved");
          return { ok: true };
        }
      });
    } catch (error) {
      log(error);
      return null;
    }

    var field = api.fields ? api.fields.unitPrice : null;
    if (field && field.control) stamp(field.control, focusTag("price", record.id));
    return api.element;
  }

  /* Archiving asks nothing: the holding stays in the list under its own mark
     and the same control puts it back, so there is nothing to undo. */
  function toggleArchived(record) {
    var Model = model();
    if (!Model || typeof Model.updateInvestment !== "function") return;
    pendingFocus = focusTag("archive", record.id);
    if (!Model.updateInvestment(record.id, { archived: !record.archived })) pendingFocus = null;
  }

  /* Deleting asks, because this is the one act on this screen that destroys
     something: the holding's whole price history goes with it, and re-adding
     the record would not bring the history back. That is also why there is no
     undo band afterwards — the question was the offer. */
  function askDelete(record) {
    var UI = Moon.UI;
    var Model = model();
    if (!UI || typeof UI.confirm !== "function" || !Model) return;

    var ask;
    try {
      ask = UI.confirm({
        titleKey: "investments.delete.title",
        bodyKey: "investments.delete.body",
        confirmKey: "common.delete",
        danger: true
      });
    } catch (error) {
      log(error);
      return;
    }
    if (!ask || typeof ask.then !== "function") return;

    ask.then(guard(function (yes) {
      /* A refused question changed nothing, and the dialog hands the focus back
         to the control that opened it on its way out — so there is nothing to
         redraw and redrawing would throw that focus away. */
      if (!yes) return;
      var removed = Model.removeInvestment(record.id);
      if (!removed) {
        say("err.unknown", null, "error");
        redraw();
        return;
      }
      closeRow();
      say("investments.removed", { name: nameOf(removed) });
      redraw();
    }));
  }

  /* ------------------------------------------------------------- a holding */

  /* What opens under the row. Built on first open rather than with the row, so
     a portfolio of twenty holdings does not build twenty price editors nobody
     has asked to see. */
  function holdingDetail(record) {
    var nodes = [];
    var value = readingOf(record);
    var measured = value.gainRatio !== null && value.gainRatio !== undefined;

    /* The gain the closed row only had room to state as a bare percentage.
       With no cost behind it there is no gain to say — the cost line directly
       below says why — so the line is left out rather than printed with
       nothing in it. The kind is no longer a pill here: it is the select two
       lines down, and saying it twice would read as two different facts. */
    if (measured) {
      nodes.push(small(dom.el("span", {
        text: t("investments.gainLine", { amount: money(value.gain), pct: value.gainRatio })
      })));
    }

    nodes.push(reading(
      "investments.cost",
      value.cost > 0 ? money(value.cost) : t("common.none"),
      "dim"
    ));

    if (record.priceDate) {
      nodes.push(small(t("investments.priceDate", { date: formatDay(record.priceDate) }), "dim"));
    }
    if (record.note) nodes.push(small(String(record.note), "dim"));

    /* The four corrections, in the order the add row asks for them, so a reader
       who wrote the holding finds its parts where they put them. */
    nodes.push(editRow("investments.name", nameControl(record)));
    nodes.push(kindControl(record));
    nodes.push(editRow("investments.quantity", quantityControl(record)));
    nodes.push(editRow("investments.unitCost", unitCostControl(record)));

    var price = priceRow(record);
    if (price) nodes.push(price);

    var archiveKey = record.archived
      ? keyOf("investments.unarchive", "accounts.unarchive")
      : keyOf("investments.archive", "accounts.archive");
    var archive = btn(archiveKey, "quiet", function () {
      toggleArchived(record);
    });
    archive.setAttribute("aria-pressed", record.archived ? "true" : "false");
    stamp(archive, focusTag("archive", record.id));

    nodes.push(actionRow([
      archive,
      btn("common.delete", "danger", function () {
        askDelete(record);
      })
    ]));

    return nodes;
  }

  /* Where the row's four parts sit.
   *
   * §10 gives the name the middle column and the two figures the one to its
   * right, and at 375px that left the name 137 pixels. "Gold, by the gram
   * (sample)" wants 208 and arrived as "Gold, by the gra…"; "Plot share
   * (sample)" as "Plot share (sam…". A name is the one thing a reader scans a
   * portfolio for, and three of six sample holdings could not be read.
   *
   * So the row is rebalanced rather than left clipped. The name takes the whole
   * width beside the icon — 257px, which every sample name fits inside — and
   * the gain rides at the end of that same line, where it is narrow enough to
   * cost the name almost nothing. The value drops to the second line beside the
   * quantity. Both figures stay hard against the row's right edge, which is
   * where the money cell's alignment actually comes from: its separator sits in
   * a fixed 6px track with two cent digits beside it, so the decimal marks land
   * on one pixel down the column whatever the cell's own width is. Releasing
   * that width is the second half of the fix — --amount-col is the ledger's
   * column measure and reserved 104px here for figures that ask for 86.
   *
   * These are the row's only inline styles and not one of them paints. The
   * stylesheet belongs to another file this round and a view may not add a rule
   * to it, but a view may say where the nodes it builds stand.
   */
  function nameCell(record, gain) {
    /* The clipping goes on an inner span: text-overflow has no effect on a flex
       container's own text, so the name would stop ellipsising and simply spill
       the moment its cell became one. */
    var text = dom.el("span", { text: nameOf(record) });
    css(text, "min-width", "0");
    css(text, "overflow", "hidden");
    css(text, "text-overflow", "ellipsis");
    css(text, "white-space", "nowrap");

    var cell = dom.el("span", { "class": "holding__name", title: nameOf(record) }, [text]);
    css(cell, "grid-column-end", "4");
    css(cell, "display", "flex");
    css(cell, "align-items", "baseline");
    css(cell, "gap", "var(--s1)");
    if (gain) {
      css(gain, "margin-left", "auto");
      cell.appendChild(gain);
    }
    return cell;
  }

  function holdingRow(record) {
    var UI = Moon.UI;
    if (!UI || typeof UI.expandRow !== "function") return null;

    var value = readingOf(record);
    var measured = value.gainRatio !== null && value.gainRatio !== undefined;

    var classes = ["holding"];
    if (measured && value.gain > 0) classes.push("is-up");
    else if (measured && value.gain < 0) classes.push("is-down");

    var qty = [dom.el("span", {
      text: t("investments.qtyLine", {
        quantity: quantityText(record.quantity),
        price: money(record.unitPrice)
      })
    })];
    /* An archived holding stays in the list and says so: it is out of every
       total above, and the only way back is the control inside it. */
    if (record.archived) {
      qty.push(" ");
      qty.push(tag(t(keyOf("investments.archived", "accounts.archived"))));
    }

    var gain = dom.el("span", {
      "class": "holding__gain",
      text: measured ? t("investments.gainPct", { pct: value.gainRatio }) : t("common.none")
    });
    /* The one money cell on this screen that earns its grid: a column of
       amounts whose decimal marks have to land on the same pixel from row to
       row, which is exactly what the cell's fixed separator track is for. */
    var amount = moneyCell(value.value, "holding__value");
    css(amount, "grid-row", "2 / 3");
    css(amount, "min-width", "0");

    var summary = [
      dom.el("span", { "class": "holding__icon", "aria-hidden": "true", text: iconOf(record) }),
      nameCell(record, gain),
      dom.el("span", { "class": "holding__qty" }, qty),
      amount
    ];

    var api;
    try {
      api = UI.expandRow({
        id: "yatirim-" + record.id,
        summaryClass: classes.join(" "),
        detailClass: "holding__detail",
        summary: summary,
        detail: function () { return holdingDetail(record); },
        open: openId === record.id,
        onToggle: function (open) {
          if (!open) {
            /* Shutting the row is also the moment the ranking is allowed to be
               true again. A list that says it is ordered by value and is not —
               because the price corrected inside the row has not been allowed
               to move it — is worse than the move itself, and the reader has
               just said they are done with that row. The caret rides along so
               that closing a row from the keyboard does not lose it. */
            closeRow();
            pendingFocus = focusTag("row", record.id);
            queueRedraw();
            return;
          }
          /* Remembered rather than left to the DOM: the next write redraws this
             whole file, and the row being worked in has to come back open.
             The ranking is pinned at the same moment, so that correcting a
             price inside the row cannot slide the row itself up the list. */
          var other = openId && openId !== record.id;
          openId = record.id;
          frozenOrder = lastOrder.slice();
          quantityError = null;
          /* expandRow opens itself and tells nobody else, so a second row
             tapped while the first is still open leaves two panels on screen
             while this file believes in one — and the first write would then
             shut one of them without being asked. The draw that settles it is
             queued rather than taken here, because the row's own click handler
             is still using the button it would tear down. */
          if (other) {
            pendingFocus = focusTag("row", record.id);
            queueRedraw();
          }
        }
      });
    } catch (error) {
      log(error);
      return null;
    }

    /* §10: a record's colour reaches the page as an inline --tone and every
       rule reads that one name back, so the icon's wash paints itself from the
       holding rather than from a class per colour. It goes on the whole row
       rather than on the summary alone: the panel that opens under the summary
       is its sibling, and a legend dot down there belongs to the same holding. */
    var tone = toneOf(record);
    if (tone) css(api.element, "--tone", tone);
    stamp(api.summary, focusTag("row", record.id));
    return api.element;
  }

  /* One card, soft dividers, value first. Archived holdings sort after the live
     ones whatever they are worth: they are not part of the ranking the totals
     above are measured from. */
  /* The order the list had when the open row opened, applied to the rows there
     are now. A holding written since then is not in the held order, so it joins
     the end in value order rather than being dropped — the freeze is a promise
     about the row under the reader's hand, not about the rest of the list. */
  function heldStill(rows) {
    var held = [];
    var rest = [];
    rows.forEach(function (record) {
      var at = frozenOrder.indexOf(record.id);
      if (at === -1) rest.push(record);
      else held.push({ record: record, at: at });
    });
    held.sort(function (a, b) {
      return a.at - b.at;
    });
    return held.map(function (one) {
      return one.record;
    }).concat(rest);
  }

  function rankedHoldings() {
    /* Each holding is valued once and the sort reads the decoration, the way
       Moon.util.sortBy does it: a comparator that asks the model for a figure
       would price the same holding a dozen times to put one list in order. */
    var decorated = holdings(true).map(function (record) {
      return { record: record, value: readingOf(record).value, archived: !!record.archived };
    });
    decorated.sort(function (a, b) {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      return b.value - a.value;
    });
    var rows = decorated.map(function (one) {
      return one.record;
    });

    if (openId && frozenOrder) rows = heldStill(rows);
    /* What the next freeze will be taken from: the order actually drawn, which
       is the order the reader is looking at when they open a row. */
    lastOrder = rows.map(function (record) {
      return record.id;
    });
    return rows;
  }

  function holdingsList(rows) {
    var list = dom.el("div", { "class": "holdings" });
    rows.forEach(function (record) {
      var row = holdingRow(record);
      if (row) list.appendChild(row);
    });
    return list;
  }

  /* --------------------------------------------------------- the add row */

  function kindOptions() {
    return constant("INVESTMENT_KINDS", ["other"]).map(function (kind) {
      return { value: kind, labelKey: "investments.kind." + kind };
    });
  }

  /* The colour and the icon are a decision about appearance, so they live in
     the row's folded half — and when neither is touched the model deals a
     colour from the spectrum and an icon from the kind, which is why nothing
     here invents a default. */
  function appearanceFields() {
    var UI = Moon.UI;
    var out = [];
    if (!UI) return out;

    if (typeof UI.swatch === "function") {
      try {
        /* form.color is the key this control wants; until the catalogue carries
           it the group goes unnamed rather than carrying an English word this
           file made up. Each dot still names itself by its own value. */
        pickers.color = UI.swatch({ labelKey: "form.color" });
        out.push(pickers.color.element);
      } catch (error) {
        log(error);
      }
    }
    if (typeof UI.emojiPicker === "function") {
      try {
        pickers.icon = UI.emojiPicker({ name: "icon", labelKey: "form.icon" });
        out.push(pickers.icon.element);
      } catch (error) {
        log(error);
      }
    }
    return out;
  }

  /* Both pickers hold a keyboard handler of their own, so a render that throws
     the old row away says so rather than leaving two listeners on a detached
     node for every redraw the reader causes. */
  function releasePickers() {
    ["color", "icon"].forEach(function (name) {
      var api = pickers[name];
      if (api && typeof api.destroy === "function") {
        try {
          api.destroy();
        } catch (error) {
          log(error);
        }
      }
      pickers[name] = null;
    });
  }

  function pickedValue(api) {
    if (!api || typeof api.value !== "function") return null;
    try {
      return api.value();
    } catch (error) {
      log(error);
      return null;
    }
  }

  function addRow() {
    var UI = Moon.UI;
    var Model = model();
    if (!UI || typeof UI.quickRow !== "function" || !Model) return null;

    var api;
    try {
      api = UI.quickRow({
        id: "yatirim-ekle",
        memoryKey: "investments.add",
        labels: "visible",
        submitLabelKey: "investments.form.submit",
        moreLabelKey: "common.more",
        keepOnSubmit: ["kind"],
        fields: [
          {
            type: "text",
            name: "name",
            labelKey: "investments.name",
            required: true,
            maxLength: constant("INVESTMENT_NAME_MAX", 80)
          },
          {
            type: "select",
            name: "kind",
            labelKey: "form.kind",
            value: addMemory.kind,
            options: kindOptions()
          },
          {
            /* Text, not money and not number: a quantity has four decimal
               places where an amount has two, and only
               Moon.Money.parseQuantity reads it. A number input would also put
               a spinner on a figure nobody steps by one. */
            type: "text",
            name: "quantity",
            labelKey: "investments.quantity",
            hintKey: "investments.quantity.hint",
            required: true
          },
          {
            type: "money",
            name: "unitCost",
            labelKey: "investments.unitCost",
            hintKey: "investments.unitCost.hint",
            currency: currency()
          },
          {
            type: "money",
            name: "unitPrice",
            labelKey: "investments.unitPrice",
            hintKey: "investments.unitPrice.hint",
            currency: currency(),
            required: true
          }
        ],
        moreFields: appearanceFields(),
        onSubmit: function (values) {
          var errors = {};
          var name = String(values.name === null || values.name === undefined ? "" : values.name)
            .replace(/^\s+|\s+$/g, "");
          if (!name) errors.name = "err.nameRequired";

          /* The quantity is refused, never rounded: four decimal places is what
             the schema keeps, and only the reader who typed a fifth knows what
             they meant by it. The three codes are three different sentences. */
          var quantity = readQuantity(values.quantity);
          if (!quantity.ok) errors.quantity = quantity.error || "err.quantityInvalid";

          if (values.unitPrice === null || values.unitPrice === undefined) {
            errors.unitPrice = "err.priceRequired";
          } else if (values.unitPrice < 0) {
            errors.unitPrice = "err.badAmount";
          }
          if (values.unitCost !== null && values.unitCost !== undefined && values.unitCost < 0) {
            errors.unitCost = "err.badAmount";
          }
          if (Object.keys(errors).length) return { ok: false, errors: errors };

          var kind = values.kind || "other";
          var draft = {
            name: name,
            kind: kind,
            /* The integer the parser produced, never the raw text: the model
               refuses a fraction here and it is right to. */
            quantity: quantity.value,
            unitCost: values.unitCost === null || values.unitCost === undefined ? 0 : values.unitCost,
            unitPrice: values.unitPrice,
            currency: currency(),
            color: pickedValue(pickers.color),
            icon: pickedValue(pickers.icon)
          };

          var check = read("validateInvestment", draft, { ok: true, errors: {} });
          if (check && check.ok === false) return { ok: false, errors: check.errors || {} };

          var id = Model.addInvestment(draft);
          if (!id) return { ok: false, errors: { name: "err.unknown" } };

          /* The write redraws this whole file, so what the row was asked to
             keep has to outlive the row itself. */
          addMemory = { kind: kind };
          closeRow();
          pendingFocus = focusTag("new", "");
          say("investments.saved");
          return { ok: true };
        }
      });
    } catch (error) {
      log(error);
      return null;
    }

    var fields = api.fields || {};
    if (fields.name && fields.name.control) stamp(fields.name.control, focusTag("new", ""));
    /* field() has no channel for this and a quantity deserves the decimal
       keypad an amount gets, so it is asked for on the control itself. */
    if (fields.quantity && fields.quantity.control) {
      fields.quantity.control.setAttribute("inputmode", "decimal");
    }
    return api;
  }

  /* ---------------------------------------------------------------- render */

  function summarySection(total) {
    var UI = Moon.UI;
    var body = [summaryCard(total)];
    trailBlock().forEach(function (node) { body.push(node); });
    kindBar(total).forEach(function (node) { body.push(node); });

    return UI.section({
      id: "yatirim-ozet",
      titleKey: "investments.value",
      body: body
    });
  }

  function listSection(rows, adder) {
    var UI = Moon.UI;
    var body = [];

    if (!rows.length) {
      body.push(emptyBlock({
        headingKey: "investments.empty.heading",
        bodyKey: "investments.empty.body",
        ghost: 2,
        columns: 3,
        actions: [{
          labelKey: "investments.empty.action",
          onClick: guard(function () {
            if (adder && typeof adder.focusFirst === "function") adder.focusFirst();
          })
        }]
      }));
    } else {
      var list = holdingsList(rows);
      body.push(list);
      /* One tab stop for the whole list, arrows between the rows, and Delete on
         the focused row asking the same question the row's own button does.
         Enter and Space are left to the summary buttons themselves. */
      if (UI && typeof UI.rovingList === "function") {
        roving = UI.rovingList(list, {
          selector: ".holding",
          start: Math.max(0, indexOfId(rows, rowId)),
          onFocus: function (index, row) { rowId = idOfRow(row); },
          onDelete: guard(function (index, row) {
            var record = recordById(rows, idOfRow(row));
            if (record) askDelete(record);
          })
        });
      }
    }

    return UI.section({
      id: "yatirim-liste",
      titleKey: "investments.title",
      body: body
    });
  }

  /* Which holding a row stands for, read off the stamp the row already carries:
     rovingList hands back the element it was given, not a record, and a second
     table keyed by node would be one more thing to keep in step. */
  function idOfRow(row) {
    var mark = row && typeof row.getAttribute === "function" ? row.getAttribute("data-focus") : null;
    if (!mark || mark.indexOf("row:") !== 0) return null;
    return mark.slice(4) || null;
  }

  function indexOfId(rows, id) {
    if (!id) return -1;
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].id === id) return i;
    }
    return -1;
  }

  function recordById(rows, id) {
    var at = indexOfId(rows, id);
    return at === -1 ? null : rows[at];
  }

  function render(root) {
    if (!root || !dom) return;
    lastRoot = root;
    if (roving && typeof roving.destroy === "function") roving.destroy();
    roving = null;
    releasePickers();
    dom.clear(root);
    if (!Moon.UI || !model()) return;

    var rows = rankedHoldings();
    var total = read("investmentTotals", undefined, BLANK_TOTALS) || BLANK_TOTALS;

    /* The adder is built first because the empty page's one action is a way
       into it, and it is appended last because that is where it belongs on
       screen. It is a child of the view rather than of the list section: the
       list is one card and the row is another, and two cards with no air
       between them read as one broken card. */
    var adder = addRow();

    /* Above everything, because the sentence belongs to what the reader just
       did and the first section is not drawn when the last holding has gone. */
    var band = flashBand();
    if (band) root.appendChild(band);

    /* Nothing written down yet: no summary, no trail, no bar. A portfolio
       nobody has described is not worth ₺0,00 — it is unmeasured, and §4 is
       explicit that an unmeasured number is said in words. */
    if (rows.length) root.appendChild(summarySection(total));
    root.appendChild(listSection(rows, adder));
    if (adder) root.appendChild(adder.element);

    /* Every inline write replaced the control that made it. This is the whole
       keyboard contract on this screen: type a price, press Enter, and the
       caret is back in the same box with the new figure in it. */
    restoreFocus(root);
  }

  var view = {
    /* The hash stays Turkish for URL permanence; the label comes from i18n. */
    id: "yatirim",
    titleKey: "nav.investments",
    render: function (root) {
      try {
        render(root);
      } catch (error) {
        log(error);
      }
    },
    destroy: function () {
      /* What has to go: the cached root (redrawing into a root the router has
         handed to another view would paint this section over it), the list's
         keyboard handler, the pickers, and every piece of state that is an
         answer to something the reader did here — which row they had open and
         the ranking that row was holding still, the refusal a quantity earned,
         what the last action said, and where the caret was going. */
      if (roving && typeof roving.destroy === "function") roving.destroy();
      roving = null;
      releasePickers();
      lastRoot = null;
      closeRow();
      lastOrder = [];
      flash = null;
      pendingFocus = null;
      rowId = null;
    }
  };

  Moon.Views = Moon.Views || {};
  Moon.Views.investments = view;
})(window);
