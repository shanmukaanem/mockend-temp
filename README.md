# Mockend

Mockend lets QA teams test how a web app handles a custom API response. One rule engine and one editor power Chrome, Edge, and the VS Code Integrated Browser. Rules and scenarios are stored locally and can be moved between platforms as JSON.

## Install

Extract the release ZIP before installing.

| Platform | Steps |
| --- | --- |
| **Chrome 125+** | Open `chrome://extensions`. Enable **Developer mode**, choose **Load unpacked**, and select the extracted `chromium` folder. |
| **Edge 125+** | Open `edge://extensions`. Enable **Developer mode**, choose **Load unpacked**, and select the same `chromium` folder. |
| **VS Code Desktop 1.112+** | Run **Extensions: Install from VSIX…** from the Command Palette and select `mockroute-1.4.36.vsix`. Open **Mockend** from the Activity Bar or run **Mockend: Open**. |

The packages are distributed for local installation. Chrome and Edge display a debugging notice while recording or mocking. The `debugger` permission intercepts requests in the tab you start mocking. The `tabs` permission identifies and displays that tab. The extension uses local storage for scenarios and never sends your configuration or activity to a service.

Mockend requests **Ctrl+Shift+M** as its default and provides **Ctrl+Shift+Y** as an alternate. Press again to close the side panel on browsers that support programmatic panel closing (Chrome 141+). Chrome reserves Ctrl+Shift+M for profile switching. **Settings → Open Mockend shortcut** shows the assigned chord and opens the browser’s extension shortcut settings if it is unassigned or you want to change it.

Use the **Open Mockend in new tab** icon to open a full browser tab that stays connected to the original app tab. In Chrome 141 and later, opening the tab also closes the sidebar.

## Run a QA scenario

1. Select a scenario and choose **Add rule**. Enter the HTTP method and full request URL. Use **Fetch/XHR** for API calls or **Any HTTP request** for other browser resource types.
2. In **Request → Parameters**, select a query name or JSON path and enter its expected value. Captured JSON and pasted example JSON populate the searchable JSON field picker. Join rows with **AND** or start an alternative group with **OR**. Use the six-dot handle to drag conditions, or focus the handle and press an arrow key. Operators stay in their positions. Only the selected conditions are saved in the rule. Use **Exact JSON** to compare the entire request body. Set the response status and paste the response JSON. Add headers, a delay, or a network error if the test needs it.
3. In Chrome or Edge, open the app tab, click the Mockend toolbar icon, and choose **Start mocking**. Reload the app if you need to catch requests made during startup. When creating a rule from a recorded request, **Save and start mocking** attaches to the recorded app tab if needed. Retry the request after mocking starts. In VS Code, enter the app URL and choose **Open test browser**. Mockend opens a new integrated browser tab with interception enabled before navigation.
4. Interact with the app. In Chrome and Edge, open **Requests → Filters → Type → Mocked** to inspect mocks alongside ordinary traffic. In VS Code, **Activity** shows mock hits and upstream outcomes. Switch scenarios to apply a different set to new requests.
5. Choose **Stop mocking** when finished. In VS Code this also closes the dedicated test browser. Chrome and Edge leave your tab open.

Rules shows every rule in the active scenario. In Chrome or Edge, **Rules → Postman Mocks** exports or copies it as a standalone JavaScript handler. Paste the code into a code-based Postman mock, or run `postman mock run mockend.postman-mock.js`. **Import** and **Paste** accept a Mockend-generated script or Postman collection JSON containing saved response examples. If exported routes share a path across original hosts, use the `x-mockend-origin` header to select an origin. **Group by API** groups rules by method and endpoint path, ignoring query variants. Requests defaults to **Current Base URL**. Select additional origins from the Base URL dropdown. Right-click a request cell to add its badges or exact status to Filters. Each rule has its own **Delete** action. Use **+** to create a scenario. Open the scenario selector to rename, duplicate, or delete the active scenario. **Rules → Export** creates a portable file for teammates. Import replaces the current configuration after confirmation.

## Mock a captured response in Chrome or Edge

1. Open **Mockend** from the browser toolbar. The **Requests** view starts recording the active HTTP(S) tab automatically.
2. Trigger a request or reload the app to capture startup traffic. Click an endpoint to view its request and response bodies when available. Search recorded requests and available response bodies. Toggle **URL** to limit search to request URLs. Toggle **.*** to use a regular expression such as `/orders.*mode=qa/i`. Requests default to newest ID first. Click a sortable header to change the sort order or reverse it. Requests **Clear** removes only the records matching the current search and filters. Open **Filters** to find and select multiple types, methods, and status groups. Choices within a group are ORed and groups are ANDed. Use a minus sign to exclude a URL term. **Export** downloads and **Copy** copies the filtered requests with captured response examples as Postman v2.1 JSON. Click **cURL** on a request to copy a command for Bash, zsh, or Git Bash. Both formats omit common credential headers. Each exported request and example includes its replay cURL in the request description. After importing into Postman, expand each request and open its **Captured** example to view the response. Export saves recorded text bodies up to 4 MiB per response, subject to the recording buffer. If a body is unavailable, its example still includes status and headers. Right-click a row to add its exact URL, status, method, or tags to Filters. Use the row’s **Mock** button to create a rule.
3. **Mock Scenario** opens Rules with a name ready to edit. Save it to create one rule per HTTP method and endpoint from the latest captured API response. This uses all captured APIs for the tab, including rows excluded by filters. Each rule matches the endpoint without requiring a specific query or body. Responses that cannot be replayed are skipped.
4. Edit the selected response in the rule editor that opens over the request list. The draft uses the captured URL, query parameters, HTTP method, resource type, status, and any available request JSON. Request and response JSON are formatted for editing. Exact query matching ignores the order of distinct parameter names and preserves the order of repeated values. Save the rule, start mocking for the app tab if needed, then repeat the request.

