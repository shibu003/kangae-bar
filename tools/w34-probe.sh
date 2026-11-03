#!/bin/sh
# W34 の測定: 起こし方ごとに「前面 0 か・何秒後に崩れるか」を 1 本ずつ測る。実機（computer use の実験役）が回す。
# 使い方: tools/w34-probe.sh <cua|open-g|open-gj|nsworkspace|cua-dl|cua-out|cua-running|open-gj-path|nsworkspace-path> [秒=150]
#   cua-dl = cua の launch_app に urls:[W34_DL=~/Downloads/ER_Triage_GUI] を付ける／cua-out = urls:[Downloads 外の dir W34_OUT=/tmp/w34-dir]／
#   open-gj-path = open -g -j -b <bundle> <W34_DL>（hidden のまま path）／nsworkspace-path = NSWorkspace.open([W34_DL], withApplicationAt:, activates=false, hides=true)／
#   cua-running = Zed を先に起こしておき（測る前）、起きている Zed に urls:[W34_DL] だけ開かせる（odoc の Apple Event で Zed が自分で activate するかの切り分け） [app 名=Zed] [bundle id=dev.zed.Zed]
# 出力: docs/verify/w34/<method>-<時刻>/ に front-watch.txt（前面と新しい窓の原文）・uc.log（UserNotificationCenter / app の activate の log）・launch.txt。
# 測る間、人は何も触らない（人が切り替えた分が混ざる）。他の app を前面に置いてから始める（Terminal など）。
set -u
# 後始末: この script が起こした pid（測る前に居なかった物）だけ控えて、終わりに閉じる（プロセス名は小文字の zed・pgrep -x Zed は空振り）
PIDS=""
cleanup() { for p in $PIDS $(pgrep -xi "$NAME"); do kill -TERM "$p" 2>/dev/null; done; n=0; while pgrep -xi "$NAME" >/dev/null && [ $n -lt 15 ]; do sleep 1; n=$((n+1)); done; for p in $(pgrep -xi "$NAME"); do kill -KILL "$p" 2>/dev/null; done; }
M=${1:?method}; SEC=${2:-150}; NAME=${3:-Zed}; BID=${4:-dev.zed.Zed}
D=docs/verify/w34/$M-$(date +%H%M%S); mkdir -p "$D"
[ -x /tmp/front-watch ] || swiftc -O tools/front-watch.swift -o /tmp/front-watch || exit 1
[ /tmp/w34-launch -nt tools/w34-launch.swift ] || swiftc -O tools/w34-launch.swift -o /tmp/w34-launch || exit 1
DL=${W34_DL:-$HOME/Downloads/ER_Triage_GUI}; OUT=${W34_OUT:-/tmp/w34-dir}; mkdir -p "$OUT" "$DL" 2>/dev/null
osascript -e "tell application \"$NAME\" to quit" 2>/dev/null; n=0; while pgrep -xi "$NAME" >/dev/null && [ $n -lt 20 ]; do sleep 1; n=$((n+1)); done # 冷えた状態から（起動前に居ないこと）
pgrep -xi "$NAME" >/dev/null && { echo "$NAME が止まりません" >&2; exit 1; }
trap cleanup EXIT # 冷えた状態を確かめた後から（人が使っている zed を、確認前の失敗で閉じない）
if [ "$M" = cua-running ]; then ~/.local/bin/cua-driver call launch_app "{\"bundle_id\":\"$BID\"}" > "$D/prelaunch.txt" 2>&1; sleep 30; PIDS="$(pgrep -xi "$NAME")"; [ -n "$PIDS" ] || { echo "$NAME が起きていません" >&2; exit 1; }; fi # 測る前に起こして落ち着かせる
/tmp/front-watch "$SEC" > "$D/front-watch.txt" 2>&1 &
log stream --style compact --predicate 'process == "UserNotificationCenter" OR (process == "'"$NAME"'" AND eventMessage CONTAINS[c] "activat") OR (process == "runningboardd" AND eventMessage CONTAINS[c] "'"$BID"'")' > "$D/uc.log" 2>&1 &
LP=$!
sleep 1; echo "start $(date +%T)" > "$D/launch.txt"
case $M in
  cua) ~/.local/bin/cua-driver call launch_app "{\"bundle_id\":\"$BID\"}" >> "$D/launch.txt" 2>&1 ;;
  cua-dl) ~/.local/bin/cua-driver call launch_app "{\"bundle_id\":\"$BID\",\"urls\":[\"$DL\"]}" >> "$D/launch.txt" 2>&1 ;;
  cua-out) ~/.local/bin/cua-driver call launch_app "{\"bundle_id\":\"$BID\",\"urls\":[\"$OUT\"]}" >> "$D/launch.txt" 2>&1 ;;
  cua-running) ~/.local/bin/cua-driver call launch_app "{\"bundle_id\":\"$BID\",\"urls\":[\"$DL\"]}" >> "$D/launch.txt" 2>&1 ;;
  open-gj-path) open -g -j -b "$BID" "$DL" ;;
  nsworkspace-path) /tmp/w34-launch "$BID" "$DL" >> "$D/launch.txt" 2>&1 ;;
  open-g) open -g -b "$BID" ;;
  open-gj) open -g -j -b "$BID" ;;
  nsworkspace) /tmp/w34-launch "$BID" >> "$D/launch.txt" 2>&1 ;;
  *) echo "method は cua|open-g|open-gj|nsworkspace|cua-dl|cua-out|cua-running|open-gj-path|nsworkspace-path" >&2; kill $LP; exit 2 ;;
esac
sleep 2; PIDS="$PIDS $(pgrep -xi "$NAME")"
echo "launched $(date +%T) pids=$PIDS" >> "$D/launch.txt"
wait %1; kill $LP 2>/dev/null
echo "== $M: $(grep -c ' → \|->' "$D/front-watch.txt") 行の前面変化 / exit は front-watch.txt の末尾 ==" ; tail -5 "$D/front-watch.txt"; echo "原文: $D"
