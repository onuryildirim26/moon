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
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { scriptOrder, ROOT } = require("./load.js");

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
      toggle(c, on) {
        if (on === undefined ? this._set.has(c) : !on) this._set.delete(c);
        else this._set.add(c);
      },
      contains(c) { return this._set.has(c); },
    },
    firstChild: null, parentNode: null,
    textContent: "", innerHTML: "", value: "",
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
    showModal() {}, close() {}, scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
  };
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

/** Loads every script index.html declares, against the stand-in above. */
function loadAll(options = {}) {
  const documentElement = makeNode("html");
  documentElement.lang = "en";

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
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
    /* Charts return SVG strings; nothing here needs them parsed back. */
    DOMParser: class { parseFromString() { return { documentElement: makeNode("svg") }; } },
    FileReader: class { readAsArrayBuffer() {} readAsText() {} },
    Blob: class {},
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    CSS: { supports: () => true },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    document: {
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
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  for (const rel of scriptOrder()) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), sandbox, { filename: rel });
  }

  /* A pinned day makes period arithmetic repeatable: a test written on the 30th
     must not behave differently when it runs on the 1st. */
  if (options.today) sandbox.Moon.Dates.today = () => options.today;
  return sandbox.Moon;
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

test("every script index.html declares loads, in that order", () => {
  const Moon = loadAll();
  const declared = scriptOrder();

  assert.ok(declared.length >= 19, `index.html declares ${declared.length} scripts`);

  for (const branch of ["util", "bus", "dom", "Money", "Dates", "I18n", "Store",
    "Model", "CSV", "Importer", "Charts", "UI", "Sample", "Views", "App"]) {
    assert.ok(Moon[branch], `Moon.${branch} is missing after loading every file`);
  }
});

test("every section is registered and can be rendered", () => {
  const Moon = loadAll();
  /* The router looks these up by name; a view that fails to register leaves a
     section of the app blank, and nothing else would notice. */
  for (const view of ["panel", "ledger", "limits", "recurring", "goals", "debts", "data"]) {
    assert.ok(Moon.Views[view], `Moon.Views.${view} is missing`);
    assert.equal(typeof Moon.Views[view].render, "function",
      `Moon.Views.${view}.render must be a function`);
  }
});

for (const name of ["Charts", "UI", "Sample"]) {
  test(`Moon.${name}._selftest() passes`, () => {
    const Moon = loadAll({ today: "2026-09-15" });
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
  const Moon = loadAll({ today: "2026-09-15" });
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
