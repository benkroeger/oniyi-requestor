'use strict';

// node core
var assert = require('assert'),
  url = require('url'),
  util = require('util');

// 3rd party
var _ = require('lodash'),
  makeRedisClient = require('make-redis-client'),
  request = require('request'),
  OniyiLocker = require('oniyi-locker'),
  OniyiLimiter = require('oniyi-limiter'),
  OniyiCache = require('oniyi-cache');

// internal dependencies
var RequestorError = require('./errors/RequestorError');

// variables and functions
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

function Requestor(args) {
  var self = this;

  // make sure args is a plain object
  if (!_.isPlainObject(args)) {
    args = {};
  }

  var opts = _.merge({
    redis: {},
    throttle: {},
    maxLockTime: 5000, // these are milliseconds
    maxLockAttemps: 5,
    disableCache: false,
    cache: {},
  }, _.pick(args, ['redis', 'throttle', 'maxLockTime', 'disableCache', 'cache']));

  opts.redisClient = makeRedisClient(args.redis || {});

  // check pre-requisites
  assert(opts.redisClient, '.redisClient required');

  self.locker = new OniyiLocker({
    redisOptions: args.redis
  });
  // get the provided throttling information per endpoint (host) if any
  self.limits = _.reduce(opts.throttle, function(result, conf, endpoint) {
    // create one oniyi-limiter instance per endpoint
    result[endpoint] = new OniyiLimiter(_.merge({}, conf, {
      id: endpoint,
      redisClient: opts.redisClient
    }));
    return result;
  }, {});

  // create cache instance with the provided cache configuration object.
  // this object is a hostname indexed hash of cache validator settings (storePrivate, storeNoStore, ignoreNoLastMod, requestValidators, responseValidators)

  if (!opts.disableCache) {
    self.cache = new OniyiCache({
      hostConfig: opts.cache,
      redisClient: opts.redisClient
    });
  }

  self.receivedRequests = 0;
  self.cacheMiss = 0;
  self.servedFromCache = 0;

  _.merge(self, _.pick(opts, ['redisClient', 'maxLockTime', 'maxLockAttemps', 'disableCache']));
}

// Debugging
Requestor.debug = process.env.NODE_DEBUG && /\boniyi-requestor\b/.test(process.env.NODE_DEBUG);

function debug() {
  if (Requestor.debug) {
    console.error('OniyiRequestor %s', util.format.apply(util, arguments));
  }
}

// general functions
function makePassBackToCacheFunction(storable, cache, hash, expireAt) {
  if (!storable) {
    // clean up what we have in cache already (response + raw);
    debug('response for hash {%s} is not storable --> purging cache', hash);
    cache.purge(hash);
    return _.noop;
  }

  return function(err, result) {
    if (err) {
      // the parsing failed -> there must be something wrong with this content -> better delete it from cache
      cache.purge(hash);
    }
    if (typeof result === 'string') {
      cache.put({
        hash: hash,
        parsed: result,
        expireAt: expireAt
      });
    }
  };
}

// prototype definitions
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
    debug('can not overwrite existing limits for endpoint {%s}', args.endpoint);
    error = new RequestorError('OR-E 002', args.endpoint);
    args.callback(error, null);
    return false;
  }

  self.limits[args.endpoint] = new OniyiLimiter(_.merge({}, args, {
    id: args.endpoint,
    redisClient: self.redisClient
  }));
  args.callback(null, self.limits[args.endpoint]);
  return true;
};

