/* The other suites load the DOM-free half of Moon. This one loads all of it.
 *
 * charts.js, ui.js, sample.js and the views are where most of the interface
 * lives, and each of them carries its own _selftest() too — but they need
 * something to build nodes against, so without a stand-in for the browser their
 * checks never run anywhere except a real page. That left three suites and
 * every view outside CI.
 *
 * The stand-in below is deliberately thin: it can hold a tree, attributes and
 * classes, and nothing else. Nothing here lays anything out, so a test must not
 * ask about geometry — getBoundingClientRect answers zeroes and means it.
 *
 * Where it is NOT thin is node identity. An earlier version of this file built
 * nodes without a nodeType, and ui.js asks `typeof value.nodeType === "number"`
 * before it will treat anything as a node: every view's markup was therefore
 * taken for a plain object, and UI.section stringified the whole body into
 * "<p class=\"prose\">[object Object]</p>". The suite stayed green because
 * nothing here ever read the markup back, which made a green tick on nine views
 * mean nothing at all. The stand-in now copies the browser — rather than
 * guessing — wherever Moon asks a node about itself:
 *   - every node carries a nodeType (element 1, text 3, comment 8, fragment 11)
 *     and appendChild flattens a fragment the way a browser moves its children;
 *   - assigning textContent leaves a real text node behind, so text a view
 *     writes that way is reachable by walking the tree, not hidden in a closure;
 *   - `children` is elements only while `childNodes` is everything, which is
 *     what ui.js's own selftest walks;
 *   - `class`, `hidden`, `disabled`, `dataset` and a <select>'s options are the
 *     attributes themselves, not a second private copy a test could agree with
 *     while the page carried something else;
 *   - dom.qs/dom.qsa answer over the tree, because a view stamping a class on a
 *     part it did not name is a step that otherwise silently never happened.
 *
 * What it still cannot see: anything a chart draws. Moon.Charts returns SVG as
 * a markup string and dom.svg() hands it to DOMParser, which is stubbed here —
 * so .kindbar, the seismograph and the allowance trail exist on the page and
 * not in this tree. A chart has to be read in a browser or in charts.js's own
 * selftest, never asserted about here.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { scriptOrder, ROOT } = require("./load.js");

/* The four node kinds this stand-in can hold, by their DOM constants, because
   that is the vocabulary ui.js and core.js test against. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const FRAGMENT_NODE = 11;

/* A text node has to be a real member of the tree: Moon writes most of its
   words through `textContent`, and a test that cannot walk down to them is
   blind to every label in the app. */
function makeText(data, type) {
  let value = data === null || data === undefined ? "" : String(data);
  const node = {
    nodeType: type || TEXT_NODE,
    nodeName: (type || TEXT_NODE) === COMMENT_NODE ? "#comment" : "#text",
    parentNode: null,
    childNodes: [],
    children: []
  };
  Object.defineProperty(node, "textContent", {
    enumerable: true,
    configurable: true,
    get() { return value; },
    set(next) { value = next === null || next === undefined ? "" : String(next); }
  });
  Object.defineProperty(node, "nodeValue", {
    enumerable: false,
    configurable: true,
    get() { return value; },
    set(next) { node.textContent = next; }
  });
  return node;
}

/* ------------------------------------------------ the selector it can answer */

/* Moon reaches back into markup it has just built with dom.qs/dom.qsa — to
 * stamp a second class on a part it did not name itself, to collect the
 * controls of a row, to find the focusable children of a dialog. A stand-in
 * that answers null to all of that silently skips every one of those steps, so
 * this file can match the handful of CSS shapes the app really uses: a tag, an
 * id, a class, an attribute with or without a value, :not() around any of
 * those, a comma-separated list, and the descendant combinator. Anything else
 * throws by name rather than answering nothing, because a quiet empty answer is
 * exactly the blindness this harness is here to end.
 */

/** Splits on `sep` at the top level, so a space or comma inside [..] or (..)
 *  or a quoted value stays where the author put it. */
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "[" || ch === "(") depth += 1;
    if (ch === "]" || ch === ")") depth -= 1;
    if (ch === sep && depth === 0) { out.push(current); current = ""; continue; }
    current += ch;
  }
  out.push(current);
  return out.map((one) => one.trim()).filter(Boolean);
}

