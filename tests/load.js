/* Loads Moon's browser scripts into one Node vm context, in the order
 * index.html uses, so the tests exercise the exact files the page ships.
 *
 * Moon is written for classic <script> tags: every file is an IIFE that takes
 * `window` and writes one branch of the global `Moon`. Here the vm context
 * plays `window` (context.window = context). Nothing else is faked by
 * default; the DOM-free modules (money, dates, i18n, store, model, csv,
 * importer) never touch `document` while loading.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

/* Same order as the <script> tags in index.html, minus the DOM-bound tail
 * (charts, ui, sample, views, app). */
const DEFAULT_FILES = [
  "js/core.js",
  "js/money.js",
  "js/dates.js",
  "js/lang.tr.js",
  "js/lang.en.js",
  "js/i18n.js",
  "js/store.js",
  "js/model.js",
  "js/csv.js",
  "js/importer.js"
];

/* Script order as index.html declares it, read from the file itself so a
 * reordering there cannot silently drift from what the tests assume. */
function scriptOrder() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const out = [];
  const re = /<script\s+src="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function load(files) {
  const list = files || DEFAULT_FILES;
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    Intl,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    setTimeout,
    clearTimeout
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const rel of list) {
    const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
    vm.runInContext(code, sandbox, { filename: rel });
  }
  return sandbox;
}

module.exports = { load, scriptOrder, ROOT, DEFAULT_FILES };
