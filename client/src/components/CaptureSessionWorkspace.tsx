import { useEffect, useState } from 'react';
import type {
  CaptureFrame,
  PacketScenario,
  SimulatedPacket
} from '../../../shared/types';
import type { CaptureSessionApi } from '../useCaptureSession';
import { FieldTree, HexView, Meta, Timeline } from './viewers';

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求',
  response: '响应',
  handshake: '握手'
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

interface WorkspaceProps {
  sessionApi: CaptureSessionApi;
  onGoInspector: () => void;
  onRetryRestore: () => void;
}

interface SessionBodyProps {
  sessionApi: CaptureSessionApi;
  onGoInspector: () => void;
}

export function CaptureSessionWorkspace({ sessionApi, onGoInspector, onRetryRestore }: WorkspaceProps) {
  const { status, loadError } = sessionApi;

  return (
    <section className="session-workspace">
      <div className="session-heading-row">
        <div>
          <p className="section-kicker">捕获会话 · CAPTURE SESSION</p>
          <h2 className="session-title">把解析结果<em>钉在会话里</em>，交给同伴逐帧复核。</h2>
        </div>
      </div>

      {status === 'loading' && (
        <div className="panel session-state-panel">
          <span className="spinner" aria-hidden="true" />
          <p>正在恢复最近一次捕获会话…</p>
        </div>
      )}

      {status === 'error' && (
        <div className="panel session-state-panel session-error">
          <p>⚠ {loadError || '会话加载失败'}</p>
          <div className="session-state-actions">
            <button className="button ghost" onClick={onRetryRestore}>重试</button>
            <button className="button primary" onClick={onGoInspector}>返回解析工作台</button>
          </div>
        </div>
      )}

      {(status === 'idle' || status === 'ready') && (
        <SessionBody sessionApi={sessionApi} onGoInspector={onGoInspector} />
      )}
    </section>
  );
}

function SessionBody({ sessionApi, onGoInspector }: SessionBodyProps) {
  const {
    session, notice, actionError, capturing, frameBusyId, activeFrameId,
    selectFrame, saveNote, removeFrame, removeSession, createSession,
    clearActionError, clearNotice
  } = sessionApi;

  // 空会话：服务端没有任何会话
  if (!session) {
    return (
      <div className="panel session-state-panel session-empty">
        <div className="empty-icon">▦</div>
        <h3>还没有捕获会话</h3>
        <p>在解析工作台点击「加入捕获会话」，会自动创建会话并保存当前原始输入、协议、场景、字段树、十六进制行和时间线。</p>
        <div className="session-state-actions">
          <button className="button primary" onClick={onGoInspector}>去解析数据包 →</button>
          <button className="button ghost" disabled={capturing} onClick={() => void createSession()}>
            {capturing ? '创建中…' : '＋ 先建一个空会话'}
          </button>
        </div>
        {actionError && <div className="error-banner compact">⚠ {actionError} <button onClick={clearActionError}>关闭</button></div>}
        {notice && <div className="notice-banner compact">✓ {notice.text} <button onClick={clearNotice}>关闭</button></div>}
      </div>
    );
  }

  const activeFrame = session.frames.find((frame) => frame.id === activeFrameId) ?? null;

  return (
    <>
      {notice && <div className="notice-banner">✓ {notice.text} <button onClick={clearNotice}>关闭</button></div>}
      {actionError && <div className="error-banner">⚠ {actionError} <button onClick={clearActionError}>关闭</button></div>}

      <div className="session-toolbar panel">
        <div className="session-meta">
          <strong>{session.title}</strong>
          <span>{session.frames.length} 帧 · 创建于 {formatTime(session.createdAt)} · 最近更新 {formatTime(session.updatedAt)}</span>
          <code className="session-id">ID {session.id.slice(0, 8)}</code>
        </div>
        <div className="session-toolbar-actions">
          <button className="button ghost" onClick={onGoInspector}>＋ 捕获新帧</button>
          <button
            className="button danger"
            disabled={capturing}
            onClick={() => {
              if (window.confirm(`确定删除整个会话「${session.title}」吗？该操作不可恢复。`)) void removeSession();
            }}
          >
            {capturing ? '处理中…' : '删除整个会话'}
          </button>
        </div>
      </div>

      {session.frames.length === 0 ? (
        <div className="panel session-state-panel session-empty">
          <div className="empty-icon">◌</div>
          <h3>会话里还没有帧</h3>
          <p>会话已创建并会在重新打开页面后恢复。回到解析工作台，把第一个解析结果捕获进来。</p>
          <div className="session-state-actions">
            <button className="button primary" onClick={onGoInspector}>去捕获第一帧 →</button>
          </div>
        </div>
      ) : (
        <div className="session-grid">
          <FrameList
            frames={session.frames}
            activeFrameId={activeFrame?.id ?? null}
            busyId={frameBusyId}
            onSelect={selectFrame}
          />
          {activeFrame
            ? <FrameViewer key={activeFrame.id} frame={activeFrame} busy={frameBusyId === activeFrame.id} onSaveNote={saveNote} onRemoveFrame={removeFrame} />
            : <div className="panel session-state-panel">请选择左侧的帧进行查看。</div>}
        </div>
      )}
    </>
  );
}

