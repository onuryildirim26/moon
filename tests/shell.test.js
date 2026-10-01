/* The app shell, as the service worker sees it.
 *
 * sw.js takes a hand-written list of files on install, and `cache.addAll` is
 * atomic: one path that no longer exists fails the install, and the worker
 * never takes over. That failure happens in a browser, on a reader's phone,
 * usually offline, and it is reported nowhere. A missing path is quieter still
 * — the app just stops working in flight mode for whatever was left out.
 *
 * So this suite owns the one invariant that keeps sw.js honest six months and
 * several agents from now: the precache list is EXACTLY the set of local files
 * index.html references. Nobody has to remember to update the worker; they
 * only have to run the tests.
 *
 * The list is read by running sw.js rather than by matching its text. The file
 * is a classic script, so its top-level `var`s land on the worker global, which
 * here is a stand-in thin enough to hold handlers and a fake cache and nothing
 * else.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { scriptOrder, ROOT } = require("./load.js");

/* Everything <link> pulls in locally: both stylesheets, the favicon, the
   manifest and the apple-touch icon. An absolute or protocol-relative URL is
   someone else's server — the Google Fonts stylesheet and its two preconnects
   — and a worker cannot store an opaque response usefully, so those are not
   part of the shell. A bare "#…" is the skip link, not a file. */
function linkAssets() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const out = [];
  const re = /<link\b[^>]*\bhref="([^"]+)"/g;
  let found;
  while ((found = re.exec(html))) {
    const href = found[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) continue;
    out.push(href);
  }
  return out;
}

/* A worker global with just enough in it for sw.js to install its three
   handlers and hand back its constants. `caches` answers from one plain Map so
   a strategy can be exercised without a browser; `fetch` always fails, which
   makes "served from the cache" provable — if a cache-first path ever reached
   the network the assertion would see the rejection. */
function loadWorker(cached = {}) {
  const store = new Map(Object.entries(cached));
  const handlers = {};
  const puts = [];
  const deleted = [];

  const cache = {
    addAll(list) { return Promise.resolve(list); },
    put(request, response) { puts.push(String(request && request.url ? request.url : request)); return Promise.resolve(); },
    match(request) { return Promise.resolve(store.get(keyOf(request)) || null); },
  };

  function keyOf(request) {
    const url = String(request && request.url ? request.url : request);
    return url.replace(/^https:\/\/example\.test\/moon\//, "").replace(/\?.*$/, "");
  }

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    URL, Promise, Map, Set, Object, Array, String, Number, Error,
    setTimeout, clearTimeout,
    fetch: () => Promise.reject(new Error("the test harness has no network")),
    caches: {
      open: () => Promise.resolve(cache),
      match(request) { return cache.match(request); },
      keys: () => Promise.resolve(["moon-shell-v1", "moon-shell-v2", "pages-other-project"]),
      delete(name) { deleted.push(name); return Promise.resolve(true); },
    },
    clients: { claim: () => Promise.resolve() },
    addEventListener(name, fn) { handlers[name] = fn; },
    location: { href: "https://example.test/moon/index.html", origin: "https://example.test" },
    skipWaiting() {},
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "sw.js"), "utf8"), sandbox, { filename: "sw.js" });

  return { worker: sandbox, handlers, puts, deleted, store };
}

/* A request the fetch handler can read: a URL, a method and the mode the
   browser sets on a navigation. */
function request(url, options = {}) {
  return {
    url: new URL(url, "https://example.test/moon/index.html").href,
    method: options.method || "GET",
    mode: options.mode || "cors",
  };
}

function answer(handlers, req) {
  let answered;
  handlers.fetch({ request: req, respondWith(value) { answered = value; } });
  return answered;
}

/* An array that came out of the vm carries that realm's Array.prototype, which
   assert/strict compares by identity — the same trap the other new suites note.
   Copying it into this realm is enough, because every member is a string. */
function plain(list) {
  return Array.isArray(list) ? Array.from(list, String) : list;
}

test("the precache list is exactly the local files index.html references", () => {
  const { worker } = loadWorker();
  const declared = [...linkAssets(), ...scriptOrder()];

  /* Both readers are regexes over the page, and a regex that quietly stops
     matching would make everything below pass on an empty set. */
  assert.ok(linkAssets().length >= 5, `index.html links ${linkAssets().length} local files`);
  assert.ok(scriptOrder().length >= 21, `index.html declares ${scriptOrder().length} scripts`);

  assert.ok(Array.isArray(worker.PRECACHE), "sw.js must declare a PRECACHE array");
  const list = plain(worker.PRECACHE);

  const precached = new Set(list);
  assert.equal(precached.size, list.length, "PRECACHE lists a path twice");

  const missing = declared.filter((file) => !precached.has(file));
  assert.deepEqual(missing, [], "index.html references files sw.js never caches");

  const page = new Set(declared);
  const stale = list.filter((file) => !page.has(file));
  assert.deepEqual(stale, [], "sw.js caches files index.html no longer references");
});

