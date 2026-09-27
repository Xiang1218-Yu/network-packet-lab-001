export type Protocol = 'HTTP' | 'TCP';
export type PacketScenario = 'request' | 'response' | 'handshake';

export interface HexRow {
  offset: string;
  bytes: string[];
  ascii: string;
}

export interface ProtocolField {
  id: string;
  key: string;
  value: string;
  description: string;
  children?: ProtocolField[];
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  label: string;
  phase: 'ingress' | 'parse' | 'transport' | 'application' | 'egress';
  detail: string;
}

export interface SimulatedPacket {
  id: string;
  protocol: Protocol;
  scenario: PacketScenario;
  summary: string;
  raw: string;
  hex: HexRow[];
  fields: ProtocolField[];
  timeline: TimelineEvent[];
  metadata: {
    capturedAt: string;
    source: string;
    destination: string;
    length: number;
    checksum: string;
  };
}

export interface ParseRequest {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
}

/** 捕获会话中的一个不可变帧：一次解析结果的完整快照 */
export interface CaptureFrame {
  id: string;
  /** 加入会话的时间（ISO 字符串） */
  capturedAt: string;
  /** 简短备注，可编辑；帧的其余字段不可变 */
  note: string;
  protocol: Protocol;
  scenario: PacketScenario;
  /** 快照时的原始输入 */
  raw: string;
  /** 解析得到的数据包（字段树、十六进制行、时间线等） */
  packet: SimulatedPacket;
}

export interface CaptureSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  frameCount: number;
  /** 最近一帧的摘要，便于在列表中预览 */
  lastSummary: string | null;
}

export interface CaptureSession extends CaptureSessionSummary {
  frames: CaptureFrame[];
}

/** POST /api/sessions 与 POST /api/sessions/:id/frames 共用的帧输入 */
export interface CaptureFrameInput {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
  note?: string;
}

export interface CreateSessionBody extends CaptureFrameInput {
  title?: string;
}

export interface UpdateFrameBody {
  note?: string;
}
