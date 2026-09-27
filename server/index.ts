import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type {
  AppendFrameRequest,
  CaptureFrame,
  CaptureFrameInput,
  CaptureSession,
  CreateSessionRequest,
  HexRow,
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  SimulatedPacket,
  TimelineEvent,
  UpdateNoteRequest
} from '../shared/types.js';

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

const HTTP_SAMPLES: Record<PacketScenario, string> = {
  request: 'GET /api/devices?status=online HTTP/1.1\r\nHost: lab.local\r\nAccept: application/json\r\nUser-Agent: PacketLab/1.0\r\nX-Trace-Id: 7f3a9c\r\n\r\n',
  response: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 47\r\nCache-Control: no-store\r\n\r\n{"devices":[{"id":"edge-01","status":"online"}]}',
  handshake: 'GET / HTTP/1.1\r\nHost: lab.local\r\nConnection: keep-alive\r\n\r\n'
};

const TCP_SAMPLES: Record<PacketScenario, string> = {
  request: 'TCP 10.0.0.24:51842 > 10.0.0.8:443 | Seq=18492031 Ack=77120102 | Flags=ACK,PSH | Win=64240 | Len=128',
  response: 'TCP 10.0.0.8:443 > 10.0.0.24:51842 | Seq=77120102 Ack=18492159 | Flags=ACK,PSH | Win=28960 | Len=512',
  handshake: 'TCP 10.0.0.24:51842 > 10.0.0.8:443 | Seq=0 Ack=0 | Flags=SYN | Win=64240 | MSS=1460 | WS=7'
};

function hexDump(value: string): HexRow[] {
  const bytes = Array.from(Buffer.from(value, 'utf8'));
  const rows: HexRow[] = [];
  for (let index = 0; index < bytes.length; index += 16) {
    const slice = bytes.slice(index, index + 16);
    rows.push({
      offset: index.toString(16).padStart(4, '0'),
      bytes: slice.map((byte) => byte.toString(16).padStart(2, '0')),
      ascii: slice.map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('')
    });
  }
  return rows;
}

function field(id: string, key: string, value: string, description: string, children?: ProtocolField[]): ProtocolField {
  return { id, key, value, description, ...(children ? { children } : {}) };
}

function parseHttpFields(raw: string): ProtocolField[] {
  const [head, body = ''] = raw.split(/\r?\n\r?\n/);
  const lines = head.split(/\r?\n/);
  const startLine = lines.shift() ?? '';
  const headers = lines.map((line, index) => {
    const separator = line.indexOf(':');
    const key = separator > -1 ? line.slice(0, separator).trim() : `Header-${index + 1}`;
    const value = separator > -1 ? line.slice(separator + 1).trim() : line.trim();
    return field(`header-${index}`, key, value || '(empty)', 'HTTP header field');
  });
  const isResponse = startLine.startsWith('HTTP/');
  const [first, second, third] = startLine.split(' ');
  return [
    field('http-start-line', isResponse ? 'Status-Line' : 'Request-Line', startLine, isResponse ? 'HTTP version and response status' : 'HTTP method, target and version', [
      field('http-part-1', isResponse ? 'Version' : 'Method', first ?? '—', isResponse ? 'Protocol version' : 'HTTP request method'),
      field('http-part-2', isResponse ? 'Status' : 'Target', second ?? '—', isResponse ? 'Status code' : 'Request target'),
      field('http-part-3', isResponse ? 'Reason' : 'Version', isResponse ? (third ?? '—') : (third ?? '—'), isResponse ? 'Reason phrase' : 'Protocol version')
    ]),
    field('http-headers', 'Headers', `${headers.length} fields`, 'Metadata carried by the application layer', headers),
    field('http-body', 'Payload', body || '(empty)', 'Application payload after the header terminator')
  ];
}

