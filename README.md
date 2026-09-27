# Network Packet Lab · 网络协议数据包可视化实验室

项目 10：一个用于学习和演示网络协议解析过程的可视化实验室。当前版本聚焦模拟 HTTP / TCP 数据包，提供输入、场景选择、协议层级字段树、十六进制数据、解析时间线，以及可供 React 管理界面调用的 Node.js API。

## 技术栈

- **前端**：React 18、Vite、TypeScript
- **后端**：Node.js、Express、TypeScript
- **工程**：前后端共享 `shared/types.ts` 类型，根目录统一管理脚本

## 目录结构

```text
network-packet-lab/
├── client/
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       ├── vite-env.d.ts
│       └── styles.css
├── server/
│   ├── index.ts        # Express 路由（解析 API + 捕获会话 API）
│   ├── packets.ts      # 协议解析与数据包快照构建
│   └── sessions.ts     # 会话仓库（内存 + .data/sessions.json 持久化）
├── shared/
│   └── types.ts
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts
└── .gitignore
```

## 功能

1. **模拟数据选择**：在 HTTP / TCP 协议之间切换，并选择请求、响应或 TCP 握手场景。
2. **数据包输入**：编辑原始 HTTP 文本或 TCP 模拟摘要，点击“解析数据包”重新生成可视化结果。
3. **协议字段树**：HTTP 展示起始行、Header、Payload；TCP 展示 Ethernet、IPv4、TCP 和 Payload 层级，并支持折叠。
4. **十六进制视图**：以 offset、hex bytes、ASCII 三列展示当前 payload 的 UTF-8 字节。
5. **传输时间线**：展示抓包、解析、传输层解码和结构化输出等阶段。
6. **捕获会话工作区**：把当前原始输入、协议、场景与解析结果（字段树、十六进制行、时间线）作为**不可变帧**加入会话；可在会话中切换帧、删除帧、为帧写复核备注，并删除整个会话。最近一次会话的 ID 记录在浏览器 localStorage 中，重新打开页面会自动从服务端恢复；会话数据持久化在服务端 `.data/sessions.json`，重启后端也不丢。
7. **解析 API / 会话 API**：Express 服务提供 `/api/parse`、`/api/simulate`、`/api/packets`、`/api/sessions` 和 `/api/health`。

## 启动方式

当前只完整落盘项目文件，**没有安装依赖**。准备运行时，在本目录执行：

```bash
npm install
```

然后打开两个终端：

```bash
# 终端 1：启动 API 服务（默认 3001）
npm run dev:server

# 终端 2：启动 Vite 管理界面（默认 5173）
npm run dev:client
```

浏览器访问 `http://localhost:5173`。如需更换 API 地址，可设置 `VITE_API_BASE`，例如：

```bash
VITE_API_BASE=http://localhost:3001 npm run dev:client
```

生产构建：

```bash
npm run build
npm start
```

> `npm start` 会启动编译后的 API 服务；前端静态产物位于 `dist/client`，可交给任意静态服务器托管。

## API 示例

### 获取模拟数据

```bash
curl 'http://localhost:3001/api/simulate?protocol=HTTP&scenario=request'
curl 'http://localhost:3001/api/simulate?protocol=TCP&scenario=handshake'
```

### 解析输入数据包

```bash
curl -X POST 'http://localhost:3001/api/parse' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"HTTP","scenario":"request","raw":"GET /health HTTP/1.1\\r\\nHost: lab.local\\r\\n\\r\\n"}'
```

### 获取某协议的全部示例

```bash
curl 'http://localhost:3001/api/packets?protocol=TCP'
```

### 捕获会话

```bash
# 创建会话（首帧随请求一起生成，可附带 note / title）
curl -X POST 'http://localhost:3001/api/sessions' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"HTTP","scenario":"request","raw":"GET /health HTTP/1.1\r\nHost: lab.local\r\n\r\n","note":"请同伴复核 Host 头"}'

# 会话列表（摘要，最近更新在前）
curl 'http://localhost:3001/api/sessions'

# 读取单个会话（含全部帧）
curl 'http://localhost:3001/api/sessions/<sessionId>'

# 向会话追加一帧（帧内容服务端生成，不可变）
curl -X POST 'http://localhost:3001/api/sessions/<sessionId>/frames' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"TCP","scenario":"handshake","raw":"TCP 10.0.0.1:1234 > 10.0.0.2:443 | Flags=SYN"}'

# 修改帧备注（帧中唯一可变更的字段，≤500 字）
curl -X PATCH 'http://localhost:3001/api/sessions/<sessionId>/frames/<frameId>' \
  -H 'Content-Type: application/json' \
  -d '{"note":"MSS 已核对"}'

# 删除单帧；删除整个会话
curl -X DELETE 'http://localhost:3001/api/sessions/<sessionId>/frames/<frameId>'
curl -X DELETE 'http://localhost:3001/api/sessions/<sessionId>'
```

会话持久化目录可用环境变量 `SESSION_DATA_DIR` 覆盖（默认 `./.data`，已在 `.gitignore` 中忽略）。

## 前端状态处理约定

- **加载中**：会话恢复、打开历史会话、保存备注等操作分别展示独立的 spinner，不互相阻塞。
- **空会话**：服务端无会话、或会话中帧被删空时，展示引导空状态与“去捕获第一帧”入口。
- **重复提交**：捕获按钮在请求进行中禁用；当前原始输入/协议/场景与最新一帧完全相同时不重复建帧，并给出提示。
- **接口失败**：网络错误、非 2xx（读取服务端 `{error}` 文案）在对应工作区显示错误条与“重试”入口，不会清空已有数据。

## 说明

本项目是教学用模拟器，不执行真实网卡抓包，也不声称校验真实 TCP 校验和。十六进制内容由当前输入字符串的 UTF-8 字节生成，字段解析为面向演示的轻量级解析结果。
