import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockShowToast = jest.fn();
const mockMutateAsync = jest.fn();
let mockMutationIsLoading = false;
let mockQueryResult = {
  data: undefined as { orgs: { id: string; name: string; isCurrent: boolean }[] } | undefined,
  isLoading: false,
  isError: false,
};
let capturedOnError: ((err: unknown) => void) | undefined;

jest.mock('~/data-provider', () => ({
  useGetCpOrgsQuery: jest.fn(() => mockQueryResult),
  useSwitchCpOrgMutation: jest.fn((options?: { onError?: (err: unknown) => void }) => {
    capturedOnError = options?.onError;
    return { mutateAsync: mockMutateAsync, isLoading: mockMutationIsLoading };
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    useToastContext: () => ({ showToast: mockShowToast }),
    TooltipAnchor: ({
      render,
    }: {
      render: React.ReactElement;
      side?: string;
      description?: string;
    }) => R.cloneElement(render),
  };
});

jest.mock('@ariakit/react/menu', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    MenuProvider: ({ children }: { children: React.ReactNode }) =>
      R.createElement('div', { 'data-testid': 'menu-provider' }, children),
    MenuButton: R.forwardRef(
      (
        {
          children,
          ...props
        }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>,
        ref: React.Ref<HTMLButtonElement>,
      ) => R.createElement('button', { ...props, ref }, children),
    ),
    Menu: ({ children }: { children: React.ReactNode }) =>
      R.createElement('div', { role: 'menu' }, children),
    MenuItem: ({
      children,
      onClick,
      disabled,
    }: {
      children: React.ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) =>
      R.createElement(
        'div',
        { role: 'menuitem', onClick: disabled ? undefined : onClick, 'aria-disabled': disabled },
        children,
      ),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { default: OrgSwitcher } = require('~/components/Nav/OrgSwitcher');

const mockOrgs = [
  { id: 'org-1', name: 'Alpha Corp', isCurrent: true },
  { id: 'org-2', name: 'Beta Inc', isCurrent: false },
  { id: 'org-3', name: 'Gamma LLC', isCurrent: false },
];

describe('OrgSwitcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryResult = { data: undefined, isLoading: false, isError: false };
    mockMutationIsLoading = false;
    capturedOnError = undefined;
  });

  it('returns null when loading', () => {
    mockQueryResult = { data: undefined, isLoading: true, isError: false };
    const { container } = render(<OrgSwitcher />);
    expect(container.innerHTML).toBe('');
  });

  it('returns null when query errors', () => {
    mockQueryResult = { data: undefined, isLoading: false, isError: true };
    const { container } = render(<OrgSwitcher />);
    expect(container.innerHTML).toBe('');
  });

  it('returns null when user has fewer than 2 orgs', () => {
    mockQueryResult = {
      data: { orgs: [{ id: 'org-1', name: 'Solo Org', isCurrent: true }] },
      isLoading: false,
      isError: false,
    };
    const { container } = render(<OrgSwitcher />);
    expect(container.innerHTML).toBe('');
  });

  it('renders menu with org list when user has 2+ orgs', () => {
    mockQueryResult = { data: { orgs: mockOrgs }, isLoading: false, isError: false };
    render(<OrgSwitcher />);

    expect(screen.getByText('Alpha Corp')).toBeInTheDocument();
    expect(screen.getByText('Beta Inc')).toBeInTheDocument();
    expect(screen.getByText('Gamma LLC')).toBeInTheDocument();
  });

  it('uses correct aria-label for accessibility', () => {
    mockQueryResult = { data: { orgs: mockOrgs }, isLoading: false, isError: false };
    render(<OrgSwitcher />);

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-label', 'com_nav_switch_org');
  });

  it('renders localized section header', () => {
    mockQueryResult = { data: { orgs: mockOrgs }, isLoading: false, isError: false };
    render(<OrgSwitcher />);
    expect(screen.getByText('com_nav_organizations')).toBeInTheDocument();
  });

  it('does not call mutateAsync when clicking the current org', () => {
    mockQueryResult = { data: { orgs: mockOrgs }, isLoading: false, isError: false };
    render(<OrgSwitcher />);

    const currentOrgItem = screen.getByText('Alpha Corp').closest('[role="menuitem"]');
    fireEvent.click(currentOrgItem!);

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('calls mutateAsync and triggers reload on successful org switch', async () => {
    mockMutateAsync.mockResolvedValue({ user: { id: '1', tenantId: 'org-2' } });
    mockQueryResult = { data: { orgs: mockOrgs }, isLoading: false, isError: false };

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    render(<OrgSwitcher />);
    const betaItem = screen.getByText('Beta Inc').closest('[role="menuitem"]');
    fireEvent.click(betaItem!);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith('org-2');
    });

    // jsdom does not implement navigation — window.location.reload() triggers
    // a "Not implemented: navigation" console.error, confirming it was called.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Not implemented: navigation') }),
    );

    errorSpy.mockRestore();
  });

  it('shows error toast when switch fails', async () => {
    mockMutateAsync.mockRejectedValue(new Error('503'));
    mockQueryResult = { data: { orgs: mockOrgs }, isLoading: false, isError: false };
    render(<OrgSwitcher />);

    const betaItem = screen.getByText('Beta Inc').closest('[role="menuitem"]');
    fireEvent.click(betaItem!);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith('org-2');
    });

    expect(capturedOnError).toBeDefined();
    capturedOnError?.(new Error('503'));

    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_nav_org_switch_error',
      status: 'error',
    });
  });

  it('disables menu items while a switch is in progress', () => {
    mockMutationIsLoading = true;
    mockQueryResult = { data: { orgs: mockOrgs }, isLoading: false, isError: false };
    render(<OrgSwitcher />);

    const betaItem = screen.getByText('Beta Inc').closest('[role="menuitem"]')!;
    expect(betaItem).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(betaItem);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
});
