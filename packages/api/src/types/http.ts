import type { TConversation, TEndpointOption } from 'librechat-data-provider';
import type { IUser, AppConfig } from '@librechat/data-schemas';
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
      /** Timestamp (ms) when our server received the token — used with tokenLifetime for clock-skew-resistant staleness check */
      receivedAt?: number;
      /** Token lifetime in seconds derived from provider claims (exp - iat) — same clock, skew cancels */
      tokenLifetime?: number;
    };
  };
  /** Server-captured conversation creation time used to anchor dynamic prompt variables. */
  conversationCreatedAt?: string;
  /** Conversation loaded while resolving the prompt timestamp anchor, reused by save logic. */
  resolvedConversation?: Partial<TConversation> | null;
  /** Passport strategy that populated req.user for this request. */
  authStrategy?: string;
};
