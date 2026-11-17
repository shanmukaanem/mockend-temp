#!/usr/bin/env python3
"""Create both installable packages from the shared source with the Python standard library."""

import json
import shutil
import struct
import zlib
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
BUILD = ROOT / "build"
DIST = ROOT / "dist"


def archive(destination, files):
    with ZipFile(destination, "w") as output:
        for name, content in sorted(files.items()):
            record = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            record.compress_type = ZIP_DEFLATED
            record.external_attr = 0o100644 << 16
            output.writestr(record, content)


def tree(directory, prefix=""):
    return {
        f"{prefix}{path.relative_to(directory).as_posix()}": path.read_bytes()
        for path in directory.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts
    }


def png(size, monochrome=False):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    def segment_distance(x, y, start, end):
        ax, ay = start
        bx, by = end
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
        return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2

    # API code brackets frame a substituted response checkmark.
    brackets = [((.32, .32), (.18, .50)), ((.18, .50), (.32, .68)),
                ((.68, .32), (.82, .50)), ((.82, .50), (.68, .68))]
    check = [((.39, .51), (.47, .59)), ((.47, .59), (.62, .40))]
    background = (31, 46, 44)

    def sample(x, y):
        if any(segment_distance(x, y, *line) <= .039 ** 2 for line in brackets):
            return (246, 232, 207, 255)
        if any(segment_distance(x, y, *line) <= .042 ** 2 for line in check):
            return (246, 232, 207, 255) if monochrome else (221, 199, 164, 255)
        corner_x = max(.23 - x, x - .77, 0)
        corner_y = max(.23 - y, y - .77, 0)
        if not monochrome and corner_x ** 2 + corner_y ** 2 <= .21 ** 2:
            return (*background, 255)
        return (0, 0, 0, 0)

    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            samples = [sample((x + dx) / size, (y + dy) / size)
                       for dy in (.25, .75) for dx in (.25, .75)]
            visible = [rgba for rgba in samples if rgba[3]]
            if visible:
                rows.extend([sum(rgba[i] for rgba in visible) // len(visible) for i in range(3)])
                rows.append(round(255 * len(visible) / len(samples)))
            else:
                rows.extend((0, 0, 0, 0))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )


def compile_host(host):
    output = BUILD / host
    for shared in ("core", "ui"):
        shutil.copytree(SRC / shared, output / shared, ignore=shutil.ignore_patterns("panel.html"))
    shutil.copytree(SRC / host, output / host)
    manifest_name = "manifest.json" if host == "chromium" else "package.json"
    (output / host / manifest_name).rename(output / manifest_name)
    panel = (SRC / "ui" / "panel.html").read_text(encoding="utf-8").replace("ui/panel.mjs", "ui/panel.js")
    if host == "chromium":
        csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';"
        panel = panel.replace("@@ROOT@@/", "").replace(' nonce="@@NONCE@@"', "").replace("@@HOST@@", host)
        manifest = output / manifest_name
        manifest.write_text(manifest.read_text(encoding="utf-8").replace("background.mjs", "background.js"), encoding="utf-8")
        web_modules = list(output.rglob("*.mjs"))
    else:
        csp = "default-src 'none'; script-src @@SOURCE@@ 'nonce-@@NONCE@@'; style-src @@SOURCE@@; img-src @@SOURCE@@;"
        web_modules = [output / path for path in ("ui/panel.mjs", "ui/json-editor.mjs", "vscode/bridge.mjs", "core/config.mjs", "core/matcher.mjs")]
    # Use the .js MIME mapping for browser and webview resources.
    for module in web_modules:
        code = module.read_text(encoding="utf-8").replace(".mjs'", ".js'")
        module.with_suffix(".js").write_text(code, encoding="utf-8")
        if host == "chromium" or module.parent.name in {"ui", "vscode"}:
            module.unlink()
    if host == "chromium":
        requests = (output / host / "requests.html")
        panel = panel.replace("</head>", '  <link rel="stylesheet" href="chromium/requests.css">\n</head>')
        header, content = requests.read_text(encoding="utf-8").split("</header>", 1)
        panel = panel.replace("<body>", "<body>\n" + header + "</header>", 1)
        panel = panel.replace("<main@@MAIN_HIDDEN@@>", content + "<main@@MAIN_HIDDEN@@>", 1)
        requests.unlink()
    panel = panel.replace("@@CSP@@", csp).replace("@@MAIN_HIDDEN@@", " hidden" if host == "chromium" else "")
    panel = panel.replace("@@REQUEST_TAB@@", '<button type="button" data-view="requests" aria-current="page">Requests</button>' if host == "chromium" else "")
    panel = panel.replace("@@TARGET_ACTION@@", "" if host == "chromium" else '<button class="primary target-action" id="toggle" type="button" disabled>Open test browser</button>')
    panel = panel.replace("@@ACTIVITY_TAB@@", '' if host == "chromium" else '<button type="button" data-view="activity">Activity <span id="hit-count" class="count" hidden></span></button>')
    panel = panel.replace("@@RULES_CURRENT@@", "" if host == "chromium" else ' aria-current="page"')
    (output / "panel.html").write_text(panel, encoding="utf-8")
    icons = output / "icons"
    icons.mkdir()
    for size in (16, 32, 48, 128):
        (icons / f"{size}.png").write_bytes(png(size))
    (icons / "activity.png").write_bytes(png(24, monochrome=True))
    return output


def vsix_manifest(package):
    name, version, publisher = (quoteattr(package[key]) for key in ("name", "version", "publisher"))
    title, description = (escape(package[key]) for key in ("displayName", "description"))
    engine = quoteattr(package["engines"]["vscode"])
    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id={name} Version={version} Publisher={publisher} />
    <DisplayName>{title}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Categories>Testing</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value={engine} />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
    </Properties>
    <Icon>extension/icons/128.png</Icon>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icons/128.png" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
""".encode()


def content_types():
    types = {
        "vsixmanifest": "text/xml", "json": "application/json", "png": "image/png",
        "css": "text/css", "html": "text/html", "cjs": "text/javascript",
        "js": "text/javascript", "mjs": "text/javascript", "md": "text/markdown",
    }
    entries = "\n".join(f'  <Default Extension="{extension}" ContentType="{mime}" />' for extension, mime in types.items())
    return f'<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n{entries}\n</Types>\n'.encode()


def main():
    for folder in (BUILD, DIST):
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir()
    chromium = compile_host("chromium")
    vscode = compile_host("vscode")
    shutil.copyfile(ROOT / "README.md", vscode / "README.md")
    package = json.loads((vscode / "package.json").read_text(encoding="utf-8"))
    version = package["version"]
    if json.loads((chromium / "manifest.json").read_text(encoding="utf-8"))["version"] != version:
        raise ValueError("The Chromium and VS Code package versions must match.")
    vsix = DIST / f"mockroute-{version}.vsix"
    archive(vsix, {
        **tree(vscode, "extension/"),
        "extension.vsixmanifest": vsix_manifest(package),
        "[Content_Types].xml": content_types(),
    })
    chrome_zip = DIST / f"Mockend-Chrome-{version}.zip"
    chrome_instructions = (
        "1. Extract this ZIP.\n"
        "2. In desktop Chrome, open chrome://extensions and enable Developer mode.\n"
        "3. Choose Load unpacked and select the MockRoute-Chrome folder containing manifest.json.\n"
        "4. Open the Mockend extension from the browser toolbar on your app tab. Ctrl+Shift+Y opens the panel when Chrome assigns the shortcut.\n"
        "5. Trigger a request, filter the request list, then right-click its row and choose Mock.\n"
        "\nUpdating an existing unpacked install? Replace the files in the loaded folder,\n"
        "click Reload on its extension card, then reopen the Mockend side panel.\n"
    )
    archive(chrome_zip, {**tree(chromium, "MockRoute-Chrome/"), "INSTALL.txt": chrome_instructions.encode()})
    bundle = DIST / f"Mockend-{version}.zip"
    archive(bundle, {
        **tree(chromium, "chromium/"),
        **tree(SRC, "source/src/"),
        **tree(ROOT / "scripts", "source/scripts/"),
        **tree(ROOT / "test", "source/test/"),
        **tree(ROOT / "examples", "examples/"),
        **tree(ROOT / "examples", "source/examples/"),
        "README.md": (ROOT / "README.md").read_bytes(),
        "source/README.md": (ROOT / "README.md").read_bytes(),
        vsix.name: vsix.read_bytes(),
    })
    print(bundle)


if __name__ == "__main__":
    main()
