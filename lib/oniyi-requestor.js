/*
 *
 * https://github.com/benkroeger/oniyi-requestor
 *
 * Copyright (c) 2014 Benjamin Kroeger
 * Licensed under the MIT license.
 */

'use strict';
var utils = require('bk-utils'),
  request = require('request'),
  querystring = require('querystring'),
  redis = require('redis');

var defaults = {
  ttl: 180
};

var serializableResponseProperties = 'httpVersion headers trailers method statusCode httpVersionMajor httpVersionMinor'.split(' ');

function parseargs(args) {
  var opts = {};
  if (typeof args[0] === 'string') {
    opts.url = args[0];
  } else if (typeof args[0] === 'object') {
    utils.extend(opts, args[0]);
  } else {
    throw new Error("Don't understand argument type at arguments 0 " + args[0]);
  }

  if (typeof args[1] === 'object') {
    utils.extend(opts, args[1]);
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

function cacheProcessedResponseBody(err, obj, type, redisClient, cacheKeys, expireat) {
  if (err) {
    // the parsing failed -> there must be something wrong with this content -> better delete it from cache
    redisClient.del(cacheKeys.raw);
    redisClient.del(cacheKeys.response);
    return;
  }
  if (obj) {
    // currently only objects of type 'string' are supported
    //type = (type) ? type : 'string';
    //new XMLSerializer().serializeToString(obj.documentElement);
    try {
      redisClient.set(cacheKeys.processed, obj, function() {
        if (expireat) {
          redisClient.expireat(cacheKeys.processed, expireat);
        }
      });
    } catch (e) {
      // problem occured when trying to store processed result in cache
    }
  }
}

function serializeResponse(resp) {
  var serialized = {};
  serializableResponseProperties.forEach(function(prop) {
    serialized[prop] = resp[prop];
  });
  return serialized;
}

function makeCacheableRequest(opts, cacheKeys, redisClient) {
  return request(opts.uri, opts, function requestorCallback(error, response, body) {
    var now = (new Date()).getTime(),
      expireat = false;

    if (!error && [200].contains(response.statusCode)) {
      // @TODO: should also evaluate http cache headers

      if (opts.ttl && (typeof opts.ttl === 'number')) {
        expireat = Math.round((now / 1000) + opts.ttl);
      }
      // there was no error and statusCode is one of the values in array provided above
      // store the serialized response object in redis cache
      redisClient.set(cacheKeys.response, serializeResponse(response), function() {
        if (expireat) {
          redisClient.expireat(cacheKeys.response, expireat);
        }
      });

      // store the raw body in redis cache
      redisClient.set(cacheKeys.raw, body, function() {
        if (expireat) {
          redisClient.expireat(cacheKeys.raw, expireat);
        }
      });
    }
    if (typeof opts.callback === 'function') {
      return opts.callback(error, response, body, function(err, obj, type) {
        cacheProcessedResponseBody(err, obj, type, redisClient, cacheKeys, expireat);
      });
    }
  });
}

function Requestor(redisOpts) {
  var redisClientOpts = [];
  // client.command_queue.length

  // extract redis connection options from provided options object
  if (redisOpts.unix_socket) {
    redisClientOpts.push(redisOpts.unix_socket);
  } else if (redisOpts.port && redisOpts.host) {
    redisClientOpts.push(redisOpts.port);
    redisClientOpts.push(redisOpts.host);
  }

  if (redisOpts.options) {
    redisClientOpts.push(redisOpts.options);
  }

  // create the redis client with the provided configuration
  this.redisClient = redis.createClient.apply(null, redisClientOpts);

  // if auth information was provided, call redisClient.auth with provided parameters
  // details see here: https://github.com/mranney/node_redis#clientauthpassword-callback
  if (redisOpts.auth && redisOpts.auth.password) {
    this.redisClient.auth(redisOpts.auth.password, redisOpts.auth.callback);
  }
}

Requestor.prototype._request = function(opts) {
  var self = this;

  // verify request type
  // if method is not 'GET', we bypass the cache implementation
  // since buffer piping requires streams and this current implementation wouldn't represent a stream if response comes from cache,
  // the requesting code can set opts.requiresPipe to true, which bypasses the cache implementation, too
  // we also check the connection status of our redis client. If the client is not connected, waiting for the connection could potentially
  // cause the request processing to take longer than without caching. Thus we bypass cache when our redis client is not connected

  //@TODO: since redisClient provides a property to keep track of currently queued commands,
  //we could additionally provide a threashold for at which command queue lenght we should start bypassing the cache and call the backend directly
  // this.redisClient.command_queue.length
  if (opts.method !== 'GET' || opts.requiresPipe || !self.redisClient.connected) {
    return request(opts);
  }
  if (opts.url) {
    // cacheKey might need some optimization
    var requestQuery = encodeURIComponent(querystring.stringify(opts.qs)),
      cacheKeys = {
        response: 'oniyi-requestor:response:%s:%s:%s'.s(opts.authenticatedUser, encodeURIComponent(opts.uri), requestQuery),
        raw: 'oniyi-requestor:response:body:raw:%s:%s:%s'.s(opts.authenticatedUser, encodeURIComponent(opts.uri), requestQuery),
        processed: 'oniyi-requestor:response:body:processed:%s:%s:%s'.s(opts.authenticatedUser, encodeURIComponent(opts.uri), requestQuery)
      };

    // ttl is interpreted as boolean or integer, the later represents seconds of how long the result should be cached while setting it to false disables caching for this request
    opts.ttl = (['boolean', 'number'].contains((typeof opts.ttl))) ? opts.ttl : defaults.ttl;

    if (opts.forceFresh) {
      return makeCacheableRequest(opts, cacheKeys, self.redisClient);
    }

    self.redisClient.get(cacheKeys.response, function(err, cachedResponse) {
      if (!err && cachedResponse) {
        self.redisClient.get(cacheKeys.processed, function readingCacheProcessed(err, processedBody) {
          if (!err && processedBody) {
            cachedResponse.fromCache = true;
            cachedResponse.processed = true;
            if (typeof opts.callback === 'function') {
              opts.callback(false, cachedResponse, processedBody);
            }
          } else {
            self.redisClient.get(cacheKeys.raw, function readingCacheRaw(err, rawBody) {
              if (!err && processedBody) {
                cachedResponse.fromCache = true;
                cachedResponse.processed = false;
                if (typeof opts.callback === 'function') {
                  opts.callback(false, cachedResponse, rawBody);
                }
              } else {
                makeCacheableRequest(opts, cacheKeys, self.redisClient);
              }
            });
          }
        });
      }
    });
  } else {
    throw new Error("there is no valid url/uri provided with your request options");
  }
};

utils.each(['delete', 'put', 'get', 'head', 'post'],
  function(idx, method) {
    Requestor.prototype[method] = function() {
      var opts = parseargs(Array.prototype.slice.call());
      opts.method = method.toUpperCase();
      return this._request(opts);
    };
  }
);

Requestor.prototype.del = Requestor.prototype.delete;
Requestor.prototype.request = Requestor.prototype.get;

utils.each(['defaults', 'forever', 'patch', 'jar', 'cookie'],
  function(idx, method) {
    Requestor.prototype[method] = function() {
      return request[method].call(request, arguments);
    };
  }
);

module.exports = function(redisOpts) {
  return new Requestor(redisOpts);
}