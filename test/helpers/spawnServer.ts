// Starts the built server the way an MCP client does, with the preload that keeps its requests on
// 127.0.0.1. Every test that starts the server with a configuration goes through this file, so no
// started server can reach a real host.
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { keepContractProblems } from './spec.ts';

const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
const MAIN = fileURLToPath(new URL('../../dist/main.js', import.meta.url));
export const ROUTE_FETCH = new URL('../fake-api/route-fetch.ts', import.meta.url).href;
/** The preload that makes the start of the server fail after the configuration check. */
export const BREAK_START = new URL('../fake-api/break-start.ts', import.meta.url).href;

/** The three variables of the test credentials, the same as in fakeFetch.ts. */
export const TEST_ENV = {
  ALFAVIEW_COMPANY_ID: 'company-1',
  ALFAVIEW_CLIENT_ID: 'mcp-test',
  ALFAVIEW_API_KEY: 'secret-key-1',
} as const;

export type LaunchOptions = {
  /** The whole environment of the server, apart from the preload's variable. */
  env: Record<string, string>;
  /** The origin on 127.0.0.1 that receives the server's requests to the production API. */
  fakeApiOrigin: string;
  /** More preload modules, loaded after the one that keeps the requests on 127.0.0.1. */
  preloads?: readonly string[];
};

export type ServerLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
};

/** Returns the parameters for StdioClientTransport or spawn: node, the preloads, dist/main.js. */
export function serverLaunch(options: LaunchOptions): ServerLaunch {
  const preloads = (options.preloads ?? []).flatMap((preload) => ['--import', preload]);
  return {
    command: process.execPath,
    args: ['--import', ROUTE_FETCH, ...preloads, MAIN],
    env: { ...options.env, ALFAVIEW_FAKE_API_ORIGIN: options.fakeApiOrigin },
    cwd: PACKAGE_DIR,
  };
}

export type SpawnedServer = {
  child: ChildProcessWithoutNullStreams;
  stdout(): string;
  stderr(): string;
  /**
   * Returns the exit code, or null when a signal ended the process. Kills the process and fails
   * when it has not exited within `ms`.
   */
  exitWithin(ms: number): Promise<number | null>;
  /** Waits until stderr contains `text`. Kills the process and fails after `ms`. */
  stderrWithin(text: string, ms: number): Promise<void>;
};

/** Waits for `ready` to become true, checking every 10 ms, and fails after `ms`. */
async function waitUntil(ready: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `${what} within ${ms} ms` });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Starts the server with exactly the given environment: nothing of the test's own environment
 * reaches it, so credentials exported in a developer's shell cannot either.
 */
export function spawnServer(options: LaunchOptions): SpawnedServer {
  const launch = serverLaunch(options);
  const child = spawn(launch.command, launch.args, { env: launch.env, cwd: launch.cwd });
  let stdout = '';
  let stderr = '';
  let exitCode: number | null | undefined;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.on('exit', (code) => (exitCode = code));
  /**
   * Kills the process when `wait` fails, so that its open stdin does not keep the test file alive.
   */
  const orKill = async (wait: Promise<void>) => {
    try {
      await wait;
    } catch (error) {
      child.kill();
      throw error;
    }
  };
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    async exitWithin(ms) {
      await orKill(waitUntil(() => exitCode !== undefined, ms, 'the server did not exit'));
      return exitCode ?? null;
    },
    stderrWithin: (text, ms) =>
      orKill(
        waitUntil(() => stderr.includes(text), ms, `stderr did not contain ${JSON.stringify(text)}`),
      ),
  };
}

export type RecordingServer = {
  origin: string;
  /** `METHOD /path?query` of every request, in order. */
  requests: string[];
  close(): Promise<void>;
};

/**
 * Starts an HTTP server on 127.0.0.1 that answers every request with 500 and records it, for tests
 * that need no fake API but must see that no request left the server. Each request goes through
 * the contract check against the API spec (spec.ts) before the answer.
 */
export async function startRecordingServer(): Promise<RecordingServer> {
  const requests: string[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    requests.push(`${request.method} ${request.url}`);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const contractRequest = {
        method: request.method ?? '',
        path: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      keepContractProblems(contractRequest, undefined, undefined);
      response.writeHead(500, { 'Content-Type': 'application/problem+json' });
      response.end(JSON.stringify({ title: 'Internal Server Error', status: 500 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