function parseTcpFields(raw: string): ProtocolField[] {
  const [route = '', ...parts] = raw.split(' | ');
  const [protocol, source = '—', arrow = '>', destination = '—'] = route.split(' ');
  const values = new Map(parts.map((part) => {
    const separator = part.indexOf('=');
    return separator > -1 ? [part.slice(0, separator), part.slice(separator + 1)] : [part, 'true'];
  }));
  return [
    field('ethernet', 'Link Layer', 'Ethernet II', 'Frame envelope', [
      field('ethernet-src', 'Source MAC', '02:42:ac:11:00:24', 'Simulated interface address'),
      field('ethernet-dst', 'Destination MAC', '02:42:ac:11:00:08', 'Simulated gateway address'),
      field('ethernet-type', 'Type', '0x0800 · IPv4', 'Network protocol identifier')
    ]),
    field('ipv4', 'Internet Layer', 'IPv4', 'Logical addressing and delivery', [
      field('ipv4-source', 'Source', source, 'Origin IP and port'),
      field('ipv4-destination', 'Destination', destination, 'Target IP and port'),
      field('ipv4-protocol', 'Next Protocol', protocol || 'TCP', 'Transport protocol')
    ]),
    field('tcp', 'Transport Layer', 'TCP', 'Reliable stream transport', [
      field('tcp-seq', 'Sequence', values.get('Seq') ?? '—', 'Byte sequence position'),
      field('tcp-ack', 'Acknowledgement', values.get('Ack') ?? '—', 'Next expected byte'),
      field('tcp-flags', 'Flags', values.get('Flags') ?? '—', 'Control bits'),
      field('tcp-window', 'Window', values.get('Win') ?? '—', 'Receive window size'),
      field('tcp-length', 'Payload Length', values.get('Len') ?? '0', 'TCP segment data length')
    ]),
    field('tcp-payload', 'Payload', values.get('Len') === '0' ? '(empty)' : 'Encrypted application data', 'Data carried by the segment')
  ];
}

