# Contributing

Use Node.js 22+ and Python 3.10+. Install development dependencies with `npm ci`.
On Windows, use `npm.cmd` if PowerShell execution policy blocks `npm.ps1`.

## Structure

Edit `src/` for both extension hosts and the shared engine. Keep host-specific APIs
in `src/chromium/` or `src/vscode/`. Tests live in `test/`, and `examples/` contains
the local demo and importable scenarios. `build/` and `dist/` are generated and
ignored. `release/` contains the current installable packages and checksums.

Keep changes focused, preserve existing configuration and extension identities,
and add regression coverage for behavior changes. Reuse the existing JavaScript
modules; a TypeScript migration is a separate architectural change. New JavaScript
uses two spaces, single quotes, and no semicolons. Avoid unrelated formatting churn.

## Verify a change

```sh
npm ci
npm run check
npm test
npm run build
npm run browser:install
npm run test:browser
```

On Linux, `npx playwright install --with-deps chromium` also installs required
system libraries. Stop the demo before the browser suite, which uses port 4319.
The repository currently has no ESLint, Prettier, or TypeScript checks configured;
`npm run check` checks JavaScript syntax. It does not perform linting or type checking.

Use the README's manual smoke test for the real VS Code Desktop debugger flow.
Do not describe simulated host tests as verification of a real desktop installation.

With VS Code Desktop installed and any pending update completed, run `npm run test:vscode`
to exercise the real Integrated Browser in a separate temporary profile. The test records
a local API response, mocks it, stops mocking while keeping the browser open, and verifies
that ordinary recording resumes. Set `VSCODE_EXECUTABLE` to the editor executable if it is
installed outside the default location. Results are saved in `test-results/vscode-integration.json`.

## Prepare installable packages

1. Update the same version in `package.json`, `src/chromium/manifest.json`, and
   `src/vscode/package.json`. Keep the existing extension name, publisher, and IDs.
2. Run `npm install --package-lock-only` and update the changelog and README links.
3. Complete the checks above, including the manual smoke test where available.
4. Run `npm run build` to refresh versioned packages, fixed-name aliases, and the
   stable `release/chromium/` directory, then
   `npm run release:check` to verify exact bytes and SHA-256 checksums.
5. Commit source and current packages together. Remove superseded installers from
   the current tree; Git history retains previous versions.

Builds use stable archive timestamps and ordering. CI checks that the committed
packages are rebuilt on Linux and Windows, and uploads `dist/` as downloadable
workflow artifacts. A build does not publish to an extension store or GitHub Release.

The combined ZIP includes its own `source/` project for rebuilding. Its packaged
installers are under `source/release/`; running `npm run release` there also creates
the combined ZIP and checksums for that extracted source tree.
