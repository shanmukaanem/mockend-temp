# Mockend

Mockend lets QA teams test how a web app handles a custom API response. One panel and rule engine power Chrome, Edge, and the VS Code Integrated Browser. Rules and flows are stored locally and can be moved between platforms as JSON.

## Install the ready-to-use extensions

No build tools are needed to install these packages:

- **Chrome / Edge:** Download [Mockend-Chrome.zip](release/Mockend-Chrome.zip), extract it, then open `chrome://extensions` or `edge://extensions`. Enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`. The same ZIP is ready for Chrome Web Store uploads.
- **VS Code Desktop 1.112+:** Download [Mockend.vsix](release/Mockend.vsix). Run **Extensions: Install from VSIX** from the Command Palette, then open **Mockend** in the Activity Bar.
- **Full offline bundle:** [Mockend.zip](release/Mockend.zip) includes the unpacked browser extension, VSIX, examples, and rebuildable source.

[SHA-256 checksums](release/SHA256SUMS) identify the current packages. These are local installation packages; a browser ZIP must be extracted before loading. The VS Code identity is now mockend.mockend. Previous mockroute-local.mockroute installations need a one-time Flow backup/import; see PUBLISHING.md. Internal browser storage and JSON backup keys stay compatible.

Every `npm run build` refreshes **release/chromium/** and the same package filenames. Load that browser folder once and use Reload for future builds. Run `npm run update:vscode` to update the VS Code package in place, then Reload Window. See [the short update and publishing guide](PUBLISHING.md).

Version metadata is synchronized with `npm run version:set -- 0.0.1` (or `patch`). After each push to `main`, passing CI automatically increments the patch version unless that push explicitly changed it, rebuilds both extensions, commits the stable packages, and publishes a tagged GitHub release. Pull `main` before your next change to include the generated release commit. GitHub release automation does not publish to extension stores or update locally installed extensions.

**Proprietary:** use of the extensions is permitted under [LICENSE](LICENSE); modification and redistribution are restricted. Keep the full offline source bundle and repository private if you do not want to publish source.

## Start here

Open this folder in your editor. It is the project root, where `package.json` and this README live. If you downloaded the combined installer ZIP, its project root is the extracted `source/` folder.

| Requirement | Used for |
| --- | --- |
| Node.js 22 or newer and npm | Running the project commands, demo, and tests |
| Python 3.10 or newer | Building both extensions and their install packages |
| Playwright Chromium | Automated browser tests. The install command is below. |

```sh
npm ci
npm run build
npm test
npm run demo
```

Open [the checkout demo](http://127.0.0.1:4319/) after the last command. Press Ctrl+C to stop it. Building and running the unit tests do not need npm dependencies. `npm ci` installs the pinned Playwright development dependency for browser tests.

### Install or reload

| Platform | Install a build |
| --- | --- |
| Chrome or Edge | Use the stable `release/chromium/` after a local build. For the prebuilt browser ZIP in `release/`, extract it and select the folder containing `manifest.json`. Open `chrome://extensions` or `edge://extensions`, enable Developer mode, and choose **Load unpacked**. Select the folder containing `manifest.json`. |
| VS Code Desktop 1.112+ | Run **Extensions: Install from VSIX…** in the Command Palette and select `release/Mockend.vsix`, or the VSIX in `dist/` after a local build. Open **Mockend** in the Activity Bar or run **Mockend: Open**. |

After changing code, run `npm run build` again. In Chrome or Edge, click **Reload** on the extension card and reopen its panel. In VS Code, install the rebuilt VSIX and run **Developer: Reload Window**. Keep the Chrome or Edge unpacked extension at the same path when updating it to retain the existing installation.

In VS Code, click **Start recording** or **Start mocking**. If the App URL is empty, Mockend asks for the address, then opens its integrated browser. Enter a URL such as `localhost:3000` or `example.com`. Existing Mockend browser sessions are reused; opening the Mockend panel alone does not attach to another browser tab. Escape cancels setup.

