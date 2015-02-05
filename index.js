'use strict';

// node core
var assert = require('assert'),
  url = require('url'),
  util = require('util');

// 3rd party
var _ = require('lodash'),
  debug = require('debug'),
  request = require('request'),
  limit = require('oniyi-limiter');

// internal dependencies
var RequestorError = require('./errors/RequestorError'),
  makeRedisClient = require('./lib/make-redis-client'),
  cacheEvaluator = require('./lib/cache/evaluator'),
  cacheStorage = require('./lib/cache/storage');

// variables and functions
var moduleName = 'oniyi-requestor';


var logError = debug(moduleName + ':error');
// set this namespace to log via console.error
logError.log = console.error.bind(console); // don't forget to bind to console!

var logWarn = debug(moduleName + ':warn');
// set all output to go via console.warn
logWarn.log = console.warn.bind(console);

var logDebug = debug(moduleName + ':debug');
// set all output to go via console.warn
logDebug.log = console.warn.bind(console);

function parseargs(args) {
  var opts = {};

  if (typeof args[0] === 'string') {
    opts.url = args[0];
  } else if (typeof args[0] === 'object') {
    opts = args[0];
  } else {
    throw new Error("Don't understand argument type at arguments 0 " + args[0]);
  }

  if (typeof args[1] === 'object') {
    opts = args[1];
    opts.url = args[0];
  } else if (typeof args[1] === 'function') {
    opts.callback = args[1];
  } else if (typeof args[1] !== 'undefined') {
    throw new Error("Don't understand argument type at arguments 1 " + args[1]);
  }

  if (typeof args[2] === 'function') {
    opts.callback = args[2];
  } else if (typeof args[2] !== 'undefined') {
    throw new Error("Don't understand argument type at arguments 2 " + args[2]);
  }

  if (opts.url) {
    opts.uri = opts.url;
  }
  if (opts.uri) {
    opts.url = opts.uri;
  }

  opts.parsedUrl = url.parse(opts.uri);

  return opts;
}

function cacheProcessedResponseBody(err, result, type, redisClient, cacheKeys, expireat) {
  if (err) {
    // the parsing failed -> there must be something wrong with this content -> better delete it from cache
    redisClient.del(cacheKeys.raw);
    redisClient.del(cacheKeys.response);
    return;
  }
  if (result && typeof result === 'string') {
    redisClient.set(cacheKeys.processed, result, function() {
      if (expireat) {
        redisClient.expireat(cacheKeys.processed, expireat);
      }
    });
  }
}

var serializableResponseProperties = [
  // 'headers',
  'trailers',
  'method',
  'statusCode',
  'httpVersion',
  'httpVersionMajor',
  'httpVersionMinor'
];

function serializeResponse(resp) {
  return JSON.stringify(_.merge(_.pick(resp, serializableResponseProperties), {
    headers: _.omit(resp.headers, ['set-cookie']),
    fromCache: true
  }));
}

function Requestor(args) {
  var self = this;
  
  // make sure args is a plain object
  if (!_.isPlainObject(args)) {
    args = {};
  }

  var opts = _.merge({
    throttle: {},
    maxLockTime: 5000, // these are milliseconds
    disableCache: false,
    cache: {},
  }, _.pick(args, ['redisClient', 'throttle', 'maxLockTime', 'disableCache', 'cache']));

  if (!opts.redisClient) {
    opts.redisClient = makeRedisClient(_.merge(args, {
      logDebug: logDebug,
      logError: logError
    }));
  }

  // check pre-requisites
  assert(opts.redisClient, '.redisClient required');

  // get the provided throttling information per endpoint (host) if any
  self.limits = _.reduce(opts.throttle, function(result, conf, endpoint) {
    // create one oniyi-limiter instance per endpoint
    result[endpoint] = new limit(_.merge({}, conf, {
      id: endpoint,
      redisClient: opts.redisClient
    }));
    return result;
  }, {});

  // get the provided cache information per endpoint (host) if any
  if (!opts.disableCache) {
    self.cacheSettings = _.reduce(opts.cache, function(result, conf, endpoint) {
      result[endpoint] = _.pick(conf, ['storePrivate', 'storeNoStore', 'ignoreNoLastMod', 'requestValidators', 'responseValidators']);
      return result;
    }, {});

    self.storage = new cacheStorage();
  }

  self.receivedRequests = 0;
  self.cacheMiss = 0;
  self.servedFromCache = 0;

  _.merge(self, _.pick(opts, ['redisClient', 'maxLockTime', 'disableCache']));
}

Requestor.prototype.addLimit = function(args) {
  var self = this,
    error;

  if (!_.isFunction(args.callback)) {
    args.callback = _.noop;
  }
  if (!_.isString(args.endpoint)) {
    error = new RequestorError('OR-E 001', 'args.endpoint must be provided');
    args.callback(error, null);
    return false;
  }
  if (!_.isUndefined(self.limits[args.endpoint])) {
    logWarn('can not overwrite existing limits for endpoint {%s}', args.endpoint);
    error = new RequestorError('OR-E 002', args.endpoint);
    args.callback(error, null);
    return false;
  }

  self.limits[args.endpoint] = new limit(_.merge({}, args, {
    id: args.endpoint,
    redisClient: self.redisClient
  }));
  args.callback(null, self.limits[args.endpoint]);
  return true;
};

