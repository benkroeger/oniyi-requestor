/*
 * The basic concept here has been borrowed from Chris Corbyn's node-http-cache.
 *
 */

/**
 * Namespace to house all built-in validators.
 */
var Validators = module.exports = {
  request: {},
  response: {}
};

/* -- Request validators -- */

Validators.request.disableCache = function(requestOptions, evaluator) {
  if (requestOptions.disableCache === true) {
    evaluator.flagStorable(false);
    evaluator.flagRetrievable(false);
    return true;
  }
  return false;
};

/**
 * Checks if the request's max-age is zero, rendering it uncacheable.
 *
 * RFC 2616 Section 13.1.6.
 */
Validators.request.maxAgeZero = function(requestOptions, evaluator) {
  if ((requestOptions.headers['cache-control'] || '').match(/max-age=(0|-[0-9]+)/)) {
    evaluator.flagStorable(true);
    evaluator.flagRetrievable(false);
    return true;
  }
  return false;
};

/**
 * Checks if request cache-control/pragma states no-cache.
 *
 * RFC 2616 Section 14.9.
 */
Validators.request.noCache = function(requestOptions, evaluator) {
  if ((requestOptions.headers['cache-control'] || '').match(/no-cache/)) {
    evaluator.flagStorable(false);
    evaluator.flagRetrievable(false);
    return true;
  }
  if ((requestOptions.headers['pragma'] || '') === 'no-cache') {
    evaluator.flagStorable(false);
    evaluator.flagRetrievable(false);
    return true;
  }
  return false;
};

/**
 * Checks if request cache-control states no-cache, rendering it uncacheable.
 *
 * RFC 2616 Section 14.9.
 */
Validators.request.noStore = function(requestOptions, evaluator) {
  if ((requestOptions.headers['cache-control'] || '').match(/no-store/)) {
    evaluator.flagStorable(false);
    evaluator.flagRetrievable(false);
    return true;
  }
  return false;
};

/**
 * Blindly make the request cacheable if the method is GET or HEAD.
 *
 * Anything else is uncacheable. RFC 2616 Section 13.9.
 *
 * This is the final validator in the listener chain.
 */
Validators.request.methodGetOrHead = function(requestOptions, evaluator) {
  var flag = (requestOptions.method === 'GET' || requestOptions.method === 'HEAD');
  evaluator.flagRetrievable(flag);
  return true;
};

/* -- Response validators -- */

/**
 * Checks if response cache-control states private, rendering it uncacheable.
 *
 * RFC 2616 Section 14.9.
 */
Validators.response.onlyPrivate = function(response, evaluator) {
  if ((response.headers['cache-control'] || '').match(/private/) && !evaluator.storePrivate) {
    evaluator.flagStorable(false);
    return true;
  }
  return false;
};

/**
 * Checks if response cache-control states no-cache, rendering it uncacheable.
 *
 * RFC 2616 Section 14.9.
 */
Validators.response.noStore = function(response, evaluator) {
  if ((response.headers['cache-control'] || '').match(/no-store(?!=)/) && !evaluator.storeNoStore) {
    evaluator.flagStorable(false);
    return true;
  }
  return false;
};

/**
 * Checks if response cache-control states max-age=0, rendering it uncacheable.
 *
 * RFC 2616 Section 14.9.
 */
Validators.response.maxAgeZero = function(response, evaluator) {
  if ((response.headers['cache-control'] || '').match(/max-age=(0|-[0-9]+)/)) {
    evaluator.flagStorable(false);
    return true;
  }
  return false;
};

/**
 * Checks if response cache-control states max-age, allowing it to be cached.
 *
 * RFC 2616 Section 14.9.
 */
Validators.response.maxAgeFuture = function(response, evaluator) {
  if ((response.headers['cache-control'] || '').match(/max-age=[0-9]+/)) {
    evaluator.flagStorable(true);
    return true;
  }
  return false;
};

/**
 * Checks if the weak validator Last-Modified is present in the response.
 *
 * RFC 2616 Section 13.3.1.
 */
Validators.response.lastModified = function(response, evaluator) {
  if (typeof response.headers['last-modified'] !== 'undefined' && !evaluator.ignoreNoLastMod) {
    evaluator.flagStorable(true);
    return true;
  }
  return false;
};

/**
 * Checks if the strong validator ETag is present in the response.
 *
 * RFC 2616 Section 13.3.2.
 */
Validators.response.eTag = function(response, evaluator) {
  if (typeof response.headers['etag'] !== 'undefined') {
    evaluator.flagStorable(true);
    return true;
  }
  return false;
};

var CacheableStatusCodes = {
  200: 'OK',
  203: 'Non-Authoritative Information',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  401: 'Unauthorized'
};

/**
 * Invalidates HTTP response codes as stipulated in RFC 2616.
 */
Validators.response.statusCodes = function(response, evaluator) {
  if (!(response.statusCode in CacheableStatusCodes)) {
    evaluator.flagStorable(false);
    return true;
  }
  return false;
};

/** All request validators, to be executed in order */
Validators.requestValidators = [
  Validators.request.disableCache,
  Validators.request.noCache,
  Validators.request.noStore,
  Validators.request.maxAgeZero,
  Validators.request.methodGetOrHead
];

/** All response validators, to be executed in order */
Validators.responseValidators = [
  Validators.response.onlyPrivate,
  Validators.response.noStore,
  Validators.response.maxAgeZero,
  Validators.response.maxAgeFuture,
  Validators.response.lastModified,
  Validators.response.eTag,
  Validators.response.statusCodes
];