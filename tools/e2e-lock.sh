#!/bin/sh
# 並列の pane が、重い e2e と本物の claude の UC を機械全体で 1 本ずつ回すための lock（2026-10-07・CEO「並列でいい」）。
# 使い方: [E2E_TIMEOUT_SEC=秒] tools/e2e-lock.sh bun test/w3c.e2e.ts <front-watch> <win-count> --fw-sec 60
# 持ち主の pid が死んでいて、かつ持ち主の子の group も居なくなっていたら外す（swift-frontend・Chrome・bun が残っている間は外さない・holes-25）。unit（bun test）は通さなくてよい
# E2E_TIMEOUT_SEC（JOB の timeout: 分 ×60）を過ぎたら、自分が起こした子の process group だけ止めて exit 124
# （lock 待ちは数えない。macOS に GNU timeout は無い・pkill -f の共有名も使わない。2026-10-08 w8a-2 が 2896 秒止まった）
L=${E2E_LOCK:-/tmp/kangae-e2e.lock}
until mkdir "$L" 2>/dev/null; do
  p=$(cat "$L/pid" 2>/dev/null); g=$(cat "$L/pgid" 2>/dev/null)
  [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null && { [ -z "$g" ] || ! kill -0 "-$g" 2>/dev/null; } && rm -rf "$L"
  sleep 2
done
echo $$ > "$L/pid"
set -m # 子を自分の process group に入れる（-pid で group ごと止める）
"$@" </dev/null &
child=$!
echo $child > "$L/pgid" # 持ち主が先に死んでも、待つ側が子の group の生死を見られるように
# 終わり方: 子の group に TERM → E2E_LOCK_GRACE 秒（既定 30）まで終わるのを待つ → まだ居れば KILL → 居なくなってから、lock が自分の物（pid が $$）の時だけ外す
release() {
  trap '' EXIT INT TERM
  [ -n "$dog" ] && kill -KILL "-$dog" 2>/dev/null # 時間切れの番犬は set -m で自分の group＝sleep ごと止める。sleep が孤児で pipe を握り続けない（orphan-lock）
  if kill -0 "-$child" 2>/dev/null; then
    kill -TERM "-$child" 2>/dev/null
    n=0; max=$(( ${E2E_LOCK_GRACE:-30} * 5 ))
    while kill -0 "-$child" 2>/dev/null && [ "$n" -lt "$max" ]; do sleep 0.2; n=$((n + 1)); done
    kill -KILL "-$child" 2>/dev/null
    n=0; while kill -0 "-$child" 2>/dev/null && [ "$n" -lt 50 ]; do sleep 0.2; n=$((n + 1)); done
  fi
  [ "$(cat "$L/pid" 2>/dev/null)" = "$$" ] && rm -rf "$L"
}
trap release EXIT
trap 'exit 143' INT TERM
echo "[e2e-lock] 取った $(date +%T) load=$(uptime | sed 's/.*averages: //')" >&2
if [ -n "$E2E_TIMEOUT_SEC" ]; then
  ( sleep "$E2E_TIMEOUT_SEC"
    # script が KILL で死んだ後に鳴っても、もう自分の物でない group（pid の再利用）へ kill を送らない: 親（$$）が生きていて lock が自分の物の時だけ（lockpid）。親が生きている間は子の pid は wait 前の zombie も含め再利用されない
    kill -0 $$ 2>/dev/null && [ "$(cat "$L/pid" 2>/dev/null)" = "$$" ] || exit 0
    : > "$L/timedout.$$"; echo "[e2e-lock] ${E2E_TIMEOUT_SEC} 秒の時間切れ・子を止める" >&2
    kill -TERM -$child 2>/dev/null; sleep 5; kill -KILL -$child 2>/dev/null ) &
  dog=$!
fi
wait $child; rc=$?
[ -n "$dog" ] && kill -KILL "-$dog" 2>/dev/null # group ごと（subshell だけ kill すると sleep が孤児になり pipe を握る）
[ -e "$L/timedout.$$" ] && exit 124
exit $rc
