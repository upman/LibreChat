import type { CpInstanceSummary } from './types';

/**
 * Formats ClickHouse Cloud service instances scoped to a tenant
 * into a context string suitable for agent instructions.
 */
export function formatServicesContext(
  instances: Record<string, CpInstanceSummary>,
  tenantId: string,
): string {
  const services: CpInstanceSummary[] = [];
  for (const instance of Object.values(instances)) {
    if (instance.organizationId === tenantId) {
      services.push(instance);
    }
  }

  if (!services.length) {
    return '';
  }

  const lines = [
    '# ClickHouse Cloud Services',
    '',
    "The user's organization has the following ClickHouse Cloud services:",
    '',
  ];

  for (const svc of services) {
    lines.push(`## ${svc.name}`);
    lines.push(`- **Service ID**: ${svc.id}`);
    lines.push(`- **State**: ${svc.state}`);
    lines.push(`- **Region**: ${svc.regionId}`);
    lines.push(`- **Tier**: ${svc.instanceTier}`);
    lines.push(`- **ClickHouse Version**: ${svc.clickhouseVersion}`);
    lines.push(`- **Database**: ${svc.database}`);

    if (svc.isClickstackInstance) {
      lines.push(`- **Type**: Clickstack`);
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}
