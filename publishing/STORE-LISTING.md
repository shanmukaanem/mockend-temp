# Mockend

**Summary:** Record browser requests and test your app with reusable API mocks, custom responses, delays, and network failures.

Mockend helps developers test browser behavior when an API returns different data or fails. Record requests in a connected app tab, create mocks from captured responses, and organize them into reusable Flows. Mock endpoint paths while Envs supply their URLs. Keep apps in separate profiles, switch Envs without rewriting rules, and merge apps or split selected Envs into a new app. Search traffic, inspect responses, and exchange local Mockend, Postman, or OpenAPI JSON files. All recording and configuration stay on your computer unless you explicitly export or copy them. CHROMEWEBSTORE.md contains the complete current Chrome submission metadata.

**Category:** Developer Tools (Chrome); Testing (VS Code).

**Single purpose:** Record and replace HTTP responses in a browser tab selected by the developer to test their web application.

**Chrome permission justifications:**

- `debugger`: attach the Chrome DevTools Protocol to the selected app tab to capture request/response data and fulfill matching requests with configured mocks.
- `tabs`: identify the current app tab, show its title/URL, and keep recording/mocking attached to that tab.
- `storage`: persist the user's local mock rules, Flows, Env settings, and preferences.
- `sidePanel`: display the recording and mock editor beside the app.
- `clipboardWrite`: copy a cURL command, JSON backup, or supported transfer file when the user chooses Copy.

**Remote code:** No. Executable extension code is included in the package. Imported JSON is parsed as data; generated Postman handler imports are decoded, not executed by Mockend.

**Data handling:** No developer-operated collection, analytics, advertising, sale, or third-party transmission. The extension processes website content and network data locally; declare those capabilities accurately in the dashboard. Explicit exports are user-controlled. Use the public URL of PRIVACY.md for the policy field.

**Reviewer test:** Open an app you control, start recording, trigger a JSON API request, click Mock beside it, change the response body, choose Save and start mocking, then repeat the request. Stop mocking restores the original response. No account or payment is required to use Mockend.
