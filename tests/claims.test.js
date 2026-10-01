/* Checks on the source itself for promises the README makes in prose. */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, DEFAULT_FILES, scriptOrder } = require("./load.js");

const jsFiles = fs.readdirSync(path.join(ROOT, "js")).filter((f) => f.endsWith(".js"));
const source = Object.fromEntries(jsFiles.map((f) => [f, fs.readFileSync(path.join(ROOT, "js", f), "utf8")]));

function hits(pattern) {
  const out = [];
  for (const [file, text] of Object.entries(source)) {
    text.split("\n").forEach((line, i) => {
      if (pattern.test(line)) out.push(`js/${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

test("parseFloat is not called anywhere", () => {
  assert.deepEqual(hits(/\bparseFloat\s*\(/), []);
});

test("no date is cut out of toISOString()", () => {
  assert.deepEqual(hits(/toISOString\(\)\s*\.\s*(slice|substr|substring|split)\b/), []);
});

test("classic scripts only: no ES modules", () => {
  assert.deepEqual(hits(/^\s*(import\s.+\sfrom\s|import\s*\(|export\s+(default|const|function|var|let|\{))/), []);
});

test("no network calls from the code: no fetch, XHR, beacon or socket", () => {
  assert.deepEqual(hits(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource/), []);
});

test("index.html loads nothing remote except Google Fonts", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const remote = [];
  const re = /<(script|link)\b[^>]*\b(src|href)="(https?:)?\/\/([^/"]+)/g;
  let m;
  while ((m = re.exec(html))) remote.push(m[4]);
  for (const host of remote) {
    assert.ok(host === "fonts.googleapis.com" || host === "fonts.gstatic.com", host);
  }
});

test("no package.json: nothing to install", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "package.json")), false);
});

test("tests load the scripts in the order index.html does", () => {
  const order = scriptOrder().filter((s) => DEFAULT_FILES.includes(s));
  assert.deepEqual(order, DEFAULT_FILES);
});
