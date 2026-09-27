import { useCallback, useState } from 'react';
import { api, ApiError } from './api';
import type { CaptureSession, SimulatedPacket } from '../../shared/types';

const LAST_SESSION_KEY = 'packet-lab:last-session-id';

export function readLastSessionId(): string | null {
  try {
    return window.localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
}

function rememberSession(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(LAST_SESSION_KEY, id);
    else window.localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    // 隐私模式等场景下 localStorage 不可用，内存会话仍可正常工作
  }
}

export type SessionStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SessionNotice = { kind: 'success' | 'warning'; text: string } | null;

/** 会话中是否已存在协议、场景与原始输入完全一致的帧 */
export function isDuplicateFrame(session: CaptureSession | null, packet: SimulatedPacket | null): boolean {
  if (!session || !packet) return false;
  return session.frames.some(
    (frame) =>
      frame.packet.protocol === packet.protocol &&
      frame.packet.scenario === packet.scenario &&
      frame.packet.raw === packet.raw
  );
}

export interface CaptureSessionApi {
  session: CaptureSession | null;
  status: SessionStatus;
  loadError: string;
  actionError: string;
  notice: SessionNotice;
  capturing: boolean;
  frameBusyId: string | null;
  activeFrameId: string | null;
  /** 打开页面时恢复最近一次会话；返回恢复到的会话（没有则为 null） */
  restore: () => Promise<CaptureSession | null>;
  createSession: (withFrame?: SimulatedPacket) => Promise<boolean>;
  capture: (packet: SimulatedPacket) => Promise<boolean>;
  selectFrame: (frameId: string) => void;
  saveNote: (frameId: string, note: string) => Promise<boolean>;
  removeFrame: (frameId: string) => Promise<void>;
  removeSession: () => Promise<boolean>;
  clearActionError: () => void;
  clearNotice: () => void;
}

export function useCaptureSession(): CaptureSessionApi {
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState<SessionNotice>(null);
  const [capturing, setCapturing] = useState(false);
  const [frameBusyId, setFrameBusyId] = useState<string | null>(null);
  const [activeFrameId, setActiveFrameId] = useState<string | null>(null);

  const applySession = useCallback((next: CaptureSession, preferFrameId?: string) => {
    setSession(next);
    setStatus('ready');
    setLoadError('');
    setActiveFrameId((current) => {
      if (preferFrameId && next.frames.some((frame) => frame.id === preferFrameId)) return preferFrameId;
      if (current && next.frames.some((frame) => frame.id === current)) return current;
      return next.frames[next.frames.length - 1]?.id ?? null;
    });
  }, []);

  // 恢复最近一次会话：优先本地记录的 id，找不到则取服务端最新会话
  const restore = useCallback(async (): Promise<CaptureSession | null> => {
    setStatus('loading');
    setLoadError('');
    try {
      const savedId = readLastSessionId();
      if (savedId) {
        try {
          const restored = await api.getSession(savedId);
          applySession(restored);
          return restored;
        } catch (cause) {
          // 记录的会话已不存在（服务重启或已删除），继续用列表兜底
          if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
        }
      }
      const sessions = await api.listSessions();
      if (sessions.length) {
        const latest = sessions[0];
        rememberSession(latest.id);
        applySession(latest);
        return latest;
      }
      setStatus('idle');
      return null;
    } catch (cause) {
      setStatus('error');
      setLoadError(cause instanceof Error ? cause.message : '恢复捕获会话失败');
      return null;
    }
  }, [applySession]);

  const createSession = useCallback(async (withFrame?: SimulatedPacket): Promise<boolean> => {
    setCapturing(true);
    setActionError('');
    setNotice(null);
    try {
      const created = await api.createSession(withFrame
        ? { frame: { protocol: withFrame.protocol, scenario: withFrame.scenario, raw: withFrame.raw } }
        : {});
      rememberSession(created.id);
      applySession(created, created.frames[0]?.id);
      setNotice(withFrame
        ? { kind: 'success', text: `已创建会话并加入第 1 帧：${withFrame.summary}` }
        : { kind: 'success', text: '已创建新的空会话，回到解析工作台捕获第一帧吧。' });
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '创建会话失败');
      return false;
    } finally {
      setCapturing(false);
    }
  }, [applySession]);

  // 把当前解析结果作为不可变帧加入会话；还没有会话时自动创建
  const capture = useCallback(async (packet: SimulatedPacket): Promise<boolean> => {
    setCapturing(true);
    setActionError('');
    setNotice(null);
    try {
      if (session) {
        const updated = await api.appendFrame(session.id, {
          protocol: packet.protocol,
          scenario: packet.scenario,
          raw: packet.raw
        });
        const frameId = updated.frames[updated.frames.length - 1]?.id;
        rememberSession(updated.id);
        applySession(updated, frameId);
      } else {
        const created = await api.createSession({
          frame: { protocol: packet.protocol, scenario: packet.scenario, raw: packet.raw }
        });
        rememberSession(created.id);
        applySession(created, created.frames[0]?.id);
      }
      setNotice({ kind: 'success', text: `已作为不可变帧加入会话：${packet.summary}` });
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '加入捕获会话失败');
      return false;
    } finally {
      setCapturing(false);
    }
  }, [session, applySession]);

  const selectFrame = useCallback((frameId: string) => setActiveFrameId(frameId), []);

  const saveNote = useCallback(async (frameId: string, note: string): Promise<boolean> => {
    if (!session) return false;
    setFrameBusyId(frameId);
    setActionError('');
    try {
      const updated = await api.updateNote(session.id, frameId, note);
      applySession(updated, frameId);
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '备注保存失败');
      return false;
    } finally {
      setFrameBusyId(null);
    }
  }, [session, applySession]);

  const removeFrame = useCallback(async (frameId: string): Promise<void> => {
    if (!session) return;
    setFrameBusyId(frameId);
    setActionError('');
    try {
      const updated = await api.deleteFrame(session.id, frameId);
      applySession(updated);
      setNotice({ kind: 'success', text: '帧已删除，其余帧保持不变。' });
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '删除帧失败');
    } finally {
      setFrameBusyId(null);
    }
  }, [session, applySession]);

  const removeSession = useCallback(async (): Promise<boolean> => {
    if (!session) return false;
    setCapturing(true);
    setActionError('');
    try {
      await api.deleteSession(session.id);
      rememberSession(null);
      setSession(null);
      setActiveFrameId(null);
      setStatus('idle');
      setNotice({ kind: 'success', text: '整个捕获会话已删除，可以重新开始。' });
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '删除会话失败');
      return false;
    } finally {
      setCapturing(false);
    }
  }, [session]);

  return {
    session,
    status,
    loadError,
    actionError,
    notice,
    capturing,
    frameBusyId,
    activeFrameId,
    restore,
    createSession,
    capture,
    selectFrame,
    saveNote,
    removeFrame,
    removeSession,
    clearActionError: () => setActionError(''),
    clearNotice: () => setNotice(null)
  };
}
