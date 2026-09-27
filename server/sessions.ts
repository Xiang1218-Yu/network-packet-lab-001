import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CaptureFrame,
  CaptureFrameInput,
  CaptureSession,
  CaptureSessionSummary,
  Protocol,
  PacketScenario,
  SimulatedPacket
} from '../shared/types.js';
import { buildPacket } from './packets.js';

const DATA_DIR = process.env.SESSION_DATA_DIR ?? join(process.cwd(), '.data');
const DATA_FILE = join(DATA_DIR, 'sessions.json');
const MAX_FRAMES_PER_SESSION = 200;
const MAX_SESSIONS = 100;
const NOTE_MAX_LENGTH = 500;
const TITLE_MAX_LENGTH = 80;

class StoreError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 仓库内实际存储的形态：摘要字段（frameCount / lastSummary）读取时派生，避免冗余 */
type StoredSession = Omit<CaptureSession, 'frameCount' | 'lastSummary'>;

interface PersistedFile {
  sessions: StoredSession[];
}

let sessions: StoredSession[] = loadFromDisk();
let saveTimer: NodeJS.Timeout | null = null;

function loadFromDisk(): StoredSession[] {
  try {
    if (!existsSync(DATA_FILE)) return [];
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as PersistedFile;
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch (cause) {
    console.warn('[sessions] 无法读取持久化文件，将从空会话仓库启动：', cause instanceof Error ? cause.message : cause);
    return [];
  }
}

/** 串行的防抖落盘：高频追加也不会产生交错写入 */
function schedulePersist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 150);
}

function persistNow(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmpFile = `${DATA_FILE}.tmp`;
    writeFileSync(tmpFile, JSON.stringify({ sessions } satisfies PersistedFile, null, 2), 'utf8');
    renameSync(tmpFile, DATA_FILE);
  } catch (cause) {
    console.error('[sessions] 持久化失败：', cause instanceof Error ? cause.message : cause);
  }
}

function getSessionOrThrow(sessionId: string): StoredSession {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) throw new StoreError(404, '会话不存在或已被删除');
  return session;
}

/**
 * 公开读取边界：返回内部会话的深冻结投影。
 * - 内部存储中的帧在 append 时即冻结，仓库自身无法改写其内容；
 * - 读取时再投影出一个独立的冻结对象，调用方拿到的引用同样不可变
 *   （note 更新走 PATCH 入口，用新帧对象替换旧帧）。
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/** 内部存储投影为 API 返回的完整会话（附带派生摘要，整体不可变） */
function toSession(stored: StoredSession): CaptureSession {
  return deepFreeze({
    ...stored,
    frames: stored.frames.map((frame) => deepFreeze({
      ...frame,
      packet: deepFreeze({ ...frame.packet })
    })),
    frameCount: stored.frames.length,
    lastSummary: stored.frames.at(-1)?.packet.summary ?? null
  });
}

function summarize(session: StoredSession): CaptureSessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    frameCount: session.frames.length,
    lastSummary: session.frames.at(-1)?.packet.summary ?? null
  };
}

function validateFrameInput(input: Partial<CaptureFrameInput> | null | undefined): CaptureFrameInput {
  if (!input || typeof input !== 'object') throw new StoreError(400, '请求体必须包含帧数据');
  const protocol = input.protocol as Protocol;
  const scenario = input.scenario as PacketScenario;
  const raw = input.raw;
  if (protocol !== 'HTTP' && protocol !== 'TCP') throw new StoreError(400, 'protocol 必须是 HTTP 或 TCP');
  if (scenario !== 'request' && scenario !== 'response' && scenario !== 'handshake') {
    throw new StoreError(400, 'scenario 必须是 request、response 或 handshake');
  }
  if (typeof raw !== 'string' || !raw.trim()) throw new StoreError(400, 'raw 不能为空');
  const note = typeof input.note === 'string' ? input.note.slice(0, NOTE_MAX_LENGTH) : '';
  return { protocol, scenario, raw, note };
}

