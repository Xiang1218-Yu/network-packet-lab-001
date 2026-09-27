import express, { type Request, type Response } from 'express';
import type {
  CaptureFrameInput,
  PacketScenario,
  ParseRequest,
  Protocol,
  SimulatedPacket
} from '../shared/types.js';
import { buildPacket, isProtocol, isScenario } from './packets.js';
import { sessionStore } from './sessions.js';

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  response.header('Access-Control-Allow-Origin', '*');
  response.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  response.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  next();
});

/** 统一的错误输出格式：{ error: string } */
function sendStoreError(response: Response, cause: unknown): void {
  if (cause instanceof sessionStore.StoreError) {
    response.status(cause.status).json({ error: cause.message });
    return;
  }
  console.error('[api] 未预期的错误：', cause);
  response.status(500).json({ error: '服务端内部错误' });
}

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'network-packet-lab-api' }));

app.get('/api/simulate', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenario = isScenario(request.query.scenario) ? request.query.scenario : (protocol === 'HTTP' ? 'request' : 'handshake');
  response.json({ data: buildPacket(protocol, scenario, '') });
});

app.get('/api/packets', (request, response) => {
  const protocol = isProtocol(request.query.protocol) ? request.query.protocol : 'HTTP';
  const scenarios: PacketScenario[] = protocol === 'HTTP' ? ['request', 'response'] : ['handshake', 'request', 'response'];
  response.json({ data: scenarios.map((scenario) => buildPacket(protocol, scenario, '')) });
});

app.post('/api/parse', (request: Request<unknown, unknown, Partial<ParseRequest>>, response: Response) => {
  const protocol = isProtocol(request.body?.protocol) ? request.body.protocol : 'HTTP';
  const scenario = isScenario(request.body?.scenario) ? request.body.scenario : 'request';
  const raw = typeof request.body?.raw === 'string' ? request.body.raw : '';
  if (!raw.trim()) return response.status(400).json({ error: 'raw is required' });
  response.json({ data: buildPacket(protocol, scenario, raw) });
});

/* ------------------------------ 捕获会话 API ------------------------------ */

// 会话列表（最近更新在前）
app.get('/api/sessions', (_request, response) => {
  response.json({ data: sessionStore.listSessions() });
});

// 读取单个会话（含全部帧）
app.get('/api/sessions/:sessionId', (request, response) => {
  try {
    response.json({ data: sessionStore.getSession(request.params.sessionId) });
  } catch (cause) {
    sendStoreError(response, cause);
  }
});

// 创建会话，首帧随请求一起生成
app.post('/api/sessions', (request: Request<unknown, unknown, Partial<CaptureFrameInput> & { title?: string }>, response: Response) => {
  try {
    const session = sessionStore.createSession(request.body ?? {});
    response.status(201).json({ data: session });
  } catch (cause) {
    sendStoreError(response, cause);
  }
});

// 向会话追加一帧（帧不可变，仅新增）
app.post('/api/sessions/:sessionId/frames', (request, response) => {
  try {
    const frame = sessionStore.appendFrame(request.params.sessionId, request.body ?? {});
    response.status(201).json({ data: frame });
  } catch (cause) {
    sendStoreError(response, cause);
  }
});

// 修改帧备注（帧中唯一允许变更的字段）
app.patch('/api/sessions/:sessionId/frames/:frameId', (request, response) => {
  try {
    const frame = sessionStore.updateFrameNote(
      request.params.sessionId,
      request.params.frameId,
      (request.body as { note?: unknown } | undefined)?.note
    );
    response.json({ data: frame });
  } catch (cause) {
    sendStoreError(response, cause);
  }
});

// 删除单帧
app.delete('/api/sessions/:sessionId/frames/:frameId', (request, response) => {
  try {
    response.json({ data: sessionStore.deleteFrame(request.params.sessionId, request.params.frameId) });
  } catch (cause) {
    sendStoreError(response, cause);
  }
});

// 删除整个会话
app.delete('/api/sessions/:sessionId', (request, response) => {
  try {
    sessionStore.deleteSession(request.params.sessionId);
    response.status(204).send();
  } catch (cause) {
    sendStoreError(response, cause);
  }
});

app.listen(port, () => {
  console.log(`Network Packet Lab API listening on http://localhost:${port}`);
});

function shutdown(): void {
  sessionStore.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
