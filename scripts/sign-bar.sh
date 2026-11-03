#!/bin/sh
# Developer ID 署名 → 公証 → staple を 1 手で（CEO が Apple Developer Program を決めた後。手順は docs/RELEASE-SIGNING.md）。
# 使い方: KANGAE_SIGN_ID="Developer ID Application: …" KANGAE_NOTARY_PROFILE=<notarytool の keychain profile 名> sh scripts/sign-bar.sh "<Kangae Bar.app>" [--dry]
#   --dry（または KANGAE_SIGN_DRY=1）は打つ command を並べるだけ。環境変数が無ければ何もせず exit 3（dist-bar.sh は adhoc のまま進む）。
# 内側から署名: 常駐（bun compile・JIT の entitlements）→ 読み取り.app → 外側の .app。全て hardened runtime + secure timestamp。
set -eu
A="${1:?.app を渡す}"
DRY="${KANGAE_SIGN_DRY:-}"; [ "${2:-}" = "--dry" ] && DRY=1
[ -n "${KANGAE_SIGN_ID:-}" ] && [ -n "${KANGAE_NOTARY_PROFILE:-}" ] || { echo "KANGAE_SIGN_ID と KANGAE_NOTARY_PROFILE が無いので署名しません（adhoc のまま）" >&2; exit 3; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"
run() { if [ -n "$DRY" ]; then echo "+ $*"; else "$@"; fi; }
S() { run codesign --force --options runtime --timestamp --sign "$KANGAE_SIGN_ID" "$@"; }
BIN="$A/Contents/Resources/bin"
S --entitlements "$HERE/bar/entitlements-bun.plist" "$BIN/kangae"
S "$BIN/Kangae Bar 読み取り.app"
S "$A"
run codesign --verify --deep --strict --verbose=2 "$A"
Z="${TMPDIR:-/tmp}/kangae-notary-$$.zip"
run ditto -c -k --keepParent "$A" "$Z"
run xcrun notarytool submit "$Z" --keychain-profile "$KANGAE_NOTARY_PROFILE" --wait
run xcrun stapler staple "$A"
run rm -f "$Z"
if [ -n "$DRY" ]; then echo "+ spctl -a -vv \"$A\""; else spctl -a -vv "$A" 2>&1 | head -2 | tr '\n' ' '; echo; fi
