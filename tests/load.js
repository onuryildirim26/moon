/* Loads Moon into a single Node vm context, in the order index.html declares.
 *
 * Moon ships as classic scripts that each write one branch of a global, so there
 * is nothing to import: the files are evaluated in order against a context that
 * stands in for the browser. Only the parts the modules actually touch are
 * faked, and each fake is noted — a stub that is more generous than the real
 * browser would let a test pass on behaviour the app cannot rely on.
 *
 * Node's built-ins only: node:fs, node:path, node:vm. No dependencies, nothing
 * to install, which is the same promise the app itself makes.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

/* The order is index.html's, and it is the contract: each file may only use the
   globals of the files above it. */
const ORDER = [
  "core.js", "money.js", "dates.js", "lang.tr.js", "lang.en.js", "i18n.js",
  "store.js", "model.js", "csv.js", "importer.js", "charts.js", "ui.js",
  "sample.js",
  "views.panel.js", "views.ledger.js", "views.limits.js", "views.plan.js",
  "views.data.js", "app.js",
];

/* localStorage: a Map behind the Storage interface. Real storage can also throw
   (private mode, quota) and Store is written for that; `failAfter` lets a test
   reproduce it. */
class MemoryStorage {
  constructor(options = {}) {
    this.map = new Map();
    this.writes = 0;
    this.failAfter = options.failAfter ?? Infinity;
  }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) {
    this.writes += 1;
    if (this.writes > this.failAfter) {
      const error = new Error("quota");
      error.name = "QuotaExceededError";
      throw error;
    }
    this.map.set(String(key), String(value));
  }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  get length() { return this.map.size; }
}

/* The smallest DOM the modules evaluate against. Views build real trees through
   Moon.dom, so nodes need children, attributes and classes — but nothing here
   lays anything out, so tests must not ask about geometry. */
function makeNode(tag = "div") {
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    children: [], childNodes: [], attributes: {}, dataset: {},
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { if (on === undefined ? this._set.has(c) : !on) this._set.delete(c); else this._set.add(c); },
      contains(c) { return this._set.has(c); },
    },
    firstChild: null, parentNode: null, textContent: "", innerHTML: "", value: "",
    tabIndex: -1, disabled: false, offsetParent: null,
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return k in this.attributes; },
    appendChild(c) {
      this.children.push(c); this.childNodes.push(c);
      this.firstChild = this.children[0];
      if (c) c.parentNode = this;
      return c;
    },
    insertBefore(c) { return this.appendChild(c); },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i !== -1) { this.children.splice(i, 1); this.childNodes.splice(i, 1); }
      this.firstChild = this.children[0] ?? null;
      return c;
    },
    replaceChildren() { this.children = []; this.childNodes = []; this.firstChild = null; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus() {}, blur() {}, click() {}, select() {},
    showModal() {}, close() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
  };
  return node;
}

function makeDocument() {
  const documentElement = makeNode("html");
  documentElement.lang = "en";
  return {
    documentElement,
    body: makeNode("body"),
    head: makeNode("head"),
    createElement: (tag) => makeNode(tag),
    createElementNS: (ns, tag) => makeNode(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    createComment: (text) => ({ nodeType: 8, textContent: String(text) }),
    createDocumentFragment: () => makeNode("fragment"),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    importNode: (node) => node,
    readyState: "complete",
  };
}

/**
 * @param {object} [options]
 * @param {string}  [options.lang]     navigator language the context reports
 * @param {string}  [options.today]    pins Moon.Dates.today() for repeatable runs
 * @param {number}  [options.failAfter] storage writes allowed before it throws
 * @param {string[]}[options.files]    load a subset (defaults to all of ORDER)
 * @returns {{Moon: object, storage: MemoryStorage, sandbox: object, loaded: string[]}}
 */
function load(options = {}) {
  const storage = new MemoryStorage({ failAfter: options.failAfter });

  const sandbox = {
    console,
    JSON, Object, Array, String, Number, Math, Date, RegExp, Map, Set, WeakMap,
    Promise, Error, TypeError, RangeError, Symbol,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, structuredClone,
    Intl, TextDecoder, TextEncoder,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    document: makeDocument(),
    localStorage: storage,
    sessionStorage: new MemoryStorage(),
    location: { hash: "#panel", href: "file:///moon/index.html", search: "", pathname: "/" },
    navigator: { language: options.lang ?? "en-US", languages: [options.lang ?? "en-US"] },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    /* Charts hand back SVG strings; nothing in a test needs them parsed. */
    DOMParser: class { parseFromString() { return { documentElement: makeNode("svg") }; } },
    FileReader: class { readAsArrayBuffer() {} readAsText() {} },
    Blob: class {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    CSS: { supports: () => true },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  const files = options.files ?? ORDER;
  const loaded = [];

  for (const name of files) {
    const file = path.join(ROOT, "js", name);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: `js/${name}` });
    loaded.push(name);
  }

  const Moon = sandbox.Moon;
  if (!Moon) throw new Error("js/core.js did not define window.Moon");

  /* A pinned day makes period arithmetic repeatable; without it a test written
     on the 30th behaves differently on the 1st. */
  if (options.today) Moon.Dates.today = () => options.today;

  return { Moon, storage, sandbox, loaded };
}

/* Each module reports in its own shape — {passed, failed:[]}, {ok,total,failed:0},
   {ok,checks,failures:[]}, {total,pass,fail,failures:[]} — so reading only one of
   them would count real failures as zero. */
function readSelftest(result) {
  if (!result || typeof result !== "object") return { passed: 0, failures: [], count: 0 };

  const failures = Array.isArray(result.failed) ? result.failed
    : Array.isArray(result.failures) ? result.failures
      : [];

  let count = failures.length;
  if (!count && typeof result.failed === "number") count = result.failed;
  if (!count && typeof result.fail === "number") count = result.fail;
  if (!count && result.ok === false) count = 1;

  const passed = result.passed ?? result.pass ?? result.checks ?? result.total ?? 0;
  return { passed, failures, count };
}

module.exports = { load, readSelftest, ORDER, ROOT, MemoryStorage };