function timelineFor(protocol: Protocol, scenario: PacketScenario): TimelineEvent[] {
  const prefix = protocol === 'HTTP' ? 'HTTP' : 'TCP';
  const steps = protocol === 'HTTP'
    ? [
        ['ingress', 'Frame captured', 'NIC received an application frame'],
        ['parse', 'Headers indexed', 'Start line and header fields identified'],
        ['application', `${prefix} payload decoded`, scenario === 'response' ? 'Response body is ready for inspection' : 'Request target and metadata extracted'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ]
    : [
        ['ingress', 'Segment captured', 'Transport segment received from the simulated wire'],
        ['transport', 'TCP header decoded', 'Sequence, acknowledgement and flags extracted'],
        ['parse', 'Layer tree assembled', 'Ethernet → IPv4 → TCP hierarchy created'],
        ['egress', 'Inspector ready', 'Structured representation emitted by parse API']
      ];
  return steps.map(([phase, label, detail], index) => ({
    id: `${prefix.toLowerCase()}-${index}`,
    timestamp: `00:00:0${index}.${(index * 37 + 12).toString().padStart(2, '0')}`,
    label,
    phase: phase as TimelineEvent['phase'],
    detail
  }));
}

function checksum(raw: string): string {
  let hash = 0;
  for (const byte of Buffer.from(raw, 'utf8')) hash = (hash + byte * 31) % 65535;
  return `0x${hash.toString(16).padStart(4, '0').toUpperCase()}`;
}

function buildPacket(protocol: Protocol, scenario: PacketScenario, raw: string): SimulatedPacket {
  const safeRaw = raw.trim() ? raw : (protocol === 'HTTP' ? HTTP_SAMPLES[scenario] : TCP_SAMPLES[scenario]);
  const isHttp = protocol === 'HTTP';
  return {
    id: `${protocol.toLowerCase()}-${scenario}-${Date.now().toString(36).slice(-6)}`,
    protocol,
    scenario,
    summary: isHttp
      ? `${safeRaw.split(/\r?\n/)[0]} · ${scenario === 'response' ? 'server response' : 'client request'}`
      : `${scenario === 'handshake' ? 'TCP connection handshake' : 'TCP data segment'} · ${safeRaw.split(' | ')[0]}`,
    raw: safeRaw,
    hex: hexDump(safeRaw),
    fields: isHttp ? parseHttpFields(safeRaw) : parseTcpFields(safeRaw),
    timeline: timelineFor(protocol, scenario),
    metadata: {
      capturedAt: new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'),
      source: isHttp ? '10.0.0.24:51842' : safeRaw.split(' > ')[0].replace('TCP ', ''),
      destination: isHttp ? '10.0.0.8:443' : (safeRaw.split(' > ')[1]?.split(' | ')[0] ?? '10.0.0.8:443'),
      length: Buffer.byteLength(safeRaw, 'utf8'),
      checksum: checksum(safeRaw)
    }
  };
}

function isProtocol(value: unknown): value is Protocol { return value === 'HTTP' || value === 'TCP'; }
function isScenario(value: unknown): value is PacketScenario { return value === 'request' || value === 'response' || value === 'handshake'; }

function readFrameInput(body: unknown): { input?: CaptureFrameInput; error?: string } {
  const source = (body as Partial<CaptureFrameInput> | null | undefined) ?? {};
  if (!isProtocol(source.protocol)) return { error: 'protocol must be HTTP or TCP' };
  if (!isScenario(source.scenario)) return { error: 'scenario must be request, response or handshake' };
  if (typeof source.raw !== 'string') return { error: 'raw is required' };
  if (!source.raw.trim()) return { error: 'raw is required' };
  const note = source.note ?? '';
  if (typeof note !== 'string') return { error: 'note must be a string' };
  return { input: { protocol: source.protocol, scenario: source.scenario, raw: source.raw, note: note.trim() } };
}

function makeFrame(input: CaptureFrameInput): CaptureFrame {
  return {
    id: randomUUID(),
    protocol: input.protocol,
    scenario: input.scenario,
    note: input.note ?? '',
    addedAt: new Date().toISOString(),
    packet: buildPacket(input.protocol, input.scenario, input.raw)
  };
}

function touch(session: CaptureSession): void {
  session.updatedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 捕获会话存储（进程内存；教学演示用，重启即清空）
// ---------------------------------------------------------------------------

const sessions = new Map<string, CaptureSession>();

function getSessionOr404(sessionId: string, response: Response): CaptureSession | null {
  const session = sessions.get(sessionId);
  if (!session) response.status(404).json({ error: 'session not found' });
  return session ?? null;
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

// 创建会话，可选地同时追加第一帧
app.post('/api/sessions', (request: Request<unknown, unknown, Partial<CreateSessionRequest>>, response: Response) => {
  const title = typeof request.body?.title === 'string' && request.body.title.trim()
    ? request.body.title.trim().slice(0, 120)
    : `捕获会话 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`;

  let firstFrame: CaptureFrame | undefined;
  if (request.body?.frame !== undefined) {
    const { input, error } = readFrameInput(request.body.frame);
    if (error) return response.status(400).json({ error });
    firstFrame = makeFrame(input!);
  }

  const now = new Date().toISOString();
  const session: CaptureSession = {
    id: randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    frames: firstFrame ? [firstFrame] : []
  };
  sessions.set(session.id, session);
  response.status(201).json({ data: session });
});

// 会话列表（按最近更新排序，供前端恢复“最近一次会话”兜底使用）
app.get('/api/sessions', (_request, response) => {
  const data = [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  response.json({ data });
});

app.get('/api/sessions/:id', (request, response) => {
  const session = getSessionOr404(request.params.id, response);
  if (session) response.json({ data: session });
});

// 追加不可变帧
app.post('/api/sessions/:id/frames', (request: Request<{ id: string }, unknown, Partial<AppendFrameRequest>>, response: Response) => {
  const session = getSessionOr404(request.params.id, response);
  if (!session) return;
  const { input, error } = readFrameInput(request.body);
  if (error) return response.status(400).json({ error });
  session.frames.push(makeFrame(input!));
  touch(session);
  response.status(201).json({ data: session });
});

// 修改帧备注（帧快照本身不可变）
app.patch('/api/sessions/:id/frames/:frameId', (request: Request<{ id: string; frameId: string }, unknown, Partial<UpdateNoteRequest>>, response: Response) => {
  const session = getSessionOr404(request.params.id, response);
  if (!session) return;
  const frame = session.frames.find((item) => item.id === request.params.frameId);
  if (!frame) return response.status(404).json({ error: 'frame not found' });
  if (typeof request.body?.note !== 'string') return response.status(400).json({ error: 'note is required' });
  frame.note = request.body.note.slice(0, 500);
  touch(session);
  response.json({ data: session });
});

app.delete('/api/sessions/:id/frames/:frameId', (request, response) => {
  const session = getSessionOr404(request.params.id, response);
  if (!session) return;
  const index = session.frames.findIndex((item) => item.id === request.params.frameId);
  if (index === -1) return response.status(404).json({ error: 'frame not found' });
  session.frames.splice(index, 1);
  touch(session);
  response.json({ data: session });
});

app.delete('/api/sessions/:id', (request, response) => {
  if (!sessions.delete(request.params.id)) return response.status(404).json({ error: 'session not found' });
  response.status(204).send();
});

app.listen(port, () => {
  console.log(`Network Packet Lab API listening on http://localhost:${port}`);
});
