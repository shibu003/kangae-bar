#!/bin/sh
# Kangae Bar をターミナルに貼る 1 行で入れる（何度打っても同じ結果）: curl -fsSL <置き場>/install-bar.sh | sh
# curl で落とした物には隔離の印（quarantine）が付かないので、Gatekeeper の「開けません」も、同梱の実行 file（Resources/bin/kangae）が止められる事も起きない（W7n）。
# 安全: 置き場は https だけ（redirect も）・zip の sha256 をこの script に固定（違えば入れない）・この本文は貼る前に <置き場>/install-bar.sh をブラウザで開けば読める。
# 本文は全部 main の中: curl | sh の途中で切れても、最後の 1 行（main）が届くまで何も起きない（review16）
# @BASE@ と @SHA_*@ は scripts/dist-bar.sh が書き込む。KANGAE_APPS / KANGAE_NO_OPEN は試験用の置き換え（KANGAE_BASE の file:// も試験だけ）
set -eu
main() {
SHA_x64=@SHA_x64@
SHA_arm64=@SHA_arm64@
BASE="${KANGAE_BASE:-@BASE@}"
APPS="${KANGAE_APPS:-$HOME/Applications}"

[ "$(uname -s)" = Darwin ] || { echo "Kangae Bar は Mac 用です" >&2; exit 1; }
case "$BASE" in @*) echo "置き場が決まっていません（KANGAE_BASE=<URL>）" >&2; exit 1 ;; https://*|file://*) ;; *) echo "置き場が https ではありません（${BASE}）" >&2; exit 1 ;; esac
# Rosetta の端末でも uname -m は x86_64 になるので、機械そのものを見る
if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" = 1 ]; then A=arm64 SHA=$SHA_arm64; else A=x64 SHA=$SHA_x64; fi
T="$(mktemp -d)"
mkdir -p "$APPS"
# 入れ替えは同じ置き場の隠し名で組んでから rename（途中で落ちても前の .app は残る・半端な .app は残さない）
NEW="$APPS/.Kangae Bar.app.new-$$" OLD="$APPS/.Kangae Bar.app.old-$$"
trap 'rm -rf "$T" "$NEW"; [ -e "$APPS/Kangae Bar.app" ] || [ ! -e "$OLD" ] || mv "$OLD" "$APPS/Kangae Bar.app"; rm -rf "$OLD"' EXIT

echo "Kangae Bar（${A}）を落としています…"
curl -fL# --proto '=https,file' --proto-redir '=https' --retry 3 -o "$T/k.zip" "$BASE/KangaeBar-$A.zip"
echo "$SHA  $T/k.zip" | shasum -a 256 -c - >/dev/null || { echo "落とした物が配った物と違います（sha256 が合わない）。入れずに止めました" >&2; exit 1; }
ditto -x -k "$T/k.zip" "$T/x"
SRC="$(find "$T/x" -maxdepth 2 -name 'Kangae Bar.app' -type d | head -1)"
[ -n "$SRC" ] || { echo "zip の中に Kangae Bar.app がありません" >&2; exit 1; }
ditto "$SRC" "$NEW"
xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true # 印は付かないはずだが、付いていても消す
[ ! -e "$APPS/Kangae Bar.app" ] || mv "$APPS/Kangae Bar.app" "$OLD"
mv "$NEW" "$APPS/Kangae Bar.app"
echo "入りました: $APPS/Kangae Bar.app"
# 人がターミナルで kangae を打つ時の置き場（他人の shell の設定は書き換えない＝PATH には足さない）。bar が常駐を探す場所でもある。試験（KANGAE_APPS を置き換えた時）は本物の home に置かない
KBIN="${KANGAE_BIN:-}"; [ -n "$KBIN" ] || [ -n "${KANGAE_APPS:-}" ] || KBIN="$HOME/.kangae/bin"
if [ -n "$KBIN" ]; then mkdir -p "$KBIN" && ln -sf "$APPS/Kangae Bar.app/Contents/Resources/bin/kangae" "$KBIN/kangae"; fi
echo "・ターミナルで kangae を打つ時は ~/.kangae/bin/kangae と書きます（PATH には足していません。例: ~/.kangae/bin/kangae cmd-list）"
# 動いている bar は止めない（人の物・試験でも共有の名前で止めない）。古い版が動いていれば案内だけ
RUNNING=""; ! pgrep -qx KangaeBar || RUNNING=1
[ -z "$RUNNING" ] || echo "・前の Kangae Bar が動いています。メニューバー右の「考」→「終わる（この bar だけ）」の後に、もう一度開いてください"
echo "・窓が出たら、何をしてほしいかを書いて Enter。しまった後はメニューバー右の「考」か ⌥Space で出せます"
# 初回だけ: この版を LaunchServices で最初に起こす時、macOS は未見の実行 file を必ず調べる（公証が無くても・隔離の印が無くても・数秒。小さい確認の窓が前に出ることがある。実測・出典は docs/verify/w57/GATEKEEPER.md）。
# silent に先に済ませる手は無い（spctl --assess も直 exec も、後の LaunchServices 起動の検査を省かない）ので、人が画面の前に居る「今」ここで 1 回起こして済ませる。2 回目からは出ない
if [ -n "${KANGAE_NO_OPEN:-}" ]; then
  echo "・この版の最初の起動では、macOS の確認の窓が数秒、前に出ることがあります。人が画面の前に居る時に Kangae Bar を 1 度だけ開いてください（無人の時に起こすと窓が前に出ることがあります）"
elif [ -n "$RUNNING" ]; then
  # review29: 前の版が動いたままだと open は動いている物を前に出すだけで、この版の最初の起動（macOS の調べ）は「終わる」の後に開き直す時になる＝今は起きない
  echo "・この版を macOS が調べるのは、前の Kangae Bar を終わらせて開き直す時です（数秒・小さい確認の窓が前に出ることがあります）。人が画面の前に居る時に開き直してください"
  open "$APPS/Kangae Bar.app"
else
  echo "・初回の起動だけ、macOS が Kangae Bar を調べます（数秒）。小さい確認の窓が前に出ることがありますが、閉じずにそのまま待ってください（2 回目からは出ません）"
  open "$APPS/Kangae Bar.app"
fi
}
main "$@"
