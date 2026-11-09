// The agent colour palette: Claude Code's names mapped to fixed 256-colour escapes (pi's theme only exposes its own
// named colours). `tint` wraps text; it resets only the foreground, so a surrounding background stays.

import type { AgentColor } from "./definition.ts";

const CODES: Record<AgentColor, number> = { red: 203, blue: 75, green: 41, yellow: 220, purple: 135, orange: 208, pink: 213, cyan: 51 };

export const tint = (color: string | undefined, text: string): string =>
  color !== undefined && color in CODES ? `\x1b[38;5;${CODES[color as AgentColor]}m${text}\x1b[39m` : text;
