// The account tools get_account and update_own_user. Both work with the API key's user, whom
// alfaview finds from the token.
import * as z from 'zod';
import { invalidInput, readAfterSavedWrite, ToolError } from '../alfaview/errors.ts';
import {
  companyNotReadWarning,
  getOwnCompany,
  getOwnUser,
  mapCompany,
  PROFILE_SAVED_BUT_NOT_READ_MESSAGE,
  updateOwnUser,
  type CompanyOutput,
} from '../domain/account.ts';
import { LOCALES, mapUser } from '../shared/users.ts';
import { compact } from '../values/inputs.ts';
import { toolOutput, USER } from './outputs.ts';
import {
  defineTool,
  IDEMPOTENT_CHANGE_ANNOTATIONS,
  READ_ANNOTATIONS,
  textParameter,
} from './tool.ts';

export const getAccountTool = defineTool({
  name: 'get_account',
  level: 'manage',
  title: 'Get the account',
  description:
    "Returns the alfaview user and company of the API key: the user's ID, name, email address, title, city, initials and language, and the company's ID and name. Use it to check the account of this server.",
  descriptionWithoutPersonalData:
    "Returns the alfaview user and company of the API key: the user's ID and language, and the company's ID and name. Use it to check the account of this server. This server leaves out personal data: the user's name, email address, title, city and initials are null.",
  inputSchema: z.strictObject({}),
  annotations: READ_ANNOTATIONS,
  personalData: { shape: 'mcp.account' },
  // company is null when its read failed, and a warning says so.
  output: toolOutput({
    user: USER,
    company: z
      .strictObject({ id: z.string().nullable(), displayName: z.string().nullable() })
      .nullable(),
  }),
  async run(_input, { api }) {
    const user = mapUser(await getOwnUser(api));

    // The company is an extra: alfaview answers 500 for every failure of this read, so a failure
    // gives a warning, not an error. A cancel ends the call.
    let company: CompanyOutput | null = null;
    const warnings: string[] = [];
    try {
      company = mapCompany(await getOwnCompany(api));
    } catch (error) {
      if (!(error instanceof ToolError) || error.code === 'Canceled') throw error;
      warnings.push(companyNotReadWarning(error.code));
    }

    const inCompany = company === null ? '' : ` in company ${company.id ?? 'unknown'}`;
    return {
      summary: `The API key belongs to user ${user.id}${inCompany}.`,
      warnings,
      data: { user, company },
    };
  },
});

export const updateOwnUserTool = defineTool({
  name: 'update_own_user',
  level: 'manage',
  title: 'Update your own profile',
  description:
    'Changes the profile of the alfaview user that owns the API key: name, title, city, initials or language. It cannot change other users.',
  // alfaview refuses a blank name, a title of more than 20 characters and initials of more than 3.
  inputSchema: z.strictObject({
    firstName: textParameter('First name.').optional(),
    lastName: textParameter('Last name.').optional(),
    title: textParameter('Title, for example Dr.', 20).optional(),
    city: textParameter('City.').optional(),
    initials: textParameter('Initials.', 3).optional(),
    locale: z
      .enum(LOCALES)
      .describe("Language of alfaview's apps and emails for this user.")
      .optional(),
  }),
  annotations: IDEMPOTENT_CHANGE_ANNOTATIONS,
  personalData: { shape: 'mcp.user' },
  output: toolOutput(USER.shape),
  readTool: 'get_account',
  async run(input, { api }) {
    const change = compact({
      firstName: input.firstName,
      lastName: input.lastName,
      title: input.title,
      city: input.city,
      initials: input.initials,
      locale: input.locale,
    });
    // alfaview answers an empty change with 204 and changes nothing.
    if (Object.keys(change).length === 0) {
      throw invalidInput('Give at least one field to change.');
    }
    await updateOwnUser(api, change);

    // The change is saved: a failed read back must not read as a failed change.
    const user = mapUser(
      await readAfterSavedWrite(() => getOwnUser(api), PROFILE_SAVED_BUT_NOT_READ_MESSAGE),
    );
    return { summary: `Updated the profile of user ${user.id}.`, data: user };
  },
});

/** The account tools, in the order of the tool list. */
export const ACCOUNT_TOOLS = [getAccountTool, updateOwnUserTool] as const;
