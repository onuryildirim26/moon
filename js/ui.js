/* Moon — shared UI parts (contract §11).
 *
 * The parts box every view assembles its screen from. Nothing here knows about
 * entries, limits or periods: it takes primitives (a minor amount, an i18n key,
 * a list of column specs) and returns detached DOM. Views own the data, this
 * file owns structure, labels and keyboard behaviour.
 *
 * Three rules shape almost every decision below:
 *   - No innerHTML. Every string reaches the page through textContent, so a CSV
 *     note reading "<img onerror=...>" is inert by construction, not by escaping.
 *   - No user-visible text in code. Everything goes through Moon.I18n.t(key);
 *     the only literals are non-linguistic glyphs († ○ ↧ ×) and those are
 *     aria-hidden with a translated <span class="sr"> beside them.
 *   - One live region in the whole app (#strip). So no role="alert" summaries
 *     and no second aria-live: a field error is announced by moving focus to
 *     the field it is bound to through aria-describedby.
 */
(function (global) {
  "use strict";

  var Moon = global.Moon || {};
  global.Moon = Moon;

  var doc = global.document;
  var util = Moon.util;
  var dom = Moon.dom;

  var STRIP_ID = "strip";
  var UNDO_SECONDS = 8;

  var SYMBOLS = { TRY: "₺", USD: "$", EUR: "€", GBP: "£" };

  /* The three margin marks of the ledger (jury G6). The glyph is decoration;
     the sentence next to it in .sr is the real content. */
  var MARKS = {
    over: { glyph: "†", key: "a11y.markOver" },
    recurring: { glyph: "○", key: "a11y.markRecurring" },
    unconfirmed: { glyph: "↧", key: "a11y.markUnconfirmed" }
  };

  var FOCUSABLE = [
    "a[href]",
    "button:not([disabled])",
    'input:not([disabled]):not([type="hidden"])',
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])'
  ].join(",");

  /* ------------------------------------------------------------- plumbing */

  function noop() {}

  function log(error, where) {
    if (global.console) global.console.error("Moon.UI" + (where ? " " + where : ""), error);
  }

  /* Every callback from a view runs inside this: one broken handler must not
     leave a half-built dialog or a running timer behind. */
  function call(fn, a, b, c) {
    if (typeof fn !== "function") return undefined;
    try {
      return fn(a, b, c);
    } catch (error) {
      log(error, "callback");
      return undefined;
    }
  }

  function t(key, params) {
    var I18n = Moon.I18n;
    if (key === null || key === undefined || key === "") return "";
    if (I18n && typeof I18n.t === "function") {
      try {
        return I18n.t(key, params);
      } catch (error) {
        log(error, "i18n");
      }
    }
    return String(key);
  }

  function lang() {
    var I18n = Moon.I18n;
    if (I18n && I18n.lang) return I18n.lang;
    var attr = doc && doc.documentElement ? doc.documentElement.getAttribute("lang") : null;
    return attr || "tr";
  }

  function localeTag() {
    var code = lang();
    if (code === "tr") return "tr-TR";
    if (code === "en") return "en-US";
    return code;
  }

  /* spec.fooKey wins over spec.foo; a plain spec.foo is a string the caller has
     already translated (or a literal like a person's name). */
  function pick(spec, base, params) {
    if (!spec) return "";
    var keyed = spec[base + "Key"];
    if (keyed) return t(keyed, params || spec.params);
    var plain = spec[base];
    if (typeof plain === "string") return plain;
    if (typeof plain === "number") return String(plain);
    return "";
  }

  function isNode(value) {
    return !!value && typeof value === "object" && typeof value.nodeType === "number";
  }

  /* Accepts a node, an array of nodes, or a plain string, so views can pass
     whichever they already have without wrapping it. */
  function content(value, wrapperClass) {
    if (value === null || value === undefined || value === false) return null;
    if (isNode(value)) return value;
    if (Array.isArray(value)) return dom.frag(value.map(function (one) { return content(one); }));
    return dom.el("p", { "class": wrapperClass || "prose", text: String(value) });
  }

  function addClass(node, name) {
    if (node && name && node.classList) node.classList.add(name);
  }

  function visible(node) {
    if (!node || typeof node.getClientRects !== "function") return false;
    return node.getClientRects().length > 0;
  }

  function focusables(root) {
    if (!root) return [];
    return dom.qsa(FOCUSABLE, root).filter(visible);
  }

  /* Never scroll smoothly: the one orchestrated motion in this app is the dark
     adaptation, and a reader who asked for less motion gets none at all. */
  function reveal(node) {
    if (!node || typeof node.scrollIntoView !== "function") return;
    try {
      node.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch (error) {
      node.scrollIntoView();
    }
  }

  function focusNode(node) {
    if (!node || typeof node.focus !== "function") return false;
    try {
      node.focus();
    } catch (error) {
      return false;
    }
    return doc.activeElement === node;
  }

  /* --------------------------------------------------------------- money */

  function symbolFor(currency) {
    if (!currency) return "";
    var Money = Moon.Money;
    if (Money && typeof Money.symbol === "function") {
      try {
        var found = Money.symbol(currency);
        if (found) return String(found);
      } catch (error) { /* fall through to the local table */ }
    }
    return SYMBOLS[currency] || String(currency);
  }

  function decimalSep() {
    try {
      var sample = new global.Intl.NumberFormat(localeTag(), { minimumFractionDigits: 1 }).format(1.1);
      var found = sample.match(/1(\D)1/);
      if (found) return found[1];
    } catch (error) { /* no Intl: decide from the language below */ }
    return lang() === "en" ? "." : ",";
  }

  function groupSep() {
    return decimalSep() === "," ? "." : ",";
  }

  function group(digits, sep) {
    var out = "";
    var count = 0;
    for (var i = digits.length - 1; i >= 0; i -= 1) {
      out = digits.charAt(i) + out;
      count += 1;
      if (count % 3 === 0 && i > 0) out = sep + out;
    }
    return out;
  }

  function toMinor(value) {
    if (typeof value === "number" && isFinite(value)) return Math.round(value);
    return 0;
  }

  /* Local last resort for parts()/format(): integer division only, never
     parseFloat, so a missing Moon.Money degrades the look, not the numbers. */
  function localParts(minor, opts) {
    var abs = Math.abs(minor);
    var sep = decimalSep();
    return {
      sign: minor < 0 ? "-" : "",
      whole: group(String(Math.floor(abs / 100)), groupSep()),
      sep: sep,
      cents: util.pad2(abs % 100),
      symbol: symbolFor(opts && opts.currency),
      symbolFirst: lang() !== "tr"
    };
  }

  /* Moon.Money falls back to Turkish grouping when no language is given, so a
     caller that omits it would print "1.234,56" inside an English screen. The
     active language is knowable here, so fill it in rather than making every
     view remember. Currency is NOT defaulted: moneyCell prints a symbol only
     when the caller asks for one, and the ledger asks for none. */
  function withLocale(opts) {
    var merged = { lang: lang() };
    if (opts) {
      Object.keys(opts).forEach(function (key) {
        if (opts[key] !== undefined && opts[key] !== null) merged[key] = opts[key];
      });
    }
    return merged;
  }

  function moneyParts(minor, opts) {
    var value = toMinor(minor);
    var local = withLocale(opts);
    var Money = Moon.Money;
    if (Money && typeof Money.parts === "function") {
      try {
        var parts = Money.parts(value, local);
        if (parts && typeof parts.whole === "string") return parts;
      } catch (error) {
        log(error, "Money.parts");
      }
    }
    return localParts(value, local);
  }

  function formatMoney(minor, opts) {
    var value = toMinor(minor);
    var local = withLocale(opts);
    var Money = Moon.Money;
    if (Money && typeof Money.format === "function") {
      try {
        var text = Money.format(value, local);
        if (typeof text === "string" && text) return text;
      } catch (error) {
        log(error, "Money.format");
      }
    }
    var parts = localParts(value, local);
    var body = parts.whole + parts.sep + parts.cents;
    if (!parts.symbol) return parts.sign + body;
    return parts.symbolFirst
      ? parts.sign + parts.symbol + body
      : parts.sign + body + " " + parts.symbol;
  }

  function parseMoney(text) {
    var Money = Moon.Money;
    if (Money && typeof Money.parse === "function") {
      try {
        var result = Money.parse(text, { decimal: "auto" });
        if (result && typeof result.ok === "boolean") return result;
      } catch (error) {
        log(error, "Money.parse");
      }
    }
    return { ok: false, error: "money.invalid" };
  }

  /* Editable form of an amount: no thousands separators, local decimal mark.
     Used after a paste, so "1.234,56 TL" becomes something the field owns. */
  function moneyForInput(minor) {
    var parts = moneyParts(minor, null);
    var digits = String(parts.whole).replace(/\D/g, "") || "0";
    var sign = toMinor(minor) < 0 ? "-" : "";
    if (!parts.cents) return sign + digits;
    return sign + digits + (parts.sep || decimalSep()) + parts.cents;
  }

  /* ---------------------------------------------------------------- dates */

  function formatDate(date, style) {
    var Dates = Moon.Dates;
    if (Dates && typeof Dates.formatDate === "function") {
      try {
        var text = Dates.formatDate(date, lang(), style || "short");
        if (text) return String(text);
      } catch (error) {
        log(error, "Dates.formatDate");
      }
    }
    return date === null || date === undefined ? "" : String(date);
  }

  var CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

  /* Reads a date field back as a civil "YYYY-MM-DD" string whether the browser
     gave us a real date picker or fell back to a text box. */
  function readDateValue(raw) {
    var text = String(raw === null || raw === undefined ? "" : raw).trim();
    if (!text) return "";
    if (CIVIL_DATE.test(text)) return text;
    var Dates = Moon.Dates;
    if (Dates && typeof Dates.parseFlexible === "function") {
      try {
        var parsed = Dates.parseFlexible(text, { order: lang() === "en" ? "mdy" : "dmy" });
        if (parsed && CIVIL_DATE.test(parsed)) return parsed;
      } catch (error) {
        log(error, "Dates.parseFlexible");
      }
    }
    return null;
  }

  var dateSupport = null;

  function supportsDateInput() {
    if (dateSupport !== null) return dateSupport;
    dateSupport = false;
    try {
      var probe = doc.createElement("input");
      probe.setAttribute("type", "date");
      dateSupport = probe.type === "date";
    } catch (error) {
      dateSupport = false;
    }
    return dateSupport;
  }

  /* -------------------------------------------------------------- buttons */

  function button(spec, api) {
    spec = spec || {};
    var classes = ["btn"];
    /* moon.css names a button variant .btn.is-<kind> — is-primary, is-danger,
       is-quiet, is-row. A BEM twin here would make every variant silently fall
       back to the plain frame, so this builder speaks the stylesheet's own
       vocabulary. "ghost" deliberately has no rule: the bare .btn frame IS the
       look a cancel button next to a primary wants. */
    if (spec.kind) classes.push("is-" + spec.kind);
    if (spec["class"]) classes.push(spec["class"]);

    var label = pick(spec, "label");
    var attrs = { "class": classes.join(" ") };
    if (spec.name) attrs.name = spec.name;
    if (spec.title) attrs.title = spec.title;
    if (spec.ariaLabel) attrs["aria-label"] = spec.ariaLabel;

    var node;
    if (spec.href) {
      attrs.href = spec.href;
      node = dom.el("a", attrs, label);
    } else {
      attrs.type = spec.type || "button";
      if (spec.disabled) attrs.disabled = true;
      node = dom.el("button", attrs, label);
    }

    node.addEventListener("click", function (event) {
      if (spec.onClick) call(spec.onClick, event, api);
      if (spec.close && api && typeof api.close === "function") api.close();
    });
    return node;
  }

  function buttonRow(actions, api, className) {
    if (!actions || !actions.length) return null;
    var row = dom.el("div", { "class": className || "actions" });
    actions.forEach(function (spec) {
      if (isNode(spec)) {
        row.appendChild(spec);
        return;
      }
      row.appendChild(button(spec, api));
    });
    return row;
  }

  /* -------------------------------------------------------------- section */

  /* <section id> + <h2> + the 1px rule that runs from the title to the right
     edge, with an optional small summary hanging off that right end. */
  function section(spec) {
    spec = spec || {};
    var id = spec.id || util.id("sec");
    var titleId = id + "-title";

    /* The rule between the title and the aside is .section__head::after in
       moon.css — a pseudo-element, so no filler span belongs here. An empty
       one would still take a flex gap and push the rule off the title. */
    var head = dom.el("div", { "class": "section__head" }, [
      dom.el("h2", { "class": "section__title", id: titleId }, pick(spec, "title"))
    ]);

    var aside = spec.aside !== undefined && spec.aside !== null ? spec.aside : spec.asideKey;
    if (aside) {
      var asideNode = isNode(aside)
        ? aside
        : dom.el("span", {
            "class": "section__aside",
            text: spec.asideKey ? t(spec.asideKey, spec.asideParams) : String(aside)
          });
      addClass(asideNode, "section__aside");
      head.appendChild(asideNode);
    }

    var node = dom.el("section", {
      "class": "section" + (spec["class"] ? " " + spec["class"] : ""),
      id: id,
      "aria-labelledby": titleId
    }, head);

    var body = content(spec.body);
    if (body) {
      var wrap = dom.el("div", { "class": "section__body" }, body);
      node.appendChild(wrap);
    }
    return node;
  }

  /* The hero measurement strip: a plate surface between two 1px rules. Jury G11
     makes the whole strip a CSV target, so it takes an optional onFiles. */
  function hero(spec) {
    spec = spec || {};
    var node = dom.el("div", {
      "class": "hero" + (spec["class"] ? " " + spec["class"] : "")
    }, content(spec.children));
    if (typeof spec.onFiles === "function") dropZone(node, spec.onFiles);
    return node;
  }

  /* ------------------------------------------------------------ moneyCell */

  /* Three spans so the decimal mark lands on the same pixel in every row
     (jury G4). The cents are NOT shrunk — they only take --ink-dim. The sign
     lives in its own span so it can hang outside the digit column. */
  function moneyCell(minor, opts) {
    opts = opts || {};
    var value = toMinor(minor);
    var parts = moneyParts(value, opts);

    /* opts.sign: false hides the sign, true forces "+" on income, omitted shows
       a sign only when the amount is negative. */
    var sign = "";
    if (opts.sign !== false) {
      if (value < 0) sign = "-";
      else if (opts.sign === true && value > 0) sign = "+";
    }

    var symbol = opts.currency ? (parts.symbol || symbolFor(opts.currency)) : "";

    var classes = ["money"];
    if (opts.dim) classes.push("is-dim");
    if (opts.strong) classes.push("is-strong");
    /* English puts the symbol in front of the digits. DOM order alone cannot
       say so: the grid places every part by column, so the layout needs the
       class moon.css keys that column off. */
    if (symbol && parts.symbolFirst) classes.push("is-sym-first");
    if (opts["class"]) classes.push(opts["class"]);

    var cell = dom.el("span", {
      "class": classes.join(" "),
      dataset: { minor: String(value) }
    });

    if (sign) cell.appendChild(dom.el("span", { "class": "m-sign" }, sign));

    if (symbol && parts.symbolFirst) {
      cell.appendChild(dom.el("span", { "class": "m-sym" }, symbol));
    }

    cell.appendChild(dom.el("span", { "class": "m-whole" }, parts.whole));
    /* A zero-decimal currency has no cents: skip both spans rather than print
       a stray separator. */
    if (parts.cents) {
      cell.appendChild(dom.el("span", { "class": "m-sep" }, parts.sep || decimalSep()));
      cell.appendChild(dom.el("span", { "class": "m-cents" }, parts.cents));
    }

    if (symbol && !parts.symbolFirst) {
      cell.appendChild(dom.el("span", { "class": "m-sym" }, symbol));
    }
    return cell;
  }

  /* ----------------------------------------------------------------- mark */

  function mark(kind) {
    var spec = MARKS[kind];
    if (!spec) return null;
    /* .mark.is-over and .mark.is-unconfirmed are what moon.css colours. */
    return dom.el("span", { "class": "mark is-" + kind }, [
      dom.el("span", { "aria-hidden": "true" }, spec.glyph),
      dom.el("span", { "class": "sr" }, t(spec.key))
    ]);
  }

  /* ---------------------------------------------------------------- field */

  function selectOptions(select, options, value, placeholder) {
    if (placeholder !== null && placeholder !== undefined) {
      select.appendChild(dom.el("option", { value: "" }, placeholder));
    }
    (options || []).forEach(function (option) {
      var optValue;
      var optLabel;
      if (option === null || option === undefined) return;
      if (typeof option === "string" || typeof option === "number") {
        optValue = String(option);
        optLabel = optValue;
      } else {
        optValue = option.value === undefined || option.value === null ? "" : String(option.value);
        optLabel = pick(option, "label") || optValue;
      }
      var attrs = { value: optValue };
      if (option && option.disabled) attrs.disabled = true;
      if (String(value === null || value === undefined ? "" : value) === optValue) attrs.selected = true;
      select.appendChild(dom.el("option", attrs, optLabel));
    });
  }

  function buildControl(spec, ids) {
    var type = spec.type || "text";
    var value = spec.value;
    var attrs = {
      id: ids.control,
      name: spec.name || ids.control,
      "class": "field__input"
    };
    if (spec.required) attrs.required = true;
    if (spec.disabled) attrs.disabled = true;
    if (spec.readonly) attrs.readonly = true;
    if (spec.autocomplete) attrs.autocomplete = spec.autocomplete;
    if (spec.autofocus) attrs.dataset = { autofocus: "true" };

    if (type === "select") {
      var select = dom.el("select", attrs);
      var placeholder = spec.placeholderKey ? t(spec.placeholderKey) : (spec.required ? "" : null);
      selectOptions(select, spec.options, value, placeholder);
      return select;
    }

    if (type === "textarea") {
      attrs.rows = spec.rows || 3;
      if (spec.maxLength) attrs.maxlength = String(spec.maxLength);
      var area = dom.el("textarea", attrs);
      area.value = value === null || value === undefined ? "" : String(value);
      return area;
    }

    if (type === "switch") {
      attrs.type = "checkbox";
      attrs["class"] = "field__switch";
      attrs.role = "switch";
      var box = dom.el("input", attrs);
      box.checked = !!value;
      return box;
    }

    if (type === "money") {
      /* Text, not number: "1.234,56" is not a valid number input value and a
         spinner on an amount is noise. inputmode brings up the right keypad. */
      attrs.type = "text";
      attrs.inputmode = "decimal";
      attrs.autocomplete = spec.autocomplete || "off";
      attrs["class"] = "field__input field__input--money tnum";
      var money = dom.el("input", attrs);
      money.value = typeof value === "number"
        ? moneyForInput(value)
        : (value === null || value === undefined ? "" : String(value));
      return money;
    }

    if (type === "date") {
      attrs.type = supportsDateInput() ? "date" : "text";
      attrs["class"] = "field__input field__input--date tnum";
      if (spec.min) attrs.min = spec.min;
      if (spec.max) attrs.max = spec.max;
      var date = dom.el("input", attrs);
      /* Always a civil string in, always a civil string out. */
      date.value = readDateValue(value) || "";
      return date;
    }

    if (type === "number") {
      attrs.type = "number";
      attrs.inputmode = "numeric";
      attrs["class"] = "field__input tnum";
      if (spec.min !== undefined) attrs.min = String(spec.min);
      if (spec.max !== undefined) attrs.max = String(spec.max);
      if (spec.step !== undefined) attrs.step = String(spec.step);
      var number = dom.el("input", attrs);
      number.value = value === null || value === undefined ? "" : String(value);
      return number;
    }

    attrs.type = type === "search" ? "search" : "text";
    if (spec.maxLength) attrs.maxlength = String(spec.maxLength);
    var input = dom.el("input", attrs);
    input.value = value === null || value === undefined ? "" : String(value);
    return input;
  }

  function readControl(entry) {
    var control = entry.control;
    if (!control) return null;
    switch (entry.type) {
      case "switch":
        return !!control.checked;
      case "money": {
        var parsed = parseMoney(control.value);
        return parsed.ok ? parsed.minor : null;
      }
      case "number": {
        var raw = String(control.value || "").trim();
        if (!raw) return null;
        /* Integers only in this app (day of month, count of days), so a digit
           scan is enough and parseFloat stays out of the codebase. */
        var sign = raw.charAt(0) === "-" ? -1 : 1;
        var digits = raw.replace(/\D/g, "");
        if (!digits) return null;
        return sign * global.parseInt(digits, 10);
      }
      case "date":
        return readDateValue(control.value);
      default:
        return String(control.value === undefined ? "" : control.value);
    }
  }

  /* One field: label above, control, hint, then the error message BELOW the
     control and wired to it with aria-describedby + aria-invalid. */
  function field(spec) {
    spec = spec || {};
    var type = spec.type || "text";
    var base = util.id("f");
    var ids = { control: base, hint: base + "-hint", error: base + "-err", read: base + "-read" };

    var control = buildControl(spec, ids);
    var label = dom.el("label", { "class": "field__label", "for": ids.control }, [
      pick(spec, "label"),
      spec.required ? dom.el("span", { "class": "field__req", "aria-hidden": "true" }, "*") : null
    ]);

    var described = [];
    var hint = null;
    var hintText = pick(spec, "hint");
    if (!hintText && type === "date" && !supportsDateInput()) hintText = t("form.dateHint");
    if (hintText) {
      hint = dom.el("p", { "class": "field__hint", id: ids.hint, text: hintText });
      described.push(ids.hint);
    }

    /* The amount readout: the reader must see how their typing was understood
       before they save. Not a live region — it is read out on focus instead. */
    var readout = null;
    if (type === "money") {
      readout = dom.el("p", { "class": "field__read tnum", id: ids.read });
      described.push(ids.read);
    }

    var error = dom.el("p", { "class": "field__error", id: ids.error, hidden: true });

    var node = dom.el("div", {
      "class": "field field--" + type + (spec["class"] ? " " + spec["class"] : ""),
      dataset: { field: spec.name || ids.control, type: type }
    }, [label, control, hint, readout, error]);

    var entry = {
      name: spec.name || ids.control,
      type: type,
      element: node,
      control: control,
      errorKey: null,
      touched: false
    };

    function describe() {
      var list = described.slice();
      if (entry.errorKey) list.push(ids.error);
      if (list.length) control.setAttribute("aria-describedby", list.join(" "));
      else control.removeAttribute("aria-describedby");
    }

    entry.setError = function (key) {
      entry.errorKey = key || null;
      if (entry.errorKey) {
        error.textContent = t(entry.errorKey);
        error.hidden = false;
        control.setAttribute("aria-invalid", "true");
        addClass(node, "is-invalid");
      } else {
        error.textContent = "";
        error.hidden = true;
        control.removeAttribute("aria-invalid");
        if (node.classList) node.classList.remove("is-invalid");
      }
      describe();
    };

    entry.read = function () {
      return readControl(entry);
    };

    entry.focus = function () {
      reveal(node);
      return focusNode(control);
    };

    describe();
    if (spec.errorKey) entry.setError(spec.errorKey);

    if (type === "money") {
      var showRead = function () {
        var raw = String(control.value || "").trim();
        if (!raw) {
          readout.textContent = "";
          control.removeAttribute("data-minor");
          return;
        }
        var parsed = parseMoney(raw);
        if (parsed.ok) {
          readout.textContent = formatMoney(parsed.minor, {
            currency: spec.currency,
            lang: lang(),
            symbol: true
          });
          control.setAttribute("data-minor", String(parsed.minor));
        } else {
          readout.textContent = "";
          control.removeAttribute("data-minor");
        }
      };

      control.addEventListener("input", function () {
        showRead();
        /* Validation happens on submit, not while typing. Once a field has
           been marked though, clearing the error as soon as it parses is kind. */
        if (entry.errorKey && parseMoney(control.value).ok) entry.setError(null);
      });

      control.addEventListener("paste", function (event) {
        var data = event.clipboardData || global.clipboardData;
        if (!data || typeof data.getData !== "function") return;
        var text = data.getData("text");
        if (!text) return;
        var parsed = parseMoney(text);
        if (!parsed.ok) return;
        /* "1.234,56 TL" pasted from a bank page becomes plain "1234,56". */
        event.preventDefault();
        control.value = moneyForInput(parsed.minor);
        showRead();
      });

      control.addEventListener("blur", function () {
        entry.touched = true;
        var raw = String(control.value || "").trim();
        if (!raw) return;
        var parsed = parseMoney(raw);
        if (parsed.ok) control.value = moneyForInput(parsed.minor);
        showRead();
        if (!parsed.ok && entry.errorKey) entry.setError(parsed.error || "money.invalid");
      });

      showRead();
    }

    if (type === "date" && !supportsDateInput()) {
      control.addEventListener("blur", function () {
        var civil = readDateValue(control.value);
        if (civil) control.value = civil;
      });
    }

    if (typeof spec.onChange === "function") {
      control.addEventListener("change", function (event) {
        call(spec.onChange, entry.read(), event, entry);
      });
    }
    if (typeof spec.onInput === "function") {
      control.addEventListener("input", function (event) {
        call(spec.onInput, entry.read(), event, entry);
      });
    }

    /* How form() (and any view holding the element) talks to this field. */
    node.moonField = entry;
    return node;
  }

  /* ----------------------------------------------------------------- form */

  function form(spec) {
    spec = spec || {};
    var entries = [];
    var byName = Object.create(null);

    var body = dom.el("div", { "class": "form__fields" });

    (spec.fields || []).forEach(function (item) {
      if (!item) return;
      var element = isNode(item) ? item : field(item);
      body.appendChild(element);
      var entry = element.moonField;
      if (entry) {
        entries.push(entry);
        byName[entry.name] = entry;
      }
    });

    var element = dom.el("form", {
      "class": "form" + (spec["class"] ? " " + spec["class"] : ""),
      /* Our messages, our wording, our placement: the browser's bubbles would
         be untranslated and would fight the error line under the field. */
      novalidate: true,
      id: spec.id || util.id("form")
    }, body);

    var api = {
      element: element,
      fields: byName,

      values: function () {
        var out = {};
        entries.forEach(function (entry) {
          out[entry.name] = entry.read();
        });
        return out;
      },

      /* Intrinsic errors the fields already know about (an amount that does not
         parse, a date the fallback text box could not read) — useful before
         handing values to a Model validator. */
      fieldErrors: function () {
        var out = {};
        entries.forEach(function (entry) {
          if (entry.type === "money") {
            var raw = String(entry.control.value || "").trim();
            if (raw && !parseMoney(raw).ok) out[entry.name] = "money.invalid";
          }
          if (entry.type === "date") {
            var text = String(entry.control.value || "").trim();
            if (text && entry.read() === null) out[entry.name] = "err.badDate";
          }
        });
        return out;
      },

      setErrors: function (map) {
        var errors = map || {};
        entries.forEach(function (entry) {
          var key = Object.prototype.hasOwnProperty.call(errors, entry.name) ? errors[entry.name] : null;
          entry.setError(key);
        });
        return api;
      },

      focusFirstError: function () {
        for (var i = 0; i < entries.length; i += 1) {
          if (entries[i].errorKey) return entries[i].focus();
        }
        return false;
      },

      focusFirst: function () {
        for (var i = 0; i < entries.length; i += 1) {
          if (!entries[i].control.disabled) return entries[i].focus();
        }
        return false;
      },

      reset: function (values) {
        api.setErrors(null);
        if (!values) {
          element.reset();
          return api;
        }
        entries.forEach(function (entry) {
          if (!Object.prototype.hasOwnProperty.call(values, entry.name)) return;
          var next = values[entry.name];
          if (entry.type === "switch") entry.control.checked = !!next;
          else if (entry.type === "money") entry.control.value = typeof next === "number" ? moneyForInput(next) : String(next || "");
          else if (entry.type === "date") entry.control.value = readDateValue(next) || "";
          else entry.control.value = next === null || next === undefined ? "" : String(next);
        });
        return api;
      }
    };

    var actions = spec.actions ? spec.actions.slice() : [];
    if (!actions.length) {
      if (spec.submitKey) actions.push({ labelKey: spec.submitKey, kind: "primary", type: "submit" });
      if (spec.cancelKey) {
        actions.push({
          labelKey: spec.cancelKey,
          kind: "ghost",
          onClick: function (event) { call(spec.onCancel, event, api); }
        });
      }
    }
    var row = buttonRow(actions, api, "form__actions");
    if (row) element.appendChild(row);

    /* Enter inside any field submits, because a real submit button exists. */
    element.addEventListener("submit", function (event) {
      event.preventDefault();
      call(spec.onSubmit, api.values(), api, event);
    });

    element.moonForm = api;
    return api;
  }

  /* --------------------------------------------------------------- dialog */

  /* Only used to build a selector, so anything exotic is simply not trusted. */
  var SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/;

  /* Contract §11 hands focus back to the element that opened a dialog. Holding
     a reference to that element is not enough: saving or deleting a record
     re-renders the whole view, so by the time the dialog closes the opener has
     been replaced by an equal-looking node (an edit) or is gone for good (a
     delete). Remember three ways to find where the reader was — the id, the
     data-id the ledger stamps on a row, and the row's place in the list. */
  function openerMemo() {
    var node = doc.activeElement;
    if (!node || node === doc.body || node === doc.documentElement) return null;

    var memo = { node: node, selector: null, rowIndex: -1 };
    if (node.id && SAFE_TOKEN.test(node.id)) memo.selector = "#" + node.id;
    var dataId = typeof node.getAttribute === "function" ? node.getAttribute("data-id") : null;
    if (!memo.selector && dataId && SAFE_TOKEN.test(dataId)) {
      memo.selector = '[data-id="' + dataId + '"]';
    }
    var row = typeof node.closest === "function" ? node.closest("[data-row]") : null;
    if (row) memo.rowIndex = dom.qsa("[data-row]").indexOf(row);
    return memo;
  }

  /* "exact" when the reader is back where they were, "fallback" when only the
     content root was left to put them on, false when nothing took focus. */
  function restoreFocus(memo, spec) {
    /* A view that knows better says so: a node, or true to take over. */
    if (spec && typeof spec.restoreFocus === "function") {
      var asked = call(spec.restoreFocus);
      if (asked === true) return "exact";
      if (isNode(asked) && focusNode(asked)) return "exact";
    }
    if (memo) {
      if (memo.node && doc.contains(memo.node) && focusNode(memo.node)) return "exact";
      if (memo.selector) {
        var again = dom.qs(memo.selector);
        if (again && focusNode(again)) return "exact";
      }
      /* The row was deleted. Its neighbour is where the reader was looking,
         and the undo offer is one Tab away from there. */
      if (memo.rowIndex >= 0) {
        var rows = dom.qsa("[data-row]");
        if (rows.length && focusNode(rows[util.clamp(memo.rowIndex, 0, rows.length - 1)])) return "exact";
      }
    }
    /* Last resort: the top of the content. Never <body>. */
    var main = doc.getElementById("view");
    return main && focusNode(main) ? "fallback" : false;
  }

  /* How long after a dialog closes a re-render still counts as that dialog's
     doing. The router redraws on the next frame, well inside this. */
  var FOCUS_SETTLE_MS = 1000;

  /* The restore above runs while the view is still the old one. Saving or
     deleting then redraws #view a frame later and drops focus on <body>, so
     the restore has to be repeated once the new DOM is in place — and only
     while focus is still loose, never over a view that placed it itself. */
  function settleFocus(memo, spec) {
    var placed = restoreFocus(memo, spec);
    if (typeof global.setTimeout !== "function") return placed;

    var host = doc.getElementById("view");
    var Observer = global.MutationObserver;

    function attempt() {
      var at = doc.activeElement;
      var loose = !at || at === doc.body || at === doc.documentElement ||
        (placed === "fallback" && at === host);
      if (loose) placed = restoreFocus(memo, spec);
    }

    global.setTimeout(attempt, 0);
    if (!host || typeof Observer !== "function") return placed;

    var observer = new Observer(attempt);
    observer.observe(host, { childList: true, subtree: true });
    global.setTimeout(function () { observer.disconnect(); }, FOCUS_SETTLE_MS);
    return placed;
  }

  function dialog(spec) {
    spec = spec || {};
    var native = typeof global.HTMLDialogElement === "function" &&
      typeof global.HTMLDialogElement.prototype.showModal === "function";

    var titleId = util.id("dlg") + "-title";
    var element = dom.el(native ? "dialog" : "div", {
      "class": "dialog" + (spec["class"] ? " " + spec["class"] : ""),
      "aria-labelledby": titleId
    });
    if (!native) {
      /* Old Safari: hand-rolled modal with the same contract. */
      element.setAttribute("role", "dialog");
      element.setAttribute("aria-modal", "true");
      element.hidden = true;
    }

    var closeButton = dom.el("button", {
      "class": "dialog__close",
      type: "button",
      "aria-label": t("common.close")
    }, dom.el("span", { "aria-hidden": "true" }, "×"));

    var head = dom.el("div", { "class": "dialog__head" }, [
      dom.el("h2", { "class": "dialog__title", id: titleId }, pick(spec, "title")),
      closeButton
    ]);

    var bodyNode = dom.el("div", { "class": "dialog__body" }, content(spec.body));
    element.appendChild(head);
    element.appendChild(bodyNode);

    var api = {
      element: element,
      body: bodyNode,
      isOpen: function () { return opened; }
    };

    var actionRow = buttonRow(spec.actions, api, "dialog__actions");
    if (actionRow) element.appendChild(actionRow);

    var opened = false;
    var opener = null;
    var trapHandler = null;

    function firstTarget() {
      var flagged = dom.qs("[data-autofocus]", bodyNode);
      if (flagged && visible(flagged)) return flagged;
      var inBody = focusables(bodyNode);
      if (inBody.length) return inBody[0];
      var anywhere = focusables(element);
      return anywhere.length ? anywhere[0] : closeButton;
    }

    /* Native <dialog> traps focus for free. This is the fallback path only. */
    function trap(event) {
      if (event.key !== "Tab") return;
      var list = focusables(element);
      if (!list.length) return;
      var first = list[0];
      var last = list[list.length - 1];
      if (event.shiftKey && doc.activeElement === first) {
        event.preventDefault();
        focusNode(last);
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault();
        focusNode(first);
      }
    }

    function onFallbackKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        api.close();
        return;
      }
      trap(event);
    }

    api.open = function () {
      if (opened) return api;
      opener = openerMemo();
      if (!element.parentNode) doc.body.appendChild(element);
      opened = true;

      if (native) {
        try {
          element.showModal();
        } catch (error) {
          log(error, "showModal");
        }
      } else {
        element.hidden = false;
        addClass(doc.documentElement, "is-modal");
        trapHandler = onFallbackKey;
        doc.addEventListener("keydown", trapHandler, true);
      }
      focusNode(firstTarget());
      return api;
    };

    function finish() {
      if (!opened) return;
      opened = false;
      if (trapHandler) {
        doc.removeEventListener("keydown", trapHandler, true);
        trapHandler = null;
      }
      if (!native) {
        element.hidden = true;
        if (doc.documentElement.classList) doc.documentElement.classList.remove("is-modal");
      }
      if (spec.keep !== true && element.parentNode) element.parentNode.removeChild(element);

      /* Focus goes back to whatever opened the dialog. Without this, keyboard
         readers land at the top of the document after every save. */
      var memo = opener;
      opener = null;
      settleFocus(memo, spec);
      call(spec.onClose);
    }

    api.close = function () {
      if (!opened) return api;
      if (native && element.open) {
        element.close(); /* the close event below runs finish() */
        return api;
      }
      finish();
      return api;
    };

    if (native) {
      /* Esc fires cancel then close; both land here. */
      element.addEventListener("close", finish);
      element.addEventListener("cancel", function (event) {
        event.preventDefault();
        if (element.open) element.close();
      });
    }

    closeButton.addEventListener("click", function () {
      api.close();
    });

    /* A click on the backdrop does NOT close: a half-typed entry must not
       vanish because the pointer slipped. The close button is right there. */

    return api;
  }

  function confirmDialog(spec) {
    spec = spec || {};
    return new global.Promise(function (resolve) {
      var settled = false;
      var answer = false;

      function settle(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }

      var box = dialog({
        "class": "dialog--confirm" + (spec.danger ? " dialog--danger" : ""),
        titleKey: spec.titleKey,
        title: spec.title,
        body: spec.body ? spec.body : dom.el("p", { "class": "prose", text: pick(spec, "body") }),
        actions: [
          {
            labelKey: spec.cancelKey || "common.cancel",
            kind: "ghost",
            onClick: function () { answer = false; },
            close: true
          },
          {
            labelKey: spec.confirmKey || "common.confirm",
            kind: spec.danger ? "danger" : "primary",
            onClick: function () { answer = true; },
            close: true
          }
        ],
        onClose: function () {
          /* Esc, the close button and the cancel button all mean "no". */
          settle(answer);
        }
      });
      box.open();
    });
  }

  /* ------------------------------------------------------------ undoStrip */

  var strip = { node: null, timer: null };

  function stripHost() {
    return doc.getElementById(STRIP_ID);
  }

  function clearStrip() {
    if (strip.timer) {
      global.clearInterval(strip.timer);
      strip.timer = null;
    }
    if (strip.node && strip.node.parentNode) strip.node.parentNode.removeChild(strip.node);
    strip.node = null;
  }

  /* Lives under the list inside #strip — the one live region in the app. No
     toast flies out of a corner (jury G12). The remaining time is visible and
     updated once per second; it is aria-hidden so the countdown does not
     re-announce the sentence eight times. */
  function undoStrip(spec) {
    spec = spec || {};
    /* A second strip replaces the first at once: two undo offers stacked on
       top of each other is an unreadable pair of promises. */
    clearStrip();

    var host = stripHost();
    if (!host) return;

    var total = util.clamp(global.parseInt(spec.seconds, 10) || UNDO_SECONDS, 3, 60);
    var left = total;

    var count = dom.el("span", {
      "class": "undo__count tnum",
      "aria-hidden": "true",
      text: t("common.undoSeconds", { seconds: left })
    });
    var bar = dom.el("span", {
      "class": "undo__bar",
      "aria-hidden": "true",
      style: { width: "100%" }
    });

    var undoButton = button({
      labelKey: spec.undoKey || "common.undo",
      kind: "ghost",
      "class": "undo__action",
      onClick: function () {
        var handler = spec.onUndo;
        clearStrip();
        call(handler);
      }
    });

    var dismiss = button({
      labelKey: spec.dismissKey || "common.close",
      kind: "quiet",
      "class": "undo__dismiss",
      onClick: function () {
        clearStrip();
        call(spec.onExpire);
      }
    });

    var node = dom.el("div", { "class": "undo", dataset: { seconds: String(total) } }, [
      dom.el("p", { "class": "undo__text", text: pick(spec, "message") }),
      undoButton,
      count,
      dismiss,
      bar
    ]);

    /* Append rather than clear: app.js may keep a standing write-error band in
       the same region, and an undo offer must not wipe it. */
    host.appendChild(node);
    strip.node = node;

    strip.timer = global.setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearStrip();
        call(spec.onExpire);
        return;
      }
      count.textContent = t("common.undoSeconds", { seconds: left });
      bar.style.width = (left / total) * 100 + "%";
    }, 1000);
  }

  /* Anyone may ask for an undo offer without reaching for Moon.UI (contract §3). */
  if (Moon.bus && typeof Moon.bus.on === "function") {
    Moon.bus.on("toast:undo", function (payload) {
      if (!payload) return;
      undoStrip({
        messageKey: payload.messageKey,
        params: payload.params,
        onUndo: payload.onUndo,
        seconds: payload.seconds
      });
    });
  }

  /* --------------------------------------------------------------- notice */

  /* An inline band at the top of a section: 1px border, faint plate, no icon.
     The "sample" kind is the standing reminder that sample data is on, so it
     cannot be dismissed. */
  function notice(spec) {
    spec = spec || {};
    var kind = spec.kind === "warn" || spec.kind === "error" || spec.kind === "sample" ? spec.kind : "info";

    /* .notice.is-<kind> is the hook moon.css colours the left rule with. */
    var node = dom.el("div", {
      "class": "notice is-" + kind + (spec["class"] ? " " + spec["class"] : ""),
      dataset: { kind: kind }
    });

    var text = pick(spec, "message");
    if (text) node.appendChild(dom.el("p", { "class": "notice__text", text: text }));
    var extra = content(spec.body, "notice__prose");
    if (extra) node.appendChild(extra);

    var api = {
      element: node,
      close: function () {
        if (node.parentNode) node.parentNode.removeChild(node);
        call(spec.onDismiss);
      }
    };

    var row = buttonRow(spec.actions, api, "notice__actions");
    if (row) node.appendChild(row);

    if (spec.dismissible && kind !== "sample") {
      node.appendChild(button({
        labelKey: spec.dismissKey || "common.close",
        kind: "quiet",
        "class": "notice__close",
        onClick: api.close
      }, api));
    }

    node.moonNotice = api;
    return node;
  }

  /* ----------------------------------------------------------- emptyState */

  /* The ghost of an empty ledger page, printed before any data exists
     (jury G9): the column heading rule and three empty row rules, nothing in
     them. Decorative, so the whole block is hidden from assistive tech. */
  function ghost(rows, columns) {
    var block = dom.el("div", { "class": "empty__ghost", "aria-hidden": "true" });
    var count = Math.max(1, columns || 3);

    /* The column count is data, so the grid that draws the hairlines between
       the columns has to be told it. A custom property is the only channel a
       stylesheet can read a number through. */
    if (block.style && typeof block.style.setProperty === "function") {
      block.style.setProperty("--ghost-cols", String(count));
    }

    function cells() {
      var out = [];
      for (var c = 0; c < count; c += 1) {
        out.push(dom.el("span", { "class": "ghost__cell" }));
      }
      return out;
    }

    block.appendChild(dom.el("div", { "class": "ghost__head" }, cells()));
    var total = Math.max(1, rows || 3);
    for (var r = 0; r < total; r += 1) {
      block.appendChild(dom.el("div", { "class": "ghost__row" }, cells()));
    }
    return block;
  }

  function emptyState(spec) {
    spec = spec || {};
    var node = dom.el("div", {
      "class": "empty" + (spec.ghost ? " empty--ghost" : "") + (spec["class"] ? " " + spec["class"] : "")
    });

    if (spec.ghost) {
      node.appendChild(ghost(spec.ghost === true ? 3 : spec.ghost, spec.columns));
    }

    var copy = dom.el("div", { "class": "empty__copy" });
    var level = spec.headingLevel || "h3";
    var heading = pick(spec, "heading");
    if (heading) copy.appendChild(dom.el(level, { "class": "empty__heading", text: heading }));
    var bodyText = pick(spec, "body");
    if (bodyText) copy.appendChild(dom.el("p", { "class": "empty__body prose", text: bodyText }));

    /* Actions are a stacked list of full-width rows, not a row of buttons: the
       empty state is the first page of the notebook, and these are its lines. */
    if (spec.actions && spec.actions.length) {
      var list = dom.el("ul", { "class": "empty__actions" });
      spec.actions.forEach(function (action) {
        if (!action) return;
        var item = dom.el("li", { "class": "empty__item" });
        if (isNode(action)) {
          item.appendChild(action);
          list.appendChild(item);
          return;
        }
        var inner = [dom.el("span", { "class": "empty__action-label", text: pick(action, "label") })];
        var hintText = pick(action, "hint");
        if (hintText) inner.push(dom.el("span", { "class": "empty__action-hint", text: hintText }));

        /* A full-width row, not a button in a row of buttons: .btn.is-row is
           the rule moon.css already carries for exactly this shape, so the
           control wears it rather than arriving unstyled. */
        var attrs = { "class": "btn is-row empty__action" };
        var control;
        if (action.href) {
          attrs.href = action.href;
          control = dom.el("a", attrs, inner);
        } else {
          attrs.type = "button";
          control = dom.el("button", attrs, inner);
        }
        control.addEventListener("click", function (event) {
          call(action.onClick, event);
        });
        item.appendChild(control);
        list.appendChild(item);
      });
      copy.appendChild(list);
    }

    var footText = pick(spec, "foot");
    if (footText) copy.appendChild(dom.el("p", { "class": "empty__foot", text: footText }));

    node.appendChild(copy);
    return node;
  }

  /* ------------------------------------------------------------ dataTable */

  var printBound = false;

  /* Every chart carries the same numbers as a real table. Printing must show
     them, and CSS alone cannot open a <details>. */
  function bindPrint() {
    if (printBound || !global.addEventListener) return;
    printBound = true;
    global.addEventListener("beforeprint", function () {
      dom.qsa("details.datatable").forEach(function (node) {
        if (!node.open) {
          node.dataset.reclose = "1";
          node.open = true;
        }
      });
    });
    global.addEventListener("afterprint", function () {
      dom.qsa("details.datatable").forEach(function (node) {
        if (node.dataset.reclose === "1") {
          node.open = false;
          delete node.dataset.reclose;
        }
      });
    });
  }

  function cellValue(row, column, index) {
    if (Array.isArray(row)) return row[index];
    if (!row || typeof row !== "object") return row;
    return row[column.key !== undefined ? column.key : index];
  }

  function cellText(value, column, opts) {
    var type = column.type || "text";
    if (value === null || value === undefined || value === "") return "";
    if (type === "money") {
      return formatMoney(value, {
        currency: opts.currency,
        lang: lang(),
        symbol: opts.symbol !== false
      });
    }
    if (type === "date") return formatDate(value, opts.dateStyle);
    if (type === "percent") return String(value);
    return String(value);
  }

  function dataTable(columns, rows, opts) {
    opts = opts || {};
    bindPrint();
    var cols = (columns || []).filter(Boolean);
    var list = rows || [];

    /* .numbers and .table are the names moon.css styles a "show the numbers"
       block with; .datatable* stays as the structural hook bindPrint() and the
       views query by. */
    var details = dom.el("details", { "class": "datatable numbers" });
    if (opts.open) details.open = true;

    var summaryText = pick(opts, "summary") || t("common.showNumbers");
    details.appendChild(dom.el("summary", { "class": "datatable__summary" }, summaryText));

    if (!cols.length || !list.length) {
      details.appendChild(dom.el("p", {
        "class": "datatable__empty prose",
        text: t(opts.emptyKey || "common.noNumbers")
      }));
      return details;
    }

    var headRow = dom.el("tr");
    cols.forEach(function (column) {
      var type = column.type || "text";
      headRow.appendChild(dom.el("th", {
        scope: "col",
        "class": "datatable__th" + (type === "money" || type === "number" || type === "percent" ? " is-num" : ""),
        text: pick(column, "label")
      }));
    });

    var body = dom.el("tbody");
    list.forEach(function (row) {
      var tr = dom.el("tr");
      cols.forEach(function (column, index) {
        var value = cellValue(row, column, index);
        var type = column.type || "text";
        var numeric = type === "money" || type === "number" || type === "percent";
        var attrs = {
          "class": "datatable__td" + (numeric ? " is-num tnum" : ""),
          text: cellText(value, column, opts)
        };
        /* Raw minor stays in the DOM; the text is produced on every draw, so a
           language switch never leaves a stale number behind. */
        if (type === "money" && typeof value === "number") attrs.dataset = { minor: String(value) };
        if (index === 0 && opts.rowHeader !== false) {
          attrs.scope = "row";
          tr.appendChild(dom.el("th", attrs));
        } else {
          tr.appendChild(dom.el("td", attrs));
        }
      });
      body.appendChild(tr);
    });

    var table = dom.el("table", { "class": "datatable__table table" });
    var captionText = pick(opts, "caption");
    if (captionText) table.appendChild(dom.el("caption", { "class": "datatable__caption" }, captionText));
    table.appendChild(dom.el("thead", null, headRow));
    table.appendChild(body);
    details.appendChild(table);
    return details;
  }

  /* -------------------------------------------------------------- dropZone */

  var pageDragGuarded = false;

  function hasFiles(event) {
    var data = event.dataTransfer;
    if (!data) return false;
    var types = data.types;
    if (!types) return false;
    if (typeof types.contains === "function") return types.contains("Files");
    return Array.prototype.indexOf.call(types, "Files") !== -1;
  }

  /* Without this the browser navigates away to the dropped CSV and the session
     (and any unsaved form) is gone. */
  function guardPageDrag() {
    if (pageDragGuarded || !doc.addEventListener) return;
    pageDragGuarded = true;
    var stop = function (event) {
      if (hasFiles(event)) event.preventDefault();
    };
    doc.addEventListener("dragover", stop, false);
    doc.addEventListener("drop", stop, false);
  }

  function dropZone(element, onFiles) {
    if (!element || typeof element.addEventListener !== "function") return noop;
    guardPageDrag();

    /* dragenter on a child fires before dragleave on the parent, so a plain
       boolean flickers over nested markup. Count instead. */
    var depth = 0;

    function paint() {
      if (element.classList) element.classList.add("is-dropping");
    }
    function unpaint() {
      depth = 0;
      if (element.classList) element.classList.remove("is-dropping");
    }

    function onEnter(event) {
      if (!hasFiles(event)) return;
      depth += 1;
      paint();
    }
    function onOver(event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        try {
          event.dataTransfer.dropEffect = "copy";
        } catch (error) { /* some browsers make dropEffect read-only here */ }
      }
      paint();
    }
    function onLeave(event) {
      if (!hasFiles(event)) return;
      depth -= 1;
      if (depth <= 0) unpaint();
    }
    function onDrop(event) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      unpaint();
      var files = event.dataTransfer && event.dataTransfer.files
        ? Array.prototype.slice.call(event.dataTransfer.files)
        : [];
      if (files.length) call(onFiles, files, event);
    }

    element.addEventListener("dragenter", onEnter, false);
    element.addEventListener("dragover", onOver, false);
    element.addEventListener("dragleave", onLeave, false);
    element.addEventListener("drop", onDrop, false);

    return function teardown() {
      element.removeEventListener("dragenter", onEnter, false);
      element.removeEventListener("dragover", onOver, false);
      element.removeEventListener("dragleave", onLeave, false);
      element.removeEventListener("drop", onDrop, false);
      unpaint();
    };
  }

  /* ------------------------------------------------------------ rovingList */

  /* One row in the tab order, arrows move between rows. The list keeps working
     after a re-render because rows are read from the DOM on every keystroke. */
  function rovingList(container, opts) {
    opts = opts || {};
    var api = { refresh: noop, destroy: noop, index: function () { return 0; } };
    if (!container || typeof container.addEventListener !== "function") return api;

    var selector = opts.selector || "[data-row]";
    var active = global.parseInt(opts.start, 10) || 0;

    function rows() {
      return dom.qsa(selector, container);
    }

    function sync(list) {
      var items = list || rows();
      if (!items.length) return items;
      active = util.clamp(active, 0, items.length - 1);
      items.forEach(function (row, index) {
        row.setAttribute("tabindex", index === active ? "0" : "-1");
      });
      return items;
    }

    function goTo(items, index, event) {
      if (!items.length) return;
      var next = index;
      if (next < 0) next = opts.wrap ? items.length - 1 : 0;
      if (next > items.length - 1) next = opts.wrap ? 0 : items.length - 1;
      active = next;
      sync(items);
      if (event) event.preventDefault();
      reveal(items[active]);
      focusNode(items[active]);
      call(opts.onFocus, active, items[active]);
    }

    function rowOf(target) {
      if (!target || typeof target.closest !== "function") return null;
      var row = target.closest(selector);
      return row && container.contains(row) ? row : null;
    }

    function onKeyDown(event) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      var row = rowOf(event.target);
      if (!row) return;
      /* A control inside the row (a delete button, a select) owns its own keys. */
      if (event.target !== row) return;

      var items = rows();
      var index = items.indexOf(row);
      if (index === -1) return;
      active = index;

      switch (event.key) {
        case "ArrowDown":
          goTo(items, index + 1, event);
          break;
        case "ArrowUp":
          goTo(items, index - 1, event);
          break;
        case "Home":
          goTo(items, 0, event);
          break;
        case "End":
          goTo(items, items.length - 1, event);
          break;
        case "Enter":
          if (opts.onActivate) {
            event.preventDefault();
            call(opts.onActivate, index, row);
          }
          break;
        case "Delete":
          if (opts.onDelete) {
            event.preventDefault();
            call(opts.onDelete, index, row);
          }
          break;
        default:
          break;
      }
    }

    /* A pointer click moves the tab stop too, so Tab out and back returns to
       the row the reader was last looking at. */
    function onFocusIn(event) {
      var row = rowOf(event.target);
      if (!row) return;
      var items = rows();
      var index = items.indexOf(row);
      if (index === -1) return;
      active = index;
      sync(items);
    }

    container.addEventListener("keydown", onKeyDown, false);
    container.addEventListener("focusin", onFocusIn, false);

    api.refresh = function (index) {
      if (index !== undefined && index !== null) active = global.parseInt(index, 10) || 0;
      sync(null);
      return api;
    };
    api.focus = function (index) {
      goTo(rows(), index === undefined || index === null ? active : index, null);
      return api;
    };
    api.index = function () {
      return active;
    };
    api.destroy = function () {
      container.removeEventListener("keydown", onKeyDown, false);
      container.removeEventListener("focusin", onFocusIn, false);
    };

    sync(null);
    return api;
  }

  /* -------------------------------------------------------------- selftest */

  /* Console-only: Moon.UI._selftest(). Never called in production.
   *
   * It checks one thing above all: that the class names this file writes are
   * the class names moon.css styles. A BEM twin (btn--danger beside
   * .btn.is-danger) costs nothing at load time and silently strips a
   * destructive button of its colour, so the vocabulary is pinned here rather
   * than left to the eye. Needs no layout — only the attributes dom.el sets. */
  function selftest() {
    var failed = [];
    var passed = 0;

    function check(name, condition) {
      if (condition) passed += 1;
      else failed.push(name);
    }

    function cls(node) {
      if (!node || typeof node.getAttribute !== "function") return "";
      return node.getAttribute("class") || "";
    }

    function kids(node) {
      return node && node.children ? Array.prototype.slice.call(node.children) : [];
    }

    function deep(node, name, out) {
      out = out || [];
      kids(node).forEach(function (child) {
        if ((" " + cls(child) + " ").indexOf(" " + name + " ") !== -1) out.push(child);
        deep(child, name, out);
      });
      return out;
    }

    /* --- buttons: moon.css knows .btn.is-<kind>, nothing else ----------- */
    check("button primary", cls(button({ kind: "primary", label: "x" })) === "btn is-primary");
    check("button danger", cls(button({ kind: "danger", label: "x" })) === "btn is-danger");
    check("button quiet", cls(button({ kind: "quiet", label: "x" })) === "btn is-quiet");
    check("button plain", cls(button({ label: "x" })) === "btn");
    check("button no BEM twin", cls(button({ kind: "danger", label: "x" })).indexOf("btn--") === -1);

    /* --- bands and margin marks: same rule ------------------------------ */
    check("notice warn", cls(notice({ kind: "warn", message: "x" })) === "notice is-warn");
    check("notice unknown kind falls back to info", cls(notice({ kind: "nope", message: "x" })) === "notice is-info");
    check("mark over", cls(mark("over")) === "mark is-over");
    check("mark unknown", mark("nope") === null);

    /* --- moneyCell: the grid is built on these direct children ---------- */
    var plain = moneyCell(-8000, {});
    check("money classes", cls(plain) === "money");
    check("money parts", kids(plain).map(cls).join(",") === "m-sign,m-whole,m-sep,m-cents");

    var symbolFirst = moneyCell(123456, { currency: "USD", lang: "en" });
    var symbolNames = kids(symbolFirst).map(cls);
    if (symbolNames.indexOf("m-sym") < symbolNames.indexOf("m-whole")) {
      /* EN layout: the symbol leads, so the cell has to say so or the grid
         puts it after the cents whatever the DOM order is. */
      check("money is-sym-first", cls(symbolFirst).indexOf("is-sym-first") !== -1);
    } else {
      check("money trailing symbol unflagged", cls(symbolFirst).indexOf("is-sym-first") === -1);
    }

    var unsigned = moneyCell(-8000, { sign: false });
    check("money sign:false", kids(unsigned).map(cls).join(",") === "m-whole,m-sep,m-cents");

    /* --- the ghost of an empty ledger page (G9) ------------------------- */
    var empty = emptyState({
      ghost: true,
      columns: 4,
      heading: "h",
      actions: [{ label: "a" }, { label: "b" }]
    });
    var block = kids(empty)[0];
    check("ghost block", cls(block) === "empty__ghost");
    check("ghost head", deep(block, "ghost__head").length === 1);
    check("ghost rows", deep(block, "ghost__row").length === 3);
    check("ghost cells", deep(block, "ghost__cell").length === 16);
    check("ghost has no dead modifier", deep(block, "ghost__cell--head").length === 0);

    var actions = deep(empty, "empty__action");
    check("empty actions built", actions.length === 2);
    check("empty action wears .btn.is-row", actions.length > 0 && cls(actions[0]) === "btn is-row empty__action");
    check("empty heading", deep(empty, "empty__heading").length === 1);

    /* --- the section rule is a pseudo-element, not a filler span -------- */
    var sec = section({ title: "t" });
    var head = kids(sec)[0];
    check("section head", cls(head) === "section__head");
    check("section head has title only", kids(head).length === 1 && cls(kids(head)[0]) === "section__title");
    check("section aside", kids(kids(section({ title: "t", aside: "a" }))[0]).length === 2);

    /* --- "show the numbers": moon.css styles .numbers and .table -------- */
    var table = dataTable([{ label: "a" }, { label: "b", type: "money" }], [["x", 100]], {});
    check("dataTable wears .numbers", (" " + cls(table) + " ").indexOf(" numbers ") !== -1);
    check("dataTable table wears .table", deep(table, "table").length === 1);

    /* --- every key this file names must exist in the catalogue ---------- */
    var I18n = Moon.I18n;
    if (I18n && typeof I18n.has === "function") {
      [
        "common.close", "common.undo", "common.undoSeconds", "common.confirm",
        "common.cancel", "common.showNumbers", "err.badDate", "form.dateHint",
        "a11y.markOver", "a11y.markRecurring", "a11y.markUnconfirmed", "money.invalid"
      ].forEach(function (key) {
        check("key " + key, I18n.has(key));
      });
    }

    return { passed: passed, failed: failed };
  }

  /* ---------------------------------------------------------------- export */

  Moon.UI = {
    _selftest: selftest,
    section: section,
    hero: hero,
    moneyCell: moneyCell,
    mark: mark,
    field: field,
    form: form,
    dialog: dialog,
    confirm: confirmDialog,
    undoStrip: undoStrip,
    clearStrip: clearStrip,
    notice: notice,
    emptyState: emptyState,
    dataTable: dataTable,
    dropZone: dropZone,
    rovingList: rovingList
  };
})(window);
