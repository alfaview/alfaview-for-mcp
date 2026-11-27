// The profile of the API key's user and its company.
import type { CallApi } from '../alfaview/client.ts';
import { invalidResponse } from '../alfaview/errors.ts';
import { textOrNull } from '../shared/outputValues.ts';
import type { ApiUser, Locale } from '../shared/users.ts';

// Messages

export const PROFILE_NOT_RETURNED_MESSAGE = 'alfaview did not return the user profile.';

export const COMPANY_NOT_RETURNED_MESSAGE = 'alfaview did not return the company.';

export const PROFILE_SAVED_BUT_NOT_READ_MESSAGE =
  'alfaview saved the profile change, but reading it back failed. Use get_account to read the profile.';

/**
 * Returns the warning of get_account when the company read fails with the ToolError code `code`.
 */
export function companyNotReadWarning(code: string): string {
  return `alfaview did not return the company (${code}), so company is null.`;
}

// API and output shapes (spec: Company, UserUpdate)

export type ApiCompany = { companyId?: string; displayName?: string; createdAt?: string };

/** The company of the API key. `id` is the company ID of alfaview, which is no UUID. */
export type CompanyOutput = { id: string | null; displayName: string | null };

/** The profile fields of the API key's user that a change sets. Only the given fields change. */
export type ProfileChange = {
  firstName?: string;
  lastName?: string;
  title?: string;
  city?: string;
  initials?: string;
  locale?: Locale;
};

/**
 * Returns the Company output without `createdAt`, which no task needs. Absent values are `null`.
 */
export function mapCompany(company: ApiCompany): CompanyOutput {
  return { id: textOrNull(company.companyId), displayName: textOrNull(company.displayName) };
}

// Requests

/** Returns the profile of the API key's user (`GET /v2/users/me`). */
export async function getOwnUser(api: CallApi): Promise<ApiUser> {
  const { data } = await api.request<ApiUser>({ method: 'GET', path: '/v2/users/me' });
  if (typeof data !== 'object' || data === null || typeof data.id !== 'string') {
    throw invalidResponse(PROFILE_NOT_RETURNED_MESSAGE);
  }
  return data;
}

/**
 * Returns the company of the API key (`GET /v2/users/me/company`). alfaview answers 500 for every
 * failure of this read, so the caller decides what a failure means.
 */
export async function getOwnCompany(api: CallApi): Promise<ApiCompany> {
  const { data } = await api.request<ApiCompany>({ method: 'GET', path: '/v2/users/me/company' });
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw invalidResponse(COMPANY_NOT_RETURNED_MESSAGE);
  }
  return data;
}

/**
 * Changes the given profile fields of the API key's user (`PATCH /v2/users`). alfaview takes the
 * user from the token, so the request cannot change another user. Its answer has no body.
 */
export async function updateOwnUser(api: CallApi, change: ProfileChange): Promise<void> {
  await api.request({ method: 'PATCH', path: '/v2/users', body: change });
}