test("every precached path is a file in the repo", () => {
  const { worker } = loadWorker();
  const gone = plain(worker.PRECACHE).filter((file) => !fs.existsSync(path.join(ROOT, file)));
  /* cache.addAll rejects as a whole, so one 404 here is not one missing icon:
     it is no service worker at all. */
  assert.deepEqual(gone, [], "PRECACHE names paths that do not exist");
});

test("the scripts in the precache list stay in the page's load order", () => {
  const { worker } = loadWorker();
  const inList = plain(worker.PRECACHE).filter((file) => file.startsWith("js/"));
  /* Not a functional requirement — a cache has no order — but it is what makes
     the list diffable against index.html by eye, which is how a reviewer
     notices a script that was added to one and not the other. */
  assert.deepEqual(inList, scriptOrder());
});

test("the document itself is cached, under both of the addresses it answers to", () => {
  const { worker } = loadWorker();
  const list = plain(worker.PRECACHE);
  assert.deepEqual(plain(worker.SHELL), ["./", "index.html"]);
  /* index.html references scripts and styles, never itself, so it must come
     from SHELL — and it must not also sit in PRECACHE, which would store the
     same bytes twice under the same key. */
  assert.ok(!list.includes("index.html"), "index.html belongs in SHELL, not PRECACHE");
  assert.ok(!list.includes("sw.js"), "a worker that caches itself can pin a stale release");
});

test("the cache name is versioned inside the family activate sweeps", () => {
  const { worker } = loadWorker();
  assert.equal(typeof worker.VERSION, "string");
  assert.ok(worker.VERSION.startsWith(worker.FAMILY),
    `VERSION ${worker.VERSION} is outside the ${worker.FAMILY} family, so it would never be cleaned up`);
  assert.match(worker.VERSION, /v\d+$/, "the cache name must carry a version to replace");
});

test("activate drops Moon's older caches and leaves the neighbours alone", async () => {
  const { handlers, deleted, worker } = loadWorker();
  const waits = [];
  handlers.activate({ waitUntil(value) { waits.push(value); } });
  await Promise.all(waits);

  /* Derived from VERSION rather than written out, because the literal answer
     changes every time the shell is versioned and a test that has to be edited
     alongside the thing it checks stops being a check.

     github.io serves every one of the owner's projects from one origin, so a
     blanket caches.keys() sweep would empty another app's cache: what must go
     is every cache in Moon's family except the current one, and nothing else. */
  const seeded = ["moon-shell-v1", "moon-shell-v2", "pages-other-project"];
  const expected = seeded.filter((name) =>
    name.startsWith(worker.FAMILY) && name !== worker.VERSION);

  assert.deepEqual(Array.from(deleted), expected);
  assert.ok(!deleted.includes("pages-other-project"),
    "a neighbouring project's cache was swept away");
  assert.ok(!deleted.includes(worker.VERSION),
    "the worker deleted the cache it had just filled");
});

test("a cached script is served without the network", async () => {
  const { handlers } = loadWorker({ "js/app.js": { body: "cached app.js" } });
  const served = await answer(handlers, request("js/app.js"));
  assert.deepEqual(served, { body: "cached app.js" });
});

test("a navigation tries the network first and falls back to the cached shell", async () => {
  const { handlers } = loadWorker({ "./": { body: "cached shell" } });
  /* fetch always fails in this harness, which is the offline case: the reader
     still gets the document. */
  const served = await answer(handlers, request("./?from=a-shared-link", { mode: "navigate" }));
  assert.deepEqual(served, { body: "cached shell" });
});

test("a navigation with nothing cached fails rather than inventing a page", async () => {
  const { handlers } = loadWorker();
  await assert.rejects(answer(handlers, request("./", { mode: "navigate" })));
});

test("the worker does not answer a POST or another origin", () => {
  const { handlers } = loadWorker({ "js/app.js": { body: "cached app.js" } });
  assert.equal(answer(handlers, request("js/app.js", { method: "POST" })), undefined);
  assert.equal(answer(handlers, request("https://fonts.googleapis.com/css2?family=X")), undefined);
});
