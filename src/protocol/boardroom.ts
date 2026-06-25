// V2 Boardroom data model (#140 / T3).
//
// A boardroom contains one or more channels. The existing single-room mechanics
// are preserved unchanged: a legacy bare room is treated *at runtime* as a
// boardroom with a single default `#general` chat channel — no data migration,
// nothing new is written for it. This module is the vocabulary + pure
// projections; host-owned files remain the single source of truth and no
// message bodies or raw tokens live in this model.
import type { Participant } from "./types.js";
import { assertSafeSlug } from "./validation.js";

export type ChannelType = "chat" | "forum";
export type ChannelLifecycle = "active" | "idle" | "inactive" | "removed";
export type HistorySource = "live-host" | "local-cache" | "exported-summary" | "offline-empty";
export type ParticipantRole = "human" | "agent";

export const CHANNEL_TYPES: readonly ChannelType[] = ["chat", "forum"];
export const CHANNEL_LIFECYCLES: readonly ChannelLifecycle[] = ["active", "idle", "inactive", "removed"];
export const HISTORY_SOURCES: readonly HistorySource[] = [
  "live-host",
  "local-cache",
  "exported-summary",
  "offline-empty"
];
export const PARTICIPANT_ROLES: readonly ParticipantRole[] = ["human", "agent"];

// The default chat channel a legacy bare room maps to.
export const DEFAULT_CHANNEL_ID = "general";
export const DEFAULT_CHANNEL_NAME = "general";

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  lifecycle: ChannelLifecycle;
  createdAt: string;
}

export interface Boardroom {
  id: string;
  name?: string;
  channels: Channel[];
  lifecycle: ChannelLifecycle;
  createdAt: string;
  updatedAt: string;
  // true when this is a runtime projection of a legacy bare room (not persisted).
  legacy: boolean;
}

// Runtime identity projection of a participant. Humans and agents are modelled
// separately via `role`. The reconnect / name-ownership marker is the presence
// of a token *hash* (`nameOwnerHash`) — never a raw invite token or URL.
export interface ParticipantIdentity {
  participantId: string;
  displayName: string;
  role: ParticipantRole;
  isHost: boolean;
  reconnectable: boolean;
  nameOwnerHash?: string;
}

// Per-participant, per-channel read position. Separated from message bodies so a
// later `unread` API can diff cursors against channel history without loading it.
export interface ChannelReadCursor {
  participantId: string;
  channelId: string;
  sinceId: number;
  updatedAt: string;
}

export function roleFromKind(kind: Participant["kind"]): ParticipantRole {
  return kind === "human" ? "human" : "agent";
}

export function participantIdentity(participant: Participant): ParticipantIdentity {
  assertSafeSlug(participant.alias, "participant alias");
  const identity: ParticipantIdentity = {
    participantId: participant.alias,
    displayName: participant.display_name ?? participant.alias,
    role: roleFromKind(participant.kind),
    isHost: participant.is_host,
    reconnectable: participant.token_hash !== undefined
  };
  // token_hash is already a one-way hash, safe to surface as the ownership marker.
  if (participant.token_hash !== undefined) identity.nameOwnerHash = participant.token_hash;
  return identity;
}

export function defaultChannel(createdAt: string): Channel {
  return {
    id: DEFAULT_CHANNEL_ID,
    name: DEFAULT_CHANNEL_NAME,
    type: "chat",
    lifecycle: "active",
    createdAt
  };
}

// Project a legacy bare room into a boardroom with a single #general chat
// channel. Pure — no data is migrated or written.
export function deriveDefaultBoardroom(input: {
  id: string;
  createdAt: string;
  updatedAt: string;
  name?: string;
}): Boardroom {
  const boardroom: Boardroom = {
    id: input.id,
    channels: [defaultChannel(input.createdAt)],
    lifecycle: "active",
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    legacy: true
  };
  if (input.name !== undefined) boardroom.name = input.name;
  return boardroom;
}

export function assertValidChannel(channel: Channel): void {
  assertSafeSlug(channel.id, "channel id");
  if (!CHANNEL_TYPES.includes(channel.type)) {
    throw new Error(`channel type must be one of ${CHANNEL_TYPES.join(", ")}`);
  }
  if (!CHANNEL_LIFECYCLES.includes(channel.lifecycle)) {
    throw new Error(`channel lifecycle must be one of ${CHANNEL_LIFECYCLES.join(", ")}`);
  }
}

export function assertValidBoardroom(boardroom: Boardroom): void {
  assertSafeSlug(boardroom.id, "boardroom id");
  if (boardroom.channels.length === 0) throw new Error("boardroom must have at least one channel");
  const seen = new Set<string>();
  for (const channel of boardroom.channels) {
    assertValidChannel(channel);
    if (seen.has(channel.id)) throw new Error(`duplicate channel id: ${channel.id}`);
    seen.add(channel.id);
  }
  if (!CHANNEL_LIFECYCLES.includes(boardroom.lifecycle)) {
    throw new Error(`boardroom lifecycle must be one of ${CHANNEL_LIFECYCLES.join(", ")}`);
  }
}
