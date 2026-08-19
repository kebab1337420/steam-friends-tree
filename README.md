# Steam Friends Tree

Plugin for [Millennium](https://steambrew.app) ([source](https://github.com/SteamClientHomebrew/Millennium))
that draws the Steam friend graph as a radial tree on its own page inside the
Steam client. You pick the account at the root, and you pick whether the tree
ends.

## Install

Millennium has to be installed first — see
[steambrew.app](https://steambrew.app) for its own installer.

Grab the archive from the [latest release](../../releases/latest), unpack it
anywhere, close Steam and run `install.bat`. It finds Steam in the registry,
copies the plugin into `<Steam>/millennium/plugins/steam-friends-tree` and
leaves `config.json` — the Web API key and the saved settings — alone. A Steam
installed somewhere unusual goes in as an argument:

```bat
install.bat "D:\Games\Steam"
```

Run from a clone instead, `install.bat` builds the bundles with npm first. To
build by hand:

```sh
npm install
npm run build      # writes .millennium/Dist/index.js and webkit.js
```

Then copy the folder to `<Steam>/millennium/plugins/steam-friends-tree` — the
manifest, `backend/` and `.millennium/Dist/` are what matter — restart Steam,
enable the plugin in Millennium's settings. The tree gets its own entry — "Arbre des
amis" — in the plugin navigation.

## Steam Web API key

The crawl uses the public Web API, so the plugin asks once for a key from
<https://steamcommunity.com/dev/apikey>. It is validated as 32 hex characters,
written to `config.json` next to `plugin.json`, and only ever sent to `api.steampowered.com`. It is stripped from any error message
that reaches the page.

Consequence of using the Web API: an account whose friend list is private is a
leaf, and only accounts reachable through public friend lists appear at all.

## Root of the tree

The root field takes a SteamID64, a vanity name, or a full profile URL; "Moi"
fills in the signed-in account. Selecting any node and clicking "Prendre comme
racine" re-runs the crawl from there — the previous walk is retired mid-flight,
so its results never leak into the new tree.

## Ending the tree

- **Profondeur fixe** — the crawl stops after N levels of friends (1 to 6).
- **Sans fin** — no depth limit. The friend graph has no natural end, so the
  crawl runs until the account budget is spent or you press Stop.

Both modes are bounded by the account budget (default 5000, hard ceiling 50000)
and, optionally, by a cap on friends kept per account. The budget is the limit
that usually bites first: at 400 accounts a crawl of depth 2 is spent on the
root's own friends and never reaches the second level, so raise it before
blaming the depth. Whenever a limit cuts the walk short, the page says the tree
is truncated, and the walk ends there instead of spending a request per account
it can no longer keep.

One request per expanded account, plus one batched request per 100 accounts for
names and avatars. A 429 or a 5xx is retried three times; only that one account
is given up on, and the retry count shows in the sidebar.

Millennium 3.x runs Lua backends and its VM has no threads, so the crawl advances
in slices of at most 700 ms: every poll from the page does a little more work and
returns the snapshot as it stands.

## From a Steam profile

Profile pages inside the client get a "Tracer l'arbre d'amis" button next to the
usual profile actions. It roots a crawl on the account being viewed, reusing the
depth, budget and friend cap currently set on the page — they are saved as soon
as the controls change, not only when a crawl is launched — and the client shows a
toast. Open the "Arbre des amis" page to watch it draw — the walk itself runs in
the backend either way.

The button reads the account from the URL, or from the profile data embedded in
the page; a vanity URL is resolved through the Web API like any other root.

## Reading the tree

- Green node: the root. Red: private friend list. Brown: read failed. Orange:
  collapsed branch.
- Click a node for its details — it shows branches drawn against total friends,
  which differ because an account already reached elsewhere keeps only its first
  edge. Double-click folds or unfolds a branch, client-side, without re-crawling.
- Drag to pan, wheel to zoom at the cursor, "Recentrer" to reframe.
- Above ~400 visible nodes or below 0.45 zoom, labels are dropped and only nodes
  inside the viewport are drawn, which is what keeps a large tree responsive.

## Exporting the tree

The page is written on its own: as soon as a walk finishes — or is stopped —
the backend renders it to
`<Steam>/millennium/plugins/steam-friends-tree/tree.html` and the client opens
it. "Exporter en HTML" does the same on demand, mid-crawl included.

Every account is drawn as its Steam avatar inside a ring coloured by profile
visibility, with the persona name underneath. The page is standalone — accounts,
edges and drawing code all live in the file — so it works in any browser with no
plugin and no server running; only the avatars themselves come from Steam's CDN,
so they need a connection. It keeps the pan, the zoom, the search and the
per-account details of the in-client view; each export overwrites the same file.

The template is `backend/export_template.html`; the backend substitutes the
crawl snapshot for its `__TREE_DATA__` placeholder.

## Tests

The backend suite runs on any LuaJIT (`scoop install luajit`).

```sh
npm test          # crawler against a fake Steam API, plus the layout maths
npm run typecheck
```

`tests/crawler.test.lua` stubs out the Millennium modules and the network to
exercise depth limits, budgets, private profiles, transient failures, restarts and stops.
`tests/layout.test.mjs` checks the radial layout, collapsing, and the walk back
up to the root.

## Layout

```
plugin.json            Millennium manifest (Lua backend)
install.bat            copies the plugin into the Steam install it finds
backend/main.lua       breadth-first crawler, Web API calls, exposed methods
backend/export_template.html  standalone page the HTML export is built from
frontend/index.tsx     plugin definition and navigation entry
frontend/TreePage.tsx  the page: controls, SVG canvas, node inspector
frontend/layout.ts     radial tidy-tree layout and edge bundling
frontend/api.ts        typed bridge over Millennium's callable()
frontend/externalStart.ts  relays crawls started outside the page
webkit/index.tsx       the profile-page button, injected into steamcommunity.com
frontend/styles.ts     injected stylesheet
```
