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
    var matched = false;
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
      if (String(value === null || value === undefined ? "" : value) === optValue) {
        attrs.selected = true;
        matched = true;
      }
      select.appendChild(dom.el("option", attrs, optLabel));
    });
    return matched;
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
      /* The <option selected> attribute is what a parsed document reads, but a
         select built node by node and never attached reports "" until the
         value is set on the element too — and quickRow reads its values before
         anything is in the page. Only when the value really is one of the
         options: assigning an unknown value would blank a select that used to
         fall back to its first entry. */
      if (selectOptions(select, spec.options, value, placeholder)) {
        select.value = String(value);
      }
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
      /* The field knows its own label. Everything that wants the words back —
         a clipped row turning them into a title and a placeholder — reads it
         from here instead of hunting for .field__label in the subtree. */
      label: label,
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
        return ownErrors(entries);
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
          writeEntry(entry, values[entry.name]);
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

  /* --------------------------------------------- field values, read/write */

  /* form(), quickRow() and inlineValue() all have to put a value into a field
     and take it out again, and the four field types each store it somewhere
     else. These two are the single place that knows which. */
  function writeEntry(entry, next) {
    var control = entry.control;
    if (!control) return;
    if (entry.type === "switch") {
      control.checked = !!next;
      return;
    }
    if (entry.type === "money") {
      control.value = typeof next === "number" ? moneyForInput(next) : String(next === null || next === undefined ? "" : next);
    } else if (entry.type === "date") {
      control.value = readDateValue(next) || "";
    } else {
      control.value = next === null || next === undefined ? "" : String(next);
    }
    /* The money readout under the field is painted by an `input` listener
       inside field(), which a programmatic write never fires. Repaint it from
       the outside rather than synthesising an event (file:// + old Safari). */
    if (entry.type === "money" && entry.element) {
      var readout = dom.qs(".field__read", entry.element);
      if (readout) {
        var raw = String(control.value || "").trim();
        var parsed = raw ? parseMoney(raw) : null;
        if (parsed && parsed.ok) {
          readout.textContent = formatMoney(parsed.minor, { symbol: true });
          control.setAttribute("data-minor", String(parsed.minor));
        } else {
          readout.textContent = "";
          control.removeAttribute("data-minor");
        }
      }
    }
  }

  /* "Cleared" is not "empty" for every control. A <select> has no empty value
     unless someone put an empty option in it, so writing "" to one leaves the
     reader looking at a blank box they cannot get back — which is exactly what
     the quick row would do to the direction field after the first save. The
     DOM already records what empty means here: the option that carries the
     `selected` attribute, or failing that the first one. */
  function blankEntry(entry) {
    var control = entry.control;
    if (entry.type === "select" && control && control.options && control.options.length) {
      var index = 0;
      for (var i = 0; i < control.options.length; i += 1) {
        if (control.options[i].defaultSelected) {
          index = i;
          break;
        }
      }
      control.selectedIndex = index;
      entry.touched = false;
      return;
    }
    writeEntry(entry, entry.type === "switch" ? false : "");
    entry.touched = false;
  }

  function fieldEntries(nodes) {
    var out = [];
    (nodes || []).forEach(function (node) {
      if (node && node.moonField) out.push(node.moonField);
    });
    return out;
  }

  /* Intrinsic errors a field already knows about before any Model validator
     sees the values: an amount that does not parse, a date the fallback text
     box could not read. */
  function ownErrors(entries) {
    var out = {};
    entries.forEach(function (entry) {
      if (!entry.control) return;
      if (entry.type === "money") {
        var raw = String(entry.control.value || "").trim();
        if (raw && !parseMoney(raw).ok) out[entry.name] = "money.invalid";
      } else if (entry.type === "date") {
        var text = String(entry.control.value || "").trim();
        if (text && entry.read() === null) out[entry.name] = "err.badDate";
      }
    });
    return out;
  }

  function hasKey(key) {
    var I18n = Moon.I18n;
    if (!key) return false;
    if (I18n && typeof I18n.has === "function") {
      try {
        return !!I18n.has(key);
      } catch (error) {
        return false;
      }
    }
    return false;
  }

  /* The first key the catalogue actually carries. A key this file asks for but
     the catalogue has not grown yet must never reach the screen as its own
     name, and lang.*.js belongs to another agent — so every new label names
     the key it wants first and an existing key behind it. */
  function firstKey(list, fallback) {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && hasKey(list[i])) return list[i];
    }
    return fallback || null;
  }

  function labelTextOf(fieldNode) {
    var entry = fieldNode && fieldNode.moonField;
    var label = (entry && entry.label) || dom.qs(".field__label", fieldNode);
    return label && label.textContent ? String(label.textContent) : "";
  }

  /* The asterisk is drawn by .field__req and hidden from the accessibility
     tree; it has no business being repeated inside the box. */
  function withoutRequiredMark(text) {
    return String(text === null || text === undefined ? "" : text).replace(/[\s*]+$/, "");
  }

  /* Which fields a hint belongs in. A date field is left out by its declared
     type rather than by the element it ends up as: where the browser has no
     date input it becomes a text box, and that case already carries
     form.dateHint under it — two copies of the same sentence is one too many.
     Everything that is not a line of text ignores the attribute anyway. */
  var NO_PLACEHOLDER_FIELDS = { date: true, select: true, switch: true };
  var PLACEHOLDER_INPUTS = {
    text: true, search: true, email: true, url: true, tel: true,
    password: true, number: true
  };

  function takesPlaceholder(entry) {
    var control = entry && entry.control;
    if (!control || !control.tagName) return false;
    if (NO_PLACEHOLDER_FIELDS[entry.type] === true) return false;
    var tag = String(control.tagName).toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    return PLACEHOLDER_INPUTS[String(control.getAttribute("type") || "text").toLowerCase()] === true;
  }

  /* ------------------------------------------------------------- quickRow */

  /* A row-shaped form that is always open. Enter in any field saves and focus
     walks back to the first cleared field, so entering sixty records feels
     like typing sixty lines instead of opening sixty dialogs. UI.dialog stays
     exactly where it was: it is the price of a decision that destroys data,
     and writing one more expense is not that (sadeleştirme §1).
     Session memory of the "more" sheet lives here, keyed by the caller, so a
     re-render (the router redraws on every state:change) does not fold it. */
  var quickMore = Object.create(null);

  function quickRow(spec) {
    spec = spec || {};
    var id = spec.id || util.id("qr");
    var moreId = id + "-more";
    var memoryKey = spec.memoryKey || spec.id || "quickrow";

    var keep = Object.create(null);
    (spec.keepOnSubmit || []).forEach(function (name) {
      keep[name] = true;
    });

    var mainNodes = [];
    var extraNodes = [];

    function build(list, target) {
      (list || []).forEach(function (item) {
        if (!item) return;
        target.push(isNode(item) ? item : field(item));
      });
    }
    build(spec.fields, mainNodes);
    build(spec.moreFields, extraNodes);

    var labelled = spec.labels === "visible";
    if (!labelled) {
      /* The row is one line, so the <label> is clipped rather than removed —
         it stays bound to the control through `for`, and the same translated
         words become the control's title for a pointer that hovers it.

         A clipped label leaves a sighted reader with identical empty boxes, so
         the same words go in as a placeholder too. It is a hint, never the
         label: the <label> is still there and still bound, which is what a
         screen reader and a `for` click both use. A date input prints its own
         format and a select shows its first option, so neither needs one. */
      mainNodes.concat(extraNodes).forEach(function (node) {
        var entry = node.moonField;
        if (!entry || !entry.control) return;
        var text = labelTextOf(node);
        if (!text) return;
        if (!entry.control.getAttribute("title")) entry.control.setAttribute("title", text);
        if (!takesPlaceholder(entry)) return;
        if (entry.control.getAttribute("placeholder")) return;
        entry.control.setAttribute("placeholder", withoutRequiredMark(text));
      });
    }

    var fieldsRow = dom.el("div", { "class": "quickrow__fields" }, mainNodes);

    var submit = button({
      /* Visible on purpose, even though Enter is the fast path: a finger has
         no Enter key, and the row must be usable with one thumb. */
      labelKey: spec.submitLabelKey || "ledger.form.submit",
      kind: "primary",
      type: "submit",
      "class": "quickrow__submit"
    });

    var moreToggle = null;
    if (extraNodes.length) {
      moreToggle = dom.el("button", {
        "class": "btn is-quiet quickrow__more",
        type: "button",
        "aria-expanded": "false",
        "aria-controls": moreId
      }, t(firstKey([spec.moreLabelKey, "common.more"], "nav.more")));
    }

    fieldsRow.appendChild(submit);
    if (moreToggle) fieldsRow.appendChild(moreToggle);

    var extraRow = dom.el("div", { "class": "quickrow__extra", id: moreId, hidden: true });

    /* One error lane under the row instead of a message inside each 104px
       column. The per-field <p> keeps its aria-describedby wiring and its
       aria-invalid, so a screen reader still hears the message on the field it
       belongs to; nothing is hidden, it is read where there is room for it. */
    var errorLane = dom.el("div", { "class": "quickrow__errors", hidden: true });

    var element = dom.el("form", {
      "class": "quickrow" +
        (labelled ? " quickrow--labeled" : "") +
        (spec["class"] ? " " + spec["class"] : ""),
      novalidate: true,
      id: id
    }, [fieldsRow, extraRow, errorLane]);

    var open = !!quickMore[memoryKey];
    var api;

    function allEntries() {
      return fieldEntries(mainNodes.concat(extraNodes));
    }

    /* Closed means NOT IN THE DOM, not `hidden`: the ledger spends its tab
       stops on 60 rows and a folded sheet must not take any of them. The nodes
       stay alive in extraNodes, so a value typed before folding survives. */
    function paintMore() {
      if (!moreToggle) return;
      moreToggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        extraNodes.forEach(function (node) {
          extraRow.appendChild(node);
        });
        extraRow.hidden = false;
      } else {
        extraNodes.forEach(function (node) {
          if (node.parentNode) node.parentNode.removeChild(node);
        });
        extraRow.hidden = true;
      }
    }

    function setOpen(next) {
      open = !!next;
      quickMore[memoryKey] = open;
      paintMore();
    }

    function values() {
      var out = {};
      allEntries().forEach(function (entry) {
        out[entry.name] = entry.read();
      });
      return out;
    }

    function setErrors(map) {
      var errors = map || {};
      var seen = Object.create(null);
      var messages = [];
      allEntries().forEach(function (entry) {
        var key = Object.prototype.hasOwnProperty.call(errors, entry.name) ? errors[entry.name] : null;
        entry.setError(key);
        if (key && !seen[key]) {
          seen[key] = true;
          messages.push(t(key));
        }
      });
      Array.prototype.slice.call(errorLane.children || []).forEach(function (child) {
        errorLane.removeChild(child);
      });
      messages.forEach(function (text) {
        errorLane.appendChild(dom.el("p", { "class": "quickrow__error", text: text }));
      });
      errorLane.hidden = messages.length === 0;
      return api;
    }

    function focusFirstError() {
      var list = allEntries();
      for (var i = 0; i < list.length; i += 1) {
        if (!list[i].errorKey) continue;
        /* An error on a folded field would otherwise be unreachable. */
        if (!open && extraNodes.indexOf(list[i].element) !== -1) setOpen(true);
        return list[i].focus();
      }
      return false;
    }

    function focusFirst() {
      var list = fieldEntries(mainNodes);
      for (var i = 0; i < list.length; i += 1) {
        if (!list[i].control || !list[i].control.disabled) return list[i].focus();
      }
      return false;
    }

    /* keepOnSubmit is what makes a run of entries cheap: the date and the
       category stay, the amount and the note empty, and focus lands on the
       first thing that emptied. */
    function clearForNext() {
      var firstCleared = null;
      var mainCleared = null;
      allEntries().forEach(function (entry) {
        if (keep[entry.name]) return;
        blankEntry(entry);
        if (!firstCleared) firstCleared = entry;
        if (!mainCleared && mainNodes.indexOf(entry.element) !== -1) mainCleared = entry;
      });
      setErrors(null);
      /* Never unfold the sheet just to park focus: if only folded fields
         emptied, go back to the top of the visible row. */
      if (mainCleared) return mainCleared;
      if (firstCleared && open) return firstCleared;
      var mains = fieldEntries(mainNodes);
      return mains.length ? mains[0] : null;
    }

    function reset(next) {
      setErrors(null);
      allEntries().forEach(function (entry) {
        if (next && Object.prototype.hasOwnProperty.call(next, entry.name)) writeEntry(entry, next[entry.name]);
        else blankEntry(entry);
      });
      return api;
    }

    api = {
      element: element,
      values: values,
      setErrors: setErrors,
      focusFirstError: focusFirstError,
      focusFirst: focusFirst,
      reset: reset,
      fields: (function () {
        var byName = Object.create(null);
        allEntries().forEach(function (entry) {
          byName[entry.name] = entry;
        });
        return byName;
      }()),
      isMoreOpen: function () { return open; },
      setMoreOpen: function (next) { setOpen(next); return api; },
      /* The same path Enter takes, for a view that wants to save from its own
         control (and for the selftest, which has no event loop). */
      submit: function () { return submitNow(null); },
      destroy: function () {
        extraNodes.forEach(function (node) {
          if (node.parentNode) node.parentNode.removeChild(node);
        });
        if (element.parentNode) element.parentNode.removeChild(element);
        return api;
      }
    };

    if (moreToggle) {
      moreToggle.addEventListener("click", function () {
        setOpen(!open);
        if (open) {
          var list = fieldEntries(extraNodes);
          if (list.length) list[0].focus();
        } else {
          focusNode(moreToggle);
        }
      });
    }

    function submitNow(event) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();

      var own = ownErrors(allEntries());
      if (Object.keys(own).length) {
        setErrors(own);
        focusFirstError();
        return false;
      }

      var result = call(spec.onSubmit, values(), api, event);
      /* Only an explicit {ok:false} holds the row: a view that returns nothing
         meant "saved", and losing the typed line over a missing return value
         would be the worst possible failure here. */
      if (result && result.ok === false) {
        setErrors(result.errors || {});
        focusFirstError();
        return false;
      }

      var next = clearForNext();
      if (next) next.focus();
      return true;
    }

    /* A real <form> with a real submit button, so Enter in ANY field is the
       browser's own behaviour and no key handler has to guess which keys mean
       "save" in which field. */
    element.addEventListener("submit", submitNow);

    element.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (typeof spec.onCancel === "function") {
        call(spec.onCancel, api);
        return;
      }
      reset();
    });

    paintMore();
    setErrors(null);
    element.moonQuickRow = api;
    return api;
  }

  /* ---------------------------------------------------------- inlineValue */

  /* A value you edit where it sits. Closed it is a <button>; open it is an
     <input> with the value selected, so typing replaces it. Enter saves, Esc
     cancels, blur saves (the reader who clicked away meant to keep it — Esc is
     how you mean the other thing), and the arrows step it without a mouse.
     Both halves live in the same single grid cell and are sized from the same
     --iv-ch, so the column is exactly as wide closed as open: the limits list
     cannot twitch when a row goes into edit (sadeleştirme §2). */
  var IV_MIN_CH = 7;

  function inlineValue(spec) {
    spec = spec || {};
    var type = spec.type === "number" ? "number" : (spec.type === "text" ? "text" : "money");
    var numeric = type !== "text";
    var value = spec.value === undefined ? null : spec.value;

    var step = typeof spec.step === "number" && spec.step > 0
      ? spec.step
      : (type === "money" ? 10000 : 1);
    var min = typeof spec.min === "number" ? spec.min : (numeric ? 0 : null);
    var max = typeof spec.max === "number" ? spec.max : null;

    /* The accessible name has to say what the control does AND what it
       currently reads, or a screen reader hears "Period limit, button" on nine
       rows that differ only by their number. labelParams(value) feeds the
       key's own placeholders, so the sentence is still built in the catalogue
       and never by joining strings in here (Turkish suffixes break if it is). */
    function labelFor(v) {
      if (spec.labelKey && typeof spec.labelParams === "function") {
        return t(spec.labelKey, call(spec.labelParams, v) || undefined);
      }
      return pick(spec, "label");
    }
    var saveErrorKey = firstKey([spec.errorKey, "common.notSaved"], "err.unknown");
    var errorId = util.id("iv") + "-err";

    var btn = dom.el("button", { "class": "inlinevalue__btn" + (numeric ? " tnum" : ""), type: "button" });
    var input = dom.el("input", {
      "class": "inlinevalue__input" + (numeric ? " tnum" : ""),
      type: "text",
      autocomplete: "off",
      hidden: true
    });
    if (numeric) input.setAttribute("inputmode", type === "money" ? "decimal" : "numeric");
    if (spec.maxLength) input.setAttribute("maxlength", String(spec.maxLength));

    /* A <span>, not a <p>: the wrapper is inline and a paragraph may not sit
       inside one. It is on its own grid row, below both halves. */
    var errorNode = dom.el("span", { "class": "inlinevalue__error", id: errorId, hidden: true });

    var node = dom.el("span", {
      "class": "inlinevalue" + (spec["class"] ? " " + spec["class"] : "")
    }, [btn, input, errorNode]);

    var isOpen = false;
    var muteBlur = false;
    var api;

    function shown(v) {
      if (typeof spec.format === "function") {
        var out = call(spec.format, v);
        if (typeof out === "string") return out;
      }
      if (v === null || v === undefined || v === "") return "";
      if (type === "money") return formatMoney(v, { currency: spec.currency, symbol: true });
      return String(v);
    }

    function editable(v) {
      if (v === null || v === undefined || v === "") return "";
      if (type === "money") return moneyForInput(v);
      return String(v);
    }

    function sizeTo(chars) {
      if (!node.style || typeof node.style.setProperty !== "function") return;
      node.style.setProperty("--iv-ch", String(Math.max(IV_MIN_CH, chars || 0)));
    }

    function showError(key) {
      var text = key && hasKey(key) ? t(key) : "";
      errorNode.textContent = text;
      errorNode.hidden = !text;
      if (text) {
        addClass(node, "is-invalid");
        btn.setAttribute("aria-describedby", errorId);
        input.setAttribute("aria-describedby", errorId);
        input.setAttribute("aria-invalid", "true");
      } else {
        if (node.classList) node.classList.remove("is-invalid");
        btn.removeAttribute("aria-describedby");
        input.removeAttribute("aria-describedby");
        input.removeAttribute("aria-invalid");
      }
    }

    function paint() {
      var text = shown(value);
      var edit = editable(value);
      btn.textContent = text;
      sizeTo(Math.max(text.length, edit.length));
      var name = labelFor(value);
      if (name) {
        btn.setAttribute("aria-label", name);
        input.setAttribute("aria-label", name);
      }
    }

    function clampNumber(n) {
      var out = n;
      if (min !== null && out < min) out = min;
      if (max !== null && out > max) out = max;
      return out;
    }

    /* "" means the value is gone — a limit typed empty and entered is a limit
       removed, which is why there is no delete button next to it. */
    function readInput() {
      var raw = String(input.value === undefined ? "" : input.value).trim();
      if (!raw) return { ok: true, value: null };
      if (type === "text") return { ok: true, value: raw };
      if (type === "money") {
        var parsed = parseMoney(raw);
        if (!parsed.ok) return { ok: false, key: parsed.error || "money.invalid" };
        var minor = typeof parsed.minor === "number" ? parsed.minor : 0;
        if (minor < 0 && min !== null && min >= 0) return { ok: false, key: "err.negativeAmount" };
        return { ok: true, value: clampNumber(minor) };
      }
      var sign = raw.charAt(0) === "-" ? -1 : 1;
      var digits = raw.replace(/\D/g, "");
      if (!digits) return { ok: false, key: "err.badAmount" };
      var whole = sign * global.parseInt(digits, 10);
      if (whole < 0 && min !== null && min >= 0) return { ok: false, key: "err.negativeAmount" };
      return { ok: true, value: clampNumber(whole) };
    }

    /* Optimistic: the reading changes under the finger, and only a flat false
       from onSave puts the old number back. A view that returns nothing meant
       "saved" — same rule as quickRow. */
    function commit(next) {
      var previous = value;
      value = next;
      paint();
      var answer = typeof spec.onSave === "function" ? call(spec.onSave, next, api) : true;
      if (answer === false) {
        value = previous;
        paint();
        showError(saveErrorKey);
        return false;
      }
      showError(null);
      return true;
    }

    function close() {
      if (!isOpen) return api;
      muteBlur = true;
      isOpen = false;
      input.hidden = true;
      btn.hidden = false;
      if (node.classList) node.classList.remove("is-editing");
      focusNode(btn);
      muteBlur = false;
      return api;
    }

    function open() {
      if (isOpen) return api;
      isOpen = true;
      showError(null);
      input.value = editable(value);
      btn.hidden = true;
      input.hidden = false;
      addClass(node, "is-editing");
      focusNode(input);
      if (typeof input.select === "function") {
        try {
          input.select();
        } catch (error) { /* a type the browser will not select: leave the caret */ }
      }
      return api;
    }

    function selectAll() {
      if (typeof input.select !== "function") return;
      try {
        input.select();
      } catch (error) { /* ignore */ }
    }

    /* fromBlur: an unreadable value must not trap focus in the box the reader
       is trying to leave, so it reverts and closes instead of fighting back. */
    function save(closeAfter, fromBlur) {
      var read = readInput();
      if (!read.ok) {
        showError(read.key);
        if (fromBlur) {
          input.value = editable(value);
          close();
          return false;
        }
        focusNode(input);
        selectAll();
        return false;
      }
      if (!commit(read.value)) {
        if (fromBlur) {
          input.value = editable(value);
          close();
        }
        return false;
      }
      if (closeAfter) close();
      return true;
    }

    function cancel() {
      input.value = editable(value);
      showError(null);
      close();
    }

    /* Stepping starts from what is on screen: half-typed text if the box is
       open, the stored number if it is not. */
    function bump(delta) {
      var base = typeof value === "number" ? value : 0;
      if (isOpen) {
        var read = readInput();
        if (read.ok && typeof read.value === "number") base = read.value;
      }
      var next = clampNumber(base + delta);
      if (isOpen) {
        input.value = editable(next);
        selectAll();
      }
      commit(next);
    }

    btn.addEventListener("click", function () {
      open();
    });

    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        /* The row may sit inside a quickRow <form>; this Enter is ours. */
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        save(true, false);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        /* Without this the quickRow around it would clear its fields too. */
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        cancel();
        return;
      }
      if (numeric && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        bump(event.key === "ArrowUp" ? step : -step);
      }
    });

    input.addEventListener("blur", function () {
      if (!isOpen || muteBlur) return;
      save(true, true);
    });

    api = {
      element: node,
      control: input,
      open: open,
      close: close,
      /* The three paths Enter, Esc and the arrows take, so a view that draws a
         draggable bar over the same number steps and saves it exactly the way
         the keyboard does rather than inventing a second rule. */
      save: function () { return save(true, false); },
      cancel: function () { cancel(); return api; },
      nudge: function (direction) {
        if (!numeric) return api;
        bump(direction < 0 ? -step : step);
        return api;
      },
      isOpen: function () { return isOpen; },
      value: function () { return value; },
      set: function (next) {
        value = next === undefined ? null : next;
        showError(null);
        paint();
        if (isOpen) input.value = editable(value);
        return api;
      },
      setError: function (key) {
        showError(key);
        return api;
      }
    };

    paint();
    node.moonInlineValue = api;
    return api;
  }

  /* ----------------------------------------------- phone: the typing state */

  /* Two measured faults, one hook (sadeleştirme §8).
   *
   *   a. iOS zooms the page when a control smaller than 16px takes focus, and
   *      the reader reads that as the screen sliding away. moon.css answers
   *      that under 768px; nothing to do here.
   *   b. The bottom rail is position:fixed. The virtual keyboard shortens the
   *      visible area but a fixed element keeps measuring the old one, so the
   *      rail lands on top of the field being typed into.
   *
   * So: ONE document-level focusin/focusout pair puts .is-typing on <html>
   * while a form control holds focus, and moon.css folds the rail away for
   * that time. Every view gets this for free and none of them has to know.
   * The same hook brings the focused field into the middle of what is left of
   * the viewport, once — after the keyboard has had time to come up, and never
   * with behavior:"smooth", which during a keyboard animation looks exactly
   * like the drift it is meant to cure.
   */
  var TYPING_CLASS = "is-typing";
  var PHONE_QUERY = "(max-width: 767px)";
  var KEYBOARD_SETTLE_MS = 260;

  var NO_KEYBOARD = {
    checkbox: true, radio: true, button: true, submit: true,
    reset: true, file: true, image: true, range: true, color: true, hidden: true
  };

  function isTypingTarget(node) {
    if (!node || !node.tagName) return false;
    var tag = String(node.tagName).toUpperCase();
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      var kind = String(node.getAttribute && node.getAttribute("type") || "text").toLowerCase();
      return !NO_KEYBOARD[kind];
    }
    if (typeof node.getAttribute === "function") {
      var editable = node.getAttribute("contenteditable");
      if (editable !== null && editable !== "false") return true;
    }
    return false;
  }

  function isPhone() {
    if (typeof global.matchMedia !== "function") return false;
    try {
      return !!global.matchMedia(PHONE_QUERY).matches;
    } catch (error) {
      return false;
    }
  }

  var typingBound = false;
  var typingTimer = null;

  function setTyping(on) {
    var root = doc && doc.documentElement;
    if (!root || !root.classList) return;
    if (on) root.classList.add(TYPING_CLASS);
    else root.classList.remove(TYPING_CLASS);
  }

  function bindTyping() {
    if (typingBound || !doc || typeof doc.addEventListener !== "function") return;
    typingBound = true;

    doc.addEventListener("focusin", function (event) {
      var target = event.target;
      if (!isTypingTarget(target)) return;
      setTyping(true);
      if (typingTimer) global.clearTimeout(typingTimer);
      if (typeof global.setTimeout !== "function") return;
      /* A modal already owns the screen and scrolls itself. */
      if (typeof target.closest === "function" && target.closest(".dialog")) return;
      if (!isPhone()) return;
      typingTimer = global.setTimeout(function () {
        typingTimer = null;
        if (doc.activeElement !== target) return;
        if (typeof target.scrollIntoView !== "function") return;
        try {
          target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
        } catch (error) {
          target.scrollIntoView();
        }
      }, KEYBOARD_SETTLE_MS);
    }, true);

    doc.addEventListener("focusout", function () {
      if (typingTimer) {
        global.clearTimeout(typingTimer);
        typingTimer = null;
      }
      /* focusin on the next field fires after this focusout, so the rail must
         not flash back in between two fields of the same row. */
      if (typeof global.setTimeout !== "function") {
        setTyping(false);
        return;
      }
      global.setTimeout(function () {
        if (isTypingTarget(doc.activeElement)) return;
        setTyping(false);
      }, 0);
    }, true);
  }

  bindTyping();

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

  /* ------------------------------------------------------------ sideways */

  /* rovingList answers Up, Down, Home and End, which is the whole keyboard a
     ledger needs. A set laid out left to right — ten colour dots, a strip of
     account chips — needs the other two arrows to mean the same thing, and
     that difference is small enough to add on top rather than to fork the
     list over. Everything else about the tab stop stays rovingList's job. */
  function sideways(element, nodes, roving) {
    function onKeyDown(event) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      var index = nodes.indexOf(event.target);
      if (index === -1 || !nodes.length) return;
      event.preventDefault();
      var next = index + (event.key === "ArrowLeft" ? -1 : 1);
      if (next < 0) next = nodes.length - 1;
      if (next > nodes.length - 1) next = 0;
      roving.focus(next);
    }

    element.addEventListener("keydown", onKeyDown, false);
    return function unbind() {
      element.removeEventListener("keydown", onKeyDown, false);
    };
  }

  /* One tab stop for a whole set, written where the set is built: the stand-in
     the tests run against has no querySelectorAll, so rovingList's own sync
     cannot reach these nodes there, and a group that arrived unreachable from
     the keyboard would pass every check. */
  function markStop(nodes, index) {
    nodes.forEach(function (node, place) {
      node.setAttribute("tabindex", place === index ? "0" : "-1");
    });
  }

  /* ------------------------------------------------------------ pickGroup */

  /* The colour picker and the icon picker are one control with two paints: a
     radiogroup of buttons, one tab stop for the set, arrows moving inside it.
     Written once so the two cannot drift on which key picks and which only
     moves. The options are real buttons, so Space and Enter already pick
     through the native click and nothing here listens for them. */
  function pickGroup(spec) {
    spec = spec || {};
    var items = (spec.items || []).filter(function (one) {
      return one && one.value !== null && one.value !== undefined && one.value !== "";
    });
    var current = spec.value === null || spec.value === undefined ? "" : String(spec.value);

    var attrs = { "class": spec["class"], role: "radiogroup" };
    var label = pick(spec, "label");
    if (label) attrs["aria-label"] = label;
    if (spec.orientation) attrs["aria-orientation"] = spec.orientation;

    var element = dom.el("div", attrs);
    var options = [];
    var api;

    function indexOf(value) {
      for (var i = 0; i < items.length; i += 1) {
        if (String(items[i].value) === value) return i;
      }
      return -1;
    }

    /* The tab stop belongs to the chosen option, the way a radio group puts it
       on the checked radio; with nothing chosen yet the first option holds it,
       so the set is still one Tab away from the reader. */
    function paint() {
      var chosen = indexOf(current);
      options.forEach(function (node, index) {
        node.setAttribute("aria-checked", index === chosen ? "true" : "false");
      });
      markStop(options, chosen === -1 ? 0 : chosen);
    }

    function choose(index) {
      var item = items[index];
      if (!item) return;
      current = String(item.value);
      paint();
      call(spec.onPick, item.value, index, item);
    }

    items.forEach(function (item, index) {
      var optAttrs = {
        "class": spec.optionClass,
        type: "button",
        role: "radio",
        "aria-checked": "false",
        tabindex: "-1",
        dataset: { pick: String(item.value) }
      };
      if (item.label) optAttrs["aria-label"] = item.label;
      var node = dom.el(
        "button",
        optAttrs,
        item.text === null || item.text === undefined ? undefined : String(item.text)
      );
      /* A record's colour reaches the page as --tone and every rule reads that
         one name back (contract §10), so a dot paints itself from the value it
         stands for instead of from a class per colour. */
      if (item.tone && node.style && typeof node.style.setProperty === "function") {
        node.style.setProperty("--tone", item.tone);
      }
      node.addEventListener("click", function () {
        choose(index);
      });
      options.push(node);
      element.appendChild(node);
    });

    var roving = rovingList(element, {
      selector: "[data-pick]",
      start: Math.max(0, indexOf(current)),
      wrap: true
    });
    var unbind = sideways(element, options, roving);
    paint();

    api = {
      element: element,
      options: options,
      value: function () {
        return current || null;
      },
      set: function (next) {
        current = next === null || next === undefined ? "" : String(next);
        paint();
        return api;
      },
      focus: function (index) {
        roving.focus(index === undefined || index === null ? Math.max(0, indexOf(current)) : index);
        return api;
      },
      destroy: function () {
        unbind();
        roving.destroy();
      }
    };
    return api;
  }

  /* --------------------------------------------------------------- swatch */

  function toneKey(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim().toUpperCase();
  }

  /* The CSS value a view should write into style="--tone: …" for a record's
     stored colour.

     A record keeps a hex, because that is what an export has to mean the same
     thing in next year and in somebody else's browser. A theme keeps a token,
     because Dawn darkens all ten of the spectrum to clear contrast on white.
     Painting the raw hex would show a reader on Dawn a different colour from
     the one they picked in the swatch, which is why both ends go through this:
     the token first, the stored hex as its fallback so a colour outside the ten
     still paints exactly as written. */
  function tone(value) {
    var hex = toneKey(value);
    if (!/^#[0-9A-F]{6}$/.test(hex)) return "";
    var Store = Moon.Store;
    var spectrum = Store && Array.isArray(Store.CATEGORY_SPECTRUM) ? Store.CATEGORY_SPECTRUM : [];
    var place = spectrum.indexOf(hex);
    return place === -1 ? hex : "var(--cat-" + (place + 1) + ", " + hex + ")";
  }

  /* The spectrum, each colour paired with the token the stylesheet keeps it
     under. The dot paints from the token and the record stores the hex: Dawn
     darkens the whole spectrum to clear 4.5:1, so reading --cat-N shows the
     reader the colour their own theme will draw, while the stored hex keeps
     meaning the same thing in an export. The hex rides along as the token's
     fallback, so a colour outside the ten still paints. */
  function swatchItems(colors) {
    var Store = Moon.Store;
    var spectrum = Store && Array.isArray(Store.CATEGORY_SPECTRUM) ? Store.CATEGORY_SPECTRUM : [];
    var source = Array.isArray(colors) && colors.length ? colors : spectrum;
    var out = [];

    source.forEach(function (one, index) {
      var object = !!one && typeof one === "object";
      var hex = toneKey(object ? one.value : one);
      if (!hex) return;
      var token = object && one.token ? one.token : null;
      if (!token) {
        var place = spectrum.indexOf(hex);
        if (place === -1 && source === spectrum) place = index;
        if (place !== -1) token = "--cat-" + (place + 1);
      }
      out.push({
        value: hex,
        tone: token ? "var(" + token + ", " + hex + ")" : hex,
        /* The catalogue has no names for the ten colours, and inventing ten
           English ones here would be exactly the hardcoded string this file
           forbids. The hex is a code rather than prose, so it can stand as the
           dot's name until a caller passes a translated one. */
        label: (object ? pick(one, "label") : "") || hex,
        text: null
      });
    });
    return out;
  }

  function swatch(spec) {
    spec = spec || {};
    var items = swatchItems(spec.colors);

    var group = pickGroup({
      "class": "swatch" + (spec["class"] ? " " + spec["class"] : ""),
      optionClass: "swatch__dot",
      items: items,
      value: toneKey(spec.value),
      labelKey: firstKey([spec.labelKey, "form.color"], null),
      label: spec.label,
      orientation: spec.orientation,
      onPick: function (value, index, item) {
        call(spec.onPick, value, index, item);
      }
    });

    var api = {
      element: group.element,
      dots: group.options,
      value: group.value,
      colors: function () {
        return items.map(function (item) {
          return item.value;
        });
      },
      set: function (next) {
        group.set(toneKey(next));
        return api;
      },
      focus: function (index) {
        group.focus(index);
        return api;
      },
      destroy: group.destroy
    };
    group.element.moonSwatch = api;
    return api;
  }

  /* ---------------------------------------------------------- emojiPicker */

  /* Forty icons for the things a household actually pays for, in the order a
     reader scans for them: money and bills, then the house, then getting
     about, then being looked after, then what is left over. They are glyphs,
     not words — a screen reader reads each one by its own Unicode name — so
     they need no catalogue entry, and none of them is a ZWJ sequence, which
     would overrun the four code units the store keeps for an icon. */
  var EMOJI = [
    "💰", "🧾", "🛒", "🍽️", "☕", "🍺", "🏠", "💡",
    "💧", "🔥", "📱", "📶", "🚌", "🚕", "🚗", "⛽",
    "✈️", "🏨", "🏥", "💊", "🦷", "🏋️", "👕", "💄",
    "✂️", "📚", "🎓", "🎁", "🎉", "🎬", "🎮", "🎵",
    "🐾", "👶", "🧹", "🔧", "🏦", "💳", "🐖", "📈"
  ];

  function iconText(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function emojiPicker(spec) {
    spec = spec || {};
    var id = spec.id || util.id("icon");
    var sheetId = id + "-sheet";
    var Store = Moon.Store;
    var max = (Store && Store.ICON_MAX) || 4;
    var fallback = (Store && Store.FALLBACK_ICON) || "•";
    /* form.icon is the key this control wants; until the catalogue carries it
       the toggle borrows the one word that is already there and still true of
       a fold. A nameless button is not an option. */
    var labelKey = firstKey([spec.labelKey, "form.icon", "common.more"], "common.more");
    var current = iconText(spec.value);
    var open = !!spec.open;
    var grid = null;
    var own = null;
    var api;

    var face = dom.el("span", { "class": "emojipicker__current", "aria-hidden": "true" }, current || fallback);
    var toggle = dom.el("button", {
      "class": "btn is-quiet emojipicker__toggle",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": sheetId
    }, [face, dom.el("span", { "class": "sr" }, t(labelKey))]);

    var sheet = dom.el("div", { "class": "emojipicker__sheet", id: sheetId });
    var element = dom.el("div", {
      "class": "emojipicker" + (spec["class"] ? " " + spec["class"] : ""),
      id: id
    }, [toggle, sheet]);

    function announce(value, fromOwn) {
      current = iconText(value);
      face.textContent = current || fallback;
      if (grid) grid.set(current);
      if (own && own.moonField && !fromOwn) own.moonField.control.value = current;
      call(spec.onPick, current || null);
    }

    function build() {
      if (grid) return;
      var source = Array.isArray(spec.emoji) && spec.emoji.length ? spec.emoji : EMOJI;
      grid = pickGroup({
        "class": "emojis",
        optionClass: "emojis__one",
        items: source.map(function (one) {
          var glyph = iconText(one);
          return { value: glyph, text: glyph };
        }),
        value: current,
        labelKey: labelKey,
        onPick: function (value) {
          announce(value, false);
        }
      });

      /* The grid is a decision; the box is the way out of it, for the reader
         whose category is a plant or a motorbike. One field, four code units,
         read on change rather than on every keystroke so a half-typed icon
         never reaches the record. */
      own = field({
        type: "text",
        name: spec.name || "icon",
        "class": "emojipicker__own",
        label: t(labelKey),
        value: current,
        maxLength: max,
        autocomplete: "off",
        onChange: function (value) {
          var typed = iconText(value);
          if (typed) announce(typed, true);
        }
      });
    }

    /* Folded means NOT IN THE DOM, not merely hidden: forty buttons and a box
       would cost forty-one tab stops and two hundred pixels on every add row
       that carries a picker. The nodes stay alive between folds, so a typed
       icon survives one. */
    function paint() {
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        build();
        sheet.appendChild(grid.element);
        sheet.appendChild(own);
        sheet.hidden = false;
      } else {
        dom.clear(sheet);
        sheet.hidden = true;
      }
    }

    function setOpen(next, moveFocus) {
      var want = !!next;
      var changed = want !== open;
      open = want;
      paint();
      /* Opening from the toggle moves the reader into the grid, onto the icon
         they already have: a picker that unfolds behind the focus would make
         them Tab back into it. A view calling setOpen() is redrawing, not
         answering a reader, so it leaves the focus where it was. */
      if (open && moveFocus && grid) grid.focus();
      if (changed) call(spec.onToggle, open, api);
      return api;
    }

    toggle.addEventListener("click", function () {
      setOpen(!open, true);
    });

    paint();

    api = {
      element: element,
      control: toggle,
      value: function () {
        return current || null;
      },
      set: function (next) {
        current = iconText(next);
        face.textContent = current || fallback;
        if (grid) grid.set(current);
        if (own && own.moonField) own.moonField.control.value = current;
        return api;
      },
      isOpen: function () {
        return open;
      },
      setOpen: function (next) {
        return setOpen(next, false);
      },
      toggle: function () {
        return setOpen(!open, false);
      },
      focus: function () {
        focusNode(toggle);
        return api;
      },
      destroy: function () {
        if (grid) grid.destroy();
      }
    };
    element.moonEmojiPicker = api;
    return api;
  }

  /* ---------------------------------------------------------------- chips */

  /* The account strip: the balances you keep an eye on, on one line, at the
     top of the page. A finger drags it; the keyboard gets the same strip as a
     toolbar — one tab stop, arrows between the chips, and rovingList scrolling
     the focused one into view. Nothing here listens for wheel or touch, so the
     page keeps its own scrolling and the strip keeps the browser's. */
  function chips(spec) {
    spec = spec || {};
    var items = (spec.items || []).filter(Boolean);
    var nodes = [];
    var labelKey = firstKey([spec.labelKey, "a11y.accounts", "nav.accounts"], null);

    var attrs = { "class": "chips" + (spec["class"] ? " " + spec["class"] : ""), role: "toolbar" };
    if (labelKey) attrs["aria-label"] = t(labelKey);
    var element = dom.el("div", attrs);
    var api;

    function parts(item) {
      var out = [];
      var icon = iconText(item.icon);
      if (icon) out.push(dom.el("span", { "class": "chip__icon", "aria-hidden": "true" }, icon));
      var name = pick(item, "name");
      if (name) out.push(dom.el("span", { "class": "chip__name" }, name));

      var value = item.value;
      if (isNode(value)) {
        out.push(dom.el("span", { "class": "chip__value" }, value));
      } else if (typeof value === "number") {
        /* A balance is money, so it is drawn by the one money formatter and
           carries its minor units with it: a language switch repaints from the
           number rather than from the text already on screen. */
        out.push(dom.el("span", {
          "class": "chip__value",
          dataset: { minor: String(value) },
          text: formatMoney(value, {
            currency: item.currency || spec.currency,
            lang: lang(),
            symbol: true
          })
        }));
      } else if (value !== null && value !== undefined && value !== "") {
        out.push(dom.el("span", { "class": "chip__value" }, String(value)));
      }
      return out;
    }

    function chip(item, index, extra) {
      var chipAttrs = {
        "class": "chip" + (extra ? " " + extra : "") + (item["class"] ? " " + item["class"] : ""),
        tabindex: "-1",
        dataset: { chip: String(index) }
      };
      if (item.id) chipAttrs.dataset.id = String(item.id);
      if (item.current) chipAttrs["aria-current"] = "true";

      var node;
      if (item.href) {
        chipAttrs.href = item.href;
        node = dom.el("a", chipAttrs, parts(item));
      } else {
        chipAttrs.type = "button";
        node = dom.el("button", chipAttrs, parts(item));
      }
      /* A caller may hand over either a ready CSS value or the bare hex a
         record stores. The bare one goes through tone() so a chip paints from
         the theme's token like every other coloured thing, instead of showing a
         Dawn reader the undarkened colour straight out of the file. */
      var paint = item.tone || tone(item.color);
      if (paint && node.style && typeof node.style.setProperty === "function") {
        node.style.setProperty("--tone", paint);
      }
      node.addEventListener("click", function (event) {
        if (typeof item.onSelect === "function") call(item.onSelect, item, index, event);
        else call(spec.onSelect, item, index, event);
      });
      return node;
    }

    var start = 0;
    items.forEach(function (item, index) {
      if (item.current) start = index;
      nodes.push(chip(item, index));
    });

    /* The trailing chip is an invitation rather than a balance, and it is
       always last: a reader who has learned where their accounts stop should
       not find the strip reordered under their thumb. */
    var add = spec.add === true ? {} : (spec.add || (spec.addHref || spec.onAdd ? {} : null));
    if (add) {
      nodes.push(chip({
        icon: add.icon === undefined ? "+" : add.icon,
        nameKey: firstKey([add.labelKey, spec.addLabelKey, "accounts.addChip"], "common.add"),
        href: add.href || spec.addHref || null,
        onSelect: add.onSelect || spec.onAdd || null
      }, items.length, "is-add"));
    }

    nodes.forEach(function (node) {
      element.appendChild(node);
    });

    var roving = rovingList(element, { selector: "[data-chip]", start: start, wrap: true });
    var unbind = sideways(element, nodes, roving);
    markStop(nodes, start);

    api = {
      element: element,
      chips: nodes,
      focus: function (index) {
        roving.focus(index === undefined || index === null ? start : index);
        return api;
      },
      destroy: function () {
        unbind();
        roving.destroy();
      }
    };
    element.moonChips = api;
    return api;
  }

  /* ------------------------------------------------------------ expandRow */

  /* A list row that opens where it stands — the progressive disclosure that
     keeps a holding's cost, its price date and its note off the first screen
     without spending a dialog on them. The summary is a real button, so a tap,
     Enter and Space all do the same thing; the detail is hidden with the
     attribute rather than with a class, so a closed row costs no tab stop at
     all and twenty of them stay walkable from a keyboard. */
  function expandRow(spec) {
    spec = spec || {};
    var id = spec.id || util.id("row");
    var detailId = id + "-detail";
    var openClass = spec.openClass || "is-open";
    var open = !!spec.open;
    var built = false;
    var api;

    var summary = dom.el("button", {
      "class": spec.summaryClass || "expandrow__summary",
      type: "button",
      id: id + "-summary",
      "aria-expanded": "false",
      "aria-controls": detailId
    }, spec.summary);

    var detail = dom.el("div", {
      "class": spec.detailClass || "expandrow__detail",
      id: detailId
    });

    var element = dom.el("div", {
      "class": "expandrow" + (spec["class"] ? " " + spec["class"] : ""),
      id: id
    }, [summary, detail]);

    /* A detail passed as a function is built on the first open. A list of
       holdings each carrying an inlineValue for its price would otherwise
       build twenty editors nobody has asked to see. */
    function fill() {
      if (built) return;
      built = true;
      var inner = typeof spec.detail === "function" ? call(spec.detail, api) : spec.detail;
      var node = content(inner);
      if (node) detail.appendChild(node);
    }

    function paint() {
      summary.setAttribute("aria-expanded", open ? "true" : "false");
      detail.hidden = !open;
      if (element.classList) element.classList.toggle(openClass, open);
      if (summary.classList) summary.classList.toggle(openClass, open);
    }

    function setOpen(next) {
      var want = !!next;
      if (want) fill();
      if (want === open) {
        paint();
        return api;
      }
      open = want;
      paint();
      call(spec.onToggle, open, api);
      return api;
    }

    function onClick() {
      setOpen(!open);
    }

    summary.addEventListener("click", onClick, false);

    api = {
      element: element,
      summary: summary,
      detail: detail,
      isOpen: function () {
        return open;
      },
      setOpen: setOpen,
      toggle: function () {
        return setOpen(!open);
      },
      focus: function () {
        reveal(element);
        focusNode(summary);
        return api;
      },
      destroy: function () {
        summary.removeEventListener("click", onClick, false);
      }
    };
    /* The api exists before anything is drawn because a detail written as a
       function is handed it, and a row asked to start open builds that detail
       on the spot rather than waiting for a toggle nobody will press. */
    if (open || typeof spec.detail !== "function") fill();
    paint();

    /* A view holding a list of these finds the row's api from the node its own
       keyboard handler was given, the way .moonField works for a field. */
    element.moonExpandRow = api;
    summary.moonExpandRow = api;
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

    /* --- quickRow: the row that replaces the entry dialog --------------- */
    var qrSaved = [];
    var qr = quickRow({
      id: "qr-test",
      memoryKey: "selftest",
      fields: [
        { type: "date", name: "date", label: "d", value: "2026-09-26" },
        { type: "money", name: "amount", label: "a" },
        { type: "select", name: "categoryId", label: "c", options: [{ value: "c_1", label: "m" }], value: "c_1" },
        { type: "text", name: "note", label: "n" }
      ],
      moreFields: [{ type: "select", name: "direction", label: "y", options: ["out", "in"], value: "out" }],
      keepOnSubmit: ["date", "categoryId"],
      onSubmit: function (values) {
        qrSaved.push(values);
        return { ok: true };
      }
    });

    check("quickRow is a form", qr.element.tagName === "FORM");
    check("quickRow class", cls(qr.element) === "quickrow");

    /* A clipped label leaves a sighted reader with identical empty boxes, so
       the label's own words go in as a placeholder as well. Only where one is
       drawn: a date input prints its format and a select shows an option, and
       a hint flashing in either would be noise. */
    check("quickRow hints the money box",
      qr.fields.amount.control.getAttribute("placeholder") === "a");
    check("quickRow hints the text box",
      qr.fields.note.control.getAttribute("placeholder") === "n");
    check("quickRow leaves the date box alone",
      qr.fields.date.control.getAttribute("placeholder") === null);
    check("quickRow leaves the select alone",
      qr.fields.categoryId.control.getAttribute("placeholder") === null);

    /* The asterisk belongs to .field__req, which is hidden from the
       accessibility tree; repeating it inside the box would be a third copy of
       a mark that is already drawn once. */
    var qrReq = quickRow({
      id: "qr-req",
      fields: [{ type: "text", name: "note", label: "Note", required: true }]
    });
    check("quickRow label carries the required mark",
      labelTextOf(qrReq.fields.note.element) === "Note*");
    check("quickRow hint drops the required mark",
      qrReq.fields.note.control.getAttribute("placeholder") === "Note");

    /* A row that asks for visible labels has nothing to replace, so it gets no
       placeholder at all. */
    var qrLabelled = quickRow({
      id: "qr-labelled",
      labels: "visible",
      fields: [{ type: "text", name: "note", label: "Note" }]
    });
    check("a labelled row needs no hint",
      qrLabelled.fields.note.control.getAttribute("placeholder") === null);
    check("quickRow novalidate", qr.element.getAttribute("novalidate") !== null);
    check("quickRow fields row", deep(qr.element, "quickrow__fields").length === 1);
    check("quickRow submit is type=submit",
      deep(qr.element, "quickrow__submit").length === 1 &&
      deep(qr.element, "quickrow__submit")[0].getAttribute("type") === "submit");
    check("quickRow submit wears .btn.is-primary",
      cls(deep(qr.element, "quickrow__submit")[0]).indexOf("btn is-primary") === 0);

    var qrMore = deep(qr.element, "quickrow__more");
    check("quickRow more toggle", qrMore.length === 1);
    check("quickRow more starts folded", qrMore[0].getAttribute("aria-expanded") === "false");
    check("quickRow more is wired to the sheet",
      qrMore[0].getAttribute("aria-controls") === "qr-test-more");

    /* The folded sheet must cost no tab stop: not hidden, absent. */
    var qrSheet = deep(qr.element, "quickrow__extra")[0];
    check("quickRow folded sheet is empty in the DOM", qrSheet && kids(qrSheet).length === 0);
    check("quickRow folded field still reports its value", qr.values().direction === "out");
    qr.setMoreOpen(true);
    check("quickRow unfolded sheet holds its field", kids(qrSheet).length === 1);
    check("quickRow unfolded says so", qrMore[0].getAttribute("aria-expanded") === "true");
    qr.setMoreOpen(false);
    check("quickRow refolds to empty", kids(qrSheet).length === 0);

    qr.fields.amount.control.value = "24,90";
    qr.fields.note.control.value = "a101";
    check("quickRow reads money as minor", qr.values().amount === 2490);

    var qrOk = qr.submit();
    check("quickRow submit reports ok", qrOk === true);
    check("quickRow called onSubmit once", qrSaved.length === 1);
    check("quickRow passed the parsed amount", qrSaved[0].amount === 2490);
    /* keepOnSubmit is the whole point: the next line starts half-written. */
    check("quickRow keeps the date", qr.fields.date.control.value === "2026-09-26");
    check("quickRow keeps the category", qr.fields.categoryId.control.value === "c_1");
    check("quickRow clears the amount", qr.fields.amount.control.value === "");
    check("quickRow clears the note", qr.fields.note.control.value === "");

    /* An unreadable amount never reaches onSubmit. */
    qr.fields.amount.control.value = "abc";
    check("quickRow refuses a bad amount", qr.submit() === false);
    check("quickRow did not call onSubmit again", qrSaved.length === 1);
    check("quickRow marked the field", qr.fields.amount.errorKey === "money.invalid");
    check("quickRow printed one error line", deep(qr.element, "quickrow__error").length === 1);
    qr.fields.amount.control.value = "";
    qr.setErrors(null);
    check("quickRow clears the error lane", deep(qr.element, "quickrow__error").length === 0);

    /* {ok:false} holds the row and clears nothing. */
    var qrHold = quickRow({
      id: "qr-hold",
      fields: [{ type: "text", name: "note", label: "n", value: "keep me" }],
      onSubmit: function () { return { ok: false, errors: { note: "err.required" } }; }
    });
    check("quickRow {ok:false} reports false", qrHold.submit() === false);
    check("quickRow {ok:false} keeps the typed value", qrHold.fields.note.control.value === "keep me");
    check("quickRow {ok:false} shows the error", qrHold.fields.note.errorKey === "err.required");

    /* A view that forgets to return must not lose the line it just saved. */
    var qrSilent = quickRow({
      id: "qr-silent",
      fields: [{ type: "text", name: "note", label: "n", value: "x" }],
      onSubmit: function () { /* no return */ }
    });
    check("quickRow treats no return as saved", qrSilent.submit() === true);
    check("quickRow cleared after a silent save", qrSilent.fields.note.control.value === "");

    /* --- inlineValue: edit in place, no dialog, no layout jump ---------- */
    var ivSeen = [];
    var iv = inlineValue({
      value: 600000,
      type: "money",
      label: "limit",
      step: 10000,
      min: 0,
      format: function (v) { return v === null ? "" : "L" + v; },
      onSave: function (v) { ivSeen.push(v); return true; }
    });

    check("inlineValue wrapper", cls(iv.element) === "inlinevalue");
    var ivBtn = deep(iv.element, "inlinevalue__btn")[0];
    var ivInput = deep(iv.element, "inlinevalue__input")[0];
    check("inlineValue closed half is a button", ivBtn && ivBtn.tagName === "BUTTON");
    check("inlineValue closed button is type=button", ivBtn.getAttribute("type") === "button");
    check("inlineValue open half is an input", ivInput && ivInput.tagName === "INPUT");
    /* Both halves stay in the one grid cell so the column cannot twitch. */
    check("inlineValue keeps both halves in the DOM", kids(iv.element).length === 3);
    check("inlineValue uses format()", ivBtn.textContent === "L600000");
    check("inlineValue labels both halves",
      ivBtn.getAttribute("aria-label") === "limit" && ivInput.getAttribute("aria-label") === "limit");
    check("inlineValue money asks for a decimal keypad", ivInput.getAttribute("inputmode") === "decimal");
    check("inlineValue starts closed", iv.isOpen() === false);

    iv.open();
    check("inlineValue opens", iv.isOpen() === true);
    check("inlineValue opens on the editable form", ivInput.value === "6000,00" || ivInput.value === "6000.00");

    iv.control.value = "7000";
    iv.close();
    check("inlineValue closes", iv.isOpen() === false);
    iv.set(700000);
    check("inlineValue set() repaints", ivBtn.textContent === "L700000");
    check("inlineValue set() does not save", ivSeen.length === 0);

    /* The arrows move the number without a mouse and save it. */
    var ivStep = [];
    var ivArrow = inlineValue({
      value: 600000,
      type: "money",
      label: "l",
      step: 10000,
      min: 0,
      onSave: function (v) { ivStep.push(v); return true; }
    });
    ivArrow.nudge(1);
    check("inlineValue steps up by step", ivArrow.value() === 610000);
    ivArrow.nudge(-1);
    ivArrow.nudge(-1);
    check("inlineValue steps down by step", ivArrow.value() === 590000);
    check("inlineValue saved every step", ivStep.length === 3);
    /* min is a floor, not a suggestion: the arrows cannot walk it negative. */
    ivArrow.set(5000);
    ivArrow.nudge(-1);
    check("inlineValue clamps at min", ivArrow.value() === 0);

    /* An empty value entered is the value removed — this is how a limit comes
       off without a delete button and without a confirm. */
    var ivCleared = [];
    var ivClear = inlineValue({
      value: 500,
      type: "money",
      label: "l",
      onSave: function (v) { ivCleared.push(v); return true; }
    });
    ivClear.open();
    ivClear.control.value = "";
    check("inlineValue empty saves as null",
      ivClear.save() === true && ivCleared.length === 1 && ivCleared[0] === null);
    check("inlineValue closes after saving", ivClear.isOpen() === false);

    /* onSave:false puts the old number back and says so. */
    var ivReject = inlineValue({
      value: 1000,
      type: "number",
      label: "n",
      min: 0,
      onSave: function () { return false; }
    });
    check("inlineValue number asks for a numeric keypad",
      deep(ivReject.element, "inlinevalue__input")[0].getAttribute("inputmode") === "numeric");
    ivReject.open();
    ivReject.control.value = "2500";
    check("inlineValue refused save reports false", ivReject.save() === false);
    check("inlineValue refused save restores the old value", ivReject.value() === 1000);
    check("inlineValue refused save shows an error",
      deep(ivReject.element, "inlinevalue__error")[0].hidden === false);

    /* A negative where min is 0 is a typo, not a direction (schema §2). */
    var ivNeg = inlineValue({ value: 100, type: "number", label: "n", min: 0, onSave: function () { return true; } });
    ivNeg.open();
    ivNeg.control.value = "-5";
    check("inlineValue refuses a negative under min", ivNeg.save() === false);
    check("inlineValue kept the old value", ivNeg.value() === 100);

    var ivCancel = inlineValue({ value: 42, type: "number", label: "n", onSave: function () { return true; } });
    ivCancel.open();
    ivCancel.control.value = "99";
    ivCancel.cancel();
    check("inlineValue Esc path discards", ivCancel.value() === 42);
    check("inlineValue Esc path closes", ivCancel.isOpen() === false);

    /* --- the phone typing hook: one class name, named once -------------- */
    check("typing class is published", TYPING_CLASS === "is-typing");
    check("a text input opens a keyboard", isTypingTarget({
      tagName: "INPUT", getAttribute: function () { return "text"; }
    }) === true);
    check("a checkbox does not", isTypingTarget({
      tagName: "INPUT", getAttribute: function () { return "checkbox"; }
    }) === false);
    check("a select does", isTypingTarget({ tagName: "SELECT", getAttribute: function () { return null; } }) === true);
    check("a button does not", isTypingTarget({
      tagName: "BUTTON", getAttribute: function () { return null; }
    }) === false);

    /* --- swatch: one colour marked, one tab stop for the ten ----------- */
    var swPicked = [];
    var sw = swatch({ value: "#3dd6a0", onPick: function (hex) { swPicked.push(hex); } });
    var dots = deep(sw.element, "swatch__dot");

    function stops(list) {
      return list.filter(function (node) {
        return node.getAttribute("tabindex") === "0";
      });
    }
    function checked(list) {
      return list.filter(function (node) {
        return node.getAttribute("aria-checked") === "true";
      });
    }

    check("swatch wrapper", cls(sw.element) === "swatch");
    check("swatch is a radiogroup", sw.element.getAttribute("role") === "radiogroup");
    check("swatch draws the whole spectrum", dots.length === 10);
    check("swatch dots are radio buttons", dots.length > 0 && dots.every(function (dot) {
      return dot.tagName === "BUTTON" && dot.getAttribute("type") === "button" &&
        dot.getAttribute("role") === "radio" && cls(dot) === "swatch__dot";
    }));
    check("swatch marks exactly one colour", checked(dots).length === 1);
    /* Case is the whole risk here: the store writes #RRGGBB uppercase, and a
       swatch picked as "#3dd6a0" has to compare equal to it. */
    check("swatch marks the colour it was given",
      checked(dots).length === 1 && checked(dots)[0].dataset.pick === "#3DD6A0");
    check("swatch reports the stored spelling", sw.value() === "#3DD6A0");
    check("swatch is one tab stop", stops(dots).length === 1);
    check("swatch puts that tab stop on the chosen colour",
      stops(dots).length === 1 && stops(dots)[0] === checked(dots)[0]);
    check("swatch names a dot it cannot translate",
      dots.length > 0 && dots[0].getAttribute("aria-label") === sw.colors()[0]);

    sw.set("#ffb454");
    check("swatch set() moves the mark",
      checked(dots).length === 1 && checked(dots)[0].dataset.pick === "#FFB454");
    check("swatch set() is not a pick", swPicked.length === 0);
    /* A record carrying a colour from outside the ten (a hand-edited import)
       must leave the group reachable rather than tab-stop-less. */
    sw.set("#123456");
    check("swatch marks nothing for a colour it does not hold", checked(dots).length === 0);
    check("swatch keeps its one tab stop anyway",
      stops(dots).length === 1 && stops(dots)[0] === dots[0]);

    /* --- emojiPicker: folded until it is asked for --------------------- */
    var epPicked = [];
    var ep = emojiPicker({ value: "💰", onPick: function (icon) { epPicked.push(icon); } });
    var epToggle = deep(ep.element, "emojipicker__toggle")[0];
    var epSheet = deep(ep.element, "emojipicker__sheet")[0];

    check("emojiPicker wrapper", cls(ep.element) === "emojipicker");
    check("emojiPicker toggle is a button",
      epToggle && epToggle.tagName === "BUTTON" && epToggle.getAttribute("type") === "button");
    check("emojiPicker toggle wears .btn.is-quiet", cls(epToggle).indexOf("btn is-quiet") === 0);
    check("emojiPicker starts folded", epToggle.getAttribute("aria-expanded") === "false");
    check("emojiPicker toggle is wired to its sheet",
      epSheet && epToggle.getAttribute("aria-controls") === epSheet.getAttribute("id"));
    check("emojiPicker folded sheet is empty in the DOM", kids(epSheet).length === 0);
    check("emojiPicker folded sheet is hidden", epSheet.hidden === true);
    check("emojiPicker shows the icon it was given",
      deep(ep.element, "emojipicker__current")[0].textContent === "💰");
    /* The glyph is decoration; the words beside it in .sr are the name. */
    check("emojiPicker toggle has a name", deep(epToggle, "sr").length === 1);

    ep.setOpen(true);
    var epGrid = deep(epSheet, "emojis")[0];
    var ones = deep(epSheet, "emojis__one");
    check("emojiPicker unfolds", epToggle.getAttribute("aria-expanded") === "true" && epSheet.hidden === false);
    check("emoji grid is a radiogroup", epGrid && epGrid.getAttribute("role") === "radiogroup");
    check("emoji grid holds forty icons", ones.length === 40);
    check("emoji grid marks the current icon",
      checked(ones).length === 1 && checked(ones)[0].dataset.pick === "💰");
    check("emoji grid is one tab stop", stops(ones).length === 1);
    check("emoji grid draws the glyph itself", ones.length > 0 && ones[0].textContent === "💰");
    check("emojiPicker offers a box for an icon of one's own",
      deep(epSheet, "emojipicker__own").length === 1);

    ep.setOpen(false);
    check("emojiPicker refolds to empty", kids(epSheet).length === 0 && epSheet.hidden === true);
    ep.set("🏠");
    check("emojiPicker set() repaints the face",
      deep(ep.element, "emojipicker__current")[0].textContent === "🏠");
    check("emojiPicker set() is not a pick", epPicked.length === 0);
    check("emojiPicker reports the icon", ep.value() === "🏠");

    /* --- chips: the one horizontal scroller ---------------------------- */
    var chipSeen = [];
    var strip = chips({
      items: [
        { id: "a_1", name: "Garanti", icon: "🏦", value: 125000, color: "#8AA6FF" },
        { id: "a_2", name: "Nakit", icon: "👛", value: -4500, current: true }
      ],
      onSelect: function (item) { chipSeen.push(item.id); },
      onAdd: function () { chipSeen.push("add"); }
    });
    var chipNodes = deep(strip.element, "chip");

    check("chips wrapper", cls(strip.element) === "chips");
    check("chips is a toolbar", strip.element.getAttribute("role") === "toolbar");
    check("chips built one per account and one to add", chipNodes.length === 3);
    check("chips are real controls",
      chipNodes[0].tagName === "BUTTON" && chipNodes[0].getAttribute("type") === "button");
    check("a chip carries icon, name and value",
      deep(chipNodes[0], "chip__icon").length === 1 &&
      deep(chipNodes[0], "chip__name").length === 1 &&
      deep(chipNodes[0], "chip__value").length === 1);
    check("a chip formats its balance as money",
      deep(chipNodes[0], "chip__value")[0].textContent.indexOf("250") !== -1);
    check("a chip keeps its minor units", deep(chipNodes[0], "chip__value")[0].dataset.minor === "125000");
    check("chips emits .is-add last",
      cls(chipNodes[chipNodes.length - 1]).indexOf("is-add") !== -1 &&
      chipNodes.filter(function (node) {
        return (" " + cls(node) + " ").indexOf(" is-add ") !== -1;
      }).length === 1);
    check("the add chip is labelled, not punctuated",
      deep(chipNodes[2], "chip__name").length === 1);
    check("chips is one tab stop", stops(chipNodes).length === 1);
    check("chips puts that tab stop on the account being shown",
      stops(chipNodes)[0] === chipNodes[1]);

    /* --- expandRow: open in place, no tab stop while closed ------------ */
    var exSeen = [];
    var ex = expandRow({
      id: "ex-test",
      summary: [dom.el("span", { "class": "holding__name" }, "THYAO")],
      detail: function () { return dom.el("button", { "class": "btn", type: "button" }, "x"); },
      summaryClass: "holding",
      detailClass: "holding__detail",
      onToggle: function (open) { exSeen.push(open); }
    });

    check("expandRow wrapper", cls(ex.element) === "expandrow");
    check("expandRow summary is a real button",
      ex.summary.tagName === "BUTTON" && ex.summary.getAttribute("type") === "button");
    check("expandRow wears the classes the view asked for",
      cls(ex.summary) === "holding" && cls(ex.detail) === "holding__detail");
    check("expandRow summary says it is closed", ex.summary.getAttribute("aria-expanded") === "false");
    check("expandRow summary is wired to its detail",
      ex.summary.getAttribute("aria-controls") === ex.detail.getAttribute("id"));
    /* The attribute, not a class: a closed row must cost nothing to Tab past. */
    check("expandRow detail is out of the tab order while closed", ex.detail.hidden === true);
    check("expandRow detail is unbuilt while closed", kids(ex.detail).length === 0);
    check("expandRow said nothing to its caller yet", exSeen.length === 0);

    ex.setOpen(true);
    check("expandRow opens", ex.isOpen() === true && ex.summary.getAttribute("aria-expanded") === "true");
    check("expandRow detail enters the tab order", ex.detail.hidden === false);
    check("expandRow builds the detail on the first open", kids(ex.detail).length === 1);
    check("expandRow marks the open row", ex.summary.classList.contains("is-open"));
    check("expandRow told its caller once", exSeen.length === 1 && exSeen[0] === true);

    ex.toggle();
    check("expandRow closes again", ex.isOpen() === false && ex.detail.hidden === true);
    check("expandRow keeps what it built", kids(ex.detail).length === 1);
    check("expandRow reported both moves", exSeen.length === 2 && exSeen[1] === false);

    /* A row asked to start open arrives with its detail already built: a view
       redrawing an open row would otherwise paint it empty until the reader
       pressed the toggle twice. */
    var exOpen = expandRow({
      id: "ex-open",
      open: true,
      summary: "s",
      detail: function () { return dom.el("p", { "class": "prose" }, "d"); }
    });
    check("expandRow can start open", exOpen.isOpen() === true && exOpen.detail.hidden === false);
    check("expandRow builds the detail it starts with", kids(exOpen.detail).length === 1);
    /* Built closed on purpose. The point of the check is the DEFAULT naming a
       view gets when it passes no summaryClass or detailClass, and an open row
       also carries the open modifier — asserting the whole class string against
       one name would be asserting that the row is shut, which is a different
       thing and is already checked above. */
    var exNamed = expandRow({ id: "ex-named", summary: "s", detail: "d" });
    check("expandRow names its own parts when the view does not",
      cls(exNamed.summary) === "expandrow__summary" && cls(exNamed.detail) === "expandrow__detail");
    check("expandRow adds the open mark to the summary as well as the wrapper",
      cls(exOpen.summary).indexOf("expandrow__summary") === 0 &&
      cls(exOpen.summary).indexOf("is-open") !== -1);

    /* --- every key this file names must exist in the catalogue ---------- */
    var I18n = Moon.I18n;
    if (I18n && typeof I18n.has === "function") {
      [
        "common.close", "common.undo", "common.undoSeconds", "common.confirm",
        "common.cancel", "common.showNumbers", "err.badDate", "form.dateHint",
        "a11y.markOver", "a11y.markRecurring", "a11y.markUnconfirmed", "money.invalid",
        /* The fallbacks the two new pickers and the chip strip lean on while
           form.color, form.icon and a11y.accounts are not in the catalogue. */
        "common.more", "common.add", "nav.accounts", "accounts.addChip"
      ].forEach(function (key) {
        check("key " + key, I18n.has(key));
      });
    }

    return { passed: passed, failed: failed };
  }

  /* ---------------------------------------------------------------- export */

  Moon.UI = {
    _selftest: selftest,
    /* The class moon.css folds the phone rail away with, and the only way a
       view or a test can name that state without guessing the string. */
    TYPING_CLASS: TYPING_CLASS,
    section: section,
    hero: hero,
    moneyCell: moneyCell,
    mark: mark,
    field: field,
    form: form,
    quickRow: quickRow,
    inlineValue: inlineValue,
    swatch: swatch,
    tone: tone,
    emojiPicker: emojiPicker,
    chips: chips,
    expandRow: expandRow,
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
