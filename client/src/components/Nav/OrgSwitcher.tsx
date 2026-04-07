import { memo, useMemo, useRef, useCallback } from 'react';
import * as Menu from '@ariakit/react/menu';
import { Building2, Check } from 'lucide-react';
import { TooltipAnchor, useToastContext } from '@librechat/client';
import { useGetCpOrgsQuery, useSwitchCpOrgMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

function OrgSwitcher() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data, isLoading, isError } = useGetCpOrgsQuery();
  const switchMutation = useSwitchCpOrgMutation({
    onError: () => showToast({ message: localize('com_nav_org_switch_error'), status: 'error' }),
  });

  const orgs = useMemo(() => data?.orgs ?? [], [data]);
  const currentOrg = useMemo(() => orgs.find((o) => o.isCurrent), [orgs]);
  const mutateRef = useRef(switchMutation.mutateAsync);
  mutateRef.current = switchMutation.mutateAsync;

  const handleSwitch = useCallback(
    async (orgId: string) => {
      if (orgId === currentOrg?.id) {
        return;
      }
      try {
        await mutateRef.current(orgId);
        window.location.reload();
      } catch {
        // error surfaced via mutation onError callback
      }
    },
    [currentOrg?.id],
  );

  if (isLoading || isError || orgs.length < 2) {
    return null;
  }

  return (
    <Menu.MenuProvider>
      <TooltipAnchor
        side="right"
        description={currentOrg?.name ?? localize('com_nav_switch_org')}
        render={
          <Menu.MenuButton
            aria-label={localize('com_nav_switch_org')}
            disabled={switchMutation.isLoading}
            className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-surface-active-alt aria-[expanded=true]:bg-surface-active-alt"
          >
            <Building2 className="h-4 w-4 flex-shrink-0 text-text-secondary" aria-hidden="true" />
          </Menu.MenuButton>
        }
      />
      <Menu.Menu
        portal
        className="popover-ui z-[125] w-[220px] rounded-lg"
        placement="right-end"
        style={{ transformOrigin: 'left bottom', translate: '4px 0' }}
      >
        <div className="px-3 py-2 text-xs font-medium text-text-secondary">
          {localize('com_nav_organizations')}
        </div>
        {orgs.map((org) => (
          <Menu.MenuItem
            key={org.id}
            onClick={() => handleSwitch(org.id)}
            className="select-item flex items-center justify-between text-sm"
            disabled={switchMutation.isLoading}
          >
            <span className="truncate">{org.name}</span>
            {org.isCurrent && (
              <Check className="h-4 w-4 flex-shrink-0 text-text-primary" aria-hidden="true" />
            )}
          </Menu.MenuItem>
        ))}
      </Menu.Menu>
    </Menu.MenuProvider>
  );
}

export default memo(OrgSwitcher);
