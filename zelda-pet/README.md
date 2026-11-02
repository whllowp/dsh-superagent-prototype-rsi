# 森林伙伴 · dsh 桌面宠物插件

给 DeepSeek Harness 面板养一只塞尔达风格的森林小精灵（克洛格气质的原创角色）：它会沿着窗口底部散步、眨眼，晚上打瞌睡；单击打招呼，双击跳舞。零配置，装完即见。

## 30 秒安装（小白版）

前提：装过 `dsh`（DeepSeek Harness 命令行），Node 22+。

```bash
cd zelda-pet          # 本目录
pnpm install          # 装依赖（约 10 秒）
pnpm build            # 构建出 lib/client.js
dsh plugin --profile 你的profile名 add "link:绝对路径到这个zelda-pet目录"
dsh --profile 你的profile名        # 重启你的面板
```

然后打开面板，点左侧栏的 **🜂 森林伙伴**（橡果图标）——小精灵就出现在窗口底部了。

> 把「你的profile名」换成你日常用的 profile（比如 `default` 或 `web`）。Windows 的 Git Bash 里请在 link: 后面用 `E:/...` 这种原生路径写法。

## 它会什么

| 互动 | 效果 |
|---|---|
| 什么都不做 | 沿底部散步、每隔几秒眨眼，头顶叶子随风摆 |
| 单击 | 跳一下 + 说一句随机台词 |
| 双击 | 转圈跳舞 |
| 晚上 22:00–6:00 | 打瞌睡（zzz），单击叫醒 |
| 鼠标悬停 → ⚙ | 设置：体型（小/中/大）、台词开关；设置存在浏览器里，下次还在 |

## 卸载

```bash
dsh plugin --profile 你的profile名 remove dsh-zelda-pet
```

## 给开发者

- `src/index.tsx`：插件入口（侧栏图标 + 面板注册，照抄 dsh-superagent 的客户端插件模式）
- `src/pet.tsx`：宠物本体（SVG 精灵 + CSS 动画 + localStorage 设置），单文件、无宿主依赖
- `src/host.ts`：一行空的主机插件——它的唯一作用是让 web 服务器把 client.js 服务出去
- `probe/`：RSI 行为探针用的机械检查脚本（见 [docs/009-rsi.md](../docs/009-rsi.md) 与 [RSI 演示](../docs/RSI-DEMO-zh.md)）
