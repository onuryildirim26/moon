/* Moon — writing an expense down in five taps.
 *
 * The owner's complaint about the old row was exact: "çok teferruat var" —
 * a date field he almost never changes, a category dropdown, a note he does not
 * want to write, and the phone's own keyboard animating in over all of it. Six
 * controls to record a coffee.
 *
 * So this is the pattern every widely used tracker has converged on, and which
 * Monefy is repeatedly named the fastest for:
 *
 *   amount first, in the app's own keypad, as the biggest thing on screen
 *   → the category grid
 *   → and the category tap IS the save.
 *
 * Five taps for a 50 lira coffee: open, 5, 0, the cup, done. No confirmation
 * afterwards, because a dialog asking "are you sure" about a coffee is the
 * thing that makes people stop keeping a budget. The undo strip carries the
 * mistake case instead, which costs nothing when there is no mistake.
 *
 * Three decisions worth knowing before changing anything here:
 *
 *   - The keypad is ours rather than the phone's. A Turkish reader writes
 *     1.234,56 and the OS keyboard will not reliably offer that comma; owning
 *     the keys also lets the arithmetic column exist, which is what lets
 *     someone split a bill without leaving the screen.
 *   - The direction comes from the category, not from a switch. Picking Salary
 *     means income because that category is income — Moon.Model already holds
 *     that rule and it is not restated here.
 *   - Nothing is validated twice. The draft goes through views.ledger's own
 *     builder and Moon.Model.addEntry, so a record written here and a record
 *     written in the ledger cannot drift apart.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon = global.Moon || {};
  var dom = Moon.dom;

  var SHEET_ID = "quickadd";
  /* How many categories the grid shows before the rest need a scroll. Four
     columns of four is what fits a phone above the keypad without the grid
     itself becoming a list to read. */
  var GRID_ROWS = 4;
  var COLUMNS = 4;
  /* Most-recent categories ride at the front of the grid, because the next
     expense is usually the same kind as the last one. */
  var RECENT = 4;
  var DIGITS_MAX = 12;

  var open = false;
  var node = null;
  /* Remembered for the session, not stored: someone working through a pile of
     receipts turns it on once and it lasts as long as the pile does. */
  var keepGoing = false;
  var lastFocus = null;
  var state = null;

  /* ------------------------------------------------------------- plumbing */

  function log(error) {
    if (global.console && global.console.error) {
      global.console.error("Moon.QuickAdd", error);
    }
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (error) {
      log(error);
      return fallback;
    }
  }

  function t(key, vars) {
    var I18n = Moon.I18n;
    if (!I18n || typeof I18n.t !== "function") return key;
    return I18n.t(key, vars);
  }

  function currency() {
    return safe(function () {
      return Moon.Store.state.settings.currency;
    }, "TRY") || "TRY";
  }

  function lang() {
    var I18n = Moon.I18n;
    return (I18n && I18n.lang) || "tr";
  }

  function money(minor) {
    return safe(function () {
      return Moon.Money.format(minor, { currency: currency(), lang: lang() });
    }, String(minor));
  }

  function decimalMark() {
    return lang() === "en" ? "." : ",";
  }

  /* ---------------------------------------------------------- the amount */

  /* The amount is held as the digits typed, not as a number, so that a reader
     who has typed "1" and expects to type "00" next is not shown 1,00 in the
     middle of it. It becomes minor units only when it is read. */
  function minorOf(digits) {
    if (!digits) return 0;
    var n = global.parseInt(digits, 10);
    return isFinite(n) ? n : 0;
  }

  /* What the display shows while typing: the digits read as minor units, with
     the group separators the reader's own language uses. */
  function shown(digits) {
    var minor = minorOf(digits);
    return safe(function () {
      var parts = Moon.Money.parts(minor, { currency: currency(), lang: lang() });
      return parts && parts.whole !== undefined
        ? parts.whole + parts.sep + parts.cents
        : money(minor);
    }, money(minor));
  }

  /* `into` lets the selftest drive the keys against its own object. Left out,
     the keys type into the open sheet, which is what every caller but the
     selftest wants -- and what the selftest must never do, because painting a
     test's digits onto the reader's screen is a bug the test itself causes. */
  function press(key, into) {
    var target = into || state;
    if (!target) return;

    if (key === "plus" || key === "minus") {
      /* A second operator resolves the first, so 10 + 20 + 30 chains the way a
         calculator does rather than forgetting the middle number. */
      var carried = target.pending
        ? apply(target.pending.value, target.pending.op, minorOf(target.digits))
        : minorOf(target.digits);
      target.pending = { op: key, value: carried };
      target.digits = "";
    } else if (key === "equals") {
      if (!target.pending) return;
      target.digits = String(apply(target.pending.value, target.pending.op, minorOf(target.digits)));
      if (target.digits === "0") target.digits = "";
      target.pending = null;
    } else if (key === "back") {
      target.digits = target.digits.slice(0, -1);
    } else if (key === "mark") {
      /* The decimal key is where a calculator puts it, but Moon's amounts are
         integer minor units: two digits of cents always exist. Typing the mark
         is therefore a no-op that only has to feel like it did something,
         which is why the key is drawn and does not move the caret. */
      return;
    } else if (/^[0-9]$/.test(key)) {
      if (target.digits.length >= DIGITS_MAX) return;
      /* A zero typed into an empty amount is nothing: it would read as 0,00 and
         the next digit would have to shuffle it along. Leading zeros never
         accumulate, so the display cannot read 0050. */
      if (key === "0" && !target.digits) return;
      target.digits += key;
    } else {
      return;
    }

    if (!into) paintAmount();
  }

  function paintAmount() {
    if (!node || !state) return;
    var face = node.querySelector(".qa__amount");
    if (face) face.textContent = shown(state.digits);

    var live = node.querySelector(".qa__reading");
    if (live) live.textContent = t("a11y.amountNow", { amount: money(minorOf(state.digits)) });

    var grid = node.querySelector(".qa__grid");
    var ready = minorOf(state.digits) > 0;
    if (grid) {
      grid.setAttribute("aria-disabled", ready ? "false" : "true");
      if (grid.classList) {
        if (ready) grid.classList.remove("is-waiting");
        else grid.classList.add("is-waiting");
      }
    }
    var hint = node.querySelector(".qa__hint");
    if (hint) hint.hidden = ready;
  }

  /* ----------------------------------------------------------- the dates */

  function today() {
    return safe(function () { return Moon.Dates.today(); }, "");
  }

  /* Moon.Dates keeps its day arithmetic to itself, and the one day this sheet
     needs is yesterday. Built from the civil parts through a LOCAL Date, never
     through Date.parse or toISOString, both of which read UTC and would hand a
     reader in Istanbul the wrong day for anything typed before 03:00. */
  function shift(days) {
    var iso = today();
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    if (!m) return iso;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days);
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function dayLabel(iso) {
    if (iso === today()) return t("common.today");
    if (iso === shift(-1)) return t("common.yesterday");
    return safe(function () {
      return Moon.Dates.formatDate(iso, lang(), "short");
    }, iso);
  }

  function paintDate() {
    if (!node || !state) return;
    var days = node.querySelectorAll(".qa__day");
    Array.prototype.slice.call(days).forEach(function (btn) {
      var on = btn.dataset && btn.dataset.day === state.date;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      if (btn.classList) {
        if (on) btn.classList.add("is-on");
        else btn.classList.remove("is-on");
      }
    });
    var picker = node.querySelector(".qa__pick");
    if (picker && picker.value !== state.date) picker.value = state.date;
  }

  /* --------------------------------------------------------- the account */

  /* Which account the last entry came out of. A reader pays with the same card
     most days, so remembering it costs nothing and saves a tap; a reader with
     no accounts never sees any of this. */
  function lastAccount() {
    var Model = Moon.Model;
    if (!Model || typeof Model.accounts !== "function") return null;
    var accounts = safe(function () { return Model.accounts(); }, []) || [];
    if (!accounts.length) return null;

    var entries = safe(function () { return Model.entries({}); }, []) || [];
    for (var i = 0; i < entries.length; i += 1) {
      var id = entries[i] && entries[i].accountId;
      if (!id) continue;
      for (var j = 0; j < accounts.length; j += 1) {
        if (accounts[j].id === id) return id;
      }
    }
    return accounts[0].id;
  }

  function accountRow() {
    var Model = Moon.Model;
    if (!Model || typeof Model.accounts !== "function") return null;
    var accounts = safe(function () { return Model.accounts(); }, []) || [];
    /* One account is not a choice, and none is not a concept. The row appears
       only when the reader actually has somewhere to put the question. */
    if (accounts.length < 2) return null;

    var chips = accounts.map(function (account) {
      var chip = dom.el("button", {
        "class": "qa__acc",
        type: "button",
        style: { "--tone": tone(account.color) },
        "aria-pressed": account.id === state.account ? "true" : "false"
      }, [
        dom.el("span", { "class": "qa__acc__icon", "aria-hidden": "true" }, account.icon || "•"),
        dom.el("span", {}, account.name)
      ]);
      chip.dataset.account = account.id;
      chip.addEventListener("click", function () {
        state.account = account.id;
        paintAccount();
      }, false);
      return chip;
    });

    return dom.el("div", {
      "class": "qa__accs",
      role: "group",
      "aria-label": t("quick.account")
    }, chips);
  }

  function paintAccount() {
    if (!node || !state) return;
    var chips = node.querySelectorAll(".qa__acc");
    Array.prototype.slice.call(chips).forEach(function (chip) {
      var on = chip.dataset && chip.dataset.account === state.account;
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      if (chip.classList) {
        if (on) chip.classList.add("is-on");
        else chip.classList.remove("is-on");
      }
    });
  }

  /* ------------------------------------------------------- the categories */

  /* Most recently written first, then the rest in their own order. The reader's
     next expense is usually the same kind as their last, so the tap they want
     is most often already under their thumb. */
  function categoriesFor(kind) {
    var Model = Moon.Model;
    if (!Model || typeof Model.categories !== "function") return [];

    var all = safe(function () { return Model.categories(); }, []) || [];
    var wanted = all.filter(function (one) {
      return one && !one.archived && (kind ? one.kind === kind : true);
    });
    if (!wanted.length) return [];

    var seen = Object.create(null);
    var recent = [];
    var entries = safe(function () { return Model.entries({}); }, []) || [];
    for (var i = 0; i < entries.length && recent.length < RECENT; i += 1) {
      var id = entries[i] && entries[i].categoryId;
      if (!id || seen[id]) continue;
      var found = null;
      for (var j = 0; j < wanted.length; j += 1) {
        if (wanted[j].id === id) { found = wanted[j]; break; }
      }
      if (!found) continue;
      seen[id] = true;
      recent.push(found);
    }

    var rest = wanted.filter(function (one) { return !seen[one.id]; });
    return recent.concat(rest);
  }

  function tone(color) {
    var UI = Moon.UI;
    if (UI && typeof UI.tone === "function") {
      var resolved = UI.tone(color);
      if (resolved) return resolved;
    }
    return color || "var(--accent)";
  }

  function tile(category) {
    var face = dom.el("span", { "class": "qa__tile__icon", "aria-hidden": "true" },
      category.icon || "•");
    var name = dom.el("span", { "class": "qa__tile__name" }, category.name);

    var button = dom.el("button", {
      "class": "qa__tile",
      type: "button",
      style: { "--tone": tone(category.color) }
    }, [face, name]);

    button.addEventListener("click", function () {
      write(category);
    }, false);

    return button;
  }

  /* ---------------------------------------------------------- the writing */

  function write(category) {
    if (!state) return;
    var minor = minorOf(state.digits);
    /* Nothing is written for a zero. The grid is already marked as waiting, so
       this only catches a keyboard reaching it, and it says nothing: there is
       no mistake to report in a tap that was always going to do nothing. */
    if (!(minor > 0)) return;

    var ledger = Moon.Views && Moon.Views.ledger;
    var Model = Moon.Model;
    if (!Model || typeof Model.addEntry !== "function") return;

    var values = {
      date: state.date,
      amount: minor,
      categoryId: category.id,
      note: state.note || ""
    };
    if (state.account) values.accountId = state.account;

    /* The ledger owns how a draft is assembled — the direction rule, the fixed
       mark, the length ceilings. Going through it is what keeps a record
       written here identical to one written there. */
    var draft = null;
    if (ledger && typeof ledger.buildDraft === "function") {
      var read = safe(function () { return ledger.buildDraft(values, {}, null); }, null);
      if (!read || !read.draft) return;
      if (read.errors && Object.keys(read.errors).length) return;
      draft = read.draft;
    } else {
      draft = {
        date: values.date,
        amount: minor,
        direction: category.kind === "income" ? "in" : "out",
        categoryId: category.id,
        note: values.note,
        source: "manual",
        confirmed: true
      };
    }

    /* buildDraft names the fields it knows; the account is this sheet's own
       addition, so it is set on the draft rather than hoped for. */
    if (state.account && !draft.accountId) draft.accountId = state.account;

    var id = safe(function () { return Model.addEntry(draft); }, null);
    if (!id) return;

    /* The panel marks the figure this entry just changed on its next redraw.
       Asking here rather than drawing here, because the write raises
       state:change and the router redraws a tick later over anything done now. */
    var panel = Moon.Views && Moon.Views.panel;
    if (panel && typeof panel.markWrite === "function") safe(function () { panel.markWrite(); });

    if (keepGoing) {
      /* The date, the account and the toggle survive; the amount and the note
         do not, because those are the two things that differ between one
         receipt and the next. */
      state.digits = "";
      state.pending = null;
      state.note = "";
      var noteField = node && node.querySelector(".qa__note");
      if (noteField) noteField.value = "";
      paintAmount();
    } else {
      close();
    }

    var UI = Moon.UI;
    if (UI && typeof UI.undoStrip === "function") {
      safe(function () {
        UI.undoStrip({
          message: t("quick.saved", { amount: money(minor), category: category.name }),
          onUndo: function () {
            safe(function () { Model.removeEntry(id); });
          }
        });
      });
    }
  }

  /* ------------------------------------------------------------- the sheet */

  /* Plus and minus, and deliberately not times or divide.

     The digits fill from the right, the way every one of these keypads does:
     typing 5000 means 50,00. Addition and subtraction are then exact, because
     both sides are the same kind of integer — which is what someone splitting a
     restaurant bill or adding up a handful of receipts actually needs.

     Multiplication is a trap under that rule. A reader who wants "three of
     these" types 3 and the keypad has already read it as three kuruş, so the
     answer would be wrong by a factor of a hundred and would look plausible.
     Two honest keys beat four where two of them lie. */
  var OPS = { plus: "+", minus: "−" };

  function apply(left, op, right) {
    var out = op === "minus" ? left - right : left + right;
    /* An amount is a magnitude. Subtracting past zero is a reader correcting
       themselves, not asking for a negative expense, so the floor holds. */
    return out > 0 ? out : 0;
  }

  function keypad() {
    var rows = [
      ["1", "2", "3", "back"],
      ["4", "5", "6", "plus"],
      ["7", "8", "9", "minus"],
      ["0", decimalMark(), "equals"]
    ];

    var labels = {
      back: "⌫", plus: OPS.plus, minus: OPS.minus, equals: "="
    };
    var names = {
      back: "a11y.backspace", plus: "a11y.plus", minus: "a11y.minus", equals: "a11y.equals"
    };

    var keys = [];
    rows.forEach(function (row) {
      row.forEach(function (key) {
        var special = Object.prototype.hasOwnProperty.call(labels, key);
        var wide = key === "0";
        var button = dom.el("button", {
          "class": "qa__key"
            + (special ? " qa__key--" + key : "")
            + (wide ? " qa__key--wide" : ""),
          type: "button",
          "aria-label": special ? t(names[key]) : key
        }, special ? labels[key] : key);
        button.addEventListener("click", function () {
          press(key === decimalMark() ? "mark" : key);
        }, false);
        keys.push(button);
      });
    });

    return dom.el("div", {
      "class": "qa__keys",
      role: "group",
      "aria-label": t("a11y.keypad")
    }, keys);
  }

  function dayRow() {
    var picker = dom.el("input", {
      "class": "qa__pick",
      type: "date",
      value: state.date,
      "aria-label": t("quick.pickDate")
    });
    picker.addEventListener("change", function () {
      var wanted = picker.value;
      if (!wanted) return;
      state.date = wanted;
      paintDate();
    }, false);

    var chips = [today(), shift(-1)].map(function (iso) {
      var chip = dom.el("button", {
        "class": "qa__day",
        type: "button",
        "aria-pressed": iso === state.date ? "true" : "false"
      }, dayLabel(iso));
      chip.dataset.day = iso;
      chip.addEventListener("click", function () {
        state.date = iso;
        picker.hidden = true;
        more.hidden = false;
        paintDate();
      }, false);
      return chip;
    });

    /* The calendar is folded away because it is the rare path: an expense is
       written the day it happens almost every time, and a date field open on
       screen costs a row that the category grid needs to stay above the fold.
       Unfolding it is one tap, and the tap is only ever taken on purpose. */
    picker.hidden = true;
    var more = dom.el("button", { "class": "qa__day qa__day--more", type: "button" },
      t("quick.pickDate"));
    more.addEventListener("click", function () {
      more.hidden = true;
      picker.hidden = false;
      if (typeof picker.focus === "function") safe(function () { picker.focus(); });
    }, false);

    return dom.el("div", { "class": "qa__days" }, chips.concat([more, picker]));
  }

  function noteRow() {
    var input = dom.el("input", {
      "class": "qa__note",
      type: "text",
      maxlength: "200",
      placeholder: t("quick.note"),
      "aria-label": t("form.note")
    });
    input.addEventListener("input", function () {
      state.note = input.value;
    }, false);
    return input;
  }

  function grid() {
    var list = categoriesFor(null);
    if (!list.length) {
      return dom.el("p", { "class": "qa__none prose" }, t("quick.empty"));
    }

    var tiles = list.slice(0, GRID_ROWS * COLUMNS).map(tile);
    var box = dom.el("div", {
      "class": "qa__grid is-waiting",
      role: "group",
      "aria-label": t("quick.chooseCategory"),
      "aria-disabled": "true"
    }, tiles);
    return box;
  }

  function build() {
    var cancel = dom.el("button", { "class": "qa__cancel btn is-quiet", type: "button" },
      t("common.cancel"));
    cancel.addEventListener("click", function () { close(); }, false);

    var keep = dom.el("button", {
      "class": "qa__keep" + (keepGoing ? " is-on" : ""),
      type: "button",
      "aria-pressed": keepGoing ? "true" : "false"
    }, t("quick.keepGoing"));
    keep.addEventListener("click", function () {
      keepGoing = !keepGoing;
      keep.setAttribute("aria-pressed", keepGoing ? "true" : "false");
      if (keep.classList) {
        if (keepGoing) keep.classList.add("is-on");
        else keep.classList.remove("is-on");
      }
    }, false);

    var head = dom.el("div", { "class": "qa__head" }, [
      cancel,
      dom.el("h2", { "class": "qa__title" }, t("quick.title")),
      keep
    ]);

    var amount = dom.el("div", { "class": "qa__face" }, [
      dom.el("span", { "class": "qa__sym", "aria-hidden": "true" },
        safe(function () { return Moon.Money.symbol(currency()); }, "")),
      dom.el("span", { "class": "qa__amount tnum" }, shown(state.digits))
    ]);

    var sheet = dom.el("div", {
      "class": "qa",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": t("quick.title")
    }, [
      head,
      dayRow(),
      accountRow(),
      amount,
      noteRow(),
      keypad(),
      dom.el("p", { "class": "qa__hint" }, t("quick.hint")),
      grid(),
      dom.el("p", { "class": "qa__reading sr", role: "status", "aria-live": "polite" }, "")
    ]);

    var scrim = dom.el("div", { "class": "qa__scrim", id: SHEET_ID }, [sheet]);
    scrim.addEventListener("click", function (event) {
      if (event.target === scrim) close();
    }, false);
    scrim.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      /* The number row types into the amount without the reader having to find
         the on-screen keys, which is what a desktop reader expects. */
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        press(event.key);
      } else if (event.key === "Backspace" && event.target === scrim) {
        event.preventDefault();
        press("back");
      }
    }, false);

    return scrim;
  }

  /* ---------------------------------------------------------------- open */

  function openSheet() {
    if (open) return;
    var doc = global.document;
    if (!doc || !doc.body) return;

    state = { digits: "", date: today(), note: "", pending: null, account: lastAccount() };
    lastFocus = doc.activeElement;

    node = safe(build, null);
    if (!node) return;

    doc.body.appendChild(node);
    open = true;
    if (doc.documentElement && doc.documentElement.classList) {
      doc.documentElement.classList.add("has-quickadd");
    }
    paintAmount();
    paintDate();

    var first = node.querySelector(".qa__key");
    if (first && typeof first.focus === "function") safe(function () { first.focus(); });
  }

  function close() {
    if (!open) return;
    var doc = global.document;
    if (node && node.parentNode) node.parentNode.removeChild(node);
    node = null;
    open = false;
    state = null;
    if (doc && doc.documentElement && doc.documentElement.classList) {
      doc.documentElement.classList.remove("has-quickadd");
    }
    if (lastFocus && typeof lastFocus.focus === "function") safe(function () { lastFocus.focus(); });
    lastFocus = null;
  }

  /* ------------------------------------------------------------ selftest */

  function selftest() {
    var checks = 0;
    var failures = [];

    function check(name, got, want) {
      checks += 1;
      var ok = want === undefined ? !!got : got === want;
      if (!ok) failures.push(name + " (got " + JSON.stringify(got) + ")");
    }

    check("no digits reads zero", minorOf(""), 0);
    check("one digit is one kuruş", minorOf("1"), 1);
    check("four digits are the lira", minorOf("5000"), 5000);
    check("a leading zero cannot survive", minorOf("0050"), 50);

    /* Its own object, never the module's: a selftest that typed into the open
       sheet would leave the reader looking at the test's digits. */
    var pad = { digits: "", date: "2026-10-01", note: "", pending: null };
    press("0", pad);
    check("a zero cannot open an amount", pad.digits, "");
    press("5", pad);
    press("0", pad);
    check("digits arrive in order", pad.digits, "50");
    press("mark", pad);
    check("the decimal key writes nothing", pad.digits, "50");
    press("back", pad);
    check("backspace drops the last", pad.digits, "5");
    press("x", pad);
    check("a key that is not a digit is ignored", pad.digits, "5");
    var i;
    pad.digits = "";
    for (i = 0; i < DIGITS_MAX + 4; i += 1) press("9", pad);
    check("the amount has a ceiling", pad.digits.length, DIGITS_MAX);
    check("the open sheet was never touched", state === null || state !== pad, true);

    var I18n = Moon.I18n;
    if (I18n && typeof I18n.has === "function") {
      ["quick.open", "quick.title", "quick.note", "quick.chooseCategory",
       "quick.saved", "quick.empty", "quick.hint", "a11y.keypad", "a11y.backspace",
       "common.cancel", "common.today", "common.yesterday"].forEach(function (key) {
        check("catalogue carries " + key, I18n.has(key), true);
      });
    }

    if (global.console && global.console.info) {
      global.console.info("Moon.QuickAdd selftest: " + (checks - failures.length) + "/" + checks);
    }
    return { ok: !failures.length, checks: checks, failures: failures };
  }

  Moon.QuickAdd = {
    open: openSheet,
    close: close,
    isOpen: function () { return open; },
    _press: press,
    _minorOf: minorOf,
    _categoriesFor: categoriesFor,
    _selftest: selftest
  };
})(window);
