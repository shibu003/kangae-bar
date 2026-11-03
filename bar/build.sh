#!/bin/bash
# universal（x86_64 + arm64・macOS 13+）の Kangae Bar.app を bar/dist に作る。外の package なし・ad-hoc 署名
set -euo pipefail
cd "$(dirname "$0")"
A="dist/Kangae Bar.app"
rm -rf "$A" && mkdir -p "$A/Contents/MacOS"
for arch in x86_64 arm64; do
  swiftc -O -target "$arch-apple-macos13.0" main.swift Glass.swift Region.swift Point.swift Lease.swift Front.swift Badge.swift -o "dist/bar-$arch"
done
lipo -create dist/bar-x86_64 dist/bar-arm64 -output "$A/Contents/MacOS/KangaeBar"
rm dist/bar-x86_64 dist/bar-arm64
cat > "$A/Contents/Info.plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Kangae Bar</string>
<key>CFBundleIdentifier</key><string>app.kangae.bar</string>
<key>CFBundleExecutable</key><string>KangaeBar</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
P
# 常駐は <bin>/../extension を見るので install（app/bin + app/extension）と同じ形で入れる。dist/kangae が無ければ入れない
[ -x ../dist/kangae ] && mkdir -p "$A/Contents/Resources/bin" && cp ../dist/kangae "$A/Contents/Resources/bin/kangae" && cp -R ../extension "$A/Contents/Resources/extension"
# 別の Space の窓を読むだけの helper を、小さな .app「Kangae Bar 読み取り」に包んで常駐（Resources/bin/kangae）の隣に置く（lease.ts の axReadPath が kangae の隣を探す・許可はこの .app に付く）。無ければ止める
mkdir -p "$A/Contents/Resources/bin"
../tools/build-reader.sh "$A/Contents/Resources/bin" x86_64 arm64
[ -d "$A/Contents/Resources/bin/Kangae Bar 読み取り.app" ] || { echo "Kangae Bar 読み取り.app が bundle に入っていません" >&2; exit 1; }
codesign --force --sign - "$A"
echo "built $A"