Requestor.prototype.addCacheSetting = function(args) {
  var self = this;
  return self.cache.addHostConfigs(args);
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
    debug('No valid uri in request options: %j', options);
    throw new Error('There is no valid uri provided for this request');
  }
  var self = this;

  // bypass caching if redis is not connected or cache is disabled
  if ((!self.redisClient.connected) || self.disableCache || options.disableCache) {
    return self.throttle(options);
  }

  var evaluator = self.cache.getEvaluator(options.parsedUrl.host, options);

  var requestHash = self.cache.hash(options);

  var originalCallback = options.callback;

  function unlockRequestAndCacheResponse(err, response, body) {
    var now = Math.round(Date.now() / 1000),
      expireAt = null;

    if (err) {
      debug('Executing {%s} request to {%s} failed', options.method, options.uri);
      debug(err);
      evaluator.flagStorable(false);

      // unlock the request and abort caching
      return self.locker.unlock({
        key: requestHash,
        token: options.unlockToken,
        message: 'not-storable',
        callback: function(unlockError) {
          if (unlockError) {
            debug(unlockError);
          }
          originalCallback(err, response, body, makePassBackToCacheFunction(!!evaluator.storable, self.cache, requestHash, expireAt));
        }
      });
    }

    if (!(evaluator && evaluator.isStorable(response))) {
      return self.locker.unlock({
        key: requestHash,
        token: options.unlockToken,
        message: 'not-storable',
        callback: function(unlockError) {
          if (unlockError) {
            debug(unlockError);
          }
          originalCallback(err, response, body, makePassBackToCacheFunction(!!evaluator.storable, self.cache, requestHash, expireAt));
        }
      });
    }

    // determine the expireAt timestamp (either from provided ttl or from response headers)
    if (_.isNumber(options.ttl)) {
      // we have a ttl defined for this request --> use it!
      expireAt = now + options.ttl;
    } else if (_.isString(response.headers['cache-control'])) {
      // we have a cache-control header
      // check for s-maxage value first
      var maxAge = response.headers['cache-control'].match(/s-maxage=([0-9]+)/);

      if (!(_.isArray(maxAge) && maxAge[1])) {
        // fallback to maxage when s-maxage wasn't found
        maxAge = response.headers['cache-control'].match(/maxage=([0-9]+)/);
      }

      if ((_.isArray(maxAge) && maxAge[1])) {
        // maxage was found
        expireAt = now + parseInt(maxAge[1], null);

      } else if ((response.headers['expires'] || '') !== '') {
        // no maxage found, try our luck with the expires header
        expireAt = Math.round((new Date(response.headers['expires'])).getTime() / 1000);
      }
    }

    // store the serialized response object and the raw response in cache
    self.cache.put({
      hash: requestHash,
      response: response,
      raw: body,
      expireAt: expireAt
    }, function(cacheError) {
      // and then release the request lock
      if (cacheError) {
        debug(cacheError);
      }
      return self.locker.unlock({
        key: requestHash,
        token: options.unlockToken,
        message: 'released',
        callback: function(unlockError) {
          if (unlockError) {
            debug(unlockError);
          }
          originalCallback(err, response, body, makePassBackToCacheFunction(!!evaluator.storable, self.cache, requestHash, expireAt));
        }
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

  self.cache.get(requestHash, function(err, data) {
    options.unlockRequestAndCacheResponse = unlockRequestAndCacheResponse;

    if (err) {
      debug('An error occured when loading data from cache for {%s}', requestHash);
      debug(err);
      return self.lockAndExecute(options, requestHash);
    }

    // verify that we received the bare minimum from cache (response object and raw data)
    if (!(data && data.response && data.raw)) {
      debug('no data in cache for {%s} --> executing new request', requestHash);
      self.cacheMiss++;
      return self.lockAndExecute(options, requestHash);
    }

    // if we have the received parsed data from cache, respond with that
    if (data.parsed) {
      data.response.parsed = true;
      self.servedFromCache++;
      return options.callback(null, data.response, data.parsed);
    }

    // otherwise respond with the raw data
    if (data.raw) {
      self.servedFromCache++;
      return options.callback(null, data.response, data.raw);
    }

    // fallback! when all conditions above fail, execute a new request
    return self.lockAndExecute(options, requestHash);
  });
};

Requestor.prototype.lockAndExecute = function(options, hash) {
  var self = this;
  self.locker.lock({
    key: hash,
    expiresAfter: self.maxLockTime,
    callback: function(err, data) {
      if (err) {
        debug('An error occured while aquiring lock for {%s}', hash);
        debug(err);
        options.callback = options.unlockRequestAndCacheResponse;
        return self.throttle(options);
      }

      switch (data.state) {
        case 'locked':
          debug('Aquired lock for {%s}, executing throttled request now', hash);
          options.unlockToken = data.token;
          options.callback = options.unlockRequestAndCacheResponse;
          self.throttle(options);
          break;
        case 'timeout':
          options.lockAttemp = (_.isNumber(options.lockAttemp)) ? options.lockAttemp + 1 : 1;
          if (options.lockAttemp > self.maxLockAttemps) {
            // @TODO: there might be a better way to disable locking for this kind of requests
            options.disableCache = true;
          }
          self.handleRequest(options);
          break;
        case 'not-storable':
          debug('Received not-storable notification for {%s}', hash);
          debug('will set options accordingly and re-execute request');
          options.disableCache = true;
          self.handleRequest(options);
          break;
        case 'released':
          debug('Received lock release notification for {%s}', hash);
          self.handleRequest(options);
          break;
      }
    }
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