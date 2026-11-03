#!/bin/sh
# W39: 製品が CEO の本物のカーソルを動かしているか。act の道具ごとに、操作の前後で OS のポインタ位置（cua get_cursor_position）を比べる。
# 実機（CEO 不在の時・w8g-59）が回す。**この script は人のカーソルを動かす物を何も呼ばない**（get_cursor_position / get_window_state / list_windows は読むだけ。
# 道具は対象の窓へ background で送る物で、cua が「物理ポインタを動かす」と判断した drag は cua 自身が拒否する）。
# 使い方: tools/w39-probe.sh [--dry-run] <pid> <window_id> [x y]
#   対象 = 自分で起こした無害な app（例 `open -g -n -a Calculator`）の、**is_on_screen=true の窓**（pid / window_id は cua-driver call list_windows）。画面上に無い窓は未測として止まる
#   --dry-run = cua を 1 回も呼ばず、何をどの順で呼ぶかだけ出す
# 出力: docs/verify/w39/pointer-<時刻>/（KANGAE_W39_OUT で変える）に tool ごとの 前 / 後の座標・道具の原文・判定
#   判定 = 不変（道具が実行され、ポインタは動かなかった）/ 動いた（実物の欠陥）/ 未測（拒否: 理由）＝道具が実行されなかった本は「不変」と数えない
# 環境変数: KANGAE_CUA（cua-driver の path・試験が偽物に替える）
set -u
DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
PID=${1:?pid}; WID=${2:?window_id}; X=${3:-60}; Y=${4:-60}
CUA=${KANGAE_CUA:-$HOME/.local/bin/cua-driver}
D=${KANGAE_W39_OUT:-docs/verify/w39/pointer-$(date +%H%M%S)}
mkdir -p "$D"
pos() { "$CUA" call get_cursor_position '{}' 2>&1 | tr -d '\n '; }
# 道具が拒否した（実行されなかった）かと、その理由。cua は拒否を exit≠0 か {"code":…} / delivery_failed / unverifiable / background_unavailable で返す
refusal() { # $1 = 道具の原文 file・$2 = exit code → 理由を出して 0（拒否）/ 何も出さず 1（実行された）
  if [ "$2" -ne 0 ] || grep -Eq '"code"|"error"|"isError": *true|"ok": *false|delivery_failed|unverifiable|background_unavailable|off_space_or_ax_unresolved' "$1"; then
    reason=$(grep -Eo '"code": *"[^"]*"' "$1" | head -1 | sed 's/.*: *"\(.*\)"/\1/')
    [ -n "$reason" ] || reason=$(grep -Eo 'delivery_failed|unverifiable|background_unavailable|off_space_or_ax_unresolved' "$1" | head -1)
    [ -n "$reason" ] || reason="exit ${2}"
    printf '%s' "$reason"; return 0
  fi
  return 1
}

# (3) 対象の窓が画面上（is_on_screen=true）に在るか。無ければ「未測」で止まる（press_key / hotkey は画面外の窓だと off_space_or_ax_unresolved）
if [ "$DRY" -eq 1 ]; then
  echo "DRY: list_windows で pid=${PID} window_id=${WID} が is_on_screen=true か確かめる" | tee -a "$D/summary.txt"
else
  "$CUA" call list_windows '{}' > "$D/list_windows.out" 2>&1
  onscreen=$(python3 - "$D/list_windows.out" "$PID" "$WID" <<'PY'
import json, sys
t = open(sys.argv[1]).read()
try:
    d = json.loads(t[t.index("{"):])
except Exception:
    print("parse"); sys.exit()
for w in d.get("windows", []):
    if str(w.get("pid")) == sys.argv[2] and str(w.get("window_id")) == sys.argv[3]:
        print("yes" if w.get("is_on_screen") else "no"); sys.exit()
print("none")
PY
)
  if [ "$onscreen" != "yes" ]; then
    echo "未測（対象の窓が画面上に無い: ${onscreen}）: pid=${PID} window_id=${WID} は is_on_screen=true ではありません。画面上に在る自分で起こした app の窓を指してください" | tee -a "$D/summary.txt"
    exit 3
  fi
fi

moved=0; still=0; unmeasured=0
for t in "click:{\"x\":$X,\"y\":$Y}" "double_click:{\"x\":$X,\"y\":$Y}" "right_click:{\"x\":$X,\"y\":$Y}" "scroll:{\"direction\":\"down\",\"amount\":1,\"x\":$X,\"y\":$Y}" "drag:{\"from_x\":$X,\"from_y\":$Y,\"to_x\":$((X+30)),\"to_y\":$((Y+30))}" "type_text:{\"text\":\"a\"}" "press_key:{\"key\":\"shift\"}" "hotkey:{\"keys\":[\"cmd\",\"a\"]}"; do
  tool=${t%%:*}; args=${t#*:}
  full=$(printf '%s' "$args" | sed "s/^{/{\"pid\":$PID,\"window_id\":$WID,/")
  if [ "$DRY" -eq 1 ]; then
    echo "DRY: get_window_state {pid,window_id} → get_cursor_position → ${tool} ${full} → get_cursor_position" | tee -a "$D/summary.txt"
    continue
  fi
  # (2) 各道具の直前に、同じ窓の get_window_state を取る（click 系は先に state が無いと screenshot_context_missing）
  "$CUA" call get_window_state "{\"pid\":$PID,\"window_id\":$WID}" > "$D/$tool.state.out" 2>&1
  b=$(pos)
  "$CUA" call "$tool" "$full" > "$D/$tool.out" 2>&1; code=$?
  a=$(pos)
  # (4) 拒否された本は「不変」と数えない（道具が実行されていない＝ポインタが動かないのは当たり前）。原文を残す
  if why=$(refusal "$D/$tool.out" "$code"); then
    unmeasured=$((unmeasured+1))
    echo "${tool} 前=${b} 後=${a} 未測（拒否: ${why}）" | tee -a "$D/summary.txt"
    echo "  原文: $(tr '\n' ' ' < "$D/$tool.out" | sed 's/  */ /g' | cut -c1-400)" | tee -a "$D/summary.txt"
  elif [ "$b" = "$a" ]; then
    still=$((still+1)); echo "${tool} 前=${b} 後=${a} 不変" | tee -a "$D/summary.txt"
  else
    moved=$((moved+1)); echo "${tool} 前=${b} 後=${a} 動いた" | tee -a "$D/summary.txt"
  fi
done
[ "$DRY" -eq 1 ] && exit 0
echo "動いた道具: ${moved}（0 でなければ、その道具が人のポインタを動かしている＝実物の欠陥）／不変（道具が実行されて動かなかった）: ${still}／未測（拒否）: ${unmeasured}" | tee -a "$D/summary.txt"
if [ "$still" -eq 0 ] && [ "$moved" -eq 0 ]; then echo "判定できません: 道具が 1 本も実行されていません（全部拒否）。『不変』とは言えません" | tee -a "$D/summary.txt"; exit 4; fi
[ "$moved" -eq 0 ]