Requestor.prototype.addCacheSetting = function(args) {
  var self = this,
    error;

  if (!_.isFunction(args.callback)) {
    args.callback = _.noop;
  }
  if (self.disableCache) {
    error = new RequestorError('OR-E 003');
    args.callback(error, null);
    return false;
  }
  if (!_.isString(args.endpoint)) {
    error = new RequestorError('OR-E 004', 'args.endpoint must be provided');
    args.callback(error, null);
    return false;
  }
  if (!_.isUndefined(self.cacheSettings[args.endpoint])) {
    logWarn('can not overwrite existing cache settings for endpoint {%s}', args.endpoint);
    error = new RequestorError('OR-E 005', args.endpoint);
    args.callback(error, null);
    return false;
  }

  self.cacheSettings[args.endpoint] = _.pick(args, ['storePrivate', 'storeNoStore', 'ignoreNoLastMod', 'requestValidators', 'responseValidators']);
  args.callback(null, self.cacheSettings[args.endpoint]);
  return true;
};

Requestor.prototype.throttle = function(args) {
  var self = this;
  if (!args.disableCache && self.limits[args.parsedUrl.host]) {
    var dummyRequestor;
    self.limits[args.parsedUrl.host].getBucket(function(err, bucket) {
      if (err) {
        return args.callback(err, null);
      }
      if (bucket.remaining < 0) {
        return args.callback(new Error(util.format('request limit {%d} for {%s} reached, please retry after {%s}', bucket.limit, args.parsedUrl.host, new Date(parseInt(bucket.reset, null)))));
      }
      dummyRequestor = request(args.uri, args, args.callback);
    });
    return dummyRequestor;
  }
  return request(args.uri, args, args.callback);
};

Requestor.prototype.handleRequest = function(options) {
  if (!options.uri) {
    logDebug('No valid uri in request options: %j', options);
    throw new Error('There is no valid uri provided for this request');
  }
  var self = this;

  // bypass caching completely if redisClient is not connected
  if ((!self.redisClient.connected) || self.disableCache || options.disableCache) {
    return self.throttle(options);
  }

  // pick this requestor instance's cache settings and merge them with cache flags from the request 
  var cacheSettings = _.merge(self.cacheSettings[options.parsedUrl.host], _.pick(options, ['storePrivate', 'storeNoStore', 'ignoreNoLastMod']));

  // if the request defines request validators, concatenate them with this instance's defaults
  // request specific validators will be first in this array so they get executed first
  if (_.isArray(options.requestValidators)) {
    cacheSettings.requestValidators = options.requestValidators.concat(cacheSettings.requestValidators);
  }
  // if the request defines response validators, concatenate them with this instance's defaults
  // request specific validators will be first in this array so they get executed first
  if (_.isArray(options.responseValidators)) {
    cacheSettings.responseValidators = options.responseValidators.concat(cacheSettings.responseValidators);
  }

  var evaluator = new cacheEvaluator(cacheSettings);

  var requestHash = self.storage.hash(options);

  var cacheKeys = {
    lock: util.format('%s:lock:%s', moduleName, requestHash),
    response: util.format('%s:cache:%s:response', moduleName, requestHash),
    raw: util.format('%s:cache:%s:raw', moduleName, requestHash),
    processed: util.format('%s:cache:%s:processed', moduleName, requestHash)
  };

  var originalCallback = options.callback;

  function unlockRequestAndCacheResponse(err, response, body) {
    var now = Math.round(Date.now() / 1000),
      expireat = false;

    var unlockAndCache = self.redisClient.multi()
      .del(cacheKeys.lock);

    if (err) {
      logError('Executing {%s} request to {%s} failed', options.method, options.uri);
      logDebug(err);
      logDebug(util.inspect(options));
      evaluator.flagStorable(false);
    }
    if (evaluator && evaluator.isStorable(response)) {
      // only cache the response when statusCode is within the defined list
      if (typeof options.ttl === 'number') {
        expireat = now + options.ttl;
      } else if ((response.headers['cache-control'] || '') !== '') {
        var maxAge = response.headers['cache-control'].match(/s-maxage=([0-9]+)/);
        if (!(_.isArray(maxAge) && maxAge[1])) {
          maxAge = response.headers['cache-control'].match(/maxage=([0-9]+)/);
        }
        if (!(_.isArray(maxAge) && maxAge[1])) {
          maxAge = false;
          expireat = false;
        }
        if (maxAge) {
          expireat = (maxAge) ? now + parseInt(maxAge, null) : false;
        }
      }
      if (!expireat && (response.headers['expires'] || '') !== '') {
        expireat = Math.round((new Date(response.headers['expires'])).getTime() / 1000);
      }

      // store the serialized response object and the raw response in redis cache
      unlockAndCache
        .set(cacheKeys.response, serializeResponse(response))
        .set(cacheKeys.raw, body);

      if (_.isNumber(expireat)) {
        unlockAndCache
          .expireat(cacheKeys.response, expireat)
          .expireat(cacheKeys.raw, expireat);
      }
    } else {
      self.redisClient.publish(cacheKeys.lock, 'not-storable');
    }

    unlockAndCache.exec(function(error, res) {
      if (error) {
        logWarn('Failed to store response in cache response {%s}; raw {%s}, expire-response {%s}, expire-raw {%s}', res[0], res[1], res[2], res[3]);
        logDebug(error);
      }
      if (res[0] === 1) {
        self.redisClient.publish(cacheKeys.lock, 'released');
      }
      originalCallback(err, response, body, function(err, result, type) {
        type = (['string'].indexOf(type) > -1) ? type : 'string';
        cacheProcessedResponseBody(err, result, type, self.redisClient, cacheKeys, expireat);
      });
    });
  }

  // since buffer piping requires streams and this current implementation wouldn't represent a stream if response comes from cache,
  // the requesting code can set opts.requiresPipe to true, which bypasses the cache implementation, too
  // we also check the connection status of our redis client. If the client is not connected, waiting for the connection could potentially
  // cause the request processing to take longer than without caching. Thus we bypass cache when our redis client is not connected

  // @TODO: since redisClient provides a property to keep track of currently queued commands,
  // we could additionally provide a threashold for at which command queue lenght we should start bypassing the cache and call the backend directly
  // this.redisClient.command_queue.length

  // if not retrievable, neve use lock feature --> response MUST not be retreived from cache!
  if (!evaluator.isRetrievable(options)) {
    // if none of the retrievable validators have set the evaluator.storable to "false",
    // we overwrite the callback with the one that tries to cache the response
    if (evaluator.storable !== false) {
      options.callback = unlockRequestAndCacheResponse;
    }
    return self.throttle(options);
  }

  if (options.forceFresh) {
    // if none of the retrievable validators have set the evaluator.storable to "false",
    // we overwrite the callback with the one that tries to cache the response
    if (evaluator.storable !== false) {
      options.callback = unlockRequestAndCacheResponse;
    }
    return self.throttle(options);
  }

  self.redisClient.mget(cacheKeys.response, cacheKeys.raw, cacheKeys.processed, function(err, res) {
    options.unlockRequestAndCacheResponse = unlockRequestAndCacheResponse;
    if (err) {
      logError('Failed to receive cacheKeys from redis: %j', err);
      return self.lock(options, cacheKeys);
    }
    if (!res[0] && res[0] !== 0) {
      logDebug('"response" key {%s} does not exist --> executing new request', cacheKeys.response);
      self.cacheMiss++;
      return self.lock(options, cacheKeys);
    }
    var response = JSON.parse(res[0]);

    if (res[2]) {
      response.processed = true;
      self.servedFromCache++;
      return options.callback(null, response, res[2]);
    }
    if (res[1]) {
      self.servedFromCache++;
      return options.callback(null, response, res[1]);
    }
    return self.lock(options, cacheKeys);
  });
};