function buildFrame(input: CaptureFrameInput): CaptureFrame {
  // 帧内容在服务端生成：packet 快照与原始输入同源于一次解析
  const packet: SimulatedPacket = buildPacket(input.protocol, input.scenario, input.raw);
  const frame: CaptureFrame = {
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    note: input.note ?? '',
    protocol: input.protocol,
    scenario: input.scenario,
    raw: packet.raw,
    packet
  };
  // 冻结快照作为仓库内部的一层防御。注意：对冻结对象的属性赋值在严格模式下
  // 抛 TypeError、在非严格模式下静默失败——两种情况下数据都不会被改动。
  // 对外 API 也没有修改帧内容的入口（唯一的 PATCH 仅替换 note），
  // 因此帧的不可变性同时由接口设计保证。
  return Object.freeze({
    ...frame,
    packet: Object.freeze(packet)
  });
}

export const sessionStore = {
  StoreError,

  listSessions(): CaptureSessionSummary[] {
    return sessions
      .map(summarize)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  getSession(sessionId: string): CaptureSession {
    return toSession(getSessionOrThrow(sessionId));
  },

  createSession(body: Partial<CaptureFrameInput & { title: string }>): CaptureSession {
    if (sessions.length >= MAX_SESSIONS) {
      // 超出上限时淘汰最久未更新的会话，避免仓库无限增长
      const oldest = [...sessions].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (oldest) sessions = sessions.filter((item) => item.id !== oldest.id);
    }
    const input = validateFrameInput(body);
    const now = new Date().toISOString();
    const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
    const title = (rawTitle || `捕获会话 ${new Date().toLocaleString('zh-CN', { hour12: false })}`).slice(0, TITLE_MAX_LENGTH);
    const stored: StoredSession = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      frames: [buildFrame(input)]
    };
    sessions = [stored, ...sessions];
    schedulePersist();
    return toSession(stored);
  },

  appendFrame(sessionId: string, body: Partial<CaptureFrameInput>): CaptureFrame {
    const session = getSessionOrThrow(sessionId);
    const input = validateFrameInput(body);
    if (session.frames.length >= MAX_FRAMES_PER_SESSION) {
      throw new StoreError(413, `单个会话最多包含 ${MAX_FRAMES_PER_SESSION} 帧`);
    }
    const frame = buildFrame(input);
    session.frames.push(frame);
    session.updatedAt = new Date().toISOString();
    schedulePersist();
    return frame;
  },

  updateFrameNote(sessionId: string, frameId: string, note: unknown): CaptureFrame {
    const session = getSessionOrThrow(sessionId);
    const frame = session.frames.find((item) => item.id === frameId);
    if (!frame) throw new StoreError(404, '帧不存在或已被删除');
    if (typeof note !== 'string') throw new StoreError(400, 'note 必须是字符串');
    const trimmed = note.slice(0, NOTE_MAX_LENGTH);
    // packet 快照保持冻结，仅替换 note
    const nextFrame: CaptureFrame = { ...frame, note: trimmed };
    session.frames.splice(session.frames.indexOf(frame), 1, nextFrame);
    session.updatedAt = new Date().toISOString();
    schedulePersist();
    return nextFrame;
  },

  deleteFrame(sessionId: string, frameId: string): CaptureSession {
    const session = getSessionOrThrow(sessionId);
    const index = session.frames.findIndex((item) => item.id === frameId);
    if (index === -1) throw new StoreError(404, '帧不存在或已被删除');
    session.frames.splice(index, 1);
    session.updatedAt = new Date().toISOString();
    schedulePersist();
    return toSession(session);
  },

  deleteSession(sessionId: string): void {
    getSessionOrThrow(sessionId);
    sessions = sessions.filter((item) => item.id !== sessionId);
    schedulePersist();
  },

  /** 进程退出时同步落盘，尽量避免防抖窗口内的数据丢失 */
  flush(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistNow();
  }
};
