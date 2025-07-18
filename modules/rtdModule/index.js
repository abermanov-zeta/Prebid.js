/**
 * This module adds Real time data support to prebid.js
 * @module modules/realTimeData
 * @typedef {import('../../modules/rtdModule/index.js').SubmoduleConfig} SubmoduleConfig
 */

/**
 * @interface UserConsentData
 */
/**
 * @property
 * @summary gdpr consent
 * @name UserConsentData#gdpr
 * @type {Object}
 */
/**
 * @property
 * @summary usp consent
 * @name UserConsentData#usp
 * @type {Object}
 */
/**
 * @property
 * @summary coppa
 * @name UserConsentData#coppa
 * @type {boolean}
 */

/**
 * @interface RtdSubmodule
 */

/**
 * @function
 * @summary return real time data
 * @name RtdSubmodule#getTargetingData
 * @param {string[]} adUnitsCodes
 * @param {SubmoduleConfig} config
 * @param {UserConsentData} userConsent
 * @param {auction} auction
 */

/**
 * @function
 * @summary modify bid request data
 * @name RtdSubmodule#getBidRequestData
 * @param {Object} reqBidsConfigObj
 * @param {function} callback
 * @param {SubmoduleConfig} config
 * @param {UserConsentData} userConsent
 */

/**
 * @property
 * @summary used to link submodule with config
 * @name RtdSubmodule#name
 * @type {string}
 */

/**
 * @property
 * @summary used to link submodule with config
 * @name RtdSubmodule#config
 * @type {Object}
 */

/**
 * @function
 * @summary init sub module
 * @name RtdSubmodule#init
 * @param {SubmoduleConfig} config
 * @param {UserConsentData} user consent
 * @return {boolean} false to remove sub module
 */

/**
 * @function
 * @summary on auction init event
 * @name RtdSubmodule#onAuctionInitEvent
 * @param {Object} data
 * @param {SubmoduleConfig} config
 * @param {UserConsentData} userConsent
 */

/**
 * @function
 * @summary on auction end event
 * @name RtdSubmodule#onAuctionEndEvent
 * @param {Object} data
 * @param {SubmoduleConfig} config
 * @param {UserConsentData} userConsent
 */

/**
 * @function
 * @summary on bid response event
 * @name RtdSubmodule#onBidResponseEvent
 * @param {Object} data
 * @param {SubmoduleConfig} config
 * @param {UserConsentData} userConsent
 */

/**
 * @function
 * @summary on bid requested event
 * @name RtdSubmodule#onBidRequestEvent
 * @param {Object} data
 * @param {SubmoduleConfig} config
 * @param {UserConsentData} userConsent
 */

/**
 * @function
 * @summary on data deletion request
 * @name RtdSubmodule#onDataDeletionRequest
 * @param {SubmoduleConfig} config
 */

/**
 * @interface ModuleConfig
 */

/**
 * @property
 * @summary auction delay
 * @name ModuleConfig#auctionDelay
 * @type {number}
 */

/**
 * @property
 * @summary list of sub modules
 * @name ModuleConfig#dataProviders
 * @type {SubmoduleConfig[]}
 */

/**
 * @interface SubModuleConfig
 */

/**
 * @property
 * @summary params for provide (sub module)
 * @name SubModuleConfig#params
 * @type {Object}
 */

/**
 * @property
 * @summary name
 * @name ModuleConfig#name
 * @type {string}
 */

/**
 * @property
 * @summary delay auction for this sub module
 * @name ModuleConfig#waitForIt
 * @type {boolean}
 */

import {config} from '../../src/config.js';
import {getHook, module} from '../../src/hook.js';
import {logError, logInfo, logWarn} from '../../src/utils.js';
import * as events from '../../src/events.js';
import { EVENTS, JSON_MAPPING } from '../../src/constants.js';
import adapterManager, {gdprDataHandler, uspDataHandler, gppDataHandler} from '../../src/adapterManager.js';
import {timedAuctionHook} from '../../src/utils/perfMetrics.js';
import {GDPR_GVLIDS} from '../../src/consentHandler.js';
import {MODULE_TYPE_RTD} from '../../src/activities/modules.js';
import {guardOrtb2Fragments} from '../../libraries/objectGuard/ortbGuard.js';
import {activityParamsBuilder} from '../../src/activities/params.js';

const activityParams = activityParamsBuilder((al) => adapterManager.resolveAlias(al));

