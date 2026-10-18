Epoch {{VERSION}}: a local-first desktop app that turns a codebase into an interactive dependency graph, with blast radius, risk tiers and likely-dead feature alerts. Your code never leaves your machine; see [privacy](https://github.com/JJUN-SEO/Epoch/blob/{{TAG}}/docs/privacy.md).

## Download

| System                           | File                       |
| -------------------------------- | -------------------------- |
| macOS (Apple Silicon)            | `Epoch-mac-arm64.dmg`      |
| Windows (x64)                    | `Epoch-win-x64-setup.exe`  |
| Linux (x64), Debian and Ubuntu   | `Epoch-linux-x64.deb`      |
| Linux (x64), other distributions | `Epoch-linux-x64.AppImage` |

## These builds are not signed

Epoch has no Apple or Microsoft signing certificate yet, so your system warns before the first launch. The [README](https://github.com/JJUN-SEO/Epoch/blob/{{TAG}}/README.md#install) has the details.

- **macOS:** open the dmg and drag Epoch to Applications. The first launch is refused; open System Settings, then Privacy & Security, and choose "Open Anyway" for Epoch. The app has only an ad-hoc signature and is not notarized. Intel Macs are not supported.
- **Windows:** SmartScreen shows "Windows protected your PC"; choose "More info", then "Run anyway". Epoch installs for your user only, with no administrator rights.
- **Linux:** install the deb with `sudo apt install ./Epoch-linux-x64.deb`; it includes the AppArmor profile Ubuntu 24.04 and later need for Chromium's sandbox. The AppImage needs FUSE 2 (`libfuse2t64` on Ubuntu 24.04) and, on Ubuntu 24.04 and later, is blocked by AppArmor's user-namespace restriction; prefer the deb there. Never run Epoch with `--no-sandbox`.

## Checksums (SHA-256)

Compare with `sha256sum -c SHA256SUMS.txt --ignore-missing` (Linux), `shasum -a 256 <file>` (macOS) or `Get-FileHash <file>` (Windows PowerShell).

```
{{CHECKSUMS}}
```
