# HongClaw（鸿爪）

鸿蒙电脑原生 AI Agent，对标 OpenClaw。纯 Node.js、零依赖、不产 HAP，一条命令运行。

## 运行要求
仅需 Node.js >= 18.17，不需要虚拟机 / 融合开发引擎 / Linux 子系统 / 任何 npm 包。

## 快速开始
```
node hongclaw.js
```
终端打印 Web UI 地址，浏览器打开即可。首次使用点「配置」填 DeepSeek Key，或 export DEEPSEEK_API_KEY=sk-...。

## 特性
- Gateway（HTTP + SSE）+ Web UI（流式聊天、会话、工具/审批可视化）
- DeepSeek 流式 + 工具调用（兼容原生 tool_calls 与 V3.2+ DSML）
- 工具：读写文件、列目录、执行命令（人工审批）、网页抓取

## Roadmap
- v1.1：CLI、MCP 客户端
- v1.2：浏览器控制（CDP）、搜索、多模型

## License
MIT
