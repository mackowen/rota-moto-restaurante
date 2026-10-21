'use strict';

const {createOsrmRouteDistanceProvider}=require('./osrm-route-distance');
const {createOrsRouteDistanceProvider}=require('./ors-route-distance');

function createRouteDistanceProvider(config={},dependencies={}){
  if(!config||config.enabled!==true)return null;
  const common={baseUrl:config.baseUrl,timeoutMs:config.timeoutMs,requestsPerMinute:config.requestsPerMinute,...dependencies};
  if(config.provider==='osrm')return createOsrmRouteDistanceProvider({...common,version:config.version});
  if(config.provider==='ors')return createOrsRouteDistanceProvider({...common,profile:config.profile});
  throw new Error('ROUTE_DISTANCE_PROVIDER_UNSUPPORTED');
}

module.exports={createRouteDistanceProvider};