function FrameList({ frames, activeFrameId, busyId, onSelect }: {
  frames: CaptureFrame[];
  activeFrameId: string | null;
  busyId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="panel frame-list">
      <div className="frame-list-heading"><p className="section-kicker">FRAMES · {String(frames.length).padStart(2, '0')}</p><span>不可变快照</span></div>
      <ol>
        {frames.map((frame, index) => (
          <li key={frame.id}>
            <button
              className={`frame-item ${frame.id === activeFrameId ? 'active' : ''}`}
              onClick={() => onSelect(frame.id)}
            >
              <span className="frame-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="frame-item-body">
                <strong>{frame.packet.summary}</strong>
                <span className="frame-item-meta">
                  <em className={`proto-badge proto-${frame.protocol.toLowerCase()}`}>{frame.protocol}</em>
                  {scenarioLabels[frame.scenario]} · {frame.packet.metadata.length}B · {formatTime(frame.addedAt)}
                </span>
                {frame.note && <span className="frame-note-preview">“{frame.note}”</span>}
              </span>
              {busyId === frame.id && <span className="mini-spinner" aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function FrameViewer({ frame, busy, onSaveNote, onRemoveFrame }: {
  frame: CaptureFrame;
  busy: boolean;
  onSaveNote: (frameId: string, note: string) => Promise<boolean>;
  onRemoveFrame: (frameId: string) => Promise<void>;
}) {
  const packet: SimulatedPacket = frame.packet;
  const [draft, setDraft] = useState(frame.note);
  const [savedTick, setSavedTick] = useState(false);
  const [activeView, setActiveView] = useState<'overview' | 'hex'>('overview');

  // 切换帧时（key 会重建组件，这里保留以应对同帧备注被外部更新）同步草稿
  useEffect(() => { setDraft(frame.note); }, [frame.note]);

  const dirty = draft !== frame.note;
  const canSave = !busy && dirty && draft.trim().length <= 500;

  const save = async () => {
    if (!canSave) return;
    const ok = await onSaveNote(frame.id, draft.trim());
    if (ok) {
      setSavedTick(true);
      window.setTimeout(() => setSavedTick(false), 1800);
    }
  };

  return (
    <div className="frame-viewer">
      <div className="panel packet-summary">
        <div className="summary-top">
          <div>
            <p className="section-kicker">FRAME {frame.id.slice(0, 8).toUpperCase()} · IMMUTABLE SNAPSHOT</p>
            <h3>{packet.summary}</h3>
          </div>
          <button
            className="button danger small"
            disabled={busy}
            onClick={() => {
              if (window.confirm('删除这一帧？其余帧和会话不会受到影响。')) void onRemoveFrame(frame.id);
            }}
          >
            {busy ? '处理中…' : '删除该帧'}
          </button>
        </div>
        <div className="metadata-grid">
          <Meta label="PROTOCOL" value={`${frame.protocol} · ${scenarioLabels[frame.scenario]}`} />
          <Meta label="SOURCE" value={packet.metadata.source} />
          <Meta label="CAPTURED AT" value={formatTime(frame.addedAt)} />
          <Meta label="CHECKSUM" value={packet.metadata.checksum} />
        </div>
      </div>

      <div className="panel note-panel">
        <div className="note-heading">
          <label htmlFor={`note-${frame.id}`}>复核备注 <span>REVIEW NOTE</span></label>
          <span className={`note-status ${savedTick ? 'ok' : ''}`}>
            {busy ? '保存中…' : savedTick ? '✓ 已保存' : dirty ? '有未保存的修改' : '已同步'}
          </span>
        </div>
        <textarea
          id={`note-${frame.id}`}
          className="note-input"
          value={draft}
          maxLength={500}
          placeholder="给同伴写一句简短备注，例如：这里的 Content-Length 和实际 body 差 2 字节。"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="note-footer">
          <span>{draft.length}/500</span>
          <div className="note-actions">
            <button className="button ghost small" disabled={!dirty || busy} onClick={() => setDraft(frame.note)}>撤销</button>
            <button className="button primary small" disabled={!canSave} onClick={() => void save()}>保存备注</button>
          </div>
        </div>
      </div>

      <div className="session-detail-grid">
        <div className="panel frame-raw-panel">
          <div className="panel-heading"><div><p className="section-kicker">CAPTURED INPUT</p><h3>原始输入</h3></div><span className="badge">{frame.protocol}</span></div>
          <pre className="raw-preview">{packet.raw}</pre>
        </div>
        <div className="panel timeline-panel">
          <div className="panel-heading"><div><p className="section-kicker">EVENT TRACE</p><h3>解析时间线</h3></div><span className="trace-id">{packet.id}</span></div>
          <Timeline events={packet.timeline} />
        </div>
      </div>

      <div className="panel details-panel">
        <div className="tabs">
          <button className={activeView === 'overview' ? 'selected' : ''} onClick={() => setActiveView('overview')}>协议字段树</button>
          <button className={activeView === 'hex' ? 'selected' : ''} onClick={() => setActiveView('hex')}>十六进制视图</button>
        </div>
        {activeView === 'overview' ? <FieldTree fields={packet.fields} /> : <HexView rows={packet.hex} />}
      </div>
    </div>
  );
}
