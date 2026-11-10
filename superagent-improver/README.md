# dsh-superagent-improver · RSI 改进器插件

把 [RSI 自我进化循环](../docs/009-rsi.md) 从 dsh-superagent 主包里拆出来的**独立可选插件**：不装它，superagent 照常工作；装了它，就多一个 `dsh-improver` 命令行，可以从已结束工单（或本地 rollout 文件）里沉淀经验、进化提示词线束。它只通过部署的**管理 API** 对话，不注入任何会话、不改变任何 agent 行为——直到你亲手 `publish`。

## 30 秒安装（小白版）

```bash
cd superagent-improver
pnpm install && pnpm build           # 产出 lib/improver.js
dsh plugin --profile 你的profile名 add "link:绝对路径到这个superagent-improver目录"
dsh plugin --profile 你的profile名 add "link:绝对路径到dsh-superagent主包目录"   # 若尚未安装
```

> 两个插件要**并排安装**在同一个 profile 里（ improver 读取主包自带的 prompts/ 模板做机械校验）。CLI 也可以不经安装直接跑：在本仓库根目录 `node superagent-improver/lib/improver.js --help`。

## 常用命令

```bash
node lib/improver.js run --runs-dir runs --tag my --evidence <rollout目录> \
  --behavioural <tasks.json> --rounds 1          # 完整进化循环（含行为探针闸门）
node lib/improver.js report --runs-dir runs --tag my --k 1 --seed 7
node lib/improver.js publish --publisher prompt-skill --runs-dir runs --tag my   # 沉淀进运行实例
node lib/improver.js publish --publisher file --runs-dir runs --tag my           # 只落盘，不碰实例
node lib/improver.js library --runs-dir runs --tag my
```

## 插件化的三个层次

| 层 | 机制 | 如何扩展 |
|---|---|---|
| **部署能力** | DSH bundle（本包 + zelda-pet + 主包） | `dsh plugin add` 装卸，互不影响 |
| **发布器** | `src/improvement/publishers.ts` 注册表（`registerPublisher`） | 新发布器注册即插；CLI `--publisher` 按名选择；内置 `prompt-skill`（进运行实例）与 `file`（只落盘） |
| **行为探针任务集** | `--behavioural <tasks.json>` + 机械检查脚本 | 每个 JSON 一个探针插件：指令 + 工作目录 + 检查命令，无需改任何核心代码 |

主包的 `lib/improve.js` 与本包的 `lib/improver.js` 是**同一份代码的两个入口**（`src/improvement/cli.ts`），命令完全一致。
