# dsh-superagent · 架构分析

本目录是对该研究原型的架构梳理，由代码与 `docs/000-008` 原文整理而成（2026-11-02），供快速理解与评审。官方文档以 `docs/` 编号文档为准；本文与其不冲突，只是换个视角重组。

## 文档索引

| 文档 | 内容 | 交互版 |
| --- | --- | --- |
| [4plus1-views.md](4plus1-views.md) | Kruchten 4+1 视图：场景（三个端到端场景）/ 逻辑（领域模型与不变量）/ 进程（运行时与 Effects 队列）/ 开发（模块分层）/ 物理（部署拓扑 + Windows 运行实录） | [4plus1-views.html](4plus1-views.html) |
| [design-deep-dive.md](design-deep-dive.md) | 设计思路（注意力原则、五支柱、决策权分离、提示词强度阶梯）/ 处理流程（十阶段流水线 + 授权双路径）/ 知识更新处理（五类知识的版本化与生效路径） | [design-deep-dive.html](design-deep-dive.html) |
| [prompts-map.md](prompts-map.md) | 提示词全景：装配流水线（两角色）/ 16 个文件逐条规则 / 团队编辑面（14 个可覆盖键）/ 提示词在防什么 | [prompts-map.html](prompts-map.html) |

> 2026-11-02 新增：仓库已加入 RSI 能力（基于 Harness² 方法的线束自我改进循环），设计见 [docs/009-rsi.md](../docs/009-rsi.md)，CLI 为 `node lib/improve.js run --dry-run`。

HTML 版为自包含单文件（内置样式与主题，双击即可在浏览器打开；浅色/深色随系统）。

## 阅读顺序建议

1. 先读 [4plus1-views.md](4plus1-views.md) 的场景视图——三个场景走完就有整体感。
2. 再看逻辑视图的九个概念与五条不变量；然后按需跳进程/开发/物理视图。
3. 想知道「为什么这样设计」读 [design-deep-dive.md](design-deep-dive.md) 第一节；想知道「一条消息进来后到底发生什么」读第二节十阶段；想改配置/排查不生效，读第三节知识更新。
4. 要改团队行为（何时说话、何时停、怎么合并）前，先读 [prompts-map.md](prompts-map.md) 第三节的编辑面与生效规则。

## 本机实例状态（2026-11-01）

- 服务已在本机启动：`dsh --profile superagent`，面板 `http://127.0.0.1:3082`（token 见 `.artifacts/manual-start-3.log`）。
- 状态：runtime 正常、等待配置（未设 GitHub 仓库与 agent 账号，属预期）。
- Windows 适配要点（dsh 升级、link 路径、POSIX 形式 stateDir）记录在 [4plus1-views.md](4plus1-views.md) 物理视图一节。
