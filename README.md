# HongClaw（鸿爪）· 深海女仆工坊

鸿蒙电脑原生 AI Agent，对标 OpenClaw。**纯 Node.js、零依赖、不产 HAP**，一条命令运行。

## 运行要求

仅需 **Node.js ≥ 18.17**，不需要虚拟机 / 融合开发引擎 / Linux 子系统 / 任何 npm 包。

## 快速开始

```bash
node hongclaw.js
```

终端打印 Web UI 地址，浏览器打开即可。首次使用点右上角「配置」添加 Provider 并填 API Key。

> 若已 clone 原版皮肤仓库 `~/dsh-deep-whale`，启动时自动提取鲸鱼娘素材；未 clone 时降级为无角色背景。

## 能力清单

- **Gateway + Web UI**：流式聊天（SSE，失败自动切轮询）、会话管理（折叠侧栏 / 删除会话）、工具调用与人工审批可视化
- **多模型 / 多 Provider**：任意 OpenAI 兼容端点（DeepSeek / OpenAI / Kimi / 通义 / 智谱…），每 Provider 独立 API Key，顶栏一键切换模型与**思考强度**（reasoning_effort）
- **工具**：读写文件、列目录、执行命令（人工审批）、网页抓取、`send_email`、`email_status`
- **Skills**：兼容 AgentSkills / SKILL.md 标准，支持 gating（requires.bins/env/os），Web UI「技能」开关管理
- **插件兼容**：读取 `openclaw.plugin.json` / `.claude-plugin/plugin.json` 的 skills 与 stdio MCP 服务器
- **定时任务（Cron）**：Web UI「定时」管理，`分 时 日 月 周` 表达式
- **邮箱**：SMTP 发信（AUTH LOGIN/PLAIN）+ IMAP 自动收信并回复 + 定时/心跳结果邮件通知
- **心跳（Heartbeat）**：周期性主动检查，无事静默（HEARTBEAT_OK），有事发提醒/邮件
- **Doctor 自检**：Web UI「诊断」面板 + 终端 `node hongclaw.js doctor [--fix]` 自动修复
- **鲸鱼娘皮肤**：深海女仆工坊主题（双女仆背景、Q 版侧栏、深海蓝蕾丝界面），素材自动提取自 [dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale)

## 邮箱配置

编辑 `~/.hongclaw/config.json`：

```json
{
  "email": {
    "smtpHost": "smtp.qq.com",
    "smtpPort": 465,
    "smtpUser": "xxx@qq.com",
    "smtpPass": "授权码",
    "from": "xxx@qq.com",
    "imapHost": "imap.qq.com",
    "imapPort": 993,
    "imapUser": "xxx@qq.com",
    "imapPass": "授权码",
    "to": "xxx@qq.com",
    "notifyCron": true
  }
}
```

QQ/163 邮箱使用**授权码**（非登录密码）。重启 gateway 生效；收件箱新邮件会自动触发 agent 阅读并回复。

## 终端命令

```bash
node hongclaw.js            # 启动 Gateway + Web UI
node hongclaw.js doctor     # 自检
node hongclaw.js doctor --fix   # 自检并自动修复
node hongclaw.js publish    # 发布到 GitHub（需 export GITHUB_TOKEN=ghp_xxx）
node hongclaw.js --version
```

## 皮肤署名

鲸鱼娘皮肤素材为衍生创作，整体以 **CC BY-NC-SA 4.0** 发布，禁止商业使用。角色形象版权：

- 上善（鲸鱼娘角色原作）· [Pixiv](https://www.pixiv.net/users/62155430) · [Bilibili](https://b23.tv/8h5L4xz)
- ZipZipPipe（DeepSeek 女仆鲸鱼娘二次设计）· [Pixiv](https://www.pixiv.net/users/18604994) · [Bilibili](https://b23.tv/Pnw6nG8)

皮肤工程来源：[dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale)（Small-tailqwq）

## License

MIT（代码）；皮肤素材见上方署名说明（CC BY-NC-SA 4.0）。
