import type {
  CaptureFrameInput,
  CaptureSession,
  CreateSessionRequest,
  ParseRequest,
  SimulatedPacket
} from '../../shared/types';

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

/** 所有接口失败统一抛出的错误，携带 HTTP 状态码便于区分 404 等情况 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface Envelope<T> {
  data?: T;
  error?: string;
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init
    });
  } catch {
    // fetch 本身 reject：服务未启动、断网、CORS 等
    throw new ApiError('无法连接解析服务，请确认 API 已启动。', 0);
  }

  if (response.status === 204) return undefined as T;

  let payload: Envelope<T> = {};
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    // 响应不是合法 JSON
  }

  if (!response.ok) {
    throw new ApiError(payload.error ?? `接口请求失败（HTTP ${response.status}）`, response.status);
  }
  if (payload.data === undefined) throw new ApiError('接口返回的数据格式不正确。', response.status);
  return payload.data;
}

function query(protocol: string, scenario: string): string {
  return `/api/simulate?protocol=${encodeURIComponent(protocol)}&scenario=${encodeURIComponent(scenario)}`;
}

export const api = {
  simulate(protocol: string, scenario: string): Promise<SimulatedPacket> {
    return send<SimulatedPacket>(query(protocol, scenario));
  },

  parse(body: ParseRequest): Promise<SimulatedPacket> {
    return send<SimulatedPacket>('/api/parse', { method: 'POST', body: JSON.stringify(body) });
  },

  listSessions(): Promise<CaptureSession[]> {
    return send<CaptureSession[]>('/api/sessions');
  },

  getSession(id: string): Promise<CaptureSession> {
    return send<CaptureSession>(`/api/sessions/${encodeURIComponent(id)}`);
  },

  createSession(body: CreateSessionRequest = {}): Promise<CaptureSession> {
    return send<CaptureSession>('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
  },

  appendFrame(sessionId: string, frame: CaptureFrameInput): Promise<CaptureSession> {
    return send<CaptureSession>(`/api/sessions/${encodeURIComponent(sessionId)}/frames`, {
      method: 'POST',
      body: JSON.stringify(frame)
    });
  },

  updateNote(sessionId: string, frameId: string, note: string): Promise<CaptureSession> {
    return send<CaptureSession>(
      `/api/sessions/${encodeURIComponent(sessionId)}/frames/${encodeURIComponent(frameId)}`,
      { method: 'PATCH', body: JSON.stringify({ note }) }
    );
  },

  deleteFrame(sessionId: string, frameId: string): Promise<CaptureSession> {
    return send<CaptureSession>(
      `/api/sessions/${encodeURIComponent(sessionId)}/frames/${encodeURIComponent(frameId)}`,
      { method: 'DELETE' }
    );
  },

  deleteSession(sessionId: string): Promise<void> {
    return send<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  }
};
