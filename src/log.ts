// The log of the server. The MCP client reads the server's standard output as protocol messages,
// so every log line goes to stderr. A line never holds a tool argument, a result, a secret or an
// error message: an error message can quote its input, and a thrown value can hold anything.

export type Logger = {
  info(message: string): void;
  /** Adds the name and stack frames of an Error, or the type of any other value. */
  error(message: string, error?: unknown): void;
};

const PREFIX = 'alfaview-mcp: ';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const STACK_FRAME = /^\s+at /;

/** Returns the name of an error when it reads as a class name, else `Error`. */
function errorName(error: Error): string {
  return typeof error.name === 'string' && IDENTIFIER.test(error.name) ? error.name : 'Error';
}

/**
 * Returns the stack frames of an error, without the header that V8 puts before them: the name and
 * the message, which can span several lines.
 */
function stackFrames(error: Error): string[] {
  if (typeof error.stack !== 'string') return [];
  const name = String(error.name);
  const header = error.message === '' ? name : `${name}: ${error.message}`;
  const frames = error.stack.startsWith(header) ? error.stack.slice(header.length) : error.stack;
  return frames
    .split('\n')
    .filter((line) => STACK_FRAME.test(line))
    .map((line) => line.trim());
}

/**
 * Creates a logger whose lines read `alfaview-mcp: <message>`. The default `write` goes to stderr.
 */
export function createLogger(
  write: (text: string) => void = (text) => process.stderr.write(text),
): Logger {
  const line = (message: string) => write(`${PREFIX}${message}\n`);
  return {
    info: line,
    error(message, error) {
      if (error === undefined) {
        line(message);
      } else if (error instanceof Error) {
        line(`${message} (${errorName(error)})`);
        for (const frame of stackFrames(error)) line(`    ${frame}`);
      } else {
        line(`${message} (${typeof error})`);
      }
    },
  };
}
