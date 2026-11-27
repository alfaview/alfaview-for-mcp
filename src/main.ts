#!/usr/bin/env node
// The command alfaview-mcp. The MCP client starts it and talks to it over standard input and
// output, and the log goes to stderr. It logs in to alfaview at the first request of a tool call,
// never at start, so that a client that starts the server only for a health check makes no login.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AlfaviewClient } from './alfaview/client.ts';
import { ConfigError, readConfig } from './config.ts';
import { createLogger } from './log.ts';
import { createServer, startLines, stdioServerFactory, TOOLS, type ServerDeps } from './server.ts';

const log = createLogger();

try {
  const config = readConfig(process.env, TOOLS);
  const client = new AlfaviewClient({ config, fetch: globalThis.fetch, log });
  const deps: ServerDeps = {
    client,
    log,
    level: config.level,
    timeZone: config.timeZone,
    personalData: config.personalData,
    tools: config.tools,
  };
  // serveStdio makes its servers at the first message, where an error only answers the client and
  // the process stays. A server made here first lets a start that cannot work exit with code 1.
  createServer(deps);
  serveStdio(stdioServerFactory(deps), {
    onerror: (error) => log.error('protocol error', error),
  });
  for (const line of startLines(config)) log.info(line);
} catch (error) {
  // A configuration problem quotes no secret, so the log shows it in full. Any other error logs
  // only its name and stack frames, never its message.
  if (error instanceof ConfigError) {
    for (const problem of error.problems) log.info(problem);
  } else {
    log.error('could not start', error);
  }
  process.exitCode = 1;
}
