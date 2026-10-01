/* Moon — the service worker (SPEC §7).
 *
 * Moon keeps every number in the browser, so the one thing still standing
 * between a reader and their own ledger is the network that serves the files.
 * This worker removes it: the shell is taken on install, and afterwards the
 * app opens in flight mode exactly as it does online.
 *
 * Two strategies, chosen per request and for a reason:
 *
 *   - A navigation goes to the NETWORK FIRST. The published copy is updated by
 *     pushing to a branch, and a reader who never leaves the cache would stay
 *     on the version they first visited. Falling back to the cached document
 *     means a lost connection still opens the app.
 *   - Everything else same-origin is served from the cache AND revalidated in
 *     the background. The cached copy answers immediately, which is the
 *     difference between the panel appearing and the panel waiting, and the
 *     fresh copy replaces it for the next load. Plain cache-first would be a
 *     trap here: Moon has no build step, so js/charts.js keeps that name
 *     forever, and a release would hand a reader the NEW document with the OLD
 *     scripts under it — a worse state than having no worker at all, and one
 *     that would last until the version below happened to be bumped.
 *
 * Cross-origin requests are not touched at all. The only one Moon makes is the
 * Google Fonts stylesheet, whose response is opaque to a worker; the fallback
 * stacks in css/tokens.css already carry the layout without it, so storing a
 * response we cannot read would buy nothing.
 *
 * The precache list below is NOT a judgement call. It is every local file
 * index.html references, and tests/shell.test.js reads both files and fails if
 * the two ever drift. Add a script tag to the page, add it here.
 */
"use strict";

/* The cache name is the version. Nothing is ever updated in place: a new name
   fills a new cache and `activate` throws the old one away, so a reader is
   never served half of one release and half of the next. Bump it whenever the
   files in it change meaningfully. */
var VERSION = "moon-shell-v5";

/* Caches at this origin that this worker is allowed to delete. The published
   copy lives on a github.io domain shared with every other project the owner
   publishes, so a blanket sweep of caches.keys() would empty a neighbour's
   cache along with the stale ones. */
var FAMILY = "moon-";

/* The document, under both addresses it answers to: "./" is what a reader who
   typed the directory gets, "index.html" is what a bookmark or the published
   links carry. They are the same bytes under two cache keys, and both have to
   be there for the offline fallback to find one. */
var SHELL = ["./", "index.html"];

/* Every local file index.html references, in the order it references them, so
   this list and the page can be read side by side. */
var PRECACHE = [
  "assets/moon.svg",
  "manifest.webmanifest",
  "assets/apple-touch-icon.png",
  "css/tokens.css",
  "css/moon.css",
  "js/core.js",
  "js/money.js",
  "js/dates.js",
  "js/lang.tr.js",
  "js/lang.en.js",
  "js/i18n.js",
  "js/store.js",
  "js/model.js",
  "js/csv.js",
  "js/pdf.js",
  "js/importer.js",
  "js/charts.js",
  "js/ui.js",
  "js/sample.js",
  "js/views.panel.js",
  "js/views.ledger.js",
  "js/views.limits.js",
  "js/views.plan.js",
  "js/views.accounts.js",
  "js/views.investments.js",
  "js/views.data.js",
  "js/quickadd.js",
  "js/app.js"
];

/* ------------------------------------------------------------------ plumbing */

function sameOrigin(url) {
  var parsed = null;
  try {
    parsed = new URL(url, self.location.href);
  } catch (error) {
    return false;
  }
  return parsed.origin === self.location.origin;
}

/* A copy of a fresh response, filed under the request that fetched it. Only a
   plain 200 is stored: a 206 cannot be put in a cache at all, and a redirect
   or an error page stored under a script's URL would survive the outage that
   produced it. A failure here is swallowed on purpose — a full disk must not
   turn a page that is already rendering into a broken one. */
function keep(request, response) {
  if (!response || response.status !== 200 || response.type === "opaque") return;
  var copy = response.clone();
  caches.open(VERSION).then(function (cache) {
    return cache.put(request, copy);
  }).catch(function () { /* quota, private mode: the response still arrived */ });
}

/* The document from the cache, whichever of its two addresses was asked for.
   The search string is ignored because a shared link can carry anything after
   the "?" and it names the same shell either way. */
function shellFromCache(request) {
  var tried = [request].concat(SHELL);

  function next(index) {
    if (index >= tried.length) return Promise.resolve(null);
    return caches.match(tried[index], { ignoreSearch: true }).then(function (hit) {
      return hit || next(index + 1);
    });
  }

  return next(0);
}

function navigation(request) {
  return fetch(request).then(function (response) {
    keep(request, response);
    return response;
  }, function (error) {
    return shellFromCache(request).then(function (hit) {
      if (hit) return hit;
      /* Nothing cached and nothing on the wire. The failure is let through
         rather than answered: the browser's own offline page is already in the
         reader's language, and a worker has no catalogue to write a sentence
         with — SPEC §0.5 says every string the reader sees comes from
         Moon.I18n.t, and this file cannot reach it. */
      throw error;
    });
  });
}

/* Stale while revalidate. The cached copy is returned at once; the network
   copy, when it arrives, replaces it for next time. The refetch is deliberately
   NOT awaited and its failure is swallowed, because the reader already has an
   answer and an offline refresh must not turn a served page into an error. */
function asset(request) {
  return caches.match(request).then(function (hit) {
    var fresh = fetch(request).then(function (response) {
      keep(request, response);
      return response;
    });
    if (!hit) return fresh;
    fresh.catch(function () { /* offline: the cached copy already went out */ });
    return hit;
  });
}

/* ------------------------------------------------------------------- events */

/* addAll is atomic: one missing file fails the install and the worker never
   takes over, which is the honest outcome — a shell with a hole in it would
   fail later, offline, where nobody can read the console.

   Every request is built with cache: "reload" so the precache is taken from
   the network rather than from whatever the browser happens to be holding.
   Without it, a file the browser cached an hour ago is copied into the shell
   and frozen there for the life of this version — the install would faithfully
   preserve the staleness it exists to prevent. */
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) {
      return cache.addAll(SHELL.concat(PRECACHE).map(function (url) {
        return new Request(url, { cache: "reload" });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

/* The new worker takes over as soon as it is ready, and the page it takes over
   reloads itself once (app.js listens for controllerchange). The alternative —
   waiting for every tab to close — left the owner looking at a week-old copy of
   his own app while the fix he had asked for sat on the server, which is a
   worse failure than the reload this costs. The reload is safe because it
   happens before anything is read: a document never ends up running the next
   release's scripts, it is simply replaced by that release. */
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name === VERSION || name.indexOf(FAMILY) !== 0) return null;
        return caches.delete(name);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;

  /* A POST is not something this app does, and not answering a request at all
     leaves the browser to handle it exactly as it would without a worker. */
  if (request.method !== "GET" || !sameOrigin(request.url)) return;

  if (request.mode === "navigate") {
    event.respondWith(navigation(request));
    return;
  }

  event.respondWith(asset(request));
});
