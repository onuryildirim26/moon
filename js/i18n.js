/* Moon — translation lookup.
 *
 * One job: turn a key plus parameters into the sentence a human reads. The
 * catalogues (lang.tr.js, lang.en.js) are flat maps of key to whole sentence;
 * nothing here builds a sentence by concatenation, because Turkish suffixes do
 * not survive that.
 *
 * Three deliberate decisions:
 *
 *  1. t() does NOT HTML-escape. Escaping belongs at the boundary where the text
 *     meets the DOM: textContent needs none, and the one place that uses
 *     innerHTML passes the result through Moon.util.esc() (see the contract,
 *     rule 7). Escaping here would double-escape every ampersand on screen.
 *
 *  2. A missing key warns once, never in a loop. A ledger of 200 rows must not
 *     turn one typo into 200 console lines, or the real warning drowns.
 *
 *  3. Turkish takes no plural suffix after a numeral ("3 kayıt"), so the plural
 *     selector always picks ".other" for tr. English picks ".one" only when
 *     count is exactly 1. Both catalogues carry both keys so their key sets
 *     stay identical — _verify() proves it.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;
  Moon.Lang = Moon.Lang || {};

  /* The chain ends here: a key missing from the active language is looked up in
     English before the key itself is shown. */
  var FALLBACK_LANG = "en";

  /* Languages whose plural rules we know. Everything else behaves like English,
     which is the safer guess for an unknown catalogue. */
  var NO_PLURAL_SUFFIX = { tr: true };

  var PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

  var current = detectLang();

  /* key -> "fallback" | "missing". Doubles as the one-warning-per-key guard and
     as the answer to missingKeys(). */
  var gaps = Object.create(null);

  function has(object, key) {
    return object !== null && object !== undefined &&
      Object.prototype.hasOwnProperty.call(object, key);
  }

  function ownKeys(object) {
    var keys = [];
    if (!object || typeof object !== "object") return keys;
    Object.keys(object).forEach(function (key) {
      if (typeof object[key] === "string") keys.push(key);
    });
    return keys;
  }

  /* Best guess before Store has been read. App overrides it with the stored
     setting one step after boot; nothing here touches storage or the DOM. */
  function detectLang() {
    var tags = [];
    try {
      var nav = global.navigator;
      if (nav) {
        if (nav.languages && nav.languages.length) tags = [].slice.call(nav.languages);
        else if (nav.language) tags = [nav.language];
      }
    } catch (e) { /* no navigator (tests, odd embeds): fall through */ }

    for (var i = 0; i < tags.length; i += 1) {
      var tag = String(tags[i] || "").toLowerCase();
      if (tag.indexOf("tr") === 0) return "tr";
      if (tag.indexOf("en") === 0) return FALLBACK_LANG;
    }
    return FALLBACK_LANG;
  }

  function catalog(lang) {
    var found = Moon.Lang[lang];
    return found && typeof found === "object" ? found : null;
  }

  /* A string or null — never undefined, so callers can test one thing. */
  function fromCatalog(lang, key) {
    var cat = catalog(lang);
    if (!cat || !has(cat, key)) return null;
    var value = cat[key];
    return typeof value === "string" ? value : null;
  }

  /* Error codes travel up from Store, Model, CSV and Importer as strings, and
     those modules name a fault after the fault ("err.amountRequired"), while the
     catalogue names it after the sentence a reader needs ("err.required"). One
     sentence often answers several codes, so the codes alias onto it here rather
     than being duplicated in two catalogues where the two copies would drift. */
  var ALIASES = {
    "csv.decodeFailed": "csv.err.notCsv",
    "csv.empty": "csv.err.empty",
    "csv.encodingGuess": "csv.err.encodingGuess",
    "csv.internal": "err.unknown",
    "csv.noAmountColumn": "csv.err.noAmount",
    "csv.noDateColumn": "csv.err.noDate",
    "csv.noFile": "csv.err.notCsv",
    "csv.readFailed": "csv.err.readFailed",
    "csv.tooLarge": "csv.err.tooBig",
    "csv.tooManyRows": "csv.err.tooManyRows",

    "data.error.notBooted": "err.unknown",
    "data.error.quota": "err.quotaFull",
    "data.error.readOnly": "err.readOnly",
    "data.error.write": "err.writeFailed",
    "data.import.badFile": "err.importBadFile",

    "err.amountPositive": "err.negativeAmount",
    "err.amountRequired": "err.required",
    "err.categoryRequired": "err.required",
    "err.categoryUnknown": "err.badCategory",
    "err.dateInvalid": "err.badDate",
    "err.dateOrder": "err.badRange",
    "err.dateRequired": "err.required",
    "err.dayOfMonthRange": "err.badDayOfMonth",
    "err.directionInvalid": "err.badDirection",
    "err.directionMismatch": "err.badDirection",
    "err.nameRequired": "err.required",
    "err.personRequired": "err.required"
  };

  function fromChain(key) {
    var hit = fromCatalog(current, key);
    if (hit !== null) return { text: hit, lang: current };
    if (current !== FALLBACK_LANG) {
      hit = fromCatalog(FALLBACK_LANG, key);
      if (hit !== null) return { text: hit, lang: FALLBACK_LANG };
    }
    if (has(ALIASES, key)) return fromChain(ALIASES[key]);
    return null;
  }

  function reportGap(key, kind) {
    if (gaps[key] === kind) return;
    gaps[key] = kind;
    if (!global.console || !global.console.warn) return;
    if (kind === "fallback") {
      global.console.warn("Moon.I18n: '" + key + "' missing in '" + current +
        "', showing '" + FALLBACK_LANG + "'");
    } else {
      global.console.warn("Moon.I18n: '" + key + "' is in no catalogue");
    }
  }

  function pluralSuffix(lang, count) {
    if (NO_PLURAL_SUFFIX[lang]) return ".other";
    return count === 1 ? ".one" : ".other";
  }

  /* Leaves an unmatched {token} standing on purpose: a visible gap on screen is
     cheaper to find than a silent empty string. */
  function fill(template, params) {
    if (template.indexOf("{") === -1) return template;
    if (!params || typeof params !== "object") return template;

    return template.replace(PLACEHOLDER, function (whole, name) {
      if (!has(params, name)) return whole;
      var value = params[name];
      if (value === null || value === undefined) return whole;
      if (typeof value === "number" && !isFinite(value)) return whole;
      return String(value);
    });
  }

  function placeholdersOf(text) {
    var names = [];
    String(text).replace(PLACEHOLDER, function (whole, name) {
      if (names.indexOf(name) === -1) names.push(name);
      return whole;
    });
    return names.sort();
  }

  var I18n = {
    /* t("panel.state.ok.body", {days: 9, amount: "3.714 ₺"}) */
    t: function (key, params) {
      if (key === null || key === undefined) return "";
      key = String(key);

      var count = params && typeof params.count === "number" && isFinite(params.count)
        ? params.count
        : null;

      var hit = null;
      if (count !== null) hit = fromChain(key + pluralSuffix(current, count));
      if (!hit) hit = fromChain(key);

      if (!hit) {
        reportGap(key, "missing");
        return key;
      }
      if (hit.lang !== current) reportGap(key, "fallback");

      return fill(hit.text, params);
    },

    /* True when the active chain can answer the key. Views use it to decide
       whether an optional ".short" variant exists. */
    has: function (key) {
      if (key === null || key === undefined) return false;
      return fromChain(String(key)) !== null;
    },

    setLang: function (lang) {
      lang = String(lang || "");
      if (!catalog(lang)) return current;

      current = lang;

      try {
        if (global.document && global.document.documentElement) {
          global.document.documentElement.lang = lang;
          var title = fromChain("about.appTitle");
          if (title) global.document.title = title.text;
        }
      } catch (e) { /* no document: nothing to label */ }

      /* Store may not exist yet (load order) or may not have booted. Either way
         the language still applies for this session — silence is correct here. */
      try {
        var store = Moon.Store;
        if (store && typeof store.update === "function" &&
            store.state && store.state.settings &&
            store.state.settings.lang !== lang) {
          store.update(function (draft) {
            draft.settings.lang = lang;
          }, { reason: "settings:lang" });
        }
      } catch (e) { /* a failed write is the Store's story to tell, not ours */ }

      if (Moon.bus) Moon.bus.emit("lang:change", { lang: lang });
      return current;
    },

    /* Keys that could not be answered by the active language so far, in the
       order they were asked for. A development aid, safe to call in production. */
    missingKeys: function () {
      return Object.keys(gaps);
    },

    /* Catalogues actually loaded, active language first. Feeds the TR|EN
       control without hard-coding the list in a view. */
    languages: function () {
      var all = Object.keys(Moon.Lang).filter(function (lang) {
        return ownKeys(Moon.Lang[lang]).length > 0;
      });
      return all.sort(function (a, b) {
        if (a === current) return -1;
        if (b === current) return 1;
        return a < b ? -1 : (a > b ? 1 : 0);
      });
    },

    /* Adding a fourth language is one file plus one call to this. */
    register: function (lang, cat) {
      if (!lang || !cat || typeof cat !== "object") return false;
      Moon.Lang[String(lang)] = cat;
      return true;
    },

    /* Proof that the two catalogues stay in step. Run it in a console (or in
       node) after touching either file:
         Moon.I18n._verify()  ->  {onlyInTr: [], onlyInEn: [], total: N, ...}
       paramMismatch catches the subtler bug: the same key with {amount} on one
       side and {tutar} on the other renders a literal brace on screen. */
    _verify: function () {
      var trKeys = ownKeys(catalog("tr"));
      var enKeys = ownKeys(catalog("en"));

      var inTr = Object.create(null);
      var inEn = Object.create(null);
      trKeys.forEach(function (key) { inTr[key] = true; });
      enKeys.forEach(function (key) { inEn[key] = true; });

      var onlyInTr = trKeys.filter(function (key) { return !inEn[key]; });
      var onlyInEn = enKeys.filter(function (key) { return !inTr[key]; });

      var paramMismatch = [];
      trKeys.forEach(function (key) {
        if (!inEn[key]) return;
        var a = placeholdersOf(catalog("tr")[key]).join(",");
        var b = placeholdersOf(catalog("en")[key]).join(",");
        if (a !== b) paramMismatch.push({ key: key, tr: a, en: b });
      });

      var union = trKeys.slice();
      onlyInEn.forEach(function (key) { union.push(key); });

      return {
        onlyInTr: onlyInTr,
        onlyInEn: onlyInEn,
        total: union.length,
        trTotal: trKeys.length,
        enTotal: enKeys.length,
        paramMismatch: paramMismatch
      };
    }
  };

  /* Read-only property, per the contract: Moon.I18n.lang is a value, not a
     call. If the engine refuses the accessor, keep a plain field in sync. */
  var hasAccessor = false;
  try {
    Object.defineProperty(I18n, "lang", {
      enumerable: true,
      get: function () { return current; }
    });
    hasAccessor = true;
  } catch (e) { /* very old engine: fall back to a plain property */ }

  if (!hasAccessor) {
    I18n.lang = current;
    var plainSetLang = I18n.setLang;
    I18n.setLang = function (lang) {
      var result = plainSetLang(lang);
      I18n.lang = result;
      return result;
    };
  }

  Moon.I18n = I18n;
})(window);