The packages are distributed for local installation. Chrome and Edge display a debugging notice while recording or mocking. The `debugger` permission intercepts requests in the tab you start mocking. The `tabs` permission identifies and displays that tab. The extension uses local storage for flows and never sends your configuration or activity to a service.

Mockend requests **Ctrl+Shift+M** as its default and provides **Ctrl+Shift+Y** as an alternate. Press again to close the side panel on browsers that support programmatic panel closing (Chrome 141+). Chrome reserves Ctrl+Shift+M for profile switching. **Settings → Open Mockend shortcut** shows the assigned chord and opens the browser’s extension shortcut settings if it is unassigned or you want to change it.

Use the **Open Mockend in new tab** icon to open a full browser tab that stays connected to the original app tab. In Chrome 141 and later, opening the tab also closes the sidebar.

## Apps and Env

Use **App / profile** at the top left to switch apps. The picker contains only app names and **Manage apps**. The manager uses the same compact list/detail layout as Env settings, with an Active badge and direct actions. It provides **New app**, **Rename app**, **Merge app**, **Split Envs into app**, and complete workspace **Export all apps / Import apps**. Each app has its own Envs, Flows, settings, and request history. Switching stops the previous app's mocks and opens its configured launch URL when one is saved.

Rules now store endpoint paths such as `/api/auth/me`. Env supplies the host: the same rule can target `https://local.example/api/auth/me` or `https://dev.example/api/auth/me` by switching Env. Creating a mock from a full URL adds its origin to the selected Env automatically. Existing concrete URL rules upgrade to paths; source origins are retained as Env mappings. Wildcard-host legacy rules retain their explicit matching behavior. A local pre-upgrade backup is retained when storage permits.

The Add/Edit mock editor has one **Env** multi-select: choose **Select all** or specific named Envs. Base URL, Path, and Endpoint are read-only previews on the same line; the separate Base URL selector is removed. Enter an endpoint path or paste a full API URL to register its origin when saving. Path/query matching, request conditions, responses, and exports remain available. New path rules require a configured Env or an app/source URL to create the first Env.

**Merge app** moves all source Envs and Flows into another app and removes the source profile; the destination keeps its settings. **Split Envs into app** moves selected Envs to a new app and copies reusable Flows, keeping selected-Env rule references valid in both apps. At least one Env must remain in the source app. Export all apps before reorganizing if you want an external backup. Flow transfer controls export the current app's configuration; Manage apps exports the complete workspace.

Before any Env exists, the toolbar offers **Save Env** for the current site or **No Env** without a site. Adding a mock adds a new origin to the selected Env, creating an Env only when needed. Saving an Env includes the current app's captured API origins together, and Save current site updates the selected Env rather than creating one Env per URL. Named Envs remain separate. Once Envs exist, the picker uses a named Env and offers **Save current site** only for unsaved origins plus **Manage Env**. Create an Env with a name (Local, QA, Staging) and an initial API origin: `http://localhost:4319`, `https://api.qa.example.com`. Switching applies immediately to active mocks in the connected test tab. Existing backups using **All Env** retain that selection; new toolbar selections use named environments. Rules can still explicitly target all configured environments.

Settings uses an environment list and a service URL detail pane. Selecting an Env in the list inspects it; **Set active** in its direct action group changes the active mocking target. The Active badge identifies the current target. **New environment** creates an Env; **Add base URL** adds another origin with an optional service name. Edit turns the service and URL cells into independent inline editors without changing their background; the row actions become Save, Enter saves, and Escape cancels only that row. Multiple rows may be edited independently. Row icons edit or delete a URL, while the joined **Set active**, **Rename**, and **Delete** buttons manage the group. At least one origin must remain per Env. Service names are labels, preserved in backups and app merge/split; endpoint rules continue to apply to the selected Env's configured origins. On narrow panels, the Env list scrolls horizontally above the details. Escape cancels inline editors and confirmations.

The editor's Env choices determine the target hosts:

| Choice | Target hosts |
| --- | --- |
| Select all | Every configured Env, including Envs added later |
| Named Envs | The checked Envs, independent of the toolbar selection |

Existing backups with toolbar-following or original-URL scopes remain readable. Editing and saving a rule uses the Env choices shown in the new editor.

New rules start with the active Env selected, or Select all before the first Env exists; saving preserves the shown Env choices. For example, a stored path `/api/v1/orders` targets that path on the configured QA or Staging API hosts. The Path and Endpoint remain exact unless the rule uses wildcards. Method, request type, query, body, response, delay, and CORS conditions still apply. Environments with multiple base URLs apply the same path on each URL. Selecting an Env changes API targets; selecting an app/profile opens its saved launch URL when configured.

The editor previews Base URL, Path, Endpoint, and the complete resolved targets. The Rules table shows effective base URLs and environment names, with an Env filter. If a rule has no configured targets it matches no requests. Edit selected-environment rules before deleting a referenced environment. Environment settings are included in flow backups; old backups still import. Postman mock exports resolve the selected targets into independent portable routes (up to 200) at export time.

Builds keep only stable filenames in `release/`: `chromium/`, `Mockend.vsix`, `Mockend-Chrome.zip`, `Mockend.zip`, and `SHA256SUMS`. Versioned packages are generated only in `dist/`; duplicate versioned archives are removed from `release/` automatically.

## Tables

Column dividers transfer width only between their two neighboring columns. Pointer and keyboard resizing preserve the combined width; minimum widths stop the divider before either neighbor becomes unreadable. Env starts at a compact four-character width. Env, Method, Type, and Status keep stable defaults during automatic sizing but remain manually adjustable; unrelated dividers do not change them. Every internal divider stays visible and supports pointer or keyboard resizing. Header labels and cells share the same left inset.

Both tables keep records at a uniform height and clip overflowing text without ellipsis. Tables fit all columns within the viewport before expanding text columns. Method (76px), Base URL (160px), Type (84px), and Status (88px) start at stable default widths. They can be resized manually and do not grow automatically with record contents or the viewport. Text columns shrink to their minimums first; narrower viewports scroll with the final controls pinned. Sort indicators have reserved space and never change a column width. Empty messages appear inside the tables. Only the top table corners are rounded, and headers stay pinned while records scroll. Names and endpoints use flexible widths; full values remain available in tooltips and editors. Drag a column divider or focus it and use Left/Right (Shift for one-pixel steps), Home, or End to resize. Double-click a divider to restore its default width. Requests and Rules remember widths independently. Toolbar controls use icons and content-sized widths below 960px; wider panels show text beside the icons. URL input and the combined view-tab strip stay aligned on one row. Requests keep the always-visible stacked cURL / Mock split button at the row end, without delete buttons or a separate Actions column. Rules expose only a delete icon; click a rule name or row to edit it. Dropdowns show selected options first. Their controls and pickers share a width based on the longest option, bounded by the available layout; clipped values have tooltips. Filter option trays also place checked choices first. Tabs use the same 24px height as compact buttons. Component contents use shared leading padding for consistent alignment. Base URL, Path, and Endpoint selectors live outside Filters. Path and Endpoint start with all values selected and show selected/total counts. Base URL, Path, and Endpoint trays each have their own search. API origins display without the HTTP(S) scheme; stored URLs and editable URL fields keep it.

Rules uses sortable rows with name, method, Base URL / Path, Endpoint, type, status, delay, enabled switch, and a small delete icon. Click a row or its name to edit. Sorting changes the display only; ID shows matching priority. Search rule names, URLs, request conditions, headers, and response contents; use URL to search only the URL or .* for regex. Requests and Rules keep independent search and filters. When search or filters are active, **Invert Filter Result** shows their complement within the selected Base URLs. The split mock control has distinct **filtered** and **all** actions: filtered changes only the currently displayed rows, including inverted filter results; **Enable all mocks / Disable all mocks** changes every rule in the active Flow, including hidden records.