/** @type {string} */
const MODULE_NAME = 'realTimeData';
/** @type {RtdSubmodule[]} */
let registeredSubModules = [];
/** @type {RtdSubmodule[]} */
export let subModules = [];
/** @type {ModuleConfig} */
let _moduleConfig;
/** @type {SubmoduleConfig[]} */
let _dataProviders = [];
/** @type {UserConsentData} */
let _userConsent;

/**
 * Register a Real-Time Data (RTD) submodule.
 *
 * @param {Object} submodule The RTD submodule to register.
 * @param {string} submodule.name The name of the RTD submodule.
 * @param {number} [submodule.gvlid] The Global Vendor List ID (GVLID) of the RTD submodule.
 * @returns {function(): void} A de-registration function that will unregister the module when called.
 */
export function attachRealTimeDataProvider(submodule) {
  registeredSubModules.push(submodule);
  GDPR_GVLIDS.register(MODULE_TYPE_RTD, submodule.name, submodule.gvlid)
  return function detach() {
    const idx = registeredSubModules.indexOf(submodule)
    if (idx >= 0) {
      registeredSubModules.splice(idx, 1);
      initSubModules();
    }
  }
}

/**
 * call each sub module event function by config order
 */
const setEventsListeners = (function () {
  let registered = false;
  return function setEventsListeners() {
    if (!registered) {
      Object.entries({
        [EVENTS.AUCTION_INIT]: ['onAuctionInitEvent'],
        [EVENTS.AUCTION_END]: ['onAuctionEndEvent', getAdUnitTargeting],
        [EVENTS.BID_RESPONSE]: ['onBidResponseEvent'],
        [EVENTS.BID_REQUESTED]: ['onBidRequestEvent'],
        [EVENTS.BID_ACCEPTED]: ['onBidAcceptedEvent']
      }).forEach(([ev, [handler, preprocess]]) => {
        events.on(ev, (args) => {
          preprocess && preprocess(args);
          subModules.forEach(sm => {
            try {
              sm[handler] && sm[handler](args, sm.config, _userConsent)
            } catch (e) {
              logError(`RTD provider '${sm.name}': error in '${handler}':`, e);
            }
          });
        })
      });
      registered = true;
    }
  }
})();

export function init(config) {
  const confListener = config.getConfig(MODULE_NAME, ({realTimeData}) => {
    if (!realTimeData.dataProviders) {
      logError('missing parameters for real time module');
      return;
    }
    confListener(); // unsubscribe config listener
    _moduleConfig = realTimeData;
    _dataProviders = realTimeData.dataProviders;
    setEventsListeners();
    getHook('startAuction').before(setBidRequestsData, 20); // RTD should run before FPD
    adapterManager.callDataDeletionRequest.before(onDataDeletionRequest);
    initSubModules();
  });
}

function getConsentData() {
  return {
    gdpr: gdprDataHandler.getConsentData(),
    usp: uspDataHandler.getConsentData(),
    gpp: gppDataHandler.getConsentData(),
    coppa: !!(config.getConfig('coppa'))
  }
}

/**
 * call each sub module init function by config order
 * if no init function / init return failure / module not configured - remove it from submodules list
 */
function initSubModules() {
  _userConsent = getConsentData();
  let subModulesByOrder = [];
  _dataProviders.forEach(provider => {
    const sm = ((registeredSubModules) || []).find(s => s.name === provider.name);
    const initResponse = sm && sm.init && sm.init(provider, _userConsent);
    if (initResponse) {
      subModulesByOrder.push(Object.assign(sm, {config: provider}));
    }
  });
  subModules = subModulesByOrder;
  logInfo(`Real time data module enabled, using submodules: ${subModules.map((m) => m.name).join(', ')}`);
}

/**
 * loop through configured data providers If the data provider has registered getBidRequestData,
 * call it, providing reqBidsConfigObj, consent data and module params
 * this allows submodules to modify bidders
 * @param {Object} reqBidsConfigObj required; This is the same param that's used in pbjs.requestBids.
 * @param {function} fn required; The next function in the chain, used by hook.js
 */
