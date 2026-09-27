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

/** 加入捕获会话时提交的内容：原始输入 + 协议/场景，解析结果由服务端生成 */
export interface CaptureFrameInput {
  protocol: Protocol;
  scenario: PacketScenario;
  raw: string;
  note?: string;
}

/** 不可变帧：解析快照一旦生成不再变化，只有备注可单独修改 */
export interface CaptureFrame {
  id: string;
  protocol: Protocol;
  scenario: PacketScenario;
  note: string;
  addedAt: string;
  packet: SimulatedPacket;
}

export interface CaptureSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  frames: CaptureFrame[];
}

export interface CreateSessionRequest {
  title?: string;
  /** 创建会话的同时追加第一帧，避免前端连发两次请求 */
  frame?: CaptureFrameInput;
}

export type AppendFrameRequest = CaptureFrameInput;

export interface UpdateNoteRequest {
  note: string;
}
