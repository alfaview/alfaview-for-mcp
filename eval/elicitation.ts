// The person's answers to the server's questions (MCP elicitation). Claude Code tells the server
// that it can ask the person, but in `claude -p` nobody can answer, and Claude Code answers
// cancel. So each run gets an Elicitation hook (elicitation-hook.ts) that accepts a question that
// names what the person asked for, and declines every other question.

/** A question that the person accepts. */
export type ElicitationRule = {
  /** The text that the message or the form of the question must contain, compared without case. */
  names: string;
  /** What the person types into each text field. A yes or no field gets yes. */
  text?: string;
};

export type ElicitationQuestion = {
  message: string;
  /** The JSON schema of the form that the server asks the person to fill in. */
  requestedSchema?: unknown;
};

export type ElicitationReply = {
  action: 'accept' | 'decline';
  content?: Record<string, string | boolean>;
};

/** What the hook keeps of one question and its answer, in the record of the run. */
export type ElicitationLogEntry = ElicitationQuestion & ElicitationReply & { server: string };

type Schema = { type?: unknown; enum?: unknown };

function propertiesOf(schema: unknown): [string, Schema][] {
  const properties = (schema as { properties?: unknown } | null | undefined)?.properties;
  if (typeof properties !== 'object' || properties === null) return [];
  return Object.entries(properties as Record<string, unknown>).filter(
    (entry): entry is [string, Schema] => typeof entry[1] === 'object' && entry[1] !== null,
  );
}

/**
 * Returns the fields of the form as the person fills them in: yes for a yes or no field, and
 * `text` for a text field whose choices allow it.
 */
function contentOf(schema: unknown, text: string | undefined): Record<string, string | boolean> {
  const content: Record<string, string | boolean> = {};
  for (const [key, property] of propertiesOf(schema)) {
    if (property.type === 'boolean') {
      content[key] = true;
    } else if (property.type === 'string' && text !== undefined) {
      if (!Array.isArray(property.enum) || property.enum.includes(text)) content[key] = text;
    }
  }
  return content;
}

/**
 * Returns the person's answer to `question`: accept with the first rule whose `names` is in the
 * message or in the form, else decline.
 */
export function replyTo(question: ElicitationQuestion, rules: readonly ElicitationRule[]): ElicitationReply {
  const asked = `${question.message}\n${JSON.stringify(question.requestedSchema ?? {})}`.toLowerCase();
  const rule = rules.find((item) => asked.includes(item.names.toLowerCase()));
  if (rule === undefined) return { action: 'decline' };
  return { action: 'accept', content: contentOf(question.requestedSchema, rule.text) };
}

/** Returns the entries of the hook's log, one JSON object per line. Bad lines are skipped. */
export function parseElicitationLog(text: string): ElicitationLogEntry[] {
  const entries: ElicitationLogEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry === 'object' && entry !== null) entries.push(entry as ElicitationLogEntry);
    } catch {
      // A line that the hook did not finish.
    }
  }
  return entries;
}
