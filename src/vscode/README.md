# Mockend

Test your app's API responses directly in the VS Code Integrated Browser.

- Record HTTP requests and inspect captured responses.
- Create reusable Flows with JSON responses, custom status codes, delays, and network errors.
- Match URLs, methods, query values, and JSON request fields.
- Switch Env targets and enable or disable individual mocks or an entire Flow.
- Import and export Mockend backups, Postman collections, mock handlers, and OpenAPI JSON examples.

## Start

1. Open **Mockend** from the Activity Bar.
2. Enter your app URL and choose **Start recording**. Mockend opens the Integrated Browser.
3. Choose **Mock** beside a captured request, edit the response, then **Save and start mocking**.
4. Retry the request in your app. Choose **Stop mocking** to return to the real server.

Requires VS Code Desktop 1.112 or newer and a trusted local workspace. Not available in vscode.dev, remote extension hosts, or virtual workspaces. The Chrome/Edge version is available from the repository's release packages.

## Privacy

Mockend has no telemetry or hosted service. Configuration and recordings remain on your computer. Recording can contain sensitive request and response data; review files before sharing exports. Mocking changes responses only in the browser session you connect.

See [privacy details](https://github.com/shanmukaanem/mockend-temp/blob/main/PRIVACY.md) and [report an issue](https://github.com/shanmukaanem/mockend-temp/issues).
