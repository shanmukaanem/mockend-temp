# Changelog

## 0.0.2

- Clear all captured requests, including hidden and filtered records; keep Clear all available when no rows match, and explain the rolling 150-request limit in the count tooltip.
- Keep sortable headers above their measured label-and-arrow minimums for pointer, keyboard, saved widths, and responsive fitting; restore the original up/down arrows.
- Share one split-button surface and sliding hover indicator across action groups, with inset dark dividers that turn beige around hovered segments.
- Remove nested Flow option backgrounds, align dropdown arrows at the right edge, and attach clear buttons to rounded right corners.

## 0.0.1

- Add searches to Base URL, Path, and Endpoint trays; display domains while retaining full URLs for matching and edits.
- Keep selected tabs black with softer hover feedback, quick fading transitions, joined dark action separators, and roomier Flow actions.
- Simplify Manage apps into the same list/detail layout as Env management.
- Add the Ctrl+Shift+M VS Code toggle and a configurable browser global command, respecting platform shortcut restrictions.
- Pin the supported CI runner and normalize archive metadata across operating systems.
- Reset the release version to 0.0.1 across Chrome, VS Code, and npm metadata; retain all current functionality.
- Synchronize versions with one command and automatically bump, build, tag, and upload GitHub releases after passing main-branch CI.

## 1.5.6

- Replace Add/Edit mock targeting modes with an Env multi-select containing Select all and named Envs; remove the separate Base URL selector.
- Align Env, Base URL, Path, and Endpoint on one row at compact and wide widths.
- Keep dropdown values contained, show clipped-value tooltips, and match control/picker widths to available space.
- Move selected native, Flow, status, and filter choices to the top while preserving focus and state.
- Reuse the HTTP status dropdown shell, positioning, and option styling across native selects, Env, Flow, and filter trays.
- Match tab height and padding to compact 24px buttons.

## 1.5.5

- Group captured API origins into one saved Env; newly mocked and recorded Flow origins join the selected Env, while named Envs and legacy loads retain their grouping.
- Edit URL service and origin cells directly in each row, with independent Save/Enter and Escape handling and unchanged cell backgrounds/heights.
- Keep Env compact by default while allowing manual resizing; show every internal divider and preserve unrelated column widths.
- Add padding inside aligned header buttons, narrow separator gaps, and use light beige for hovered counts.
- Fit Flow and filter option trays to their contents and reduce Flow action sizes.

## 1.5.4

- Replace the Env action dropdown with direct joined Set active, Rename, and Delete buttons; use icons in narrow panes and labels when space permits.
- Match Settings heading and content sizes to Requests and Rules.
- Darken shared paper, control, and header tints slightly across both extensions.
- Verify Env action sizing and placement at 320, 360, 480, 620, and 1000 pixels in Chrome and VS Code panels.

## 1.5.3

- Replace bulk Env editing with a responsive environment list and service URL detail pane.
- Add optional service labels, per-URL edit/delete, and explicit Env activation, rename, and deletion.
- Keep existing backups compatible; preserve service labels through exports and app reorganization.
- Validate origins and duplicates before saving, retain at least one URL per Env, and cancel drafts with Escape.

## 1.5.2

- Separate filtered/all mock split controls, with independent enable and disable actions.
- Resize dividers exchange width only between neighboring columns.
- Fixed four-character Env cells and aligned table header/cell insets.

## 1.5.1

- Limit the app picker to app names and Manage apps; move creation, rename, merge, split, and backup actions into a dedicated manager.
- Center Code, Export, and Import symbols at compact and wide sizes. Give all Flow option actions the same filled button style, including Delete, and suppress redundant Flow-name tooltips.
- Slide tab hover indicators using native CSS anchor positioning, retaining explicit selection state, immediate keyboard activation, reduced-motion handling, and a static fallback.
- Preserve input and textarea fills on focus, remove text-entry underlining, and retain a visible focus outline without changing the JSON editor's transparent highlight layer.

## 1.5.0

- Store concrete mock routes as endpoint paths, create or reuse their source Env automatically, and apply the selected Env's mapped origins at runtime. Upgrade legacy URL rules while retaining a local pre-upgrade backup when storage permits.
- Add an app/profile picker with independent Envs, Flows, settings, request histories, and complete workspace export/import. Switching apps stops the previous app's mocks and opens the saved app URL when configured.
- Merge an app's Envs and Flows into another app with collision-safe IDs. Split selected Envs into a new app with reusable Flows and valid per-app Env references.
- Show all mapped base URLs in the rule editor, retain request/query matching modes and portable exports, and package the new shared module for both Chrome and VS Code.
- Install Chrome's Modern Web Guidance skills and track permissions, privacy, assets, and submission requirements in CHROMEWEBSTORE.md.