export const setBidRequestsData = timedAuctionHook('rtd', function setBidRequestsData(fn, reqBidsConfigObj) {
  _userConsent = getConsentData();

  const relevantSubModules = [];
  const prioritySubModules = [];
  subModules.forEach(sm => {
    if (typeof sm.getBidRequestData !== 'function') {
      return;
    }
    relevantSubModules.push(sm);
    const config = sm.config;
    if (config && config.waitForIt) {
      prioritySubModules.push(sm);
    }
  });

  const shouldDelayAuction = prioritySubModules.length && _moduleConfig?.auctionDelay > 0;
  let callbacksExpected = prioritySubModules.length;
  let isDone = false;
  let waitTimeout;
  const verifiers = [];

  if (!relevantSubModules.length) {
    return exitHook();
  }

  const timeout = shouldDelayAuction ? _moduleConfig.auctionDelay : 0;
  waitTimeout = setTimeout(exitHook, timeout);

  relevantSubModules.forEach(sm => {
    const fpdGuard = guardOrtb2Fragments(reqBidsConfigObj.ortb2Fragments || {}, activityParams(MODULE_TYPE_RTD, sm.name));
    verifiers.push(fpdGuard.verify);
    reqBidsConfigObj.ortb2Fragments = fpdGuard.obj;
    sm.getBidRequestData(reqBidsConfigObj, onGetBidRequestDataCallback.bind(sm), sm.config, _userConsent, timeout);
  });

  function onGetBidRequestDataCallback() {
    if (isDone) {
      return;
    }
    if (this.config && this.config.waitForIt) {
      callbacksExpected--;
    }
    if (callbacksExpected === 0) {
      setTimeout(exitHook, 0);
    }
  }

  function exitHook() {
    if (isDone) {
      return;
    }
    isDone = true;
    clearTimeout(waitTimeout);
    verifiers.forEach(fn => fn());
    fn.call(this, reqBidsConfigObj);
  }
});

/**
 * loop through configured data providers If the data provider has registered getTargetingData,
 * call it, providing ad unit codes, consent data and module params
 * the sub mlodle will return data to set on the ad unit
 * this function used to place key values on primary ad server per ad unit
 * @param {Object} auction object received on auction end event
 */
export function getAdUnitTargeting(auction) {
  const relevantSubModules = subModules.filter(sm => typeof sm.getTargetingData === 'function');
  if (!relevantSubModules.length) {
    return;
  }

  // get data
  const adUnitCodes = auction.adUnitCodes;
  if (!adUnitCodes) {
    return;
  }
  let targeting = [];
  for (let i = relevantSubModules.length - 1; i >= 0; i--) {
    const smTargeting = relevantSubModules[i].getTargetingData(adUnitCodes, relevantSubModules[i].config, _userConsent, auction);
    if (smTargeting && typeof smTargeting === 'object') {
      targeting.push(smTargeting);
    } else {
      logWarn('invalid getTargetingData response for sub module', relevantSubModules[i].name);
    }
  }
  // place data on auction adUnits
  const mergedTargeting = deepMerge(targeting);
  auction.adUnits.forEach(adUnit => {
    const kv = adUnit.code && mergedTargeting[adUnit.code];
    if (!kv) {
      return
    }
    logInfo('RTD set ad unit targeting of', kv, 'for', adUnit);
    adUnit[JSON_MAPPING.ADSERVER_TARGETING] = Object.assign(adUnit[JSON_MAPPING.ADSERVER_TARGETING] || {}, kv);
  });
  return auction.adUnits;
}

/**
 * deep merge array of objects
 * @param {Array} arr - objects array
 * @return {Object} merged object
 */
export function deepMerge(arr) {
  if (!Array.isArray(arr) || !arr.length) {
    return {};
  }
  return arr.reduce((merged, obj) => {
    for (let key in obj) {
      if (obj.hasOwnProperty(key)) {
        if (!merged.hasOwnProperty(key)) merged[key] = obj[key];
        else {
          // duplicate key - merge values
          const dp = obj[key];
          for (let dk in dp) {
            if (dp.hasOwnProperty(dk)) merged[key][dk] = dp[dk];
          }
        }
      }
    }
    return merged;
  }, {});
}

export function onDataDeletionRequest(next, ...args) {
  subModules.forEach((sm) => {
    if (typeof sm.onDataDeletionRequest === 'function') {
      try {
        sm.onDataDeletionRequest(sm.config);
      } catch (e) {
        logError(`Error executing ${sm.name}.onDataDeletionRequest`, e)
      }
    }
  });
  next.apply(this, args);
}

module('realTimeData', attachRealTimeDataProvider);
init(config);