Both tables show the origin on the first line and Path on the second line of **Base URL / Path**. **Endpoint** is the last non-empty path segment before query parameters. For `https://example.com/api/v1/orders?page=2`, these are `https://example.com`, `/api/v1`, and `orders`. Missing Path and Endpoint cells stay blank; their filter choices are labeled No path and No endpoint. Trailing slashes do not create empty endpoints. Localhost ports, relative rule paths, encoded segments, and wildcard rule patterns are preserved. Full URLs, including query parameters, remain in tooltips, details/editors, search, and the matching engine.

Filters support multiple Type, Method, Status, Base URL, Path, and Endpoint choices, searchable options, select-all, removable pills, and Clear filters. Rules also filters On/Off. Choices within a group use OR; groups combine with AND. Rules Clear still confirms deletion of **all rules in the active flow**, including rows hidden by filters.

All tabs share the full app viewport and page-header styling. Tab hover feedback slides over 150ms on supported runtimes without changing selection; keyboard activation and reduced-motion feedback stay immediate. The Flow toolbar appears in Requests and Rules; Settings omits it. Filters, Path, Endpoint, Base URL, and Flow trays open on hover. Filter search remains above its scrolling options. URL trays use full-width options with balanced padding. Flow, Base URL, Path, Endpoint, and filter option trays size to their contents within the viewport; Flow row action buttons are smaller. Hovered button counts use the same light beige as their labels. Button feedback stays immediate. Pointer-opened trays use a brief 150ms fade; keyboard opening stays immediate, and reduced-motion settings suppress the fade. Success, progress, and error feedback uses dismissible toasts without shifting page content. Settings uses the same heading and content sizes as Requests and Rules. Compact controls use consistent heights, with small rounded rectangular badges to distinguish metadata. Recording and mocking show a blinking red indicator while active, or a steady indicator with reduced motion. Recording uses play/stop icons; mocking uses browser play/stop icons. Active modes use the theme dark fill. Scroll thumbs appear only while scrolling and hide on scroll end. Table thumbs sit just outside the table so they do not cover row actions or reserve a gutter. Escape closes menus and dialogs or aborts unsaved Flow and Env drafts.

## Status and flow formats

Dropdowns share the HTTP status picker's compact styling. Selected options appear first; controls and trays fit their longest option within the available space, and clipped values have tooltips. The HTTP status dropdown offers predefined codes and names. Search for a status or enter a custom value such as `599 Maintenance`, then select **Use 599 Maintenance**. The optional custom reason phrase is replayed in responses and exported mock handlers.