## 1.4.54

- Tighten Flow tray actions, align filter options with heading text, and give filter counts a small inline slot without overlapping icons or labels.
- Start request-filter inversion off when opening a site, and use neutral fills for add buttons until hover.
- Leave absent path and endpoint cells blank while retaining compatible filter values; label empty filter choices clearly.
- Show scrollbars only while scrolling, outside table controls, and hide them immediately on scroll end.
- Replace Flow transfer and collection export glyphs, restore red recording/mocking indicators, and use a brief opacity transition for pointer-opened trays with instant keyboard access and reduced-motion support.

## 1.4.53

- Keep filter search above a separate scrolling options area, unify heading hover surfaces, and hide unused filter-action space.
- Open Filters on hover using the same tray behavior as Flow, transfer, and URL selectors. Move Endpoint beside Path in Requests and Rules, selected in full by default.
- Combine view tabs into one segmented strip, space the Code glyph as `{ }`, and distinguish start/stop mocking with browser play/stop icons.
- Offer Save Env only for unsaved current origins. Remove All Env from new toolbar selections while retaining existing saved selections and per-rule targeting scopes.

## 1.4.52

- Prompt for the app URL when starting recording or mocking in VS Code without a connected browser, instead of rejecting an empty URL.
- Keep the URL prompt open while entering the address, cancel cleanly, and reuse an existing integrated browser without prompting again.
- Avoid showing a mocking success toast after cancelling browser setup.

## 1.4.51

- Align rule-editor headers, tabs, and content; move Path and Endpoint left while preserving Base URL placement.
- Replace numeric HTTP status controls and the separate name field with one themed, searchable dropdown supporting predefined and custom statuses.
- Simplify the parameter drag handle, center remove icons, and unify dropdown arrows.
- Give the request-name pencil a proper button hover state and switch editor tabs immediately.

## 1.4.50

- Keep Method, Base URL, Type, and Status at stable default widths while restoring manual resizing, including Status without a trailing divider.
- Apply immediate black button hover states and use a single hover owner per table, clearing highlights on scrolling, row replacement, and navigation.
- Clip overflowing labels without ellipsis, retaining full values in tooltips and editors.
- Replace Requests and Invert Filter icons; unify all filter checkboxes and give scrolling tray headers opaque backgrounds.
- Match the Flow editor field to the current picker and align Flow tray action slots with the controls above.

## 1.4.49

- Fit all columns within the available viewport before expanding text columns; remove legacy minimum table widths that forced overflow.
- Keep Method, Base URL, Type, and Status widths fixed across records, filters, sorting, and window resizing. Pin the final controls column when a narrow panel requires scrolling.
- Replace inline success, progress, and error notices with a shared, dismissible toast system above pages and dialogs, including validation and code-copy feedback.
- Establish Settings typography with a larger page title, consistent section titles, and smaller field and Env labels.

## 1.4.48

- Remove Group by API and its extra group rows. Rules remain a single sortable, filterable list; IDs continue to show matching priority.
- Round only the top-left and top-right table corners. Clip at the viewport so the rounded top corners remain visible during horizontal and vertical scrolling; keep the header bottom edge square.

## 1.4.47

- Reserve sort-indicator space without including the indicator in column measurements, so sorting does not resize columns.
- Keep column separators light without active or hover shading.
- Open Flow, transfer, Path, and Base URL trays immediately on hover, with click, touch, keyboard, and Escape access preserved.
- Put Requests and Rules empty states inside full-span table rows, with messages kept visible in narrow scrolling viewports.
- Hide the Flow toolbar in Settings, match Flow control typography, rename Download/Upload to Export/Import, and equalize URL/regex/filter control heights.

## 1.4.46

- Give Path options the full tray width, with equal 8px padding for rows, headers, and select-all checkbox areas.
- Align Base URL options and checkbox placement, and keep the current-origin subtitle on a separate line.
- Give select text padding on every side and share the Flow toolbar across Requests, Rules, and Settings so page headers have identical placement and spacing.
- Remove action color transitions and copy-label motion, and reuse one reversed record list when updating filter groups.