const TAG_PART = /^(?:\*|[a-zA-Z][\w-]*)/;
const ID_PART = /^#([\w-]+)/;
const CLASS_PART = /^\.([\w-]+)/;
const ATTR_PART = /^\[([\w-]+)(?:([~|^$*]?=)\s*("[^"]*"|'[^']*'|[^\]]+))?\]/;
const NOT_PART = /^:not\(([^()]*)\)/;

function parseCompound(text, whole) {
  const compound = { tag: null, id: null, classes: [], attrs: [], nots: [] };
  let rest = text.trim();
  while (rest) {
    let match = TAG_PART.exec(rest);
    if (match) {
      if (match[0] !== "*") compound.tag = match[0].toUpperCase();
    } else if ((match = ID_PART.exec(rest))) {
      compound.id = match[1];
    } else if ((match = CLASS_PART.exec(rest))) {
      compound.classes.push(match[1]);
    } else if ((match = ATTR_PART.exec(rest))) {
      if (match[2] && match[2] !== "=") {
        throw new Error(`the test stand-in cannot match ${JSON.stringify(whole)}: only [attr] and [attr="value"]`);
      }
      compound.attrs.push({
        name: match[1],
        value: match[3] === undefined ? null : match[3].replace(/^["']|["']$/g, "")
      });
    } else if ((match = NOT_PART.exec(rest))) {
      compound.nots.push(parseCompound(match[1], whole));
    } else {
      throw new Error(`the test stand-in cannot match ${JSON.stringify(whole)}: it stops at ${JSON.stringify(rest)}`);
    }
    rest = rest.slice(match[0].length).trim();
  }
  return compound;
}

function parseSelector(selector) {
  return splitTop(String(selector), ",").map((one) =>
    splitTop(one, " ").map((part) => parseCompound(part, selector)));
}

function matchCompound(node, compound) {
  if (!node || node.nodeType !== ELEMENT_NODE) return false;
  if (compound.tag && node.tagName !== compound.tag) return false;
  if (compound.id && node.getAttribute("id") !== compound.id) return false;
  if (compound.classes.some((name) => !node.classList.contains(name))) return false;
  const attrsFit = compound.attrs.every((attr) => {
    if (!node.hasAttribute(attr.name)) return false;
    return attr.value === null || node.getAttribute(attr.name) === attr.value;
  });
  if (!attrsFit) return false;
  return !compound.nots.some((not) => matchCompound(node, not));
}

/* Right to left, as a browser does it: match the last compound on the node
   itself, then find each earlier one somewhere above it. Only the descendant
   combinator is supported, and for that the nearest matching ancestor is always
   a safe choice, because ancestors are a single chain. */
function matchParts(node, parts) {
  if (!matchCompound(node, parts[parts.length - 1])) return false;
  let at = node.parentNode;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    while (at && !matchCompound(at, parts[i])) at = at.parentNode;
    if (!at) return false;
    at = at.parentNode;
  }
  return true;
}

/** Descendants of `root` that match, in tree order. Never `root` itself, which
 *  is also what a browser answers. */
function queryAll(root, selector) {
  const groups = parseSelector(selector);
  const out = [];
  (function walk(node) {
    (node.childNodes || []).forEach((child) => {
      if (!child || child.nodeType !== ELEMENT_NODE) return;
      if (groups.some((parts) => matchParts(child, parts))) out.push(child);
      walk(child);
    });
  }(root));
  return out;
}

/* dataset.i18nLabel is the attribute data-i18n-label, both ways round. */
function dashed(key) {
  return String(key).replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase());
}

function camelled(name) {
  return String(name).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function makeNode(tag = "div", nodeType = ELEMENT_NODE) {
  const name = String(tag).toUpperCase();
  const node = {
    nodeType: nodeType,
    nodeName: nodeType === FRAGMENT_NODE ? "#document-fragment" : name,
    childNodes: [], attributes: {},
    ownerDocument: null,
    /* It remembers what was written and lays out nothing. A custom property is
       the only styling Moon's views are allowed to set from JavaScript — a
       record's colour as --tone, an inlineValue's width as --iv-ch — so the
       values have to be readable back even though no box is ever measured. */
    style: (function () {
      const own = new Map();
      return {
        setProperty(prop, value) { own.set(String(prop), value === null || value === undefined ? "" : String(value)); },
        removeProperty(prop) {
          const had = own.get(String(prop)) ?? "";
          own.delete(String(prop));
          return had;
        },
        getPropertyValue(prop) { return own.get(String(prop)) ?? ""; },
        item(i) { return Array.from(own.keys())[i] ?? ""; },
        get length() { return own.size; }
      };
    }()),
    parentNode: null,
    innerHTML: "", value: "",
    tabIndex: -1, offsetParent: null,
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return k in this.attributes; },
    appendChild(c) {
      if (!c) return c;
      /* A fragment is a carrier, not a node you can see: appending one moves
         its children and leaves it empty. UI.content() returns a fragment for
         every array a view hands it, so without this the tree would be one
         phantom level deeper than the page's and no selector would match. */
      if (c.nodeType === FRAGMENT_NODE) {
        c.childNodes.slice().forEach((grand) => this.appendChild(grand));
        c.childNodes.length = 0;
        return c;
      }
      if (c.parentNode && typeof c.parentNode.removeChild === "function") c.parentNode.removeChild(c);
      this.childNodes.push(c);
      c.parentNode = this;
      return c;
    },
    insertBefore(c, ref) {
      if (!c) return c;
      if (c.nodeType === FRAGMENT_NODE) {
        c.childNodes.slice().forEach((grand) => this.insertBefore(grand, ref));
        c.childNodes.length = 0;
        return c;
      }
      const at = ref ? this.childNodes.indexOf(ref) : -1;
      if (at === -1) return this.appendChild(c);
      if (c.parentNode && typeof c.parentNode.removeChild === "function") c.parentNode.removeChild(c);
      this.childNodes.splice(at, 0, c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i !== -1) this.childNodes.splice(i, 1);
      if (c && c.parentNode === this) c.parentNode = null;
      return c;
    },
    replaceChildren(...next) {
      this.childNodes.slice().forEach((c) => this.removeChild(c));
      next.forEach((c) => this.appendChild(c));
    },
    /* A node contains itself, as it does in a browser: views.data.js asks
       document.contains(root) before it will redraw, and the three other views
       with a self-repaint ask the same of their own root. */
    contains(other) {
      for (let at = other; at; at = at.parentNode) if (at === this) return true;
      return false;
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    querySelector(selector) { return queryAll(this, selector)[0] ?? null; },
    querySelectorAll(selector) { return queryAll(this, selector); },
    closest(selector) {
      const groups = parseSelector(selector);
      for (let at = this; at; at = at.parentNode) {
        if (groups.some((parts) => matchParts(at, parts))) return at;
      }
      return null;
    },
    focus() {
      const doc = this.ownerDocument;
      if (doc) doc.activeElement = this;
    },
    blur() {
      const doc = this.ownerDocument;
      if (doc && doc.activeElement === this) doc.activeElement = doc.body;
    },
    click() {}, select() {},
    showModal() {}, close() {}, scrollIntoView() {},
    /* ui.js decides a control is reachable by asking for its client rects, and
       an empty list is its answer for "not on screen" — which is how it keeps a
       folded quickrow sheet and a closed row's detail out of a dialog's focus
       trap. So: no rects for a node outside the document or under a `hidden`
       ancestor, one zero-sized rect for anything else. Nothing here lays
       anything out, so a test still must not read the numbers. */
    getClientRects() {
      for (let at = this; at; at = at.parentNode) {
        if (at.nodeType === ELEMENT_NODE && at.hasAttribute("hidden")) return [];
        if (at.nodeType === 9) return [{ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }];
      }
      return [];
    },
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 })
  };

  if (nodeType === ELEMENT_NODE) node.tagName = name;

  /* dataset IS the data-* attributes. The ledger finds its rows by [data-row],
     the views park focus on [data-focus] and ui.js remembers a row's minor
     units in data-minor — all written through dataset and all read back as
     attributes, so a private bag here would answer every one of those
     selectors with nothing. */
  Object.defineProperty(node, "dataset", {
    enumerable: false,
    configurable: true,
    value: new Proxy({}, {
      get(_, key) {
        if (typeof key !== "string") return undefined;
        const found = node.getAttribute("data-" + dashed(key));
        return found === null ? undefined : found;
      },
      set(_, key, value) {
        node.setAttribute("data-" + dashed(key), value);
        return true;
      },
      has(_, key) { return node.hasAttribute("data-" + dashed(key)); },
      deleteProperty(_, key) {
        node.removeAttribute("data-" + dashed(key));
        return true;
      },
      ownKeys() {
        return Object.keys(node.attributes)
          .filter((k) => k.indexOf("data-") === 0)
          .map((k) => camelled(k.slice(5)));
      },
      getOwnPropertyDescriptor(_, key) {
        if (!node.hasAttribute("data-" + dashed(key))) return undefined;
        return {
          value: node.getAttribute("data-" + dashed(key)),
          enumerable: true, configurable: true, writable: true
        };
      }
    })
  });

  /* `children` is elements only and `childNodes` is everything. ui.js's own
     selftest walks `children` looking for a class, so a text node counted as
     an element there would make it search inside the words. */
  Object.defineProperty(node, "children", {
    enumerable: true,
    configurable: true,
    get() { return this.childNodes.filter((c) => c && c.nodeType === ELEMENT_NODE); }
  });

  [["firstChild", (kids) => kids[0]], ["lastChild", (kids) => kids[kids.length - 1]]]
    .forEach(([prop, pick]) => {
      Object.defineProperty(node, prop, {
        enumerable: true,
        configurable: true,
        get() { return pick(this.childNodes) ?? null; }
      });
    });

  [["nextSibling", 1], ["previousSibling", -1]].forEach(([prop, step]) => {
    Object.defineProperty(node, prop, {
      enumerable: true,
      configurable: true,
      get() {
        const parent = this.parentNode;
        if (!parent) return null;
        const at = parent.childNodes.indexOf(this);
        return at === -1 ? null : (parent.childNodes[at + step] ?? null);
      }
    });
  });

  Object.defineProperty(node, "parentElement", {
    enumerable: false,
    configurable: true,
    get() {
      const parent = this.parentNode;
      return parent && parent.nodeType === ELEMENT_NODE ? parent : null;
    }
  });

  /* classList and the class attribute are one thing, as they are in a browser.
     Half the state in the class contract (.is-open, .is-archived, .is-invalid)
     is set through classList and read back through getAttribute("class"), and
     two private copies would let a test agree with itself about a class the
     page never carries. */
  Object.defineProperty(node, "classList", {
    enumerable: false,
    configurable: true,
    value: {
      _read() { return String(node.getAttribute("class") || "").split(/\s+/).filter(Boolean); },
      _write(list) {
        if (list.length) node.setAttribute("class", list.join(" "));
        else node.removeAttribute("class");
      },
      add(...names) {
        const list = this._read();
        names.forEach((one) => { if (one && list.indexOf(one) === -1) list.push(one); });
        this._write(list);
      },
      remove(...names) {
        this._write(this._read().filter((one) => names.indexOf(one) === -1));
      },
      toggle(one, on) {
        const want = on === undefined ? !this.contains(one) : !!on;
        if (want) this.add(one);
        else this.remove(one);
        return want;
      },
      contains(one) { return this._read().indexOf(one) !== -1; },
      get length() { return this._read().length; },
      item(i) { return this._read()[i] ?? null; }
    }
  });

  /* `hidden` and `disabled` are their attributes, not second flags beside
     them. UI folds the quickrow sheet, the undo strip and every error line with
     the property and opens them with the attribute, and it builds a disabled
     control from the attribute while form.focusFirst skips it by the property —
     two private copies would let a test read whichever one agrees with it. */
  ["hidden", "disabled"].forEach((prop) => {
    Object.defineProperty(node, prop, {
      enumerable: true,
      configurable: true,
      get() { return this.hasAttribute(prop); },
      set(next) {
        if (next) this.setAttribute(prop, "");
        else this.removeAttribute(prop);
      }
    });
  });

  /* Assigning textContent replaces the children with one text node, which is
     what a browser does and what makes the words findable by walking the tree.
     Reading it concatenates the descendants: a label built as
     [text, <span>*</span>] is the shape half the interface uses to mark a
     required field, and ui.js reads such a label back to make the control's
     title and placeholder. */
  Object.defineProperty(node, "textContent", {
    enumerable: true,
    configurable: true,
    get() {
      return this.childNodes.map((c) => (c && c.textContent) || "").join("");
    },
    set(value) {
      this.childNodes.slice().forEach((c) => this.removeChild(c));
      const text = value === null || value === undefined ? "" : String(value);
      if (text !== "") this.appendChild(makeText(text));
    }
  });

  if (name === "SELECT") {
    /* ui.js clears a <select> by walking its options for the one carrying the
       `selected` attribute rather than by writing "" into it, because a select
       has no empty value unless somebody put an empty option in it. Without
       these three the clearing path was never taken here, and views.plan.js
       reads `select.options.length` outright. */
    Object.defineProperty(node, "options", {
      enumerable: false,
      configurable: true,
      get() { return this.children.filter((c) => c.tagName === "OPTION"); }
    });
    Object.defineProperty(node, "selectedIndex", {
      enumerable: false,
      configurable: true,
      get() {
        const options = this.options;
        for (let i = 0; i < options.length; i += 1) {
          if (String(options[i].getAttribute("value") ?? "") === String(this.value ?? "")) return i;
        }
        return -1;
      },
      set(i) {
        const option = this.options[i];
        this.value = option ? String(option.getAttribute("value") ?? "") : "";
      }
    });
  }

  if (name === "OPTION") {
    Object.defineProperty(node, "defaultSelected", {
      enumerable: false,
      configurable: true,
      get() { return this.hasAttribute("selected"); }
    });
  }

  return node;
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  get length() { return this.map.size; }
}

/** Loads every script index.html declares, against the stand-in above, and
 *  answers with the window it loaded them into. */
function loadAll(options = {}) {
  /* Moon logs a swallowed render failure through console.error and carries on
     with half a screen. Keeping the lines lets a failing assertion say WHY the
     markup is missing instead of only that it is. */
  const logged = [];
  const console_ = {
    log() {}, info() {}, debug() {},
    warn() {}, /* a missing i18n key warns once; the raw-key test reads the markup */
    error(...args) { logged.push(args.map((a) => (a && a.stack) || String(a)).join(" ")); }
  };

  const document_ = {
    nodeType: 9,
    nodeName: "#document",
    readyState: "complete",
    createElement: (tag) => own(makeNode(tag)),
    createElementNS: (ns, tag) => own(makeNode(tag)),
    createTextNode: (text) => makeText(text),
    createComment: (text) => makeText(text, COMMENT_NODE),
    createDocumentFragment: () => own(makeNode("fragment", FRAGMENT_NODE)),
    /* index.html itself is not parsed here, so the only thing in this document
       is what a test mounts. These answer over that, which is why a view's own
       dom.qs into its own subtree works and app.js's hunt for #view does not. */
    getElementById(id) { return this.querySelector("#" + id); },
    querySelector(selector) { return queryAll(this, selector)[0] ?? null; },
    querySelectorAll(selector) { return queryAll(this, selector); },
    addEventListener() {}, removeEventListener() {},
    importNode: (node) => node,
    contains(node) {
      return node === this || this.documentElement.contains(node);
    }
  };

  function own(node) {
    node.ownerDocument = document_;
    return node;
  }

  document_.documentElement = own(makeNode("html"));
  document_.documentElement.lang = "en";
  /* A document holds its root element as a child, which is what makes a query
     on the document reach the page and a walk up from a mounted node arrive
     somewhere that says "yes, this is on screen". */
  document_.childNodes = [document_.documentElement];
  document_.documentElement.parentNode = document_;
  document_.head = own(makeNode("head"));
  document_.body = own(makeNode("body"));
  document_.documentElement.appendChild(document_.head);
  document_.documentElement.appendChild(document_.body);
  document_.activeElement = document_.body;

  const sandbox = {
    console: console_,
    JSON, Object, Array, String, Number, Math, Date, RegExp, Map, Set, WeakMap,
    Promise, Error, TypeError, RangeError, Symbol,
    parseInt, parseFloat, isNaN, isFinite, structuredClone,
    Intl, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    location: { hash: "#panel", href: "file:///moon/index.html", search: "", pathname: "/" },
    navigator: { language: "en-US", languages: ["en-US"] },
    matchMedia: () => ({
      matches: false, addEventListener() {}, removeEventListener() {}, addListener() {},
    }),
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    /* Charts arrive as SVG markup strings and dom.svg() hands them here. An
       empty <svg> is as far as this stand-in goes, which is why no test in this
       file may assert anything about a chart's insides — charts.js proves its
       own drawing from the strings, before any of this. */
    DOMParser: class { parseFromString() { return { documentElement: own(makeNode("svg")) }; } },
    FileReader: class { readAsArrayBuffer() {} readAsText() {} },
    Blob: class {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    CSS: { supports: () => true },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    document: document_
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  /* Read as win.logged by a failing assertion that wants to say why a view drew
     nothing; the views swallow a render failure and carry on with half a
     screen, so the line console.error got is the only account of it. */
  sandbox.logged = logged;

  vm.createContext(sandbox);
  for (const rel of scriptOrder()) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
  }

  /* A pinned day makes period arithmetic repeatable: a test written on the 30th
     must not behave differently when it runs on the 1st. */
  if (options.today) sandbox.Moon.Dates.today = () => options.today;
  return sandbox;
}

/* Self-tests report in four shapes, and reading only one of them would count a
   real failure as zero. */
function normalise(report) {
  if (!report || typeof report !== "object") return { count: 0, failures: ["no report"] };

  const failures = Array.isArray(report.failed) ? report.failed
    : Array.isArray(report.failures) ? report.failures
      : Array.isArray(report.results) ? report.results.filter((x) => !x.ok).map((x) => x.name)
        : [];

  let count = failures.length;
  if (!count && typeof report.failed === "number") count = report.failed;
  if (!count && typeof report.fail === "number") count = report.fail;
  if (!count && report.ok === false) count = 1;

  const passed = report.passed ?? report.pass ?? report.checks ?? report.total ?? 0;
  return { count, failures, passed };
}

/* ------------------------------------------------------- reading the markup */

/* Every section of the app, in the order index.html declares their scripts.
   The router looks these up by name; a view that fails to register leaves a
   section of the app blank, and nothing else would notice. */
const VIEW_NAMES = ["panel", "ledger", "limits", "recurring", "goals", "debts",
  "accounts", "investments", "data"];

/** Every text node under `node`, as written. */
function allText(node, out = []) {
  if (!node) return out;
  if (node.nodeType === TEXT_NODE) {
    out.push(String(node.textContent || ""));
    return out;
  }
  if (node.nodeType === COMMENT_NODE) return out;
  (node.childNodes || []).forEach((child) => allText(child, out));
  return out;
}

/** The text a reader gets: the same walk, minus anything the view folded away
 *  with `hidden` (a quickrow's extra sheet, a closed holding's detail). */
function readableText(node, out = []) {
  if (!node) return out;
  if (node.nodeType === TEXT_NODE) {
    out.push(String(node.textContent || ""));
    return out;
  }
  if (node.nodeType !== ELEMENT_NODE) return out;
  if (node.hasAttribute && node.hasAttribute("hidden")) return out;
  (node.childNodes || []).forEach((child) => readableText(child, out));
  return out;
}

/** Strings a reader hears or sees on hover rather than reads in place. */
const SPOKEN_ATTRS = ["aria-label", "title", "placeholder"];

function spokenText(node, out = []) {
  if (!node || node.nodeType !== ELEMENT_NODE) return out;
  SPOKEN_ATTRS.forEach((name) => {
    const value = node.getAttribute(name);
    if (value) out.push(value);
  });
  (node.childNodes || []).forEach((child) => spokenText(child, out));
  return out;
}

/** Every element under `node`, itself included. */
function allElements(node, out = []) {
  if (!node || node.nodeType !== ELEMENT_NODE) return out;
  out.push(node);
  (node.childNodes || []).forEach((child) => allElements(child, out));
  return out;
}

/* The catalogue's own first segments — "ledger", "accounts", "err" and the
   rest. A key that reached the screen untranslated looks exactly like one of
   its own names, and matching on the shape alone would also accuse a file name
   like "moon.json", so the namespace has to be one the catalogue really uses. */
function namespaces(Moon) {
  const out = new Set();
  Object.keys(Moon.Lang || {}).forEach((code) => {
    Object.keys(Moon.Lang[code] || {}).forEach((key) => {
      const head = String(key).split(".")[0];
      if (head) out.add(head);
    });
  });
  return out;
}

const DOTTED = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;

/** The dotted tokens in `strings` that name a catalogue namespace — the
 *  signature of a key the catalogue has not grown yet. */
function rawKeys(strings, known) {
  const found = new Set();
  strings.forEach((text) => {
    String(text).split(/[\s,;()[\]"'·]+/).forEach((word) => {
      const token = word.replace(/[.:!?]+$/, "");
      if (!DOTTED.test(token)) return;
      if (known.has(token.split(".")[0])) found.add(token);
    });
  });
  return Array.from(found).sort();
}

/** A host inside document.body, because a view that asks whether it is still
 *  on screen before redrawing must be able to answer yes. */
function mount(win) {
  const host = win.document.createElement("div");
  host.setAttribute("id", "view");
  win.document.body.appendChild(host);
  return host;
}

/** Renders one view into a fresh window and hands back what it drew. */
function draw(name, options = {}) {
  const win = loadAll({ today: options.today || "2026-09-15" });
  if (options.sample) win.Moon.Sample.apply();
  const host = mount(win);
  win.Moon.Views[name].render(host);
  return { win, host, Moon: win.Moon };
}

/* --------------------------------------------------------------- the suite */

test("every script index.html declares loads, in that order", () => {
  const Moon = loadAll().Moon;
  const declared = scriptOrder();

  assert.ok(declared.length >= 19, `index.html declares ${declared.length} scripts`);

  for (const branch of ["util", "bus", "dom", "Money", "Dates", "I18n", "Store",
    "Model", "CSV", "Importer", "Charts", "UI", "Sample", "Views", "App"]) {
    assert.ok(Moon[branch], `Moon.${branch} is missing after loading every file`);
  }
});

test("every section is registered and can be rendered", () => {
  const Moon = loadAll().Moon;
  for (const view of VIEW_NAMES) {
    assert.ok(Moon.Views[view], `Moon.Views.${view} is missing`);
    assert.equal(typeof Moon.Views[view].render, "function",
      `Moon.Views.${view}.render must be a function`);
  }
});

/* The stand-in's own tripwire. Everything below it reads markup back out of the
   tree, and all of that silently measures nothing the moment a node stops
   looking like a node to ui.js — which is the state this file shipped in. */
test("the browser stand-in is node-shaped enough for ui.js to build into", () => {
  const win = loadAll();
  const Moon = win.Moon;

  const node = win.document.createElement("p");
  assert.equal(node.nodeType, 1, "an element the stand-in makes must have nodeType 1");
  assert.equal(win.document.createTextNode("x").nodeType, 3);
  assert.equal(win.document.createDocumentFragment().nodeType, 11);

  /* A fragment hands its children over instead of joining the tree itself. */
  const host = win.document.createElement("div");
  host.appendChild(Moon.dom.frag([Moon.dom.el("i"), Moon.dom.el("b")]));
  assert.deepEqual(host.children.map((c) => c.tagName), ["I", "B"]);

  /* Text written through textContent stays readable by walking the tree, and
     `children` counts elements while `childNodes` counts the words too. */
  const label = Moon.dom.el("label", null, ["Amount", Moon.dom.el("span", null, "*")]);
  assert.equal(label.textContent, "Amount*");
  assert.equal(allText(label).join(""), "Amount*");
  assert.equal(label.children.length, 1);
  assert.equal(label.childNodes.length, 2);

  const written = Moon.dom.el("b");
  written.textContent = "42";
  assert.equal(allText(written).join(""), "42");

  /* classList and the class attribute are the same thing; `hidden` is the
     attribute. */
  const flagged = Moon.dom.el("div", { "class": "holding" });
  flagged.classList.add("is-open");
  assert.equal(flagged.getAttribute("class"), "holding is-open");
  assert.ok(flagged.classList.contains("holding"));
  flagged.hidden = true;
  assert.ok(flagged.hasAttribute("hidden"));

  /* And the shape this file used to get wrong: UI.section must carry the body
     it was given, not a paragraph reading "[object Object]". */
  const tree = Moon.dom.el("div", { "class": "holdings" }, [
    Moon.dom.el("div", { "class": "holding", dataset: { row: "h1" } }, [
      Moon.dom.el("span", { "class": "holding__name" }, "Gold"),
      Moon.dom.el("button", { "class": "btn", type: "button" }, "Open"),
      Moon.dom.el("button", { "class": "btn", type: "button", disabled: true }, "Sell")
    ])
  ]);
  assert.equal(tree.querySelectorAll(".holding__name").length, 1);
  assert.equal(tree.querySelectorAll(".holdings").length, 0, "a query must not answer with its own root");
  assert.equal(tree.querySelectorAll("[data-row]").length, 1);
  assert.equal(tree.querySelectorAll('[data-row="h1"]').length, 1);
  assert.equal(tree.querySelectorAll('[data-row="h2"]').length, 0);
  assert.equal(tree.querySelectorAll(".holding .btn").length, 2);
  assert.equal(tree.querySelectorAll(".holdings .holding span, button").length, 3);
  /* The shape UI.focusables is built from: a disabled control is not a stop. */
  assert.equal(tree.querySelectorAll("button:not([disabled])").length, 1);
  assert.equal(Moon.dom.qs(".holding__name", tree).textContent, "Gold");
  assert.equal(Moon.dom.qsa(".btn", tree).length, 2);
  const inner = tree.querySelector(".holding__name");
  assert.equal(inner.closest(".holdings"), tree);
  assert.equal(inner.closest(".holding__name"), inner, "closest starts at the node itself");
  /* Answering "nothing matched" to a selector it cannot parse is how a stand-in
     goes blind. It says so instead. */
  assert.throws(() => tree.querySelectorAll(".holdings > .holding"), /cannot match/);

  const section = Moon.UI.section({
    title: "Holdings",
    body: Moon.dom.el("ul", { "class": "holdings" }, Moon.dom.el("li", null, "Gold"))
  });
  const classes = allElements(section).map((el) => el.getAttribute("class") || "");
  assert.ok(classes.indexOf("holdings") !== -1,
    `UI.section dropped its body; it holds ${JSON.stringify(classes)}`);
  assert.ok(!section.textContent.includes("[object Object]"),
    "UI.section stringified its body instead of appending it");
});

for (const name of ["Charts", "UI", "Sample"]) {
  test(`Moon.${name}._selftest() passes`, () => {
    const Moon = loadAll({ today: "2026-09-15" }).Moon;
    const module = Moon[name];
    assert.ok(module, `Moon.${name} is missing`);
    assert.equal(typeof module._selftest, "function", `Moon.${name}._selftest is missing`);

    const { count, failures, passed } = normalise(module._selftest());
    assert.ok(passed > 0, `${name} ran no checks at all`);
    assert.deepEqual(Array.from(failures, String), [],
      `${name}: ${count} of ${passed} checks failed`);
  });
}

test("the suites together still cover a few hundred checks", () => {
  const Moon = loadAll({ today: "2026-09-15" }).Moon;
  const names = ["Money", "Dates", "Store", "Model", "CSV", "Importer", "Charts", "UI", "Sample"];

  const total = names.reduce((sum, name) => {
    const module = Moon[name];
    if (!module || typeof module._selftest !== "function") return sum;
    return sum + Number(normalise(module._selftest()).passed || 0);
  }, 0);

  /* Not a quality measure, a tripwire: if a refactor quietly drops a suite the
     count falls off a cliff instead of the build staying green. */
  assert.ok(total > 500, `expected more than 500 checks in total, counted ${total}`);
});

/* -------------------------------------------------------------- the screens */

/* Each view gets its own window so one view's store writes, open folds and
   remembered focus cannot decide what the next one draws. */
for (const sample of [false, true]) {
  const where = sample ? "with the sample month" : "with an empty store";

  test(`every view draws something readable ${where}`, () => {
    for (const name of VIEW_NAMES) {
      const { win, host } = draw(name, { sample });

      assert.ok(host.children.length > 0,
        `${name} rendered no elements at all${win.logged.length ? ` — it logged ${JSON.stringify(win.logged[0])}` : ""}`);

      const readable = readableText(host).join(" ").replace(/\s+/g, " ").trim();
      assert.ok(readable.length > 0,
        `${name} drew ${host.children.length} element(s) and not one word of text`);

      /* "[object Object]" is what a view gets when something it passed as
         markup was not recognised as a node and was stringified instead. */
      const stringified = allText(host).filter((text) => text.includes("[object Object]"));
      assert.deepEqual(stringified, [],
        `${name} stringified a node into its text: ${JSON.stringify(stringified)}`);
    }
  });

  test(`no view shows a raw i18n key ${where}`, () => {
    const complaints = [];
    for (const name of VIEW_NAMES) {
      const { host, Moon } = draw(name, { sample });
      const known = namespaces(Moon);

      const shown = rawKeys(readableText(host), known);
      if (shown.length) complaints.push(`${name} prints ${shown.join(", ")}`);

      /* A key copied into a title, a placeholder or an aria-label reaches a
         reader just as surely, and quickRow copies every label into two of
         those three. */
      const spoken = rawKeys(spokenText(host), known);
      if (spoken.length) complaints.push(`${name} names ${spoken.join(", ")} in a label a reader hears`);
    }
    assert.deepEqual(complaints, [],
      `a key the catalogue has not grown reached the screen:\n  ${complaints.join("\n  ")}`);
  });

  /* A record stores a hex so an export means the same colour next year; a theme
     stores a token because Dawn darkens all ten of the spectrum for contrast on
     white. Moon.UI.tone is the one place that joins them, answering
     "var(--cat-N, #HEX)" for a spectrum colour and the hex itself for anything
     else — so a view that writes the stored hex straight into --tone shows a
     reader on Dawn a different colour from the one they picked. */
  test(`every colour a view paints goes through UI.tone ${where}`, () => {
    const complaints = [];
    for (const name of VIEW_NAMES) {
      const { host, Moon } = draw(name, { sample });
      const wrong = new Map();
      allElements(host).forEach((element) => {
        const written = element.style.getPropertyValue("--tone");
        if (!written) return;
        const wanted = Moon.UI.tone(written);
        /* UI.tone answers a bare hex for a colour outside the ten, so a hex on
           the page is wrong only when the theme keeps a token for it. */
        if (wanted && wanted !== written) wrong.set(written, wanted);
      });
      wrong.forEach((wanted, written) => {
        complaints.push(`${name} writes --tone: ${written} where UI.tone(…) says ${wanted}`);
      });
    }
    assert.deepEqual(complaints, [],
      `a stored hex reached the page instead of the theme's token:\n  ${complaints.join("\n  ")}`);
  });
}
