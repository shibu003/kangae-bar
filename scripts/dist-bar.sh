#!/bin/sh
# 配る物を dist/ に作る: KangaeBar-arm64.zip と KangaeBar-x64.zip。bar 本体は universal だが同梱の常駐（bun compile）は arch ごとに 1 つなので zip を 2 つに分ける
# 使い方: [KANGAE_BASE=https://置き場] sh scripts/dist-bar.sh   （既定は ad-hoc 署名。KANGAE_SIGN_ID と KANGAE_NOTARY_PROFILE を渡すと Developer ID 署名＋公証・docs/RELEASE-SIGNING.md）。bar を作り直す時は bar/dist を消す
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
A="bar/dist/Kangae Bar.app"
mkdir -p dist
V="$(git rev-parse --short HEAD 2>/dev/null || echo dev)" # 版 = commit（常駐が bar.json と `kangae version` で返す・実行時の環境変数では替えられない）
for T in x64 arm64; do bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --define "process.env.KANGAE_BUILD=\"$V\"" --target=bun-darwin-$T src/main.ts --outfile dist/kangae-$T >/dev/null; done
[ -d "$A" ] || { cp dist/kangae-x64 dist/kangae && bash bar/build.sh; } # build.sh は ../dist/kangae を同梱する（中身は下で arch ごとに差し替える）
rm -rf "$A/Contents/Resources/extension" && cp -R extension "$A/Contents/Resources/extension" # 再利用した bar の拡張は常に今の物にする
for T in x64 arm64; do
  cp dist/kangae-$T "$A/Contents/Resources/bin/kangae"
  # KANGAE_SIGN_ID と KANGAE_NOTARY_PROFILE が有る時だけ Developer ID 署名＋公証（scripts/sign-bar.sh・docs/RELEASE-SIGNING.md）。無ければ今まで通り adhoc
  if [ -n "${KANGAE_SIGN_ID:-}" ] && [ -n "${KANGAE_NOTARY_PROFILE:-}" ]; then sh scripts/sign-bar.sh "$A"; else codesign --force --sign - "$A" >/dev/null 2>&1; fi
  rm -f dist/KangaeBar-$T.zip
  # zip の頭に .app と「開けない時.txt」を並べる（Archive Utility は KangaeBar-<arch>/ の中に 2 つを出す。txt は Gatekeeper に止められない・W7n）
  S="$(mktemp -d)"
  ditto "$A" "$S/Kangae Bar.app" && cp "bar/開けない時.txt" "$S/"
  ditto -c -k "$S" dist/KangaeBar-$T.zip
  rm -rf "$S"
  echo "配る物: $REPO/dist/KangaeBar-$T.zip ($(du -h dist/KangaeBar-$T.zip | cut -f1))"
done
# 印の付かない道（curl | sh）: 今の zip の sha256 と置き場を install-bar.sh に書き込む。KANGAE_BASE が無ければ @BASE@ のまま（script は置き場が決まるまで止まる）
sed -e "s|@SHA_x64@|$(shasum -a 256 dist/KangaeBar-x64.zip | cut -d' ' -f1)|" -e "s|@SHA_arm64@|$(shasum -a 256 dist/KangaeBar-arm64.zip | cut -d' ' -f1)|" -e "s|@BASE@|${KANGAE_BASE:-@BASE@}|" scripts/install-bar.sh > dist/install-bar.sh
echo "置く物: dist/KangaeBar-x64.zip・dist/KangaeBar-arm64.zip・dist/install-bar.sh（貼る 1 行: curl -fsSL ${KANGAE_BASE:-<置き場>}/install-bar.sh | sh）"
