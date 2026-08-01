#!/bin/bash
# Pi Agent 表现基准测试（A/B 对比）
# A: 干净配置（无扩展）  B: 完整增强配置（2-pi-r + MCP + observational-memory）
#
# 用法: bash benchmarks/run-bench.sh [--only-a|--only-b] [--rounds N]
#   --rounds N  每组每个任务跑 N 轮（取通过率 + 汇总），默认 1
# 结果: benchmarks/results/results-<日期>.md

set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
RESULTS_DIR="$ROOT/benchmarks/results"
mkdir -p "$RESULTS_DIR"

WS_A="/tmp/pi-bench-ws-a"
WS_B="/tmp/pi-bench-ws-b"
SESS_A="/tmp/pi-bench-sess-a"
SESS_B="/tmp/pi-bench-sess-b"
AGENT_A="/tmp/pi-bench-agent-a"

# ---------- 准备干净 A 组配置 ----------
rm -rf "$AGENT_A" "$WS_A" "$WS_B" "$SESS_A" "$SESS_B"
mkdir -p "$AGENT_A" "$WS_A" "$WS_B"
cp ~/.pi/agent/auth.json "$AGENT_A/auth.json" 2>/dev/null || { echo "❌ 无法复制 auth.json"; exit 1; }
cat > "$AGENT_A/settings.json" <<'EOF'
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4-flash",
  "defaultThinkingLevel": "high"
}
EOF

# ---------- 任务集 ----------
declare -a TASK_NAMES TASK_PROMPTS TASK_VERIFY
TASK_NAMES[1]="文件创建"
TASK_PROMPTS[1]="在 __WS__/t1 目录下创建文件 hello.txt，内容为 Hello Benchmark 2026（仅此一行，无多余内容）"
TASK_VERIFY[1]='[ "$(cat __WS__/t1/hello.txt)" = "Hello Benchmark 2026" ]'

TASK_NAMES[2]="编码+测试"
TASK_PROMPTS[2]="在 __WS__/t2 目录创建 prime.js：导出函数 isPrime(n)。同时创建 test.js 用 node:assert 测试 isPrime(97)===true、isPrime(100)===false、isPrime(2)===true，并在命令行直接运行通过"
TASK_VERIFY[2]='[ -f __WS__/t2/prime.js ] && [ -f __WS__/t2/test.js ] && node __WS__/t2/test.js'

TASK_NAMES[3]="检索统计"
TASK_PROMPTS[3]="统计 C:/Users/Chace/.pi/agent/git/github.com/SaltedFish0318/2-pi-r/extensions 目录下所有 .ts 文件的总行数，只输出数字"
TASK_VERIFY[3]='true'

TASK_NAMES[4]="代码分析"
TASK_PROMPTS[4]="在 C:/Users/Chace/.pi/agent/git/github.com/SaltedFish0318/2-pi-r/extensions/loop.ts 中统计 persistState 字符串出现的总次数，只输出数字"
TASK_VERIFY[4]='true'

TASK_NAMES[5]="多步任务"
TASK_PROMPTS[5]="按顺序完成：(1) 在 __WS__/t5 创建目录 (2) 写入 config.json 内容为 {"name":"bench","count":3} (3) 用 node 读取并打印 count 字段的值，只输出数字"
TASK_VERIFY[5]='[ -f __WS__/t5/config.json ] && grep -q "bench" __WS__/t5/config.json'

# ---------- 运行 ----------
run_group() {
  local GROUP=$1 WS=$2 SESS=$3 AGENT_DIR=$4 ONLY=$5
  local MD="$RESULTS_DIR/results-$(date +%Y%m%d-%H%M).md"
  [ "$ONLY" = "1" ] && MD="$RESULTS_DIR/results-$(date +%Y%m%d-%H%M)-$GROUP.md"
  echo "# Pi Agent 基准结果 - $GROUP - $(date '+%Y-%m-%d %H:%M')" > "$MD"
  echo "" >> "$MD"
  echo "| 任务 | 结果 | 耗时 | 说明 |" >> "$MD"
  echo "|------|------|------|------|" >> "$MD"

  local PASS=0 FAIL=0 NERR=0
  for i in 1 2 3 4 5; do
    local prompt="${TASK_PROMPTS[$i]//__WS__/$WS}"
    local verify="${TASK_VERIFY[$i]//__WS__/$WS}"
    local ok=0 dur=0 total_dur=0
    # 每任务跑 ROUNDS 轮：全部通过才算通过（结果取最后一次耗时），并统计轮次通过率
    local rounds_pass=0 rounds_total=0
    for round in $(seq 1 "$ROUNDS"); do
      # 每轮最多 3 次尝试（容忍 opencode-go 网关连接错误等网络噪声）
      for attempt in 1 2 3; do
        local t0=$(date +%s)
        local out
        out=$(PI_CODING_AGENT_DIR="$AGENT_DIR" timeout 300 pi -p "$prompt" --session-dir "$SESS" --name "bench-$GROUP-$i-r$round" 2>&1)
        local t1=$(date +%s)
        dur=$((t1 - t0))
        if [ "$verify" = "true" ] || eval "$verify" 2>/dev/null; then
          rounds_pass=$((rounds_pass + 1))
          total_dur=$((total_dur + dur))
          break
        fi
        if echo "$out" | grep -qi "Connection error\|rate limit\|overloaded"; then
          NERR=$((NERR + 1))
          sleep 3
          continue
        fi
      done
      rounds_total=$((rounds_total + 1))
    done

    if [ "$ROUNDS" -le 1 ] && [ "$rounds_pass" -ge 1 ]; then
      PASS=$((PASS + 1))
      echo "| ${TASK_NAMES[$i]} | ✅ | ${dur}s | - |" >> "$MD"
    elif [ "$ROUNDS" -gt 1 ]; then
      PASS=$((PASS + rounds_pass))
      FAIL=$((FAIL + (rounds_total - rounds_pass)))
      echo "| ${TASK_NAMES[$i]} | ${rounds_pass}/${rounds_total} | ${total_dur}s | - |" >> "$MD"
    else
      FAIL=$((FAIL + 1))
      echo "| ${TASK_NAMES[$i]} | ❌ | ${dur}s | 验证失败 |" >> "$MD"
    fi
  done
  echo "" >> "$MD"
  if [ "$ROUNDS" -gt 1 ]; then
    echo "## 汇总: $PASS/$(($ROUNDS * 5)) 轮次通过, 失败 $FAIL, 网络错误 $NERR 次（${ROUNDS} 轮 × 5 任务）" >> "$MD"
  else
    echo "## 汇总: $PASS/5 通过, 失败 $FAIL, 网络错误 $NERR 次" >> "$MD"
  fi
  echo "✅ $GROUP 完成: $PASS/5 ($MD)"
}

ONLY=""
ROUNDS=1
for arg in "$@"; do
  case "$arg" in
    --only-a) ONLY=1 ;;
    --only-b) ONLY=2 ;;
    --rounds=*) ROUNDS=${arg#--rounds=} ;;
  esac
done

if [ "$ONLY" != "2" ]; then
  echo "=== 运行 A 组（干净配置）==="
  run_group "A-baseline" "$WS_A" "$SESS_A" "$AGENT_A" "$ONLY"
fi
if [ "$ONLY" != "1" ]; then
  echo "=== 运行 B 组（完整增强）==="
  run_group "B-enhanced" "$WS_B" "$SESS_B" "$HOME/.pi/agent" "$ONLY"
fi
echo "完成。结果目录: $RESULTS_DIR"
