// The Platform of this server for the readers and checks of ./shared: a refused input throws a
// ToolError with the code InvalidInput. zod reads the booleans of a tool call, so a message names
// the two values of a yes/no field as the JSON values true and false.
import { invalidInput } from './alfaview/errors.ts';
import type { Platform } from './shared/platform.ts';

export const platform: Platform = { invalidInput, booleanWords: 'true or false' };
