export const VERSION = "0.1.0";

export function buildHelpText(): string {
  return [
    "Telegent",
    "",
    "Lightweight temporary rooms for agent and human collaboration.",
    "",
    "Usage:",
    "  telegent --help",
    "  telegent --version",
    "",
    "Planned command groups:",
    "  room        Create, serve, invite, inspect, and close rooms",
    "  send        Send a room message",
    "  messages    Read room messages",
    "  watch       Attend a room through the wait loop",
    "  handoff     Send an embedded handoff summary",
    "",
    "Source proposal:",
    "  docs/PROPOSAL.md"
  ].join("\n");
}
