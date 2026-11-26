# Build, update, publish

## Local updates

Run `npm run build`. Every build refreshes these same paths:

- **Chrome/Edge:** load `release/chromium/` once with **Load unpacked**. After later builds, click **Reload** at `chrome://extensions` or `edge://extensions` and reopen the panel. Keep this folder at the same path.
- **VS Code:** run `npm run update:vscode`, then **Developer: Reload Window**. This updates the existing extension from `release/Mockend.vsix`; it does not uninstall it or reset its settings. A fixed VSIX filename alone cannot live-update an installed extension.

Existing browser installs loaded from another directory need a one-time move to the stable directory, or you can copy the contents of `release/chromium/` into their original loaded directory to preserve that installation's ID and storage.

## Versions and GitHub releases

- Set an exact version: `npm run version:set -- 0.0.1`.
- Bump locally: `npm run version:set -- patch`.
- Push to `main`: CI checks both operating systems and browser behavior, then automatically bumps the patch version, rebuilds, commits the stable packages, tags the version, and uploads the three packages plus checksums to GitHub Releases. An explicit version change in the push is preserved; this reset publishes `0.0.1`.
- Pull `main` after the workflow completes. The bot uses the built-in GitHub token, whose pushes do not trigger recursive workflow runs. An outdated run fails without overwriting newer commits.

These commands synchronize npm metadata, the lockfile, and both extension manifests. Builds remain reproducible and never change the version themselves. Store publishing still requires the same listing and a strictly higher version; resetting to `0.0.1` cannot replace an already-published higher version.

## Chrome Web Store

1. Register at the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) and upload `release/Mockend-Chrome.zip`.
2. Add the description and screenshots from `publishing/`, and host [PRIVACY.md](PRIVACY.md) at a publicly accessible URL. Complete the privacy and distribution fields.
3. Submit for review. Later: increase the version, build, and upload the new ZIP to **the same listing**.

## VS Code Marketplace

1. Create or select the `mockend` [publisher](https://marketplace.visualstudio.com/manage). The configured extension ID is `mockend.mockend`; the package includes a proprietary license permitting use and restricting modification/redistribution. Confirm you control this publisher before uploading.
2. Run `npm run build`, then `npm run publish:check`.
3. On the publisher page, choose **New extension → Visual Studio Code** and upload `release/Mockend.vsix`. Later upload higher versions to **the same listing**.

Store installations receive updates through the stores. Unpacked browser installations require Reload; locally installed VSIX packages require the update command above.

**One-time VS Code rename:** installations of `mockroute-local.mockroute` are a different identity. Export your Flows in the old extension, install `mockend.mockend`, import the backup, and disable the old extension to avoid duplicate panels. Future updates keep `mockend.mockend`.

Keep the repository and the full `Mockend.zip` source bundle private if you do not want to publish project source. Upload only the Store ZIP or VSIX. Installed JavaScript remains inspectable; Chrome forbids obfuscating functionality ([code readability policy](https://developer.chrome.com/docs/webstore/program-policies/code-readability)). A proprietary license restricts reuse; it cannot make shipped files unreadable.

Official guides: [Chrome publishing](https://developer.chrome.com/docs/webstore/publish), [permission declarations](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [VS Code publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
