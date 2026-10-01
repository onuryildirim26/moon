/* Moon — the app shell (contract §14, supplement E6/E7).
 *
 * Last script on the page. It owns four things and nothing else:
 *
 *   1. Boot order. Store first (so a read-only browser is announced before any
 *      view draws), then language, then theme, then the router.
 *   2. The router. A hash is a route; a route names a Moon.Views global. The
 *      view owns #view and clears it itself — this file never builds content
 *      inside a section.
 *   3. The four header controls, which index.html leaves empty on purpose.
 *   4. The three standing bands: the read-only warning, the last store error
 *      and the quiet backup nudge.
 *
 * Three rules shaped the code:
 *
 *   - Recurring payments are NOT generated at boot (E6). generateRecurring
 *     writes entries the moment it is called, so the panel counts what is
 *     pending and the reader presses the button. This file must not decide to
 *     write records on someone's behalf.
 *   - The header controls are built once and then synced in place. Rebuilding
 *     them on every state:change would throw focus back to the body every time
 *     the reader clicked a currency, which is exactly when they are using the
 *     keyboard.
 *   - Nothing here produces a user-visible sentence. Every string comes from
 *     Moon.I18n.t; the only literals are the two chevrons, and those are
 *     aria-hidden with a translated aria-label on the button around them.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var doc = global.document;
  var dom = Moon.dom;

  /* hash -> the Moon.Views global that answers it (E11). The hashes stay
     Turkish for URL permanence, so "#defter" is served by Moon.Views.ledger:
     a view's own `id` is NOT the route and must not be used as one. */
  var ROUTES = [
    { hash: "panel", view: "panel" },
    { hash: "defter", view: "ledger" },
    { hash: "limitler", view: "limits" },
    { hash: "yatirim", view: "investments" },
    { hash: "tekrar", view: "recurring" },
    { hash: "hedefler", view: "goals" },
    { hash: "borc", view: "debts" },
    { hash: "hesaplar", view: "accounts" },
    { hash: "veri", view: "data" }
  ];

  var HOME = "panel";
  var DATA_HASH = "veri";

  var CURRENCIES = ["TRY", "USD", "EUR", "GBP"];

  /* Moon's ground language. I18n guesses from the browser, which on a Turkish
     machine lands on Turkish; the product has one main language and it is this
     one. Only a stored preference overrules it (see seedLang). */
  var DEFAULT_LANG = "en";

  /* Cycle order, jury G8: System -> Dial -> Paper -> Prism -> System, written
     as the material's name, never an icon. */
  var THEMES = ["system", "dial", "paper", "prism"];

  /* The three materials that pin themselves on <html data-theme>. "system" is
     the ABSENCE of the attribute, which is why it is not here. */
  var SURFACES = { dial: 1, paper: 1, prism: 1 };

  /* The media query each theme-color meta in index.html carries while the
     reader is on "system". Keyed by the surface, not by the colour: the hexes
     live in index.html next to the tokens they mirror and are never touched
     from here. Prism answers no system preference — nothing asks a machine for
     a colourful surface — so on "system" its tag stays switched off. */
  var SURFACE_MEDIA = {
    dial: "(prefers-color-scheme: dark)",
    paper: "(prefers-color-scheme: light)",
    prism: "not all"
  };

  var PERIOD_RE = /^\d{4}-\d{2}$/;
  var NUDGE_AT = 40;          /* contract §14 step 8 */
  var ADAPT_MAX = 1400;       /* ms — belt for an animationend that never comes */
  /* ms — mirrors --dur-theme in css/tokens.css, plus a few frames so the class
     outlives the last one. The two numbers are a pair; change them together. */
  var THEME_FADE = 320 + 60;
  var ANNOUNCE_MS = 2500;     /* how long a screen-reader line stays in #strip */
  /* ms — Store debounces a write by 250 and then hands it to an idle callback
     with a 1000ms timeout, so a state change arrives well before the attempt
     it caused. This is how long to wait before asking whether it worked. */
  var RECOVER_MS = 1400;

  /* ------------------------------------------------------------ module state */

  var booted = false;
  var period = null;
  var periodPinned = false;   /* true once the reader moved the selector */
  var route = null;           /* the active ROUTES row */
  var mountedView = null;
  var firstPaint = true;
  var renderTimer = null;
  var adaptRun = false;
  var sheetBound = false;
  var nudgeOff = false;       /* dismissed for this session only */

  /* E7: the read-only warning is raised once, at boot, and has to stand for the
     whole session — persistNow stays silent afterwards. */
  var readOnlyNote = null;
  var storeError = null;
  var recoverTimer = null;    /* pending "did that write get through?" look */

  var ctl = null;             /* header control references, built once */
  var periodAccessor = false; /* false on an engine that refused the getter */
  var themingTimer = null;    /* the open colour-transition window, if any */

  /* ---------------------------------------------------------------- plumbing */

  function log(error, where) {
    if (global.console) global.console.error("Moon.App" + (where ? " " + where : ""), error);
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (error) {
      log(error);
      return fallback;
    }
  }

  function t(key, params) {
    var I18n = Moon.I18n;
    if (key === null || key === undefined) return "";
    if (I18n && typeof I18n.t === "function") {
      return safe(function () { return I18n.t(key, params); }, String(key));
    }
    return String(key);
  }

  function lang() {
    var I18n = Moon.I18n;
    return (I18n && I18n.lang) || "tr";
  }

  function settings() {
    var st = Moon.Store;
    var state = st ? st.state : null;
    return (state && state.settings) || {};
  }

  function monthStartDay() {
    var day = settings().monthStartDay;
    return typeof day === "number" && day >= 1 && day <= 28 ? Math.round(day) : 1;
  }

  function el(tag, attrs, children) {
    return dom.el(tag, attrs, children);
  }

  function focusNode(node) {
    if (!node || typeof node.focus !== "function") return false;
    return safe(function () {
      node.focus();
      return doc.activeElement === node;
    }, false);
  }

  function setClass(node, name, on) {
    if (!node || !node.classList) return;
    if (on) node.classList.add(name);
    else node.classList.remove(name);
  }

  function reducedMotion() {
    return safe(function () {
      return !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }, false);
  }

  /* The one storage key, read raw, exactly as the pre-paint script in
     index.html reads it and for the same reason: two questions have to be
     answered BEFORE Store.boot() — which language a fresh install seeds its
     category names in, and which surface the reader last pinned — and after
     boot the raw answers are out of reach. Store owns the real parsing; this
     never writes and never throws. */
  function storedSettings() {
    return safe(function () {
      var key = (Moon.Store && Moon.Store.KEY) || "moon.v1";
      var raw = global.localStorage ? global.localStorage.getItem(key) : null;
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var found = parsed ? parsed.settings : null;
      return found && typeof found === "object" ? found : null;
    }, null);
  }

  /* The one live region in the app is #strip (contract §16), so a route or
     language change is announced by parking a visually hidden line there and
     taking it away again. Nothing appears on screen. */
  function announce(key, params) {
    var host = doc.getElementById("strip");
    if (!host) return;
    var node = el("p", { "class": "sr", text: t(key, params) });
    host.appendChild(node);
    global.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, ANNOUNCE_MS);
  }

  /* ------------------------------------------------------------------ period */

  function todayPeriod() {
    var Dates = Moon.Dates;
    if (!Dates || typeof Dates.periodKey !== "function" || typeof Dates.today !== "function") {
      return null;
    }
    /* periodKey returns null on bad input (E2), which is a valid answer here:
       the controls then show the raw key and nothing divides by it. */
    return safe(function () { return Dates.periodKey(Dates.today(), monthStartDay()); }, null);
  }

  function periodText() {
    var Dates = Moon.Dates;
    if (!period) return "";
    if (Dates && typeof Dates.formatPeriod === "function") {
      var text = safe(function () { return Dates.formatPeriod(period, lang()); }, "");
      if (text) return text;
    }
    return period;
  }

  /* Keeps the plain fallback field in step on an engine without accessors. */
  function publishPeriod() {
    if (!periodAccessor && Moon.App) Moon.App.period = period;
  }

  function setPeriod(key) {
    var next = String(key === null || key === undefined ? "" : key);
    if (!PERIOD_RE.test(next)) return period;
    if (next === period) return period;
    period = next;
    publishPeriod();
    /* Pinned, so a later state:change (a new entry, a settings edit) does not
       yank the reader back to today. Never written to storage: the chosen
       period is a session thing and a reload starts at today again. */
    periodPinned = true;
    syncControls();
    if (route) mount(route);
    return period;
  }

  function stepPeriod(n) {
    var Dates = Moon.Dates;
    if (!Dates || typeof Dates.shiftPeriod !== "function" || !period) return;
    /* Future periods are allowed on purpose — planning next month is a real
       use — and every view already has a state for a period with no data. */
    var next = safe(function () { return Dates.shiftPeriod(period, n); }, null);
    if (next) setPeriod(next);
  }

  /* The sample month may sit in the last complete period, because this one was
     only days old when it was written. Landing on today would then open a page
     with two entries on it and nothing to read, which is exactly what the
     sample exists to avoid. Only the opening period is chosen this way, only
     while the sample is on, and only until the reader moves the selector. */
  function openingPeriod() {
    var now = todayPeriod();
    var state = Moon.Store && Moon.Store.state;
    if (!state || !state.settings || !state.settings.sampleOn) return now;

    var sample = safe(function () {
      return Moon.Sample && Moon.Sample.period ? Moon.Sample.period() : null;
    }, null);
    if (!sample || sample === now) return now;

    var counted = { here: 0, there: 0 };
    (Array.isArray(state.entries) ? state.entries : []).forEach(function (entry) {
      if (!entry || typeof entry.date !== "string") return;
      var key = entry.date.slice(0, 7);
      if (key === now) counted.here += 1;
      else if (key === sample) counted.there += 1;
    });
    return counted.there > counted.here ? sample : now;
  }

  function trackToday() {
    if (periodPinned && period) return;
    var now = openingPeriod();
    if (now && now !== period) period = now;
    else if (!period) period = now;
    publishPeriod();
  }

  /* ------------------------------------------------------------------ writing */

  /* Settings are the one part of the schema Model exposes no writer for, so the
     base layer's own path is Store.update (the Data section does the same).
     countsAsChange is off: picking a currency or a theme changes no record, and
     it must not push the reader towards a backup they do not need. */
  function writeSetting(patch, reason) {
    var st = Moon.Store;
    if (!st || typeof st.update !== "function") return;
    safe(function () {
      st.update(function (draft) {
        if (!draft.settings) draft.settings = {};
        Object.keys(patch).forEach(function (name) {
          draft.settings[name] = patch[name];
        });
      }, { reason: reason, immediate: true, countsAsChange: false });
    });
  }

  /* -------------------------------------------------------------------- theme */

  function currentTheme() {
    var value = settings().theme;
    return THEMES.indexOf(value) === -1 ? "system" : value;
  }

  function isSurface(theme) {
    return Object.prototype.hasOwnProperty.call(SURFACES, String(theme));
  }

  function nextTheme(theme) {
    var index = THEMES.indexOf(theme);
    return THEMES[(index === -1 ? 0 : index + 1) % THEMES.length];
  }

  /* Which language a fresh install should be seeded in, or null when the reader
     already has a preference and nothing should be touched. */
  function seedsLang(stored) {
    if (stored && (stored.lang === "tr" || stored.lang === "en")) return null;
    return DEFAULT_LANG;
  }

  /* js/store.js validates settings.theme against two surfaces and silently
     normalises anything else to "system" as it reads the file, so the reader who
     picked Prism would be handed System back on the next load. The pick is still
     in the stored bytes — index.html reads them before first paint and paints
     Prism — so the shell recovers it here and writes it back, keeping the
     attribute, the header button and the stored settings on one story. Returns
     the theme to restore, or null when there is nothing to do. Delete this once
     store.js knows the third material. */
  function recoverableTheme(stored, active) {
    if (!stored) return null;
    var want = stored.theme;
    if (THEMES.indexOf(want) === -1) return null;
    return want === active ? null : want;
  }

  /* A theme change is the one colour change worth following with the eye:
     .theming opens a --dur-theme window in which moon.css lets the colour
     properties transition (named one by one, never `all`), and it comes
     straight back off so no later redraw animates. A reader who asked for less
     motion never gets the class.

     A timer, not transitionend: <html> itself is not guaranteed to transition
     any property, and a descendant's event would close the window for every
     other node too. One duration drives all of them, so one timer is honest. */
  function fadeTheme() {
    var html = doc.documentElement;
    if (!html || !html.classList || reducedMotion()) return;

    if (themingTimer) global.clearTimeout(themingTimer);
    html.classList.add("theming");
    themingTimer = global.setTimeout(function () {
      themingTimer = null;
      setClass(html, "theming", false);
    }, THEME_FADE);
  }

  /* On a phone the address bar is part of the page, so it has to follow the
     surface too. index.html ships one theme-color meta per surface behind its
     own media query, which covers "system" on its own and before any script
     runs. A pinned theme is exactly the case the system query gets wrong, so
     the queries are retargeted instead: the chosen surface gets `all` and the
     other `not all`. Colours are not rewritten here — they stay in index.html
     beside the tokens they mirror, in one place rather than two. */
  function syncThemeColor(theme) {
    safe(function () {
      var metas = doc.querySelectorAll('meta[name="theme-color"][data-surface]');
      var pinned = isSurface(theme);
      for (var i = 0; i < metas.length; i += 1) {
        var surface = metas[i].getAttribute("data-surface");
        if (pinned) metas[i].setAttribute("media", surface === theme ? "all" : "not all");
        else metas[i].setAttribute("media", SURFACE_MEDIA[surface] || "all");
      }
    });
  }

  /* "system" REMOVES the attribute rather than writing it: the page then follows
     prefers-color-scheme, which is what tokens.css is built around.
     `animate` opens the colour window first, so the attribute swap below is
     already inside it — at boot there is nothing to fade from. */
  function applyTheme(theme, animate) {
    if (animate) fadeTheme();
    safe(function () {
      var html = doc.documentElement;
      if (!html) return;
      if (isSurface(theme)) html.setAttribute("data-theme", theme);
      else html.removeAttribute("data-theme");
    });
    syncThemeColor(theme);
    if (Moon.bus && typeof Moon.bus.emit === "function") {
      Moon.bus.emit("theme:change", { theme: theme });
    }
  }

  function cycleTheme() {
    var next = nextTheme(currentTheme());
    applyTheme(next, true);
    if (ctl && ctl.theme) ctl.theme.textContent = t("common.theme." + next);
    writeSetting({ theme: next }, "settings:theme");
  }

  /* ----------------------------------------------------------------- controls */

  function symbolOf(code) {
    var Money = Moon.Money;
    if (Money && typeof Money.symbol === "function") {
      var found = safe(function () { return Money.symbol(code); }, null);
      if (found) return String(found);
    }
    return String(code);
  }

  /* A chevron is not a word, so it is aria-hidden and the button carries a
     translated aria-label. data-i18n-label lets relabel() refresh it. */
  function glyphButton(glyph, labelKey, onClick) {
    return el("button", {
      type: "button",
      "aria-label": t(labelKey),
      dataset: { i18nLabel: labelKey },
      on: { click: onClick }
    }, el("span", { "aria-hidden": "true" }, glyph));
  }


  function langButton(code) {
    var key = "common.lang." + code;
    return el("button", {
      type: "button",
      title: t(key),
      "aria-pressed": "false",
      dataset: { lang: code, i18nTitle: key },
      on: {
        click: function () {
          var I18n = Moon.I18n;
          if (!I18n || typeof I18n.setLang !== "function") return;
          if (I18n.lang === code) return;
          safe(function () { I18n.setLang(code); });
          announce("a11y.langChanged", { lang: t(key) });
        }
      }
    }, String(code).toUpperCase());
  }

  /* The catalogue decides which languages exist (I18n.languages()), but its
     order puts the active one first — which would reshuffle the buttons under
     the reader's cursor. Sorted descending here instead: deterministic, and it
     lands on the header's TR|EN reading for the two catalogues we ship. */
  function languageCodes() {
    var I18n = Moon.I18n;
    var list = [];
    if (I18n && typeof I18n.languages === "function") {
      list = safe(function () { return I18n.languages(); }, []) || [];
    }
    list = list.slice().sort(function (a, b) {
      return a < b ? 1 : (a > b ? -1 : 0);
    });
    if (!list.length && I18n && I18n.lang) list = [I18n.lang];
    return list;
  }

  function buildControls() {
    ctl = { period: null, label: null, currency: [], lang: [], theme: null };

    var periodHost = doc.getElementById("period-control");
    if (periodHost) {
      dom.clear(periodHost);
      periodHost.setAttribute("role", "group");
      periodHost.appendChild(glyphButton("‹", "a11y.periodPrev", function () {
        stepPeriod(-1);
      }));
      ctl.label = el("span", { "class": "period__label" });
      periodHost.appendChild(ctl.label);
      periodHost.appendChild(glyphButton("›", "a11y.periodNext", function () {
        stepPeriod(1);
      }));
      ctl.period = periodHost;
    }

    /* One select rather than four buttons. The currency is set once and then
       left alone, so spending four slots of permanent chrome on it crowds the
       period — the control the reader actually moves — and the same choice is
       already a select down in Settings. */
    var currencyHost = doc.getElementById("currency-control");
    if (currencyHost) {
      dom.clear(currencyHost);
      currencyHost.removeAttribute("role");
      currencyHost.removeAttribute("aria-label");
      currencyHost.setAttribute("data-i18n-group", "common.currency");

      var currencySelect = el("select", {
        "class": "picker__select",
        "aria-label": t("common.currency")
      });
      CURRENCIES.forEach(function (code) {
        currencySelect.appendChild(el("option", {
          value: code,
          selected: code === settings().currency ? true : null
        }, Moon.Money.symbol(code) + " " + code));
      });
      currencySelect.addEventListener("change", function () {
        var code = currencySelect.value;
        if (CURRENCIES.indexOf(code) === -1) return;
        if (settings().currency === code) return;
        writeSetting({ currency: code }, "settings:currency");
      });
      ctl.currency.push(currencySelect);
      currencyHost.appendChild(currencySelect);
    }

    var langHost = doc.getElementById("lang-control");
    if (langHost) {
      dom.clear(langHost);
      langHost.setAttribute("role", "group");
      langHost.setAttribute("aria-label", t("common.language"));
      langHost.setAttribute("data-i18n-group", "common.language");
      languageCodes().forEach(function (code, index) {
        if (index > 0) {
          langHost.appendChild(el("span", { "class": "picker__sep", "aria-hidden": "true" }, "|"));
        }
        var node = langButton(code);
        ctl.lang.push(node);
        langHost.appendChild(node);
      });
    }

    var themeHost = doc.getElementById("theme-control");
    if (themeHost) {
      dom.clear(themeHost);
      themeHost.setAttribute("role", "group");
      themeHost.setAttribute("aria-label", t("common.theme"));
      themeHost.setAttribute("data-i18n-group", "common.theme");
      /* No icon (G8): the button says which material is on, and pressing it
         moves to the next one. The group label supplies "Theme". */
      ctl.theme = el("button", {
        type: "button",
        on: { click: cycleTheme }
      }, t("common.theme." + currentTheme()));
      themeHost.appendChild(ctl.theme);
    }
  }

  function syncControls() {
    if (!ctl) return;

    var label = periodText();
    if (ctl.label) ctl.label.textContent = label;
    if (ctl.period) {
      ctl.period.setAttribute("aria-label", t("a11y.periodCurrent", { period: label }));
    }

    var currency = settings().currency;
    ctl.currency.forEach(function (node) {
      if (node.tagName === "SELECT") {
        if (node.value !== currency) node.value = currency;
        node.setAttribute("aria-label", t("common.currency"));
        return;
      }
      var on = node.dataset.currency === currency;
      setClass(node, "is-active", on);
      node.setAttribute("aria-pressed", on ? "true" : "false");
    });

    var active = lang();
    ctl.lang.forEach(function (node) {
      var on = node.dataset.lang === active;
      setClass(node, "is-active", on);
      node.setAttribute("aria-pressed", on ? "true" : "false");
    });

    if (ctl.theme) ctl.theme.textContent = t("common.theme." + currentTheme());
  }

  /* Every translated attribute in the shell is tagged, so a language change is
     one walk rather than a list of hand-written assignments. */
  function relabel() {
    dom.qsa("[data-i18n]").forEach(function (node) {
      var key = node.getAttribute("data-i18n");
      if (key) node.textContent = t(key);
    });
    dom.qsa("[data-i18n-label]").forEach(function (node) {
      var key = node.getAttribute("data-i18n-label");
      if (key) node.setAttribute("aria-label", t(key));
    });
    dom.qsa("[data-i18n-title]").forEach(function (node) {
      var key = node.getAttribute("data-i18n-title");
      if (key) node.setAttribute("title", t(key));
    });
    dom.qsa("[data-i18n-group]").forEach(function (node) {
      var key = node.getAttribute("data-i18n-group");
      if (key) node.setAttribute("aria-label", t(key));
    });
    var skip = dom.qs(".skip");
    if (skip) skip.textContent = t("a11y.skip");
    var rail = railNode();
    if (rail) rail.setAttribute("aria-label", t("a11y.rail"));
  }

  /* --------------------------------------------------------------- more sheet */

  function railNode() {
    return doc.getElementById("rail");
  }

  function moreNode() {
    return doc.getElementById("rail-more");
  }

  function sheetOpen() {
    var more = moreNode();
    return !!more && more.getAttribute("aria-expanded") === "true";
  }

  /* Both halves move together: aria-expanded is what a screen reader reads and
     what the :has() rule keys on, .is-open is the fallback for engines without
     :has(). One without the other is a half-open sheet. */
  function setSheet(open) {
    var more = moreNode();
    if (more) more.setAttribute("aria-expanded", open ? "true" : "false");
    setClass(railNode(), "is-open", open);
  }

  function bindSheet() {
    if (sheetBound) return;
    var rail = railNode();
    var more = moreNode();
    if (!rail || !more) return;
    sheetBound = true;

    more.addEventListener("click", function (event) {
      event.preventDefault();
      setSheet(!sheetOpen());
    });

    /* Following a link closes the sheet: the destination is already on screen
       behind it. */
    rail.addEventListener("click", function (event) {
      var target = event.target;
      if (target && typeof target.closest === "function" && target.closest(".rail__item")) {
        setSheet(false);
      }
    });

    doc.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !sheetOpen()) return;
      setSheet(false);
      focusNode(moreNode());
    });

    doc.addEventListener("click", function (event) {
      if (!sheetOpen()) return;
      var target = event.target;
      /* The toggle itself lives inside #rail, so its own click lands here after
         it has already flipped the state — and is correctly ignored. */
      if (target && typeof target.closest === "function" && target.closest("#rail")) return;
      setSheet(false);
    });
  }

  /* -------------------------------------------------------------------- bands */

  function hostBefore(id) {
    var found = doc.getElementById(id);
    if (found) return found;
    var shell = dom.qs(".shell");
    if (!shell || !shell.parentNode) return null;
    /* .strip is the existing max-width + gutter wrapper and collapses when it
       is empty, so no new class is invented for these two hosts. */
    found = el("div", { "class": "strip", id: id });
    shell.parentNode.insertBefore(found, shell);
    return found;
  }

  function hostAfter(id) {
    var found = doc.getElementById(id);
    if (found) return found;
    var shell = dom.qs(".shell");
    if (!shell || !shell.parentNode) return null;
    found = el("div", { "class": "strip", id: id });
    if (shell.nextSibling) shell.parentNode.insertBefore(found, shell.nextSibling);
    else shell.parentNode.appendChild(found);
    return found;
  }

  function band(spec) {
    var UI = Moon.UI;
    if (!UI || typeof UI.notice !== "function") {
      return el("p", { "class": "sm dim", text: t(spec.messageKey, spec.params) });
    }
    var node = UI.notice(spec);
    /* moon.css keys the left rule on .is-<kind>. */
    setClass(node, "is-" + (spec.kind || "info"), true);
    return node;
  }

  function dataLink() {
    return { labelKey: "nav.data", href: "#" + DATA_HASH, "class": "is-quiet" };
  }

  /* E7 names no "a write finally worked" event: persistNow clears
     status.quotaHit and status.lastError on success and stays silent. Without
     this, a band raised by a full disk would sit there for the rest of the
     session — unclosable, telling the reader nothing is being saved — while
     every entry since then saved fine. Store.status is the live object the
     store mutates, so the shell re-reads it rather than waiting for an event
     that is never coming. A fresh failure re-raises the band through
     store:error as before, so nothing is swallowed. */
  function syncStoreError() {
    if (!storeError) return;
    var st = Moon.Store;
    if (!st || !st.status) return;          /* nothing to read: leave it up */
    if (st.status.lastError) return;        /* still failing */
    storeError = null;
  }

  /* The write is debounced and then deferred to an idle callback, so the state
     change arrives before the attempt it caused. One late look settles it.
     Armed only from a state change, never from inside its own callback, so
     this stays a single pending timer and not a poll. */
  function watchRecovery() {
    if (!storeError || recoverTimer !== null) return;
    recoverTimer = global.setTimeout(function () {
      recoverTimer = null;
      if (!storeError) return;
      syncStoreError();
      if (!storeError) safe(drawBands);
    }, RECOVER_MS);
  }

  function drawBands() {
    var host = hostBefore("moon-bands");
    if (!host) return;
    dom.clear(host);

    if (readOnlyNote) {
      /* Permanent, not dismissible: the session cannot save, and the reader
         needs the way out (a JSON download in the Data section) in reach. */
      host.appendChild(band({
        kind: "warn",
        messageKey: readOnlyNote.messageKey,
        actions: [dataLink()]
      }));
    }

    if (storeError) {
      /* E7: show the payload's messageKey directly. No switch over `kind`, so a
         kind this file has never heard of still speaks on screen. */
      var spec = { kind: "error", messageKey: storeError.messageKey || "err.unknown" };
      if (storeError.kind === "quota") spec.actions = [dataLink()];
      host.appendChild(band(spec));
    }
  }

  function drawNudge() {
    var host = hostAfter("moon-nudge");
    if (!host) return;
    dom.clear(host);
    if (nudgeOff) return;

    var s = settings();
    var count = typeof s.changesSinceBackup === "number" ? s.changesSinceBackup : 0;
    if (count < NUDGE_AT) return;

    /* A quiet mark under the rail with a link, never a modal: a backup is worth
       suggesting, not worth interrupting for. */
    var never = !s.lastBackup;
    host.appendChild(band({
      kind: "info",
      "class": "sm",
      messageKey: never ? "data.backup.nudge.never" : "data.backup.nudge",
      params: never ? null : { count: count },
      actions: [dataLink()],
      dismissible: true,
      dismissKey: "common.close",
      onDismiss: function () { nudgeOff = true; }
    }));
  }

  /* ------------------------------------------------------------------- router */

  function currentHash() {
    var raw = safe(function () { return String(global.location.hash || ""); }, "");
    return raw.replace(/^#/, "").replace(/[?&].*$/, "");
  }

  function routeFor(hash) {
    for (var i = 0; i < ROUTES.length; i += 1) {
      if (ROUTES[i].hash === hash) return ROUTES[i];
    }
    return null;
  }

  function viewFor(row) {
    var views = Moon.Views || {};
    var found = row ? views[row.view] : null;
    return found && typeof found.render === "function" ? found : null;
  }

  function normalizeHash(hash) {
    var replaced = safe(function () {
      if (global.history && typeof global.history.replaceState === "function") {
        /* replaceState, not assignment: the back button should not bounce
           between a bad hash and the panel. It fires no hashchange, so the
           mount happens here. */
        global.history.replaceState(null, "", "#" + hash);
        return true;
      }
      return false;
    }, false);

    if (replaced) {
      mount(routeFor(hash));
      return;
    }
    var moved = safe(function () {
      global.location.hash = "#" + hash;
      return true;
    }, false);
    if (!moved) mount(routeFor(hash));
  }

  function mount(row) {
    if (!row) return;
    var host = doc.getElementById("view");
    if (!host) return;

    var changed = !route || route.hash !== row.hash;
    var view = viewFor(row);

    if (changed && mountedView && typeof mountedView.destroy === "function") {
      safe(function () { mountedView.destroy(); });
    }

    route = row;
    mountedView = view;
    syncRail();

    if (!view) {
      /* A section whose file failed to load still gets one honest sentence
         instead of an empty white page. */
      dom.clear(host);
      host.appendChild(el("p", { "class": "prose", text: t("err.unknown") }));
      firstPaint = false;
      return;
    }

    /* Every view clears #view itself and is idempotent (E10), so a redraw on
       state:change or lang:change is just another call. */
    safe(function () { view.render(host); });

    /* The sample month has to announce itself wherever the reader is standing.
       Living only in the Data section meant someone could read a panel full of
       invented numbers with nothing on screen saying so. The view owns the
       strip's wording and its clear action; mounting it on every route is the
       router's job, after the view has drawn and cleared the host. */
    safe(function () {
      var data = Moon.Views && Moon.Views.data;
      if (!data || typeof data.sampleNotice !== "function") return;
      if (row.hash === DATA_HASH) return;   /* that section prints its own */
      var strip = data.sampleNotice();
      if (strip) host.insertBefore(strip, host.firstChild);
    });

    if (changed) {
      setSheet(false);
      if (!firstPaint) {
        /* Focus follows the route for keyboard readers — but not on load, where
           stealing focus would skip past the skip link. */
        focusNode(host);
        announce("a11y.routeChanged", { section: t(view.titleKey || row.hash) });
      }
    }
    firstPaint = false;
  }

  function syncRail() {
    var rail = railNode();
    if (rail) rail.setAttribute("aria-label", t("a11y.rail"));
    dom.qsa(".rail__item").forEach(function (item) {
      var target = String(item.getAttribute("href") || "").replace(/^#/, "");
      var on = !!route && target === route.hash;
      setClass(item, "is-active", on);
      if (on) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
  }

  function routeNow() {
    var hash = currentHash();
    var row = routeFor(hash);
    if (!row) {
      /* A hash nobody owns is corrected. An EMPTY hash is left alone: the
         reader never typed it, and rewriting it would push a history entry in
         front of wherever they came from. */
      if (hash) {
        normalizeHash(HOME);
        return;
      }
      row = routeFor(HOME);
    }
    mount(row);
  }

  function go(id) {
    var hash = String(id === null || id === undefined ? "" : id).replace(/^#/, "");
    if (!routeFor(hash)) hash = HOME;
    if (currentHash() === hash) {
      mount(routeFor(hash));
      return;
    }
    safe(function () { global.location.hash = "#" + hash; });
  }

  /* ------------------------------------------------------------------ redraws */

  function refresh() {
    trackToday();
    syncControls();
    syncStoreError();
    drawBands();
    watchRecovery();
    drawNudge();
    if (route) mount(route);
  }

  /* A language change writes settings.lang, so lang:change and state:change
     arrive back to back. Coalescing them into one redraw keeps a 500-entry
     ledger from being built twice for one click. */
  function schedule() {
    if (renderTimer) return;
    renderTimer = global.setTimeout(function () {
      renderTimer = null;
      safe(refresh);
    }, 0);
  }

  /* ------------------------------------------------------------------- adapt */

  /* Dark adaptation: one class on <html>, removed when the sequence ends. Once
     per session, and never at all for a reader who asked for less motion. */
  function adapt() {
    if (adaptRun) return;
    adaptRun = true;

    if (reducedMotion()) return;

    var html = doc.documentElement;
    if (!html || !html.classList) return;
    var view = doc.getElementById("view");
    var timer = null;

    function done() {
      if (timer) {
        global.clearTimeout(timer);
        timer = null;
      }
      doc.removeEventListener("animationend", onEnd, true);
      html.classList.remove("adapt");
    }

    /* Several elements animate inside the 600ms sequence; only the one that
       runs the whole length means it is over. The timeout covers the case where
       nothing animated at all. */
    function onEnd(event) {
      if (view && event.target !== view) return;
      done();
    }

    doc.addEventListener("animationend", onEnd, true);
    timer = global.setTimeout(done, ADAPT_MAX);
    html.classList.add("adapt");
  }

  /* -------------------------------------------------------------- installing */

  /* The service worker is what lets Moon open in flight mode and be installed
     from the browser, and it is the one piece of the app that cannot run from
     a file: URL — a worker needs an origin, and registering without one throws
     a SecurityError. Guarding on the protocol keeps the offline copy the README
     describes working exactly as it does today instead of logging a refusal on
     every load.
     Nothing on screen depends on the outcome, so a rejection is logged and
     dropped: an app that will not draw because a cache could not be warmed is
     worse than one that still needs the network. */
  function registerWorker() {
    var protocol = safe(function () { return String(global.location.protocol); }, "");
    if (protocol !== "https:" && protocol !== "http:") return;

    var worker = global.navigator ? global.navigator.serviceWorker : null;
    if (!worker || typeof worker.register !== "function") return;

    safe(function () {
      /* Relative to the document, so the published copy under /moon/ registers
         /moon/sw.js and takes /moon/ as its scope with nothing configured. */
      var pending = worker.register("sw.js");
      if (pending && typeof pending.catch === "function") {
        pending.catch(function (error) { log(error, "serviceWorker"); });
      }
    });

    /* A new release has just taken control of this page, so what is on screen
       is the old one. Reloading once hands the reader the version they came
       for; without it a worker installed weeks ago keeps serving its own copy
       and every fix published since is invisible, with nothing on screen
       admitting it. Guarded against a loop, because a worker that failed to
       activate could otherwise reload the page forever. */
    safe(function () {
      var reloaded = false;
      worker.addEventListener("controllerchange", function () {
        if (reloaded) return;
        reloaded = true;
        safe(function () { global.location.reload(); });
      });
    });
  }

  /* -------------------------------------------------------------------- boot */

  function onStoreError(payload) {
    var info = payload || { kind: "write", messageKey: "err.unknown" };
    if (info.kind === "readonly") {
      readOnlyNote = { messageKey: info.messageKey || "data.readOnly" };
    } else {
      storeError = info;
    }
    /* Out of the emitter's turn: Store is mid-write when this fires. */
    global.setTimeout(function () { safe(drawBands); }, 0);
  }

  function bootStore() {
    var st = Moon.Store;
    if (!st || typeof st.boot !== "function") return null;

    /* Subscribed BEFORE boot: the read-only error is emitted from inside
       boot(), and a listener added afterwards would never hear it. */
    if (Moon.bus && typeof Moon.bus.on === "function") {
      Moon.bus.on("store:error", onStoreError);
    }

    var result = safe(function () { return st.boot(); }, null);
    if (result && result.readOnly && !readOnlyNote) {
      var last = st.status ? st.status.lastError : null;
      readOnlyNote = { messageKey: (last && last.messageKey) || "data.readOnly" };
    }
    return result;
  }

  /* Runs BEFORE Store.boot(). A fresh install names its thirteen seed
     categories in whatever language is active at that moment, as plain text
     that deliberately never follows a later switch (contract §6.1) — so the
     ground language has to be in place before those names are written, not
     after. With a stored preference nothing is set here: applyLang() reads it
     once the store is up. Store is not booted yet, so setLang finds no state to
     write to and only moves this session's language. */
  function seedLang(stored) {
    var I18n = Moon.I18n;
    if (!I18n || typeof I18n.setLang !== "function") return;
    var want = seedsLang(stored);
    if (!want) return;
    safe(function () { I18n.setLang(want); });
  }

  function applyLang() {
    var I18n = Moon.I18n;
    if (!I18n || typeof I18n.setLang !== "function") return;
    var want = settings().lang;
    var known = typeof I18n.languages === "function"
      ? (safe(function () { return I18n.languages(); }, []) || [])
      : [];
    if (!want || known.indexOf(want) === -1) return;
    /* E3: setLang writes <html lang> and document.title. This file never
       touches either. */
    safe(function () { I18n.setLang(want); });
  }

  function bindBus() {
    var bus = Moon.bus;
    if (!bus || typeof bus.on !== "function") return;
    bus.on("state:change", schedule);
    bus.on("lang:change", function () {
      relabel();
      schedule();
    });
    /* The Data section carries its own theme select and emits the same event,
       so the address-bar colour and the fade answer the event rather than the
       click: one path for both controls. applyTheme's own emit lands here too
       and is idempotent — and the one at boot is raised before this
       subscription exists, which is exactly why the first paint does not fade. */
    bus.on("theme:change", function (payload) {
      var theme = payload ? payload.theme : null;
      if (THEMES.indexOf(theme) === -1) return;
      syncThemeColor(theme);
      fadeTheme();
    });
  }

  function fatal(error) {
    log(error, "boot");
    var host = doc.getElementById("view");
    if (!host) return;
    safe(function () {
      dom.clear(host);
      host.appendChild(el("p", { "class": "prose", text: t("err.unknown") }));
    });
  }

  function boot() {
    if (booted) return Moon.App;
    booted = true;

    try {
      /* Read the raw settings first: boot order is the whole point here. The
         language has to be chosen before the store seeds a fresh install, and
         the surface the reader pinned has to be recovered after it. */
      var stored = storedSettings();
      seedLang(stored);
      bootStore();
      applyLang();

      var recovered = recoverableTheme(stored, currentTheme());
      if (recovered) writeSetting({ theme: recovered }, "settings:theme");
      applyTheme(currentTheme());

      /* Step 4 of the contract is deliberately absent: generateRecurring is
         NOT called here (E6). It writes confirmed entries the instant it runs,
         so the panel counts pendingRecurring and the reader presses the
         button. Nothing is written on someone's behalf at boot. */

      period = openingPeriod();
      publishPeriod();

      buildControls();
      bindSheet();
      relabel();
      syncControls();
      bindBus();

      global.addEventListener("hashchange", function () {
        safe(routeNow);
      }, false);

      drawBands();
      drawNudge();
      routeNow();
      safe(adapt);
      registerWorker();
    } catch (error) {
      fatal(error);
    }
    return Moon.App;
  }

  /* --------------------------------------------------------------------- api */

  /* The decisions the shell makes before anything is on screen — which language
     a fresh install is seeded in, how the theme cycle turns, which surface
     survives a reload — are pure functions, so they can be proved without a
     browser. Same report shape as the other modules. */
  function selftest() {
    var failed = [];
    var passed = 0;

    function check(name, got, want) {
      if (got === want) passed += 1;
      else failed.push(name + ": got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
    }

    /* 1 — English is the ground language, and only a stored pick overrules it */
    check("ground language", DEFAULT_LANG, "en");
    check("no stored settings seeds en", seedsLang(null), "en");
    check("empty settings seed en", seedsLang({}), "en");
    check("unknown stored language seeds en", seedsLang({ lang: "de" }), "en");
    check("stored tr wins", seedsLang({ lang: "tr" }), null);
    check("stored en is left alone", seedsLang({ lang: "en" }), null);

    /* 2 — the cycle gained a fourth stop and still closes */
    check("cycle 1", nextTheme("system"), "dial");
    check("cycle 2", nextTheme("dial"), "paper");
    check("cycle 3", nextTheme("paper"), "prism");
    check("cycle 4", nextTheme("prism"), "system");
    check("cycle from nonsense", nextTheme("chrome"), "system");
    check("four stops", THEMES.length, 4);

    /* 3 — prism pins an attribute and owns a theme-color tag */
    check("prism is a surface", isSurface("prism"), true);
    check("dial is a surface", isSurface("dial"), true);
    check("paper is a surface", isSurface("paper"), true);
    check("system pins nothing", isSurface("system"), false);
    check("prism answers no system query", SURFACE_MEDIA.prism, "not all");
    Object.keys(SURFACES).forEach(function (name) {
      check("media for " + name, typeof SURFACE_MEDIA[name], "string");
    });

    /* 4 — a pinned surface the store dropped is recovered, once */
    check("prism recovered", recoverableTheme({ theme: "prism" }, "system"), "prism");
    check("prism already on", recoverableTheme({ theme: "prism" }, "prism"), null);
    check("paper needs no rescue", recoverableTheme({ theme: "paper" }, "paper"), null);
    check("junk is not a theme", recoverableTheme({ theme: "neon" }, "system"), null);
    check("nothing stored", recoverableTheme(null, "system"), null);

    /* 5 — the fade window is a real one and matches the stylesheet */
    check("fade outlives --dur-theme", THEME_FADE > 320, true);

    return { ok: failed.length === 0, passed: passed, failed: failed };
  }

  var App = {
    boot: boot,
    setPeriod: setPeriod,
    go: go,
    render: function () {
      if (route) safe(function () { mount(route); });
      return App;
    },
    _selftest: selftest
  };

  /* A read-only property, per the contract: views read Moon.App.period and
     never assign it. */
  periodAccessor = safe(function () {
    Object.defineProperty(App, "period", {
      enumerable: true,
      get: function () { return period; }
    });
    return true;
  }, false);

  Moon.App = App;
  publishPeriod();

  /* ------------------------------------------------------------------- start */

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", function () {
      safe(boot);
    }, false);
  } else {
    /* Already parsed (a deferred load, an injected script): boot at once. */
    safe(boot);
  }
})(window);
