import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  PacketScenario,
  ParseRequest,
  Protocol,
  SimulatedPacket
} from '../../../shared/types';
import { FieldTree, HexView, Meta, Timeline } from './viewers';

const scenarioLabels: Record<PacketScenario, string> = {
  request: '请求 / Request',
  response: '响应 / Response',
  handshake: '握手 / Handshake'
};

interface InspectorProps {
  capturing: boolean;
  hasSession: boolean;
  duplicate: boolean;
  onPacketChange: (packet: SimulatedPacket | null) => void;
  onCapture: (packet: SimulatedPacket) => void;
  onCreateSession: () => void;
  onOpenSession: () => void;
}

export function Inspector({ capturing, hasSession, duplicate, onPacketChange, onCapture, onCreateSession, onOpenSession }: InspectorProps) {
  const [protocol, setProtocol] = useState<Protocol>('HTTP');
  const [scenario, setScenario] = useState<PacketScenario>('request');
  const [rawInput, setRawInput] = useState('');
  const [packet, setPacket] = useState<SimulatedPacket | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState<'overview' | 'hex'>('overview');

  const availableScenarios = useMemo<PacketScenario[]>(
    () => (protocol === 'TCP' ? ['handshake', 'request', 'response'] : ['request', 'response']),
    [protocol]
  );

  const loadSample = async (nextProtocol = protocol, nextScenario = scenario) => {
    setLoading(true);
    setError('');
    try {
      const data = await api.simulate(nextProtocol, nextScenario);
      setPacket(data);
      setRawInput(data.raw);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '加载模拟数据失败');
    } finally {
      setLoading(false);
    }
  };

  const parsePacket = async () => {
    // 解析进行中直接忽略点击，避免同一输入被重复提交
    if (loading) return;
    setLoading(true);
    setError('');
    const body: ParseRequest = { protocol, scenario, raw: rawInput };
    try {
      const data = await api.parse(body);
      setPacket(data);
      setRawInput(data.raw);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '解析数据包失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSample('HTTP', 'request');
    // 仅在挂载时载入初始示例
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 把当前解析结果同步给父级，用于“重复帧”提示与捕获
  useEffect(() => {
    onPacketChange(packet);
  }, [packet, onPacketChange]);

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

  const captureDisabled = loading || capturing || !packet;

  return (
    <>
      <section className="hero-copy">
        <div>
          <p className="section-kicker">解析工作台 · INSPECTOR</p>
          <h2>把每一个字节，<em>还原成可读的网络故事。</em></h2>
          <p className="hero-subtitle">选择协议和场景，载入模拟流量，逐层查看字段、时间线与十六进制原始数据；解析完成后可把结果作为不可变帧加入捕获会话。</p>
        </div>
        <div className="hero-stat"><strong>{packet?.metadata.length ?? '—'}</strong><span>BYTES<br />CURRENT FRAME</span></div>
      </section>

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
          <button className="button ghost" onClick={() => void loadSample()} disabled={loading}>↻ 载入模拟包</button>
          <button className="button primary" onClick={() => void parsePacket()} disabled={loading || !rawInput.trim()}>{loading ? '处理中…' : '解析数据包 →'}</button>
          <button
            className="button capture"
            onClick={() => packet && onCapture(packet)}
            disabled={captureDisabled}
            title={duplicate ? '该结果已存在于当前会话，仍可再次加入' : '把当前解析结果作为不可变帧加入捕获会话'}
          >
            {capturing ? '加入中…' : duplicate ? '↧ 再次加入会话' : '↧ 加入捕获会话'}
          </button>
        </div>
      </section>

      {duplicate && (
        <div className="warning-banner">
          ⓘ 当前协议、场景和原始输入与会话中已有帧完全一致。帧是不可变快照，同伴复核时保留多次捕获也有价值——仍可再次加入。
          {!hasSession && <button className="button ghost inline" onClick={onCreateSession}>新建空会话</button>}
          {hasSession && <button className="button ghost inline" onClick={onOpenSession}>查看会话</button>}
        </div>
      )}
      {error && <div className="error-banner">⚠ {error} <button onClick={() => setError('')}>关闭</button></div>}

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
  );
}
