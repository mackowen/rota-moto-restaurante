(() => {
  'use strict';

  function forCompany(records, companyId) {
    if (typeof companyId !== 'string' || !companyId) return [];
    return (Array.isArray(records) ? records : []).filter(record => record?.companyId === companyId);
  }

  window.RotaMotoTenantCacheScope = Object.freeze({ forCompany });
})();
