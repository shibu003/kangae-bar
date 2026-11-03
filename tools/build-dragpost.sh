#!/bin/bash
# W54b: drag-post の helper を小さな .app「Kangae Bar 注入」に包む（tools/build-reader.sh と同じ理由: 許可（アクセシビリティ）は「起こした側の app」に付く＝.app にして LaunchServices から起こせば 1 つの名前に付く）。
# 窓も Dock の icon も出さない（LSUIElement）。**ここでは build だけ。実行・許可の付与は owner が決める**（SLEventPostToPid は非公開 API・docs/design-dragpost.md）。
# 使い方: tools/build-dragpost.sh <出力 dir>（通常は ~/.kangae/bin）。出力: <出力 dir>/Kangae Bar 注入.app
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$1"
A="$OUT/Kangae Bar 注入.app"
rm -rf "$A" && mkdir -p "$A/Contents/MacOS"
swiftc -O -target "$(uname -m)-apple-macos13.0" "$HERE/drag-post.swift" -o "$A/Contents/MacOS/KangaeDragPost"
cat > "$A/Contents/Info.plist" <<'P'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Kangae Bar 注入</string>
<key>CFBundleDisplayName</key><string>Kangae Bar 注入</string>
<key>CFBundleIdentifier</key><string>app.kangae.bar.dragpost</string>
<key>CFBundleExecutable</key><string>KangaeDragPost</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
P
codesign -s - --force "$A" >/dev/null 2>&1 || true
echo "$A"