Requestor.prototype.lock = function(options, keys) {
  var self = this;
  self.redisClient.set(keys.lock, 'locked', 'PX', self.maxLockTime, 'NX', function(err, result) {
    if (err) {
      logError('An error occured while aquiring lock for {%s}', keys.lock);
      logDebug(err);
      options.callback = options.unlockRequestAndCacheResponse;
      return self.throttle(options);
    }
    if (result === null) {
      logDebug('Lock for {%s} is taken already', keys.lock);
      // subscribe to lock release
      var client = makeRedisClient(self.redisOptions);

      var timeout = setTimeout(function(){
        logDebug('Waited %d milliseconds on timeout release for %s, aborted', self.maxLockTime, keys.lock);
        options.disableCache = true;
        client.unsubscribe();
        client.end();
        self.handleRequest(options);
      }, self.maxLockTime);

      client.on('message', function(channel, message) {
        if (channel === keys.lock) {
          clearTimeout(timeout);
          if (message === 'not-storable') {
            logDebug('Received not-storable notification for {%s}', keys.lock);
            logDebug('will set options accordingly and re-execute request');
            options.disableCache = true;
          }
          if (message === 'released') {
            logDebug('Received lock release notification for {%s}', keys.lock);
          }
          client.unsubscribe();
          client.end();
          self.handleRequest(options);
        }
      });
      return client.subscribe(keys.lock);
    }
    logDebug('Aquired lock for {%s}, executing throttled request now', keys.lock);
    options.callback = options.unlockRequestAndCacheResponse;
    self.throttle(options);
  });
};

['delete', 'put', 'get', 'head', 'post', 'patch'].forEach(function(method) {
  Requestor.prototype[method] = function() {
    this.receivedRequests++;
    var opts = parseargs(Array.prototype.slice.call(arguments, 0));
    opts.method = method.toUpperCase();
    return this.handleRequest(opts);
  };
});

['defaults', 'forever', 'jar', 'cookie'].forEach(function(method) {
  Requestor.prototype[method] = function() {
    return request[method].call(request, arguments);
  };
});

module.exports = Requestor;