export type ParticipantKind = "agent" | "human" | "system";
export type ParticipantLocation = "local" | "remote";
export type ParticipantInstall = "lite" | "core" | "host";
export type ParticipantAttention = "manual" | "attending" | "away";
export type RoomStatus = "open" | "closed";
export type MessageType =
  | "message"
  | "question"
  | "reply"
  | "status"
  | "request_review"
  | "request_debug"
  | "handoff"
  | "system";
export type ClientMessageType = Exclude<MessageType, "system">;

export interface RoomBrief {
  body: string;
  brief_version: number;
  brief_updated_at: string;
  brief_updated_by: string;
}

export interface RoomState {
  id: string;
  status: RoomStatus;
  createdAt: string;
  updatedAt: string;
  expires_at?: string;
  next_message_id: number;
  brief_version: number;
  brief_updated_at: string;
  brief_updated_by: string;
}

export interface Participant {
  alias: string;
  kind: ParticipantKind;
  location: ParticipantLocation;
  install: ParticipantInstall;
  attention: ParticipantAttention;
  is_host: boolean;
  token_hash?: string;
  removed_at?: string;
  joinedAt: string;
  lastSeenAt: string;
}

export interface Invite {
  room: string;
  alias: string;
  token: string;
  expiresAt: string;
  singleUse: boolean;
}

export interface ClientMessageInput {
  text: string;
  type?: ClientMessageType;
  reply_to?: number;
  client_msg_id?: string;
}

export interface Message {
  id: number;
  room: string;
  ts: string;
  from: string;
  type: MessageType;
  text: string;
  reply_to?: number;
  client_msg_id?: string;
  mentions: string[];
}

export interface WaitResponse {
  ok: true;
  room: string;
  room_status: RoomStatus;
  participant: string;
  heartbeat: boolean;
  messages: Message[];
  mentioned: boolean;
  next_since_id: number;
  keep_waiting: boolean;
  next_cmd: string | null;
}

export interface ProtocolError {
  ok: false;
  error: string;
  message: string;
}
