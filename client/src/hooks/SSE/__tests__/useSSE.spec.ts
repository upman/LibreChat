import { renderHook, act } from '@testing-library/react';
import type { TSubmission } from 'librechat-data-provider';

type SSEEventListener = (e: Partial<MessageEvent> & { responseCode?: number }) => void;

interface MockSSEInstance {
  addEventListener: jest.Mock;
  stream: jest.Mock;
  close: jest.Mock;
  dispatchEvent: jest.Mock;
  headers: Record<string, string>;
  readyState: number;
  _listeners: Record<string, SSEEventListener>;
  _emit: (event: string, data?: Partial<MessageEvent> & { responseCode?: number }) => void;
}

const mockSSEInstances: MockSSEInstance[] = [];

jest.mock('sse.js', () => ({
  SSE: jest.fn().mockImplementation(() => {
    const listeners: Record<string, SSEEventListener> = {};
    const instance: MockSSEInstance = {
      addEventListener: jest.fn((event: string, cb: SSEEventListener) => {
        listeners[event] = cb;
      }),
      stream: jest.fn(),
      close: jest.fn(),
      dispatchEvent: jest.fn(),
      headers: {},
      readyState: 2,
      _listeners: listeners,
      _emit: (event, data = {}) => listeners[event]?.(data as MessageEvent),
    };
    mockSSEInstances.push(instance);
    return instance;
  }),
}));

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: () => jest.fn(),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    activeRunFamily: jest.fn(),
    abortScrollFamily: jest.fn(),
    showStopButtonByIndex: jest.fn(),
  },
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'test-token', isAuthenticated: true }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { balance: { enabled: false } } }),
  useGetUserBalance: () => ({ refetch: jest.fn() }),
}));

const mockErrorHandler = jest.fn();
const mockClearStepMaps = jest.fn();
const mockMaybeRedirectForChcReauth = jest.fn();

jest.mock('~/hooks/SSE/useEventHandlers', () =>
  jest.fn(() => ({
    errorHandler: mockErrorHandler,
    finalHandler: jest.fn(),
    createdHandler: jest.fn(),
    attachmentHandler: jest.fn(),
    stepHandler: jest.fn(),
    syncHandler: jest.fn(),
    contentHandler: jest.fn(),
    resetContentHandler: jest.fn(),
    messageHandler: jest.fn(),
    abortConversation: jest.fn(),
    clearStepMaps: mockClearStepMaps,
  })),
);

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    createPayload: jest.fn(() => ({
      payload: { model: 'gpt-4o' },
      server: '/api/ask',
    })),
    removeNullishValues: jest.fn((v: unknown) => v),
    maybeRedirectForChcReauth: (errorData: unknown) => mockMaybeRedirectForChcReauth(errorData),
    request: {
      refreshToken: jest.fn(),
      dispatchTokenUpdatedEvent: jest.fn(),
    },
  };
});

import useSSE from '~/hooks/SSE/useSSE';

const CONV_ID = 'conv-abc-123';

const buildSubmission = (): TSubmission =>
  ({
    conversation: { conversationId: CONV_ID },
    userMessage: {
      messageId: 'msg-1',
      conversationId: CONV_ID,
      text: 'Hello',
      isCreatedByUser: true,
      sender: 'User',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    },
    messages: [],
    isTemporary: false,
    initialResponse: {
      messageId: 'resp-1',
      conversationId: CONV_ID,
      text: '',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
    endpointOption: { endpoint: 'agents' },
  }) as unknown as TSubmission;

const buildChatHelpers = () => ({
  setMessages: jest.fn(),
  getMessages: jest.fn(() => []),
  setConversation: jest.fn(),
  setIsSubmitting: jest.fn(),
  newConversation: jest.fn(),
  resetLatestMessage: jest.fn(),
});

const getLastSSE = (): MockSSEInstance => {
  const sse = mockSSEInstances[mockSSEInstances.length - 1];
  expect(sse).toBeDefined();
  return sse;
};

describe('useSSE - error paths', () => {
  beforeEach(() => {
    mockSSEInstances.length = 0;
    mockErrorHandler.mockClear();
    mockClearStepMaps.mockClear();
    mockMaybeRedirectForChcReauth.mockReset();
    mockMaybeRedirectForChcReauth.mockReturnValue(false);
  });

  it('redirects for CHC reauth 401 without refreshing or showing a stream error', async () => {
    mockMaybeRedirectForChcReauth.mockReturnValueOnce(true);
    const { request } = jest.requireMock('librechat-data-provider') as {
      request: { refreshToken: jest.Mock };
    };
    request.refreshToken.mockClear();

    const chatHelpers = buildChatHelpers();
    const { unmount } = renderHook(() => useSSE(buildSubmission(), chatHelpers));

    await act(async () => {
      await Promise.resolve();
    });

    const sse = getLastSSE();
    const errorBody = {
      error_code: 'CHC_REAUTH_REQUIRED',
      login_url: '/oauth/openid?prompt=login',
    };

    await act(async () => {
      await sse._emit('error', { responseCode: 401, data: JSON.stringify(errorBody) });
    });

    expect(mockMaybeRedirectForChcReauth).toHaveBeenCalledWith(errorBody);
    expect(request.refreshToken).not.toHaveBeenCalled();
    expect(mockErrorHandler).not.toHaveBeenCalled();
    expect(sse.close).toHaveBeenCalled();
    expect(chatHelpers.setIsSubmitting).toHaveBeenCalledWith(false);
    unmount();
  });
});
