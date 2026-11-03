#!/bin/sh
# 配る物を dist/release/ に作る（install.sh と arch ごとの本体）。置き場にそのまま置けば 1 行のインストールが通る
# 使い方: KANGAE_BASE=https://置き場 sh scripts/release.sh
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
: "${KANGAE_BASE:?置き場の URL を KANGAE_BASE に（末尾の / は無し）}"
OUT="$REPO/dist/release"
rm -rf "$OUT"
mkdir -p "$OUT"
for A in x64 arm64; do
  S="$(mktemp -d)"
  (cd "$REPO" && bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --target=bun-darwin-$A src/main.ts --outfile "$S/bin/kangae" >/dev/null)
  # 別の Space の窓を読むだけの helper（小さな .app「Kangae Bar 読み取り」）。本体の隣に置く（lease.ts が kangae の隣を探す・許可はこの .app に付く）
  SA=$([ "$A" = x64 ] && echo x86_64 || echo arm64)
  "$REPO/tools/build-reader.sh" "$S/bin" "$SA" >/dev/null
  cp -R "$REPO/extension" "$S/extension"
  tar -czf "$OUT/kangae-$A.tar.gz" -C "$S" bin extension
  rm -rf "$S"
done
sed "s|@BASE@|$KANGAE_BASE|" "$REPO/scripts/install.sh" > "$OUT/install.sh"
echo "置く物: $OUT"
echo "貼る 1 行: curl -fsSL $KANGAE_BASE/install.sh | sh"