## 1.4.45

- Add leading padding to the rule-name placeholder and align the target summary to the page inset.
- Reduce controls to 24px, metadata badges to 18px rounded rectangles, and the stacked cURL / Mock control width.
- Add space before sort indicators and between header hover fills and the shaded resize separator.
- Replace hover-driven transfer menus with click-operated trays showing all Mockend/Postman options together, with black open-trigger states.
- Round Flow and filter trays, use a single surface with section labels, normalize Flow action SVGs, and replace the start-mocking bolt with a response-check icon.

## 1.4.44

- Restore warm filled controls and consistent stroke icons, with theme-colored active recording and mocking states.
- Restore rounded table header ends, balanced header padding, and hover insets clear of resize separators.
- Refresh a stable unpacked browser directory, fixed-name packages, and checksums on every build; add a VS Code update command.
- Use the mockend publisher, extension, command, and view identities. Existing mockroute-local.mockroute installations require one-time backup/import into mockend.mockend.
- Add a root-manifest Chrome Store ZIP, Marketplace metadata, proprietary use license, privacy policy, listing materials, and a short publication guide.

## 1.4.43

- Rename Scenario to Flow throughout the interface while preserving existing backup and storage formats.
- Keep records at a uniform height with ellipses, fill available table width, and omit the trailing header divider.
- Move Requests cURL / Mock controls to the row end and remove Requests delete buttons.
- Enable or disable every mock in the active Flow, including filtered rows, and invert search/filter results.
- Unify compact control sizes, flatten menus and panel surfaces, and distinguish recording and mocking start/stop controls by color and icon.
- Give every tab the same full-width viewport, overlay scrollbars without reserved gutters, and Escape cancellation for draft Flow and Env forms alongside dialogs and menus.

## 1.4.42

- Restore the always-visible stacked cURL / Mock split button in Requests and reserve enough endpoint width for it.
- Remove the duplicate action from Rules, leaving only the delete icon and existing enabled switch.
- Apply consistent leading insets to headings, table cells, inputs, and menus.

## 1.4.41

- Use icons by default, reveal icon labels at 960px, and keep controls content-sized.
- Align app URL input and view tabs in one row.
- Prefill and save the current site as an Env.
- Add predefined HTTP status names and custom reason phrases across editor, validation, capture, interception, and Postman mocks.
- Embed delete buttons at record ends, removing the Actions column.
- Rename the display label Ingress to Path and move Base URL/Path selection outside Filters, with all paths selected by default.
- Consolidate scenario copy/paste, downloads, and uploads into three same-row controls. Add Collection and OpenAPI JSON transfers; mark Flows unavailable.

## 1.4.40

- Fit Requests and Rules columns to record contents within individual width limits.
- Add pointer and keyboard resizing, independent saved widths, and double-click auto-fit.
- Replace the separate environment button with an Env picker: No Env uses saved URLs, an empty picker opens Settings, and Manage Env remains available after setup.
- Use compact toolbar icons on narrow panels and red rule delete icons without a visible Actions heading.
- Add a real VS Code Desktop Integrated Browser integration test using an isolated profile.

## 1.4.39

Changes compared with remote commit `bf90e59` (1.4.37):

- Move the development project from `source/` to the repository root and generate
  extension output under ignored `build/` and `dist/` directories.
- Add named environments and original, active, all, or selected environment scopes.
  Preserve origin-only rebasing, existing configuration imports, and Postman exports.
- Separate URL origin, ingress, and endpoint fields in request and rule tables, with
  independent filtering, search, sorting, and rule actions.
- Add VS Code request recording, response capture, clipboard and file exports, and
  separate controls for stopping mocks and recording. Accept app URLs without a scheme.
- Add environment, URL, table, and host regression coverage.
- Prevent duplicate route IDs when environment targets expand in Postman exports.
- Keep rule switches inside their table cells and request tables within short
  viewports. Update browser fixtures, selectors, tab synchronization, and clipboard
  assertions for the current UI and Windows behavior.
- Add cross-platform build CI, browser CI, syntax checks, reproducible current
  installers, checksums, and installer freshness verification.

The VS Code package remains `mockroute` from publisher `mockroute-local` and browser
packages retain their installation folder name to preserve update compatibility.

## 1.4.37

Remote baseline: `bf90e59`, updating the Chromium extension to 1.4.37. The remote
tree still contained a root VSIX named `mockroute-1.4.36.vsix`.
