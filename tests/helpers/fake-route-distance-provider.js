'use strict';

if (process.env.NODE_ENV !== 'test') throw new Error('Fake route distance provider is available only in NODE_ENV=test.');

function createFakeRouteDistanceProvider({ distances = {}, unknownSequences = [], unavailableSequences = [],
  providerId = 'fake-route-distance-v1', companyId = null } = {}) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Fake route distance provider is available only in NODE_ENV=test.');
  const sequenceKey = ids => ids.join('>');
  let known = new Map(Object.entries(distances));
  let unknown = new Set(unknownSequences), unavailable = new Set(unavailableSequences), scopedCompanyId = companyId;
  return Object.freeze({
    providerId,
    testOnly:true,
    configure(input) {
      if(process.env.NODE_ENV!=='test'||!input||typeof input.companyId!=='string')throw new Error('Invalid test distance scope.');
      scopedCompanyId=input.companyId;known=new Map(Object.entries(input.distances||{}));
      unknown=new Set(input.unknownSequences||[]);unavailable=new Set(input.unavailableSequences||[]);
    },
    async calculateDistance({ companyId:requestCompanyId,deliveryIds }) {
      const key=sequenceKey(deliveryIds),provenance={kind:'test',providerId,version:'1'};
      if(!scopedCompanyId||requestCompanyId!==scopedCompanyId)return {status:'unknown',provenance,reason:'TEST_TENANT_SCOPE_MISMATCH'};
      if(unavailable.has(key))return {status:'unavailable',provenance,reason:'TEST_DISTANCE_UNAVAILABLE'};
      if(unknown.has(key)||!known.has(key))return {status:'unknown',provenance,reason:'TEST_DISTANCE_UNKNOWN'};
      const value=known.get(key);
      return {status:'known',distanceM:value,provenance};
    }
  });
}

module.exports={createFakeRouteDistanceProvider};
