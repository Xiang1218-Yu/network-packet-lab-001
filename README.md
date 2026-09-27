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
│       └── styles.css
├── server/
│   └── index.ts
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
6. **捕获会话工作区**：把当前原始输入、协议、场景、解析字段树、十六进制行和时间线作为**不可变帧**加入会话；支持切换帧、删除帧、为帧写复核备注；重新打开页面自动恢复最近一次会话。
7. **会话 API**：Express 服务额外提供 `/api/sessions` 的创建、追加、读取、列表、删除，以及帧备注修改和帧删除接口。

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
# 创建会话（可同时携带第一帧；不带 frame 则创建空会话）
curl -X POST 'http://localhost:3001/api/sessions' \
  -H 'Content-Type: application/json' \
  -d '{"title":"第3组实验","frame":{"protocol":"HTTP","scenario":"request","raw":"GET / HTTP/1.1\r\nHost: lab.local\r\n\r\n","note":"请复核起始行"}}'

# 追加不可变帧（原始输入 + 协议/场景，解析快照由服务端生成）
curl -X POST 'http://localhost:3001/api/sessions/<sid>/frames' \
  -H 'Content-Type: application/json' \
  -d '{"protocol":"TCP","scenario":"handshake","raw":"TCP 10.0.0.1:1 > 10.0.0.2:2 | Seq=0 | Flags=SYN"}'

# 读取 / 列表（按 updatedAt 倒序，前端据此恢复最近会话）
curl 'http://localhost:3001/api/sessions/<sid>'
curl 'http://localhost:3001/api/sessions'

# 修改帧备注（帧快照本身不可变）
curl -X PATCH 'http://localhost:3001/api/sessions/<sid>/frames/<fid>' \
  -H 'Content-Type: application/json' -d '{"note":"同伴已确认"}'

# 删除单帧 / 删除整个会话（204）
curl -X DELETE 'http://localhost:3001/api/sessions/<sid>/frames/<fid>'
curl -X DELETE 'http://localhost:3001/api/sessions/<sid>'
```

> 会话保存在服务端进程内存中；最近一次会话 id 记录在浏览器 `localStorage`（键 `packet-lab:last-session-id`）。服务重启后内存清空，前端会回退到服务端最新会话；若全部丢失则显示空会话引导。

## 说明

本项目是教学用模拟器，不执行真实网卡抓包，也不声称校验真实 TCP 校验和。十六进制内容由当前输入字符串的 UTF-8 字节生成，字段解析为面向演示的轻量级解析结果。