Recording follows the active tab in the panel’s window and retains the latest 150 completed requests per origin and 750 overall in extension storage, including available response bodies. Each origin remembers its search, filters, selected view, and sort. Pause recording to inspect your captures. Pausing recording still shows new mocked requests while the panel is open on the mocked tab. Closing the panel keeps the saved history. Mocking has its own control. The editor handles JSON and text responses up to 1 MiB. Chrome exposes response bodies after a request finishes. Capture keeps the body in the editor until you save the rule. New captured rules go first in the active scenario so an existing broad rule does not take precedence.

## Try it on a demo app

Run `node examples/demo.mjs` from the extracted ZIP. Open **http://127.0.0.1:4319/** and choose **Load cart**. The demo server returns a Notebook. Import `examples/checkout-scenarios.json` to try the optional examples. With mocking active, **Demo · Checkout** returns a Canvas tote and intercepts only the `EXPIRED` coupon. **Demo · Empty cart** returns an empty array and **Demo · Offline** simulates a dropped connection. The same starter configuration is available in `examples/checkout-scenarios.json`.

## Matching and browser behavior

- Rules run from top to bottom in the active scenario. The first enabled match wins. Unmatched requests continue to the original server. Matched responses and network errors are applied at the request stage, before an API request reaches the server.
- Exact URL + query matches the full URL and its query values. Endpoint only matches the scheme, host, and path, making it suitable for individual query conditions. JSON parameter paths use slash-separated keys such as `/items/0/id`, and values use JSON syntax. Pattern supports wildcard URLs. `*` matches zero or more characters anywhere in a pattern. Use a host and path to keep rules specific. HTTP methods are case-sensitive after normalization. Enter `*` to match any method.
- A JSON body condition matches object keys recursively and matches arrays by length and order. The request may include additional object keys. JSON scalars, including `null`, match by value. The response may be any JSON value. The rule editor accepts statuses 100–999. The 1xx range is informational and a browser may require a final response. HEAD and statuses 204, 205, and 304 return an empty body.
- The browser still enforces its security policies. For cross-origin APIs, supply the CORS headers your app expects or turn on **Allow requesting origin on this mock** per rule. That helper echoes the request Origin and can answer preflights that Chromium exposes to interception. An explicit OPTIONS rule takes precedence when the browser exposes the OPTIONS request.
- Browser HTTP caching is disabled while mocking. Service worker bypass defaults to on and can be switched off in Settings for testing service worker behavior. Existing tabs only receive mocks after you start a session.
- Mockend targets browser HTTP(S) requests. WebSocket messages, native app traffic, and server-to-server traffic are outside its scope. Chrome and Edge also attempt to cover out-of-process iframes and dedicated workers. In VS Code, coverage is the main page target and requests exposed by its JavaScript debugger. The integrated browser requires VS Code Desktop's built-in JavaScript debugger and a trusted local workspace if a workspace is open. Managed browser policies may restrict debugger access.
- In VS Code, Activity retains the latest 100 entries in local extension storage, and omits query strings, request bodies, and request headers. URL paths and rule names still appear. Configuration exports include the values entered in your rules.
- Limits are 50 scenarios, 200 rules per scenario, 4 MiB per configuration, 1 MiB per response body, and a 30-second delay. Mockend leaves transport-managed headers to the browser.

## Build and verify

From the extracted `source` folder, run `python3 scripts/build.py` to recreate the packages under `dist/`. Building requires Python 3.10+ and has zero third-party dependencies. Run `node --test test/core.test.mjs test/hosts.test.mjs test/capture.test.mjs` for the engine and simulated extension-host tests using Node 22+. Browser integration tests use Playwright and a local Chromium executable. Run `node --test test/chromium.test.mjs` after building, with Playwright installed or `PLAYWRIGHT_MODULE` set to its absolute module path. Set `CHROMIUM_PATH` to select a browser binary. Run `node --test test/side-panel.test.mjs` to verify request filters and the response editor in Chromium with simulated Chrome extension APIs.

Platform documentation: [Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger), [Edge sideloading](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading), [VS Code Integrated Browser](https://code.visualstudio.com/docs/debugtest/integrated-browser), [VSIX installation](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix).

Use **Ctrl + +** or **Ctrl + −** to zoom the panel, and **Ctrl + 0** to reset it. On macOS, use Command.
