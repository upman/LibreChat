import { logger } from '@librechat/data-schemas';

import type { GUSDResponse } from './types';

import { getMockGUSDResponse } from './mock';

const GUSD_TIMEOUT_MS = Number(process.env.GUSD_TIMEOUT_MS) || 5000;

export async function fetchUserSessionDetails(accessToken: string): Promise<GUSDResponse> {
  const baseUrl = process.env.CP_API_BASE_URL;

  if (!baseUrl) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[CpClient] CP_API_BASE_URL is required in production');
    }
    logger.debug('[CpClient] CP_API_BASE_URL not set, returning mock GUSD response');
    return getMockGUSDResponse();
  }

  const url = `${baseUrl}/api/account`;

  logger.debug(`[CpClient] Calling getUserSessionDetails at ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ rpcAction: 'getUserSessionDetails' }),
    signal: AbortSignal.timeout(GUSD_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error(`[CpClient] GUSD request failed (${response.status}): ${text}`);
    throw new Error(`GUSD request failed with status ${response.status}`);
  }

  const data = (await response.json()) as GUSDResponse;
  logger.debug(`[CpClient] GUSD response received for userId=${data.userId}`);
  return data;
}
