#!/bin/sh
# ターミナルに貼る 1 行で入る（何度打っても同じ結果）: curl -fsSL <置き場>/install.sh | sh
# curl で落とした物とその場で作った物には quarantine が付かず、Gatekeeper は止めない（公証も Apple Developer も要らない）。
# <置き場> は scripts/release.sh が下の @BASE@ に書き込む。KANGAE_HOME / KANGAE_APPS は試験用の置き換え
set -eu
VER=154.0.8037.57-1.1
SHA_x64=58ee9436dcbc457fe6634bbc247ad03e0d1609ed5ce9954106ddce89944eb2ff
SHA_arm64=20b9b3104032c2011c89c8356fd94169565f3c9880ae281119ea189634a85e00
# Chrome stable が Critical を直した版（https://chromereleases.googleblog.com/ ・2026-10-01 の投稿を 2026-10-03 に確認: 154.0.8037.97 が CVE-2026-103628 を修正）。VER を上げたら見直す
FIXED=154.0.8037.97
BASE="${KANGAE_BASE:-@BASE@}"
P="${KANGAE_HOME:-$HOME/Library/Application Support/Kangae}"
APPS="${KANGAE_APPS:-$HOME/Applications}"

[ "$(uname -s)" = Darwin ] || { echo "Kangae は Mac 用です" >&2; exit 1; }
case "$BASE" in @*) echo "置き場が決まっていません（KANGAE_BASE=<URL>）" >&2; exit 1 ;; esac
# Rosetta の端末でも uname -m は x86_64 になるので、機械そのものを見る
if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" = 1 ]; then A=arm64 FILE=arm64 SHA=$SHA_arm64; else A=x64 FILE=x86_64 SHA=$SHA_x64; fi
mkdir -p "$P" "$APPS"
T="$(mktemp -d)"
trap 'hdiutil detach "$T/m" >/dev/null 2>&1 || true; rm -rf "$T"' EXIT

if [ ! -x "$P/Chromium.app/Contents/MacOS/Chromium" ] || [ "$(cat "$P/chromium-version" 2>/dev/null)" != "$VER-$A" ]; then
  echo "ブラウザ（ungoogled Chromium ${VER}・${A}）を落としています…"
  curl -fL# --retry 3 -o "$T/c.dmg" "https://github.com/ungoogled-software/ungoogled-chromium-macos/releases/download/$VER/ungoogled-chromium_${VER}_${FILE}-macos.dmg"
  echo "$SHA  $T/c.dmg" | shasum -a 256 -c - >/dev/null
  hdiutil attach -nobrowse -readonly -mountpoint "$T/m" "$T/c.dmg" >/dev/null
  rm -rf "$P/Chromium.app"
  ditto "$T/m/Chromium.app" "$P/Chromium.app"
  hdiutil detach "$T/m" >/dev/null
  rm -f "$T/c.dmg"
  echo "$VER-$A" > "$P/chromium-version"
fi

echo "Kangae 本体を落としています…"
curl -fL# --retry 3 -o "$T/k.tar.gz" "$BASE/kangae-$A.tar.gz"
rm -rf "$P/app"
mkdir -p "$P/app"
tar -xzf "$T/k.tar.gz" -C "$P/app"
# Apple Silicon は署名の無い実行 file を動かさない。ad-hoc 署名で足りる
codesign --force --sign - "$P/app/bin/kangae" >/dev/null 2>&1
codesign --force --sign - "$P/app/bin/Kangae Bar 読み取り.app" >/dev/null 2>&1 || true # 別の Space の窓を読むだけの小さな .app（アクセシビリティの許可はこの .app に出す）
xattr -dr com.apple.quarantine "$P" 2>/dev/null || true

mkdir -p "$HOME/.kangae/bin" && ln -sf "$P/app/bin/kangae" "$HOME/.kangae/bin/kangae" # bar が常駐を探す場所
ln -sfn "$P/app/bin/Kangae Bar 読み取り.app" "$HOME/.kangae/bin/Kangae Bar 読み取り.app" # 常駐が読み取り .app を探す場所（lease.ts の axReadPath）
rm -rf "$APPS/考えの空.app" "$APPS/Kangae.app" # 前の名前の物も消す
osacompile -o "$APPS/Kangae.app" -e "do shell script quoted form of \"$P/app/bin/kangae\" & \" --open >/dev/null 2>&1 &\""
echo "入りました: $APPS/Kangae.app"
echo "・ターミナルで kangae を打つ時は ~/.kangae/bin/kangae と書きます（PATH には足していません。例: ~/.kangae/bin/kangae cmd-list）"
echo "・新しいタブが普通のページに戻ったら、⌘Q で終えてもう一度開いてください（「元に戻す」は押さない）"
echo "・入れたら一言を試して、「通った」か「通らない」を返信してください"
# 同梱の版が、公開済みの Chrome の Critical 修正より古い時だけ出す
if [ "$(printf '%s\n%s\n' "${VER%-*}" "$FIXED" | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | head -1)" != "$FIXED" ] && [ "${VER%-*}" != "$FIXED" ]; then
  echo "・この専用ブラウザは更新されず、公開済みの Chrome の Critical 修正を含みません。ログインが要る大事なサイトには使わず、考える session だけに使ってください"
fi
[ -n "${KANGAE_NO_OPEN:-}" ] || open "$APPS/Kangae.app"
