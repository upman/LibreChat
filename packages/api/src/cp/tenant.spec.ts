import { resolveTenant } from './tenant';

describe('resolveTenant', () => {
  const eligibleOrgIds = ['org-a', 'org-b', 'org-c'];

  describe('with requestedOrgId', () => {
    it('returns requested org when eligible', () => {
      const result = resolveTenant({ requestedOrgId: 'org-b', eligibleOrgIds });

      expect(result).toEqual({ tenantId: 'org-b' });
    });

    it('returns error when requested org is not eligible', () => {
      const result = resolveTenant({ requestedOrgId: 'org-x', eligibleOrgIds });

      expect(result).toEqual({
        tenantId: null,
        error: 'Organization org-x does not have LibreChat enabled',
      });
    });

    it('prefers requestedOrgId over lastTenantId', () => {
      const result = resolveTenant({
        requestedOrgId: 'org-b',
        lastTenantId: 'org-a',
        eligibleOrgIds,
      });

      expect(result).toEqual({ tenantId: 'org-b' });
    });

    it('returns error when requested org is not eligible even with valid lastTenantId', () => {
      const result = resolveTenant({
        requestedOrgId: 'org-x',
        lastTenantId: 'org-a',
        eligibleOrgIds,
      });

      expect(result.tenantId).toBeNull();
      expect(result.error).toContain('org-x');
    });
  });

  describe('with empty string requestedOrgId', () => {
    it('treats empty string as absent and falls through to lastTenantId', () => {
      const result = resolveTenant({
        requestedOrgId: '',
        lastTenantId: 'org-b',
        eligibleOrgIds,
      });

      expect(result).toEqual({ tenantId: 'org-b' });
    });
  });

  describe('with lastTenantId (no requestedOrgId)', () => {
    it('returns lastTenantId when still eligible', () => {
      const result = resolveTenant({ lastTenantId: 'org-b', eligibleOrgIds });

      expect(result).toEqual({ tenantId: 'org-b' });
    });

    it('falls through to first eligible when lastTenantId is stale', () => {
      const result = resolveTenant({ lastTenantId: 'org-revoked', eligibleOrgIds });

      expect(result).toEqual({ tenantId: 'org-a' });
    });
  });

  describe('with no requestedOrgId and no lastTenantId', () => {
    it('returns first eligible org', () => {
      const result = resolveTenant({ eligibleOrgIds });

      expect(result).toEqual({ tenantId: 'org-a' });
    });

    it('returns first eligible when lastTenantId is undefined', () => {
      const result = resolveTenant({ lastTenantId: undefined, eligibleOrgIds });

      expect(result).toEqual({ tenantId: 'org-a' });
    });
  });

  describe('with no eligible orgs', () => {
    it('returns null with error message', () => {
      const result = resolveTenant({ eligibleOrgIds: [] });

      expect(result).toEqual({
        tenantId: null,
        error: 'LibreChat is not enabled for any of your organizations',
      });
    });

    it('returns error even with requestedOrgId', () => {
      const result = resolveTenant({ requestedOrgId: 'org-a', eligibleOrgIds: [] });

      expect(result.tenantId).toBeNull();
      expect(result.error).toContain('org-a');
    });

    it('returns error even with lastTenantId', () => {
      const result = resolveTenant({ lastTenantId: 'org-a', eligibleOrgIds: [] });

      expect(result).toEqual({
        tenantId: null,
        error: 'LibreChat is not enabled for any of your organizations',
      });
    });
  });
});
