// A preload for test/main.test.ts that makes the start fail after the configuration check, with
// a marker as the error message, which the log must not show. It replaces registerTool in the
// SDK module that dist/main.js also imports, so src/ needs no test hook.
import { McpServer } from '@modelcontextprotocol/server';

McpServer.prototype.registerTool = function registerTool(): never {
  throw new Error('marker-of-the-start-error');
};
