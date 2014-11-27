/*
 *
 * https://github.com/benkroeger/oniyi-requestor
 *
 * Copyright (c) 2014 Benjamin Kroeger
 * Licensed under the MIT license.
 */

'use strict';
var util = require('util'),
  _ = require('lodash'),
  limit = require('../lib/limiter'),
  request = require('request'),
  url = require('url'),
  querystring = require('querystring'),
  redis = require('redis');

var debug = require('debug'),
  moduleName = 'oniyi-requestor';

var logError = debug(moduleName + ':error');
// set this namespace to log via console.error
logError.log = console.error.bind(console); // don't forget to bind to console!

var logWarn = debug(moduleName + ':warn');
// set all output to go via console.warn
logWarn.log = console.warn.bind(console);

var logDebug = debug(moduleName + ':debug');
// set all output to go via console.warn
logDebug.log = console.warn.bind(console);

var defaults = {
  ttl: 180
};

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

  return opts;
}

function ignoreCache(options) {
  return (options.method !== 'GET' || options.encoding === null || options.requiresPipe || options.noCache);
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
  'httpVersion',
  'headers',
  'trailers',
  'method',
  'statusCode',
  'httpVersionMajor',
  'httpVersionMinor'
];

function serializeResponse(resp) {
  return JSON.stringify(_.pick(resp, serializableResponseProperties));
}

var validRedisOptions = [
  'unixSocket',
  'host',
  'port',
  'parser',
  'return_buffers',
  'detect_buffers',
  'socket_nodelay',
  'socket_keepalive',
  'no_ready_check',
  'enable_offline_queue',
  'retry_max_delay',
  'retry_max_delay',
  'connect_timeout',
  'max_attempts',
  'auth_pass',
  'family'
];

function Requestor(options) {
  var self = this;
  var redisOptions = _.merge({
    host: '127.0.0.1',
    port: 6379
  }, _.pick((options.redis || {}), validRedisOptions));

  if (redisOptions.unixSocket) {
    self.redisClient = redis.createClient(redisOptions.unixSocket, redisOptions);
  } else {
    self.redisClient = redis.createClient(redisOptions.port, redisOptions.host, redisOptions);
  }

  // BK: I think this can be ignored, since it would get called automatically, when options.auth_pass is presented
  // if auth information was provided, call redisClient.auth with provided parameters
  // details see here: https://github.com/mranney/node_redis#clientauthpassword-callback
  // if (redisOpts.auth && redisOpts.auth.password) {
  //   this.redisClient.auth(redisOpts.auth.password, redisOpts.auth.callback);
  // }

  self.limiter = _.reduce(options.throttle, function(result, conf, endpoint) {
    result[endpoint] = new limit(_.merge(_.pick(conf, ['limit', 'duration']), {
      id: endpoint,
      redisClient: self.redisClient
    }));
    return result;
  }, {});
}

Requestor.prototype.throttled = function(opts) {
  var self = this;
  var parsedUrl = url.parse(opts.uri);
  if (self.limiter[parsedUrl.host]) {
    return self.limiter[parsedUrl.host].getBucket(function(err, bucket) {
      if (err) {
        return opts.callback(err, null);
      }
      if (bucket.remaining > 0) {
        return request(opts.uri, opts, opts.callback);
      }
      return opts.callback(new Error(util.format('request limit {%d} for {%s} reached, please retry after {%s}', bucket.limit, parsedUrl.host, new Date(parseInt(bucket.reset, null)))));
    });
  }
  return request(opts.uri, opts, opts.callback);
};

