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

var cacheClient = redis.createClient();
var defaults = {
  ttl: 180
};

// organize params for patch, post, put, head, del
function initParams(uri, options, callback) {
  var opts;
  if ((typeof options === 'function') && !callback) {
    callback = options;
  }
  if (options && typeof options === 'object') {
    opts = utils.extend({}, options);
    opts.uri = uri;
  } else if (typeof uri === 'string') {
    opts = {
      uri: uri
    };
  } else {
    opts = utils.extend({}, uri);
    uri = opts.uri;
  }

  return {
    uri: uri,
    options: opts,
    callback: callback
  };
}

function requestor(uri, options, callback) {
  var params = initParams(uri, options, callback),
    Requestor, RequestorError;

  // cacheKey might need some optimization
  var qs = '?' + querystring.stringify(options.qs),
    cacheKeyRaw = 'services:core:httprequestor:response:raw:%s:%s'.s([params.options.authenticatedUser, encodeURIComponent(params.uri + qs)]),
    cacheKeyProcessed = 'services:core:httprequestor:response:processed:%s:%s'.s([params.options.authenticatedUser, encodeURIComponent(params.uri + qs)]);

  // ttl is interpreted as boolean or integer, the later represents seconds of how long the result should be cached while setting it to false disables caching for this request
  var ttl = ((typeof params.options.ttl).isIn(['boolean', 'number'])) ? params.options.ttl : defaults.ttl,
    expireat = false;

  function cacheProcessedResponse(err, obj, type) {
    if (err) {
      // the parsing failed -> there must be something wrong with this content -> better delete it from cache
      return cacheClient.del(cacheKeyRaw);
    }
    if (obj) {
      // currently only objects of type 'string' are supported
      //type = (type) ? type : 'string';
      //new XMLSerializer().serializeToString(obj.documentElement);
      try {
        cacheClient.set(cacheKeyProcessed, obj);
        if (expireat) {
          cacheClient.expireat(cacheKeyProcessed, expireat);
        }
      } catch (e) {
        // problem occured when trying to store processed result in cache
      }
    }
  }

  function executeRequest() {
    return request(params.uri || null, params.options, function requestorCallback(error, response, body) {
      // console.log('requestorCallback received Response');
      var now = (new Date()).getTime();
      if (!error && response.statusCode === 200) {
        // store the raw response in redis cache
        cacheClient.set(cacheKeyRaw, body);
        if (ttl) {
          expireat = Math.round((now / 1000) + ttl);
          cacheClient.expireat(cacheKeyRaw, expireat);
        }
      }
      if (typeof params.callback === 'function') {
        return params.callback(error, response, body, cacheProcessedResponse);
      }
    });
  }

  if (params.options.forceFresh) {
    return executeRequest();
  }

  cacheClient.get(cacheKeyProcessed, function readingCacheProcessed(err, reply) {
    if (!err && reply) {
      // console.log('had response in cache');
      if (typeof params.callback === 'function') {
        params.callback(false, {
          fromCache: true,
          statusCode: 200,
          processed: true
        }, reply);
      }
      return;
    }

    cacheClient.get(cacheKeyRaw, function readingCacheRaw(err, reply) {
      if (!err && reply) {
        // console.log('had response in cache');
        if (typeof params.callback === 'function') {
          params.callback(false, {
            fromCache: true,
            statusCode: 200,
            processed: false
          }, reply);
        }
        return;
      }

      Requestor = executeRequest();
    });
  });

  if (RequestorError) {
    throw RequestorError;
  }
  return Requestor;
}

requestor.defaults = function(options, requester) {
  return request.defaults(options, requester);
};

requestor.forever = function(agentOptions, optionsArg) {
  return request.forever(agentOptions, optionsArg);
};

requestor.get = function(uri, options, callback) {
  //  console.log('Requestor.get was called');
  var params = initParams(uri, options, callback);
  params.options.method = 'GET';
  return requestor(params.uri || null, params.options, params.callback);
};

requestor.post = function(uri, options, callback) {
  return request.post(uri, options, callback);
};

requestor.put = function(uri, options, callback) {
  return request.put(uri, options, callback);
};

requestor.patch = function(uri, options, callback) {
  return request.patch(uri, options, callback);
};

requestor.head = function(uri, options, callback) {
  return request.head(uri, options, callback);
};

requestor.del = function(uri, options, callback) {
  return request.del(uri, options, callback);
};

requestor.jar = function() {
  return request.jar();
};

requestor.cookie = function(str) {
  return request.cookie(str);
};

module.exports = exports = requestor;