The Flow row has three transfer controls: **{}** for copy/paste, **down arrow** for Export, and **up arrow** for Import. Hover to open a tray; click, touch, and keyboard access are also available. Mockend and Postman options are visible together. Leave the tray, click outside, or press Escape to close it. Postman supports Collections with saved examples, executable Mocks, and OpenAPI 3.0 JSON Specs. Specs preserve Mockend matching conditions in a vendor extension. Third-party OpenAPI 3.0/3.1 JSON imports need inline response examples and resolved server URLs; resolve references before import. Collections and Specs require concrete HTTP routes; use Mocks for wildcards and network errors. Postman Flows is explicitly unavailable because independent mock rules do not include a flow graph. Postman can import [OpenAPI specifications](https://learning.postman.com/docs/design-apis/specifications/import-a-specification/).

The interface calls scenarios **Flows**. Backups retain the `scenarios` and `activeScenarioId` JSON keys, and backups with older filenames remain importable.

## Run a QA flow

1. Select a flow and choose **Add rule**. Enter the HTTP method and full request URL. Use **Fetch/XHR** for API calls or **Any HTTP request** for other browser resource types.
2. In **Request → Parameters**, select a query name or JSON path and enter its expected value. Captured JSON and pasted example JSON populate the searchable JSON field picker. Join rows with **AND** or start an alternative group with **OR**. Use the small handle to drag conditions, or focus the handle and press an arrow key. Operators stay in their positions. Only the selected conditions are saved in the rule. Use **Exact JSON** to compare the entire request body. Set the response status and paste the response JSON. Add headers, a delay, or a network error if the test needs it.
3. In Chrome or Edge, open the app tab, click the Mockend toolbar icon, and choose **Start mocking**. Reload the app if you need to catch requests made during startup. When creating a rule from a recorded request, **Save and start mocking** attaches to the recorded app tab if needed. Retry the request after mocking starts. In VS Code, enter the app address and choose **Start recording** or **Start mocking**. Mockend opens the Integrated Browser and enables the selected mode before navigation. An address without a scheme uses HTTPS, with HTTP for localhost and loopback addresses.
4. Interact with the app. Open **Requests → Filters → Type → Mocked** to inspect mocks alongside ordinary traffic. Switch flows to apply a different set to new requests.
5. Choose **Stop mocking** when finished. The app tab stays open and recording can continue. Close the Integrated Browser tab in VS Code to end its debugging session.

Rules shows every rule in the active flow. **Flow transfer controls / Postman / Mocks** exports or copies it as a standalone JavaScript handler. Paste the code into a code-based Postman mock, or run `postman mock run mockend.postman-mock.js`. **Import** and **Paste** accept a Mockend-generated script or Postman collection JSON containing saved response examples. If exported routes share a path across original hosts, use the `x-mockend-origin` header to select an origin. Requests defaults to **Current Base URL**. Select additional origins from the Base URL dropdown. Right-click a request cell to add its badges or exact status to Filters, or add its origin to the Base URL selector. Each rule has its own **Delete** action. Use **+** to create a flow. Open the flow selector to rename, duplicate, or delete the active flow. **Flow Export / Mockend** creates a portable file for teammates. Import replaces the current configuration after confirmation.

## Mock a captured response in Chrome or Edge

1. Open **Mockend** from the browser toolbar. The **Requests** view starts recording the active HTTP(S) tab automatically.
2. Trigger a request or reload the app to capture startup traffic. Click an endpoint to view its request and response bodies when available. Search recorded requests and available response bodies. Toggle **URL** to limit search to request URLs. Toggle **.*** to use a regular expression such as `/orders.*mode=qa/i`. Requests default to newest ID first. Click a sortable header to change the sort order or reverse it. Requests **Clear** removes only the records matching the current search and filters. Open **Filters** to find and select multiple types, methods, and status groups. Choices within a group are ORed and groups are ANDed. Use a minus sign to exclude a URL term. **Export** downloads and **Copy** copies the filtered requests with captured response examples as Postman v2.1 JSON. Click **cURL** on a request to copy a command for Bash, zsh, or Git Bash. Both formats omit common credential headers. Each exported request and example includes its replay cURL in the request description. After importing into Postman, expand each request and open its **Captured** example to view the response. Export saves recorded text bodies up to 4 MiB per response, subject to the recording buffer. If a body is unavailable, its example still includes status and headers. Right-click a row to add its origin to Base URL or its status, method, or tags to Filters. Use the row’s **Mock** button to create a rule.
3. **Mock Flow** opens Rules with a name ready to edit. Save it to create one rule per HTTP method and endpoint from the latest captured API response. This uses all captured APIs for the tab, including rows excluded by filters. Each rule matches the endpoint without requiring a specific query or body. Responses that cannot be replayed are skipped.
4. Edit the selected response in the rule editor that opens over the request list. The draft uses the captured URL, query parameters, HTTP method, resource type, status, and any available request JSON. Request and response JSON are formatted for editing. Exact query matching ignores the order of distinct parameter names and preserves the order of repeated values. Save the rule, start mocking for the app tab if needed, then repeat the request.

Recording follows the active tab in the panel’s window and retains the latest 150 completed requests per origin and 750 overall in extension storage, including available response bodies. Each origin remembers its search, filters, selected view, and sort. Pause recording to inspect your captures. Pausing recording still shows new mocked requests while the panel is open on the mocked tab. Closing the panel keeps the saved history. Mocking has its own control. The editor handles JSON and text responses up to 1 MiB. Chrome exposes response bodies after a request finishes. Capture keeps the body in the editor until you save the rule. New captured rules go first in the active flow so an existing broad rule does not take precedence.

## Try it on a demo app

Run `npm run demo` from the project root. Open **http://127.0.0.1:4319/** and choose **Load cart**. The demo server returns a Notebook. Import `examples/checkout-scenarios.json` to try the optional examples. With mocking active, **Demo · Checkout** returns a Canvas tote and intercepts only the `EXPIRED` coupon. **Demo · Empty cart** returns an empty array and **Demo · Offline** simulates a dropped connection.

## Matching and browser behavior

- Rules run from top to bottom in the active flow. The first enabled match wins. Unmatched requests continue to the original server. Matched responses and network errors are applied at the request stage, before an API request reaches the server.
- Exact URL + query matches the full URL and its query values. Endpoint only matches the scheme, host, and path, making it suitable for individual query conditions. JSON parameter paths use slash-separated keys such as `/items/0/id`, and values use JSON syntax. Pattern supports wildcard URLs. `*` matches zero or more characters anywhere in a pattern. Use a host and path to keep rules specific. HTTP methods are case-sensitive after normalization. Enter `*` to match any method.
- A JSON body condition matches object keys recursively and matches arrays by length and order. The request may include additional object keys. JSON scalars, including `null`, match by value. The response may be any JSON value. The rule editor accepts statuses 100–999. The 1xx range is informational and a browser may require a final response. HEAD and statuses 204, 205, and 304 return an empty body.
- The browser still enforces its security policies. For cross-origin APIs, supply the CORS headers your app expects or turn on **Allow requesting origin on this mock** per rule. That helper echoes the request Origin and can answer preflights that Chromium exposes to interception. An explicit OPTIONS rule takes precedence when the browser exposes the OPTIONS request.
- Browser HTTP caching is disabled while mocking. Service worker bypass defaults to on and can be switched off in Settings for testing service worker behavior. Existing tabs only receive mocks after you start a session.
- Mockend targets browser HTTP(S) requests. WebSocket messages, native app traffic, and server-to-server traffic are outside its scope. Chrome and Edge also attempt to cover out-of-process iframes and dedicated workers. In VS Code, coverage is the main page target and requests exposed by its JavaScript debugger. The integrated browser requires VS Code Desktop's built-in JavaScript debugger and a trusted local workspace if a workspace is open. Managed browser policies may restrict debugger access.
- Limits are 50 flows, 200 rules per flow, 4 MiB per configuration, 1 MiB per response body, and a 30-second delay. Mockend leaves transport-managed headers to the browser.

## Development commands

| Command | What it does |
| --- | --- |
| `npm ci` | Installs the locked development dependencies |
| `npm run build` | Recreates `build/` and `dist/`, refreshes stable `release/` paths and checksums |
| `npm run check` | Checks JavaScript syntax across source, scripts, examples, and tests |
| `npm run release` | Builds and refreshes the current installers and checksums in `release/` |
| `npm run release:check` | Verifies committed installers and checksums against a fresh build |
| `npm run update:vscode` | Builds and updates the installed mockend.mockend extension, preserving its settings |
| `npm run publish:check` | Checks publishing materials, identity, license, packages, and checksums locally |
| `npm run demo` | Starts the local checkout demo on port 4319 |
| `npm test` | Exercises matching, capture, storage, Postman exports, and the simulated hosts |
| `npm run browser:install` | Downloads Playwright's Chromium |
| `npm run test:tables` | Checks URL columns, independent filters, search, sorting, row controls, spacing, and switches in Chromium |
| `npm run test:vscode` | Runs recording and mocking against the installed VS Code Desktop in an isolated profile |
| `npm run test:panel` | Runs the shared panel tests in Chromium with simulated Chrome and VS Code hosts |
| `npm run test:browser` | Runs the panel tests and Chromium interception tests, including unpacked extension tests |

```sh
npm ci
npm run browser:install
npm run build
npm run test:browser
```

Stop a running demo before `npm run test:browser`. The unpacked extension test starts its own demo on port 4319. Use the Playwright-installed Chromium for the full suite. On supported Linux distributions, run `npx playwright install --with-deps chromium` if Chromium reports missing system libraries. See the [Playwright Chromium setup guide](https://playwright.dev/docs/browsers) for browser and OS dependencies.

If you only need the build and unit tests, run `npm run build` and `npm test` without installing Playwright. You can also build directly with `py -3 scripts/build.py` on Windows or `python3 scripts/build.py` on macOS/Linux. The Python builder uses the standard library.

### Source map

| Path | Where to make changes |
| --- | --- |
| `src/core/` | Flow validation, matching rules, response construction, interception |
| `src/ui/` | Shared panel markup, styles, rule editor, and code editor |
| `src/chromium/` | Chrome and Edge extension host, plus the request list, recorder, and Postman code shared with VS Code |
| `src/vscode/` | VS Code extension host, webview bridge, Integrated Browser, and debugger connection |
| `test/` | Unit, host, browser, and panel tests |
| `examples/` | Checkout demo and importable flows |
| `scripts/` | Build and packaging scripts |
| `release/` | Prebuilt installers shipped with the full project ZIP |

Edit `src/`, then rebuild and reload the target extension. `build/chromium/` is the unpacked browser extension, `build/vscode/` stages the VS Code extension, and `dist/` contains the new Chrome ZIP, VSIX, and combined ZIP. The build replaces both generated directories. Every build also refreshes the stable directory and package filenames in `release/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for verification and release steps and [CHANGELOG.md](CHANGELOG.md) for changes from the remote baseline. CI builds on Linux and Windows, checks installer freshness, and runs the browser suite on Linux.

For a new release, set the same version in `package.json`, `src/chromium/manifest.json`, and `src/vscode/package.json`. Run `npm install --package-lock-only` to sync the lockfile, refresh any versioned filenames in the README, and run the build and tests. Package files are named from the extension manifests. The root npm package is private.

### Quick manual smoke test

1. Install the extension or VSIX. Run `npm run demo`.
2. In Chrome or Edge, open the demo and then Mockend. In VS Code, open Mockend, enter `localhost:4319`, and select **Start recording**.
3. Click **Load cart**. In Requests, open `GET /api/cart` and check the response. The demo returns **Notebook**.
4. In Rules, import `examples/checkout-scenarios.json` and select **Demo · Checkout**. Start mocking, then click **Load cart** again.
5. Check for **Canvas tote** in the demo and the **Mocked** badge on the request. In VS Code, this step also verifies the real desktop debugger connection.

### Verification boundaries

CI and local commands verify source behavior and package consistency. The VS Code host tests simulate the debugger API; the real desktop Integrated Browser connection still needs the manual smoke test above. Browser test results depend on having the Playwright Chromium download installed.

Platform documentation: [Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger), [Edge sideloading](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading), [VS Code Integrated Browser](https://code.visualstudio.com/docs/debugtest/integrated-browser), [VSIX installation](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix).

Use **Ctrl + +** or **Ctrl + −** to zoom the panel, and **Ctrl + 0** to reset it. On macOS, use Command.

### Shortcut scope

`Ctrl+Shift+M` toggles Mockend in supported browsers and VS Code, including Control on macOS. Browser and operating system shortcuts can take precedence. For an OS-wide browser shortcut, open **Manage browser shortcuts**, clear any conflicting binding, assign `Ctrl+Shift+M` to **Toggle Mockend (global shortcut)** and choose **Global** where the browser supports it. Chrome only permits numbered keys as suggested global defaults, and ChromeOS does not support global commands. VS Code keybindings work while VS Code is focused; an extension cannot register an OS-wide hotkey through VS Code's API.
