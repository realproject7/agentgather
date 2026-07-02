export type ParticipantKind = "agent" | "human" | "system";
export type ParticipantLocation = "local" | "remote";
export type ParticipantInstall = "lite" | "core" | "host";
export type ParticipantAttention = "manual" | "attending" | "standby" | "away" | "managed";
// Wake-on-event attention modes (V2 9A), most → least capable. See protocol/attention.ts.
export type AttentionMode = "foreground_attended" | "wake_on_event" | "heartbeat" | "manual";
export type RoomStatus = "open" | "closed";
export type AttendancePolicy = "manual-ok" | "agents-foreground" | "all-foreground" | "host-directed";
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

// Active chat session (V2 T11): a channel-wide bounded live-chat event on a chat
// channel (#general in this version). The host starts it with an expected
// duration and a requested attendance policy; it ends explicitly or on room
// close. Idle (no active_session) is the default state — this is an event, not a
// permanent channel state machine. expected_duration_m is advisory metadata; the
// server does NOT auto-end on it. ended_at is set on the end response; an
// ended/closed session is cleared from RoomState so /status returns to idle.
export interface ActiveSession {
  channel_id: string;
  started_at: string;
  expected_duration_m: number;
  requested_mode?: AttendancePolicy;
  started_by: string;
  ended_at?: string;
}

export interface RoomState {
  id: string;
  status: RoomStatus;
  attendance_policy: AttendancePolicy;
  createdAt: string;
  updatedAt: string;
  expires_at?: string;
  next_message_id: number;
  brief_version: number;
  brief_updated_at: string;
  brief_updated_by: string;
  // T11: the single active chat session for this room, when one is running.
  // Absent when idle; cleared on end and on room close.
  active_session?: ActiveSession;
}

export interface Participant {
  alias: string;
  display_name?: string;
  kind: ParticipantKind;
  location: ParticipantLocation;
  install: ParticipantInstall;
  attention: ParticipantAttention;
  is_host: boolean;
  token_hash?: string;
  removed_at?: string;
  joinedAt: string;
  lastSeenAt: string;
  // Wake-on-event attention protocol (V2 9A). All optional/additive: legacy
  // participants without these negotiate to "manual". supported_modes is what
  // the participant declares; requested_mode is what the host asks for;
  // effective_mode is the server-negotiated result. poll_cadence_s is an
  // advisory check interval (NOT a model-invocation cadence); safety_wake_s
  // bounds silence before one safety wake.
  supported_modes?: AttentionMode[];
  requested_mode?: AttentionMode;
  effective_mode?: AttentionMode;
  poll_cadence_s?: number;
  safety_wake_s?: number;
  // Forum review task (V2 T10): the forum channel this agent was invited to
  // review/respond on. Drives the Attend Card's forum-review section.
  forum_review_channel?: string;
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
