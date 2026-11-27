// The parts of a tool context for a test that calls `run` without the wrapper, such as a test of a
// cancel, and the output of such a call.
import assert from 'node:assert/strict';
import {
  Confirmations,
  isPersonQuestion,
  PersonConfirmation,
  type PersonQuestion,
} from '../../src/tools/confirmation.ts';
import type { ToolOutput } from '../../src/tools/tool.ts';

/**
 * Returns the confirmation of a call that cannot ask the person, as a call outside an MCP request.
 */
export function noQuestions(tool = 'direct_call'): PersonConfirmation {
  return new PersonConfirmation(new Confirmations(), tool, false, undefined, undefined);
}

/** Returns the output of a direct call of `run`, and fails when the tool asked the person. */
export function outputOf<Data>(result: ToolOutput<Data> | PersonQuestion): ToolOutput<Data> {
  assert.ok(!isPersonQuestion(result), 'the tool asked the person');
  return result;
}
