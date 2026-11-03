#!/bin/bash
# 別の Space の窓を読むだけの helper を、小さな .app「Kangae Bar 読み取り」に包む（W4h-3）。
# なぜ .app か: アクセシビリティの許可（TCC）は「起こした側の app」に付く（responsibility・docs/verify/w4h2/permission-attribution.txt）。
#   裸の実行 file だと bar / Chrome の relay / 端末のどれが常駐を起こしたかで許可の相手が変わる。.app にして LaunchServices（open -g -n -W）で起こせば、誰が起こしても同じ 1 つの名前に付く。
# 窓も Dock の icon も出さない（LSUIElement）。許可のダイアログは出さない（前面を取る）。
# 使い方: tools/build-reader.sh <出力 dir> [arch...]（既定 = この Mac の arch）。出力: <出力 dir>/Kangae Bar 読み取り.app
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$1"; shift || true
ARCHS=("$@"); [ ${#ARCHS[@]} -gt 0 ] || ARCHS=("$(uname -m)")
A="$OUT/Kangae Bar 読み取り.app"
rm -rf "$A" && mkdir -p "$A/Contents/MacOS"
T="$(mktemp -d)"
for arch in "${ARCHS[@]}"; do swiftc -O -target "$arch-apple-macos13.0" "$HERE/ax-read.swift" -o "$T/r-$arch"; done
if [ ${#ARCHS[@]} -gt 1 ]; then lipo -create "$T"/r-* -output "$A/Contents/MacOS/KangaeReader"; else cp "$T/r-${ARCHS[0]}" "$A/Contents/MacOS/KangaeReader"; fi
rm -rf "$T"
cat > "$A/Contents/Info.plist" <<'P'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Kangae Bar 読み取り</string>
<key>CFBundleDisplayName</key><string>Kangae Bar 読み取り</string>
<key>CFBundleIdentifier</key><string>app.kangae.bar.reader</string>
<key>CFBundleExecutable</key><string>KangaeReader</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
P
codesign --force --sign - "$A" >/dev/null 2>&1
echo "built $A"
