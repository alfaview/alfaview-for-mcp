// The access levels of the server. ALFAVIEW_ACCESS_LEVEL sets the level of a server entry, and a
// server registers the tools of its level and of the levels before it. `read` has only tools that
// read, and `full` adds the deletes of rooms and users and the tools that change who has access.

/** The levels, from the fewest tools to every tool. */
export const ACCESS_LEVELS = ['read', 'standard', 'manage', 'full'] as const;

export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** The level of a server entry without ALFAVIEW_ACCESS_LEVEL. */
export const DEFAULT_ACCESS_LEVEL: AccessLevel = 'standard';

/** Returns whether a server at `level` registers a tool of `toolLevel`. */
export function levelIncludes(level: AccessLevel, toolLevel: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(toolLevel) <= ACCESS_LEVELS.indexOf(level);
}
