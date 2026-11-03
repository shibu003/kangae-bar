#!/bin/sh
# 新しい worktree を作る（wtnew）。使い方: sh tools/wt-new.sh <名前>
#   impl/w1a の最新から ~/kangae-sora-wt/<名前> を impl/<名前> で作り、node_modules を入れる（bun install --frozen-lockfile）。
#   手で `git worktree add` すると node_modules が無く、startup1 など @ai-sdk を読む試験が偽の赤になる（2026-10 に何度も）＝この 1 本を通す。
#   既存の worktree・branch には触らない（同じ名前があれば何もせず止まる）。
# 環境変数（試験用）: KANGAE_WT_DIR（既定 ~/kangae-sora-wt）・KANGAE_WT_BASE（既定 impl/w1a）・KANGAE_WT_NO_INSTALL=1（node_modules を入れない＝負の対照）
set -eu
name="${1:-}"
# 名前の検査は LC_ALL=C で（locale によって [a-z] が é・ñ など ASCII の外の字を含む＝review27 の実測: en_US.UTF-8 で「é」が通った）。許す字以外が 1 字でも残れば断る（改行も残る）。$( ) の中に case は書かない（macOS の /bin/sh=bash 3.2 は構文エラーになる）
rest=$(printf %s "$name" | LC_ALL=C tr -d 'a-z0-9-' | wc -c | tr -d ' ')
case "$name" in ""|-*) rest=1;; esac
[ "$rest" = 0 ] || { echo "wt-new: 名前は英小文字（ASCII）・数字・「-」だけ（先頭は「-」でない）。例: sh tools/wt-new.sh w52" >&2; exit 2; }
[ "${#name}" -le 32 ] || { echo "wt-new: 名前は 32 字まで" >&2; exit 2; }
here="$(cd "$(dirname "$0")/.." && pwd -P)"
common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"
main="$(dirname "$common")" # 本線の checkout（node_modules の元）
dir="${KANGAE_WT_DIR:-$HOME/kangae-sora-wt}"
base="${KANGAE_WT_BASE:-impl/w1a}"
path="$dir/$name"
[ ! -e "$path" ] && [ ! -L "$path" ] || { echo "wt-new: $path は既にあります（何もしていません）" >&2; exit 1; } # -L = 指す先が無い symlink も「在る」（git が失敗して branch だけ残るのを防ぐ・review27）
if git -C "$main" show-ref --verify --quiet "refs/heads/impl/$name"; then echo "wt-new: branch impl/$name は既にあります（何もしていません）" >&2; exit 1; fi
git -C "$main" rev-parse --verify --quiet "$base^{commit}" >/dev/null || { echo "wt-new: 元の branch $base が見つかりません" >&2; exit 1; }
mkdir -p "$dir"
git -C "$main" worktree add -q -b "impl/$name" "$path" "$base"
if [ "${KANGAE_WT_NO_INSTALL:-}" != 1 ]; then
  # 実体を入れる（lockfile どおり）。入れられない時（offline など）だけ本線の node_modules への symlink
  if ! (cd "$path" && bun install --frozen-lockfile >/dev/null 2>&1); then
    rm -rf "$path/node_modules"
    if [ -d "$main/node_modules" ]; then ln -s "$main/node_modules" "$path/node_modules"; echo "wt-new: bun install できなかったので本線の node_modules へ symlink しました" >&2; fi
  fi
  [ -e "$path/node_modules" ] || { echo "wt-new: node_modules を用意できませんでした（${path}）" >&2; exit 1; }
fi
echo "$path"