var cacheableStatusCodes = [200];
Requestor.prototype.makeCacheableRequest = function(opts, cacheKeys) {
  var self = this;

  var originalCallback = opts.callback;

  function cacheableRequestCallback(err, response, body) {
    var now = (new Date()).getTime(),
      expireat = false;

    if (err) {
      logError('Executing {%s} request to {%s} failed', opts.method, opts.uri);
      logDebug(err);
      logDebug(util.inspect(opts));
    } else {
      // only cache the response when statusCode is within the defined list
      if (cacheableStatusCodes.indexOf(response.statusCode) > -1) {
        // @TODO: should also evaluate http cache headers

        if (typeof opts.ttl === 'number') {
          expireat = Math.round((now / 1000) + opts.ttl);
        }
        // there was no error and statusCode is one of the values in array provided above
        // store the serialized response object in redis cache

        self.redisClient.set(cacheKeys.response, serializeResponse(response), function(err) {
          if (!err && expireat) {
            self.redisClient.expireat(cacheKeys.response, expireat);
          }
        });

        // store the raw body in redis cache
        self.redisClient.set(cacheKeys.raw, body, function(err) {
          if (!err && expireat) {
            self.redisClient.expireat(cacheKeys.raw, expireat);
          }
        });
      }
    }

      originalCallback(err, response, body, function(err, result, type) {
        type = (['string'].indexOf(type) > -1) ? type : 'string';
        cacheProcessedResponseBody(err, result, type, self.redisClient, cacheKeys, expireat);
      });
  }

  opts.callback = cacheableRequestCallback;

  self.throttled(opts);
};

Requestor.prototype._request = function(opts) {
  var self = this;

  // verify request type
  // if method is not 'GET', we bypass the cache implementation
  // since buffer piping requires streams and this current implementation wouldn't represent a stream if response comes from cache,
  // the requesting code can set opts.requiresPipe to true, which bypasses the cache implementation, too
  // we also check the connection status of our redis client. If the client is not connected, waiting for the connection could potentially
  // cause the request processing to take longer than without caching. Thus we bypass cache when our redis client is not connected

  // @TODO: since redisClient provides a property to keep track of currently queued commands,
  // we could additionally provide a threashold for at which command queue lenght we should start bypassing the cache and call the backend directly
  // this.redisClient.command_queue.length

  if (ignoreCache(opts) || !self.redisClient.connected) {
    return self.throttled(opts);
  }
  if (!opts.uri) {
    throw new Error("there is no valid url/uri provided with your request options");
  }
  // cacheKey might need some optimization
  var requestQuery = encodeURIComponent(querystring.stringify(opts.qs));
  var requestUri = encodeURIComponent(opts.uri);
  var requestHash = requestUri + ':' + requestQuery;

  var cacheKeys = {
    response: util.format('%s:cache:response:%s', moduleName, requestHash),
    raw: util.format('%s:cache:response:body:raw:%s', moduleName, requestHash),
    processed: util.format('%s:cache:response:body:processed:%s', moduleName, requestHash)
  };

  // ttl is interpreted as boolean or integer, the later represents seconds of how long the result should be cached while setting it to false disables caching for this request
  opts.ttl = (['boolean', 'number'].indexOf(typeof opts.ttl) > -1) ? opts.ttl : defaults.ttl;

  if (opts.forceFresh) {
    return self.makeCacheableRequest(opts, cacheKeys);
  }

  self.redisClient.mget(cacheKeys.response, cacheKeys.raw, cacheKeys.processed, function(err, res) {
    if (err) {
      logError('Failed to receive cacheKeys from redis: %j', err);
      return self.makeCacheableRequest(opts, cacheKeys);
    }
    if (!res[0] && res[0] !== 0) {
      logDebug('"response" key {%s} does not exist --> executing new request', cacheKeys.response);
      return self.makeCacheableRequest(opts, cacheKeys);
    }
    var response = JSON.parse(res[0]);
    response.fromCache = true;

    if (res[2]) {
      response.processed = true;
      return opts.callback(null, response, res[2]);
    }
    if (res[1]) {
      return opts.callback(null, response, res[1]);
    }
    return self.makeCacheableRequest(opts, cacheKeys);
  });
};

['delete', 'put', 'get', 'head', 'post', 'patch'].forEach(function(method) {
  Requestor.prototype[method] = function() {
    var opts = parseargs(Array.prototype.slice.call(arguments, 0));
    opts.method = method.toUpperCase();
    return this._request(opts);
  };
});

['defaults', 'forever', 'jar', 'cookie'].forEach(function(method) {
  Requestor.prototype[method] = function() {
    return request[method].call(request, arguments);
  };
});

module.exports = Requestor;