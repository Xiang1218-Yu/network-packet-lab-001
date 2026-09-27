import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  CaptureFrame,
  CaptureSession,
  CaptureSessionSummary,
  PacketScenario,
  ParseRequest,
  Protocol,
  ProtocolField,
  SimulatedPacket,
  TimelineEvent
} from '../../shared/types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';
const LAST_SESSION_KEY = 'packet-lab:last-session-id';

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

type WorkspaceTab = 'inspector' | 'session';

class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** 统一的接口调用：网络失败、非 2xx（读取 {error}）、空响应分别处理 */
async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init
    });
  } catch {
    throw new ApiError('无法连接到 API 服务，请确认后端（localhost:3001）已启动。');
  }
  if (response.status === 204) return undefined as T;
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // 非 JSON 响应留到状态码判断
  }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof (payload as { error: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `接口请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}

function App() {
  const [tab, setTab] = useState<WorkspaceTab>('inspector');

  // —— 解析工作台（原有）状态 ——
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [scenario, setScenario] = useState<PacketScenario>('request');
  const [rawInput, setRawInput] = useState('');
  const [packet, setPacket] = useState<SimulatedPacket | null>(null);
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [inspectorError, setInspectorError] = useState('');
  const [activeView, setActiveView] = useState<'overview' | 'hex'>('overview');

  // —— 捕获会话工作区状态 ——
  const [sessionsList, setSessionsList] = useState<CaptureSessionSummary[]>([]);
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const [activeFrameId, setActiveFrameId] = useState<string | null>(null);
  const [captureState, setCaptureState] = useState<'idle' | 'submitting'>('idle');
  const [captureError, setCaptureError] = useState('');
  const [deletingFrameId, setDeletingFrameId] = useState<string | null>(null);
  const [deletingSession, setDeletingSession] = useState(false);

  const bootedRef = useRef(false);

  const availableScenarios = useMemo<PacketScenario[]>(
    () => (protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response']),
    [protocol]
  );

  const activeFrame = useMemo(
    () => session?.frames.find((item) => item.id === activeFrameId) ?? null,
    [session, activeFrameId]
  );

  // 当前解析结果是否与会话最新一帧完全相同（防止重复加入）
  const duplicateOfLast = useMemo(() => {
    if (!session || !packet || session.frames.length === 0) return false;
    const last = session.frames[session.frames.length - 1];
    return last.protocol === packet.protocol && last.scenario === packet.scenario && last.raw === packet.raw;
  }, [session, packet]);

  const loadSample = async (nextProtocol = protocol, nextScenario = scenario) => {
    setInspectorLoading(true);
    setInspectorError('');
    try {
      const result = await apiJson<{ data: SimulatedPacket }>(
        `/api/simulate?protocol=${nextProtocol}&scenario=${nextScenario}`
      );
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      setInspectorError(cause instanceof Error ? cause.message : '加载模拟数据失败');
    } finally {
      setInspectorLoading(false);
    }
  };

  const parsePacket = async () => {
    setInspectorLoading(true);
    setInspectorError('');
    const body: ParseRequest = { protocol, scenario, raw: rawInput };
    try {
      const result = await apiJson<{ data: SimulatedPacket }>('/api/parse', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      setPacket(result.data);
      setRawInput(result.data.raw);
    } catch (cause) {
      setInspectorError(cause instanceof Error ? cause.message : '解析数据包失败');
    } finally {
      setInspectorLoading(false);
    }
  };

  const refreshSessionList = async () => {
    try {
      const result = await apiJson<{ data: CaptureSessionSummary[] }>('/api/sessions');
      setSessionsList(result.data);
    } catch {
      // 列表刷新失败不打断主流程，下次操作时会再试
    }
  };

  const openSession = async (sessionId: string) => {
    setOpeningSessionId(sessionId);
    setSessionError('');
    try {
      const result = await apiJson<{ data: CaptureSession }>(`/api/sessions/${sessionId}`);
      setSession(result.data);
      setActiveFrameId(result.data.frames.at(-1)?.id ?? null);
      localStorage.setItem(LAST_SESSION_KEY, sessionId);
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : '读取会话失败');
    } finally {
      setOpeningSessionId(null);
    }
  };

  /** 启动时恢复最近一次会话：优先 localStorage 记录，其次服务端最新会话 */
  const restoreLatestSession = async () => {
    setSessionLoading(true);
    setSessionError('');
    try {
      const list = await apiJson<{ data: CaptureSessionSummary[] }>('/api/sessions');
      setSessionsList(list.data);
      const savedId = localStorage.getItem(LAST_SESSION_KEY);
      const target = list.data.find((item) => item.id === savedId) ?? list.data[0] ?? null;
      if (target) {
        const detail = await apiJson<{ data: CaptureSession }>(`/api/sessions/${target.id}`);
        setSession(detail.data);
        setActiveFrameId(detail.data.frames.at(-1)?.id ?? null);
        localStorage.setItem(LAST_SESSION_KEY, target.id);
        setTab('session');
      }
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : '恢复最近会话失败');
    } finally {
      setSessionLoading(false);
    }
  };

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    // 会话恢复与默认模拟包加载互不阻塞
    void Promise.allSettled([restoreLatestSession(), loadSample('HTTP', 'request')]);
  }, []);

  const changeProtocol = (nextProtocol: Protocol) => {
    const nextScenario = nextProtocol === 'TCP' && scenario === 'response' ? 'handshake' : scenario;
    setProtocol(nextProtocol);
    setScenario(nextScenario);
    void loadSample(nextProtocol, nextScenario);
  };

  const changeScenario = (nextScenario: PacketScenario) => {
    setScenario(nextScenario);
    void loadSample(protocol, nextScenario);
  };

  // —— 把当前解析结果作为不可变帧加入会话（无会话时先创建） ——
  const captureFrame = async () => {
    if (!packet || captureState === 'submitting') return;
    setCaptureError('');
    if (duplicateOfLast) return; // 内容与最新一帧相同，不重复提交
    setCaptureState('submitting');
    const payload = { protocol, scenario, raw: rawInput };
    try {
      if (!session) {
        const result = await apiJson<{ data: CaptureSession }>('/api/sessions', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        setSession(result.data);
        setActiveFrameId(result.data.frames.at(-1)?.id ?? null);
        localStorage.setItem(LAST_SESSION_KEY, result.data.id);
      } else {
        const result = await apiJson<{ data: CaptureFrame }>(`/api/sessions/${session.id}/frames`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const next: CaptureSession = {
          ...session,
          frames: [...session.frames, result.data],
          frameCount: session.frames.length + 1,
          lastSummary: result.data.packet.summary,
          updatedAt: result.data.capturedAt
        };
        setSession(next);
        setActiveFrameId(result.data.id);
      }
      void refreshSessionList();
      setTab('session');
    } catch (cause) {
      setCaptureError(cause instanceof Error ? cause.message : '加入捕获会话失败');
    } finally {
      setCaptureState('idle');
    }
  };

  const handleNoteSaved = (frame: CaptureFrame) => {
    setSession((current) => {
      if (!current) return current;
      return {
        ...current,
        frames: current.frames.map((item) => (item.id === frame.id ? frame : item)),
        updatedAt: new Date().toISOString()
      };
    });
    void refreshSessionList();
  };

  const deleteFrame = async (frame: CaptureFrame) => {
    if (!session || deletingFrameId) return;
    if (!window.confirm(`确定删除第 ${session.frames.findIndex((item) => item.id === frame.id) + 1} 帧吗？此操作不可撤销。`)) return;
    setDeletingFrameId(frame.id);
    setSessionError('');
    try {
      const result = await apiJson<{ data: CaptureSession }>(
        `/api/sessions/${session.id}/frames/${frame.id}`,
        { method: 'DELETE' }
      );
      const remaining = result.data.frames;
      if (frame.id === activeFrameId && remaining.length > 0) {
        // 删除的是中间帧时定位同位置的下一帧；删除的是末帧则回退到新的末帧
        const deletedIndex = session.frames.findIndex((item) => item.id === frame.id);
        setActiveFrameId(remaining[Math.min(deletedIndex, remaining.length - 1)].id);
      }
      setSession(result.data);
      void refreshSessionList();
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : '删除帧失败');
    } finally {
      setDeletingFrameId(null);
    }
  };

  const deleteSession = async () => {
    if (!session || deletingSession) return;
    if (!window.confirm(`确定删除整个会话「${session.title}」及其 ${session.frames.length} 帧吗？此操作不可撤销。`)) return;
    setDeletingSession(true);
    setSessionError('');
    try {
      await apiJson<undefined>(`/api/sessions/${session.id}`, { method: 'DELETE' });
      if (localStorage.getItem(LAST_SESSION_KEY) === session.id) localStorage.removeItem(LAST_SESSION_KEY);
      setSession(null);
      setActiveFrameId(null);
      await refreshSessionList();
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : '删除会话失败');
    } finally {
      setDeletingSession(false);
    }
  };

  /** “新建会话”只是进入空白草稿态：下一帧捕获时才真正在服务端创建 */
  const startNewSession = () => {
    setSession(null);
    setActiveFrameId(null);
    setSessionError('');
    localStorage.removeItem(LAST_SESSION_KEY);
    setTab('inspector');
  };

  const loadFrameToInspector = (frame: CaptureFrame) => {
    setProtocol(frame.protocol);
    setScenario(frame.scenario);
    setRawInput(frame.raw);
    setPacket(frame.packet);
    setInspectorError('');
    setTab('inspector');
  };

  const captureDisabled = inspectorLoading || captureState === 'submitting' || !packet || duplicateOfLast;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /> <span /> <span /></div>
          <div>
            <p className="eyebrow">PROJECT 10 / PACKET OBSERVATORY</p>
            <h1>网络协议数据包可视化实验室</h1>
          </div>
        </div>
        <div className="connection-status"><i /> API ONLINE <span>localhost:3001</span></div>
      </header>

      <main className="dashboard">
        <section className="hero-copy">
          <div>
            <p className="section-kicker">解析工作台 · INSPECTOR</p>
            <h2>把每一个字节，<em>还原成可读的网络故事。</em></h2>
            <p className="hero-subtitle">选择协议和场景，载入模拟流量；把复核需要的解析结果捕获成不可变帧，在会话中和同伴逐帧对照。</p>
          </div>
          <div className="hero-stat"><strong>{session?.frames.length ?? 0}</strong><span>FRAMES<br />ACTIVE SESSION</span></div>
        </section>

        <nav className="workspace-switch" aria-label="工作区切换">
          <button className={tab === 'inspector' ? 'active' : ''} onClick={() => setTab('inspector')}>
            <span className="ws-icon">⚡</span> 解析工作台
          </button>
          <button className={tab === 'session' ? 'active' : ''} onClick={() => setTab('session')}>
            <span className="ws-icon">◉</span> 捕获会话
            {session && <span className="ws-count">{session.frames.length}</span>}
          </button>
        </nav>

        {tab === 'inspector' && (
          <>
            <section className="control-panel panel">
              <div className="control-group">
                <label>协议 <span>PROTOCOL</span></label>
                <div className="segmented-control">
                  {(['HTTP', 'TCP'] as Protocol[]).map((item) => (
                    <button key={item} className={protocol === item ? 'active' : ''} onClick={() => changeProtocol(item)}>{item}</button>
                  ))}
                </div>
              </div>
              <div className="control-group scenario-control">
                <label>模拟场景 <span>SCENARIO</span></label>
                <select value={scenario} onChange={(event) => changeScenario(event.target.value as PacketScenario)}>
                  {availableScenarios.map((item) => <option key={item} value={item}>{scenarioLabels[item]}</option>)}
                </select>
              </div>
              <div className="control-actions">
                <button className="button ghost" onClick={() => void loadSample()} disabled={inspectorLoading}>↻ 载入模拟包</button>
                <button className="button primary" onClick={() => void parsePacket()} disabled={inspectorLoading || !rawInput.trim()}>{inspectorLoading ? '处理中…' : '解析数据包 →'}</button>
                <button
                  className="button capture"
                  onClick={() => void captureFrame()}
                  disabled={captureDisabled}
                  title={duplicateOfLast ? '当前结果与最新一帧相同' : undefined}
                >
                  {captureState === 'submitting' ? '加入中…' : session ? `◉ 加入会话 (${session.frames.length})` : '◉ 新建捕获会话'}
                </button>
              </div>
            </section>

            {captureError && <div className="error-banner">⚠ 捕获失败：{captureError} <button onClick={() => setCaptureError('')}>关闭</button></div>}
            {duplicateOfLast && !captureError && (
              <div className="info-banner">ⓘ 当前原始输入、协议和场景与会话中最新一帧完全相同，未重复加入；如需新帧请先修改输入。</div>
            )}
            {session && !duplicateOfLast && (
              <div className="info-banner subtle">下一帧将加入「{session.title}」；没有会话时将自动创建并在刷新后恢复。</div>
            )}
            {inspectorError && <div className="error-banner">⚠ {inspectorError} <button onClick={() => setInspectorError('')}>关闭</button></div>}

            <section className="workspace-grid">
              <div className="left-column">
                <div className="panel packet-input-panel">
                  <div className="panel-heading"><div><p className="section-kicker">01 / INPUT STREAM</p><h3>数据包输入</h3></div><span className="badge">{protocol}</span></div>
                  <textarea value={rawInput} onChange={(event) => setRawInput(event.target.value)} spellCheck={false} aria-label="原始数据包输入" />
                  <div className="input-footer"><span>{rawInput.length} chars · editable payload</span><button onClick={() => setRawInput('')}>清空输入</button></div>
                </div>
                <div className="panel timeline-panel">
                  <div className="panel-heading"><div><p className="section-kicker">02 / EVENT TRACE</p><h3>传输时间线</h3></div><span className="trace-id">{packet?.id ?? 'WAITING'}</span></div>
                  <Timeline events={packet?.timeline ?? []} />
                </div>
              </div>

              <div className="right-column">
                <div className="panel packet-summary">
                  <div className="summary-top"><div><p className="section-kicker">ACTIVE FRAME</p><h3>{packet?.summary ?? '等待数据包'}</h3></div><div className="live-chip"><i /> DECODED</div></div>
                  <div className="metadata-grid">
                    <Meta label="SOURCE" value={packet?.metadata.source ?? '—'} />
                    <Meta label="DESTINATION" value={packet?.metadata.destination ?? '—'} />
                    <Meta label="CAPTURED AT" value={packet?.metadata.capturedAt ?? '—'} />
                    <Meta label="CHECKSUM" value={packet?.metadata.checksum ?? '—'} />
                  </div>
                </div>

                <div className="panel details-panel">
                  <div className="tabs"><button className={activeView === 'overview' ? 'selected' : ''} onClick={() => setActiveView('overview')}>协议字段树</button><button className={activeView === 'hex' ? 'selected' : ''} onClick={() => setActiveView('hex')}>十六进制视图</button></div>
                  {activeView === 'overview' ? <FieldTree fields={packet?.fields ?? []} /> : <HexView rows={packet?.hex ?? []} />}
                </div>
              </div>
            </section>
          </>
        )}

        {tab === 'session' && (
          <section className="session-workspace">
            {sessionLoading ? (
              <div className="panel session-state-panel">
                <Spinner label="正在恢复最近一次捕获会话…" />
              </div>
            ) : sessionError && !session ? (
              <div className="panel session-state-panel">
                <div className="state-block">
                  <p className="state-icon">⚠</p>
                  <h3>会话加载失败</h3>
                  <p className="state-text">{sessionError}</p>
                  <div className="state-actions">
                    <button className="button primary" onClick={() => void restoreLatestSession()}>重试</button>
                    <button className="button ghost" onClick={startNewSession}>回到空白工作台</button>
                  </div>
                </div>
              </div>
            ) : !session ? (
              <div className="panel session-state-panel">
                <div className="state-block">
                  <p className="state-icon">◉</p>
                  <h3>还没有捕获会话</h3>
                  <p className="state-text">在解析工作台点击「新建捕获会话」，当前原始输入、协议、场景、字段树、十六进制行和时间线就会组成第一帧。</p>
                  <div className="state-actions">
                    <button className="button primary" onClick={() => setTab('inspector')}>去解析数据包 →</button>
                    {sessionsList.length > 0 && (
                      <select className="session-recover-select" value="" onChange={(event) => event.target.value && void openSession(event.target.value)}>
                        <option value="">或打开历史会话…</option>
                        {sessionsList.map((item) => (
                          <option key={item.id} value={item.id}>{item.title}（{item.frameCount} 帧）</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <>
                {sessionError && <div className="error-banner">⚠ {sessionError} <button onClick={() => setSessionError('')}>关闭</button></div>}
                <div className="session-grid">
                  <aside className="panel session-rail">
                    <div className="session-rail-head">
                      <p className="section-kicker">CAPTURE SESSION</p>
                      <h3 title={session.title}>{session.title}</h3>
                      <p className="session-meta-line">
                        {session.frames.length} 帧 · 更新于 {formatTime(session.updatedAt)}
                      </p>
                    </div>

                    <div className="session-toolbar">
                      <select
                        className="session-switch-select"
                        value={session.id}
                        onChange={(event) => event.target.value !== session.id && void openSession(event.target.value)}
                        disabled={openingSessionId !== null || sessionsList.length === 0}
                      >
                        {sessionsList.length === 0 && <option value={session.id}>{session.title}</option>}
                        {sessionsList.map((item) => (
                          <option key={item.id} value={item.id}>{item.title}（{item.frameCount} 帧）</option>
                        ))}
                      </select>
                      <button className="tool-button" onClick={startNewSession} title="清空当前选择，下一帧将创建为新会话">＋ 新建</button>
                      <button className="tool-button danger" onClick={() => void deleteSession()} disabled={deletingSession} title="删除整个会话">
                        {deletingSession ? '删除中…' : '删除'}
                      </button>
                    </div>

                    <div className="frame-list">
                      {openingSessionId && <div className="frame-list-loading"><Spinner small label="打开中…" /></div>}
                      {session.frames.length === 0 && (
                        <div className="empty-state">会话中没有帧。<br />回到解析工作台捕获第一帧。</div>
                      )}
                      {session.frames.map((frame, index) => (
                        <div
                          key={frame.id}
                          role="button"
                          tabIndex={0}
                          className={`frame-item ${frame.id === activeFrameId ? 'active' : ''} ${deletingFrameId === frame.id ? 'busy' : ''}`}
                          onClick={() => setActiveFrameId(frame.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setActiveFrameId(frame.id);
                            }
                          }}
                          aria-current={frame.id === activeFrameId}
                        >
                          <span className="frame-index">{String(index + 1).padStart(2, '0')}</span>
                          <span className="frame-item-body">
                            <span className="frame-item-top">
                              <span className={`proto-chip ${frame.protocol.toLowerCase()}`}>{frame.protocol}</span>
                              <span className="frame-scenario">{scenarioLabels[frame.scenario]}</span>
                            </span>
                            <span className="frame-summary" title={frame.packet.summary}>{frame.packet.summary}</span>
                            {frame.note && <span className="frame-note-excerpt">📝 {frame.note}</span>}
                            <span className="frame-time">{formatTime(frame.capturedAt)}</span>
                          </span>
                          <button
                            type="button"
                            aria-label="删除该帧"
                            className="frame-delete"
                            disabled={deletingFrameId !== null}
                            onClick={(event) => {
                              event.stopPropagation();
                              void deleteFrame(frame);
                            }}
                          >×</button>
                        </div>
                      ))}
                    </div>

                    <button className="button ghost capture-more" onClick={() => setTab('inspector')}>＋ 到工作台继续捕获</button>
                  </aside>

                  <div className="session-main">
                    {activeFrame ? (
                      <FrameDetail
                        key={activeFrame.id}
                        frame={activeFrame}
                        frameIndex={session.frames.findIndex((item) => item.id === activeFrame.id) + 1}
                        sessionId={session.id}
                        onNoteSaved={handleNoteSaved}
                        onNoteError={setSessionError}
                        onLoadToInspector={loadFrameToInspector}
                      />
                    ) : (
                      <div className="panel session-state-panel">
                        <div className="state-block">
                          <p className="state-icon">▦</p>
                          <h3>这是一个空会话</h3>
                          <p className="state-text">所有帧都已删除。帧本身不可修改，但你可以随时捕获新的帧。</p>
                          <div className="state-actions"><button className="button primary" onClick={() => setTab('inspector')}>去捕获新帧 →</button></div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
        )}
      </main>
      <footer className="footer"><span>PACKET LAB / EDUCATIONAL SIMULATOR</span><span>React + Vite + TypeScript · Express API · 会话持久化于服务端</span></footer>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="meta-item"><span>{label}</span><strong>{value}</strong></div>;
}

function Spinner({ label, small }: { label?: string; small?: boolean }) {
  return (
    <div className={`spinner-wrap ${small ? 'small' : ''}`}>
      <span className="spinner" aria-hidden="true" />
      {label && <span className="spinner-label">{label}</span>}
    </div>
  );
}

function FrameDetail({
  frame,
  frameIndex,
  sessionId,
  onNoteSaved,
  onNoteError,
  onLoadToInspector
}: {
  frame: CaptureFrame;
  frameIndex: number;
  sessionId: string;
  onNoteSaved: (frame: CaptureFrame) => void;
  onNoteError: (message: string) => void;
  onLoadToInspector: (frame: CaptureFrame) => void;
}) {
  const [view, setView] = useState<'overview' | 'hex'>('overview');
  const packet = frame.packet;

  return (
    <>
      <div className="panel packet-summary">
        <div className="summary-top">
          <div>
            <p className="section-kicker">FRAME #{String(frameIndex).padStart(2, '0')} · IMMUTABLE SNAPSHOT</p>
            <h3>{packet.summary}</h3>
          </div>
          <div className="frame-badges">
            <span className={`proto-chip ${frame.protocol.toLowerCase()}`}>{frame.protocol}</span>
            <span className="live-chip"><i /> CAPTURED {formatTime(frame.capturedAt)}</span>
          </div>
        </div>
        <div className="metadata-grid">
          <Meta label="SOURCE" value={packet.metadata.source} />
          <Meta label="DESTINATION" value={packet.metadata.destination} />
          <Meta label="CAPTURED AT" value={packet.metadata.capturedAt} />
          <Meta label="CHECKSUM" value={packet.metadata.checksum} />
        </div>
      </div>

      <div className="panel note-panel">
        <div className="panel-heading compact">
          <div><p className="section-kicker">REVIEW NOTE · 同伴复核备注</p><h3>帧备注</h3></div>
        </div>
        <NoteEditor frame={frame} sessionId={sessionId} onSaved={onNoteSaved} onError={onNoteError} />
      </div>

      <div className="panel details-panel">
        <div className="tabs">
          <button className={view === 'overview' ? 'selected' : ''} onClick={() => setView('overview')}>协议字段树</button>
          <button className={view === 'hex' ? 'selected' : ''} onClick={() => setView('hex')}>十六进制视图</button>
          <button className="load-to-inspector" onClick={() => onLoadToInspector(frame)}>↗ 载入工作台继续编辑</button>
        </div>
        {view === 'overview' ? <FieldTree fields={packet.fields} /> : <HexView rows={packet.hex} />}
      </div>

      <div className="panel">
        <div className="panel-heading compact"><div><p className="section-kicker">SNAPSHOT INPUT · 帧生成时的原始输入</p><h3>原始输入（只读）</h3></div><span className="badge">{frame.scenario}</span></div>
        <textarea className="readonly-input" value={frame.raw} readOnly spellCheck={false} aria-label="帧的原始输入快照" />
      </div>

      <div className="panel timeline-panel">
        <div className="panel-heading"><div><p className="section-kicker">EVENT TRACE · 捕获时的解析时间线</p><h3>传输时间线</h3></div><span className="trace-id">{packet.id}</span></div>
        <Timeline events={packet.timeline} />
      </div>
    </>
  );
}

function NoteEditor({
  frame,
  sessionId,
  onSaved,
  onError
}: {
  frame: CaptureFrame;
  sessionId: string;
  onSaved: (frame: CaptureFrame) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(frame.note);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const dirty = draft !== frame.note;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      const result = await apiJson<{ data: CaptureFrame }>(
        `/api/sessions/${sessionId}/frames/${frame.id}`,
        { method: 'PATCH', body: JSON.stringify({ note: draft }) }
      );
      onSaved(result.data);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
    } catch (cause) {
      onError(cause instanceof Error ? `备注保存失败：${cause.message}` : '备注保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="note-editor">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={500}
        placeholder="给同伴写几句：这帧哪里可疑、结论是什么……（保存后随会话持久化）"
        spellCheck={false}
        aria-label="帧备注"
      />
      <div className="note-footer">
        <span className={`note-status ${saving ? 'saving' : savedFlash ? 'saved' : ''}`}>
          {saving ? '保存中…' : savedFlash ? '✓ 已保存' : dirty ? '有未保存的修改' : '帧内容不可变，仅备注可编辑'}
        </span>
        <span className="note-count">{draft.length}/500</span>
        <button className="button primary small" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? '保存中…' : '保存备注'}
        </button>
      </div>
    </div>
  );
}

function FieldTree({ fields }: { fields: ProtocolField[] }) {
  if (!fields.length) return <div className="empty-state">解析后将在这里显示协议层级字段。</div>;
  return <div className="field-tree">{fields.map((field) => <FieldNode key={field.id} field={field} depth={0} />)}</div>;
}

function FieldNode({ field, depth }: { field: ProtocolField; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = Boolean(field.children?.length);
  return <div className="field-node" style={{ '--depth': depth } as CSSProperties}>
    <div className="field-row" onClick={() => hasChildren && setExpanded((value) => !value)}>
      <span className={`chevron ${hasChildren ? '' : 'invisible'} ${expanded ? 'open' : ''}`}>⌄</span>
      <span className="field-key">{field.key}</span>
      <span className="field-value">{field.value}</span>
      <span className="field-description">{field.description}</span>
    </div>
    {hasChildren && expanded && <div className="field-children">{field.children!.map((child) => <FieldNode key={child.id} field={child} depth={depth + 1} />)}</div>}
  </div>;
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <div className="empty-state">还没有事件记录。</div>;
  return <div className="timeline">{events.map((event, index) => <div className="timeline-event" key={event.id}><div className="timeline-marker"><span>{String(index + 1).padStart(2, '0')}</span></div><div className="timeline-content"><div><strong>{event.label}</strong><time>{event.timestamp}</time></div><p>{event.detail}</p><span className={`phase phase-${event.phase}`}>{event.phase}</span></div></div>)}</div>;
}

function HexView({ rows }: { rows: SimulatedPacket['hex'] }) {
  if (!rows.length) return <div className="empty-state">没有可显示的十六进制内容。</div>;
  return <div className="hex-view"><div className="hex-header"><span>OFFSET</span><span>HEX BYTES</span><span>ASCII</span></div>{rows.map((row) => <div className="hex-row" key={row.offset}><code>{row.offset}</code><code>{row.bytes.join(' ')}</code><code className="ascii">{row.ascii}</code></div>)}</div>;
}

export default App;
