'use strict';

// 3rd party
var _ = require('lodash'),
  request = require('request'),
  toughCookie = require('tough-cookie'),
  makeRedisClient = require('make-redis-client'),
  OniyiLimiter = require('oniyi-limiter'),
  OniyiCache = require('oniyi-cache');

// variables and functions
var redisClient,
  cache,
  limits = {};

var Request = require('./lib/request');
var helpers = require('./lib/helpers');
var paramsHaveRequestBody = helpers.paramsHaveRequestBody;
var parseUri = helpers.parseUri;
var needAsyncJarHandler = helpers.needAsyncJarHandler;

function requestor(uri, options, callback) {
  if (typeof uri === 'undefined') {
    throw new Error('undefined is not a valid uri or options object.');
  }

  var params = request.initParams(uri, options, callback);

  if (params.method === 'HEAD' && paramsHaveRequestBody(params)) {
    throw new Error('HTTP HEAD requests MUST NOT include a request body.');
  }

  params = parseUri(params);

  var limit = limits[params.uri.host] || null;
  var asyncJar = needAsyncJarHandler(params);
  var canCache = (cache && params.disableCache !== true);

  if (asyncJar || canCache || limit) {
    return new Request(params, cache, limit);
  }

  return new request.Request(params);
}

var verbs = ['get', 'head', 'post', 'put', 'patch', 'del'];

verbs.forEach(function(verb) {
  var method = (verb === 'del') ? 'DELETE' : verb.toUpperCase();
  requestor[verb] = function(uri, options, callback) {
    var params = request.initParams(uri, options, callback);
    params.method = method;
    return requestor(params, params.callback);
  };
});

requestor.cookie = function(str) {
  return new toughCookie.Cookie.parse(str);
};

requestor.jar = function(store) {
  return new toughCookie.CookieJar(store);
};

function setRedisOptions(options) {
  if (redisClient) {
    throw new Error('a Redis Client exists already');
  }
  // default to an empty options object
  options = options || {};

  redisClient = makeRedisClient(options);
  return requestor;
}

function enableCache(options) {
  if (!redisClient) {
    throw new Error('a Redis Client must exist prior to enabling cache');
  }

  // don't create a new cache instance if we have one already
  if (cache) {
    return cache;
  }

  options.redisClient = redisClient;
  cache = new OniyiCache(options);
  return requestor;
}

function addCacheOptions(options) {
  if (!cache) {
    throw new Error('cache must be enabled before setting options');
  }
  cache.addHostConfigs(options);
  return requestor;
}

function setLimits(options) {
  if (!redisClient) {
    throw new Error('a Redis Client must exist prior to defining limits');
  }

  limits = limits || {};

  _.reduce(options, function(result, conf, hostname) {
    if (result[hostname]) {
      return result;
    }

    result[hostname] = new OniyiLimiter(_.merge({}, conf, {
      id: hostname,
      redisClient: redisClient
    }));
    return result;
  }, limits);

  return requestor;
}

module.exports = requestor;
requestor.setRedisOptions = setRedisOptions;
requestor.enableCache = enableCache;
requestor.addCacheOptions = addCacheOptions;
requestor.setLimits = setLimits;
