import type { IUser, AppConfig } from '@librechat/data-schemas';
import type { TEndpointOption } from 'librechat-data-provider';
import type { Request } from 'express';

/**
 * LibreChat-specific request body type that extends Express Request body
 * (have to use type alias because you can't extend indexed access types like Request['body'])
 */
export type RequestBody = {
  messageId?: string;
  fileTokenLimit?: number;
  conversationId?: string;
  parentMessageId?: string;
  endpoint?: string;
  endpointType?: string;
  model?: string;
  key?: string;
  endpointOption?: Partial<TEndpointOption>;
};

export type ServerRequest = Request<unknown, unknown, RequestBody> & {
  user?: IUser;
  config?: AppConfig;
  /** CHC per-request context — set by requireChcContext middleware */
  chcUserId?: string;
  tenantId?: string;
  /** Fresh GUSD-resolved context, attached by requireChcContext for downstream use */
  cpContext?: import('../cp/types').ResolvedCpContext;
  session: Request['session'] & {
    openidTokens?: {
      accessToken?: string;
      refreshToken?: string;
      idToken?: string;
    };
  };
};
