# RSI 自我进化实录 · 以森林伙伴插件为实验对象

> 本文是一份**真实运行记录**：用 [森林伙伴](../zelda-pet/README.md)（塞尔达风格的 dsh 桌面宠物插件）作为任务对象，让 [009 RSI](009-rsi.md) 的改进循环在真实模型会话上跑三轮。三轮里没有一次人工设定"应该进化成什么样"——提案由模型写、测量由探针做、采纳与否由数据决定。

## 实验设置（小白可照抄）

```bash
# 0) 模型凭据：DEEPSEEK_API_KEY 写进仓库根的 .env（已被 git 忽略）
# 1) 探针任务集：4 个宠物插件微任务（爱心动画/影子/台词历史/夜间光晕），每个配一个机械检查脚本
scripts/rsi-demo/tasks.json          # 指令 + 工作目录 + 检查命令
zelda-pet/probe/check-*.cjs   # 检查器：grep 关键类名与 CSS 结构，退出码即分数
# 2) 证据：base 线束下真实跑一遍任务，留痕为 rollout（会话尾部 + 检查结果）
node scripts/rsi-demo/collect-rollouts.mjs
# 3) 进化循环：采集→提案→组合→盲选→行为探针→采纳/否决→反思入库
node lib/improve.js run --runs-dir runs/demo --tag demo --k 1 --seed 7 \
  --evidence runs/demo/evidence --behavioural scripts/rsi-demo/tasks.json --rounds 1 --timeout 480000
# 4) 看报告
node lib/improve.js report --runs-dir runs/demo --tag demo
```

## 第一轮：完整闭环跑通，探针第一次否决

流程全部真实执行：2 个提案（不变式视角 + 领域视角）→ 机械校验 → 组合 → 盲选 → 行为探针 → 采纳/否决 → 反思。

- **证据洞察（编辑器自己发现的）**：三条 base rollout 呈现同一失败模式——"静态核对文本条件就报 ready，从不真正运行检查器"。编辑器的 notes 原文引用了三条 rollout 的 `[REPORT]` 时刻，并对单一来源的结论标了 `CONFIRMED: SINGLE`。
- **候选内容**：新增 `local-ui-handoff` 技能（本地 UI 任务的按需交接清单）+ delivery 段扩展（"验收检查只有真正运行并成功退出才算数；环境故障重试一次后明确标记未验证"）。
- **探针结果**：base 3/3 vs candidate 3/3，耗时指标当时只测了检查器（0.1s，失真）→ **无测量优势 → 诚实否决**。

## 第二轮：指标修正 + 任务加难，否决依然成立

针对第一轮暴露的两个探针缺陷做策略修正（这就是 RSI 策略的自我优化）：

1. 耗时指标改为**会话墙钟时间 + 检查时间**（之前只测检查器，失去意义）；
2. 新增第 4 个更有区分度的 held-out 任务（夜间光晕：要求 `.zpet-night .zpet-glow` 组合选择器 + transition）；
3. 顺带修复续跑语义（`--stage X` = 从 X 强制重跑并丢弃其后结果）。

| 组 | 通过 | 平均会话耗时 | 各任务秒数 |
|---|---|---|---|
| base | 4/4 | 71s | heart 66 · shadow 118 · log 54 · glow 46 |
| candidate | 4/4 | 105s | heart 119 · shadow 112 · log 61 · glow 125 |

**否决成立，且这次否决揭示了机理**：候选把一大段规则塞进了 always-on 的 delivery 段——每个模型请求都要背着它（"更严的规则反而更慢"）。这正是 Harness² 的警告：*always-on 文字是最贵的选项，重复指令稀释其余指令*。

## 第三轮：把定价写进提案纪律

据此给提案/组合提示词加入**预算付账**约束（`src/improvement/sessions.ts` 的 SURFACE 块）：

> Paying: every always-on line you add must compress or remove an equivalent amount of existing text in the same file, unless it fixes a failure the evidence names — a longer harness is a slower agent, and length alone has been measured to hurt.

第三轮循环在"带付账纪律"下重跑 propose→reflect。实测：**base 4/4（76.5s）vs candidate 4/4（73.3s）**——付账纪律让候选从"慢 48%"变成"快 3%"，方向正确但仍未跨过 ≥10% 的自动采纳门槛 → **探针第三次否决**。`node lib/improve.js report --runs-dir runs/demo --tag demo --k 1 --seed 7` 给出了完整 diff：delivery 段按付账纪律被压缩重写；新增 `local-ui-handoff` 技能（"验收是证据不是源码匹配"清单）。

**双轨收尾**：自动闸门的三连否决说明候选没有可测量的性能优势——但候选修复的"静态核对假 ready"失败模式在 rollout 证据里有独立于速度的质量价值。于是走人工审阅路径（这正是面板 Prompts 页的用途）：`scripts/rsi-demo/adopt-final1.mjs` 经 `PUT prompts` 把候选存为**提示词版本 1**（面板可查历史、一键回滚）。总结：**自动闸门守质量底线，人工审阅做最终决定权**。

### 三轮总账

| 轮 | 策略变化 | 探针数据 | 结果 |
|---|---|---|---|
| 1 | 原始探针（耗时指标失真） | 3/3 vs 3/3 | 否决 |
| 2 | 指标含会话时间 · 任务加难 · 续跑语义修复 | base 71s vs cand 105s | 否决，揭示 always-on 定价问题 |
| 3 | 预算付账纪律 | base 76.5s vs cand 73.3s | 否决（差 7pp），人工审阅后采纳为版本 1 |

## 这份实录证明了什么

1. **闭环是真的**：证据→提案→组合→盲选→测量→采纳/否决→入库，每一环都是真实模型会话与真实检查器，全程可审计（`runs/demo/rsi-*/` 下有 run.json、提案 notes、diff.patch、探针 metrics、决策记录）。
2. **否决闸门是 RSI 的安全带**：三轮候选都被探针否决——没有测量优势的"进化"不会自动进你的面板。对比没有探针的第一版实现（采纳=假设），这是策略升级的核心价值。
3. **RSI 自身也在被同样的方法优化**：耗时指标失真→修正；任务无区分度→加难；候选变慢→把定价写进纪律；续跑语义含糊→改为显式强制重跑。改进 RSI 的依据同样是执行对比，不是直觉。

## 复现须知

- 每轮消耗约 10-16 个 headless 模型会话（DeepSeek API 费用很低，但不是零）。
- 行为探针对每个候选组跑 `任务数 × rounds` 个会话；`--rounds 2` 以上才能把噪声摊开。
- 探针只对比**团队三段**（会话能携带的 standing instructions）；覆盖键与技能的效果要靠工单级观察。
