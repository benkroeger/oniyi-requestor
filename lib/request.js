'use strict';

// node core
var util = require('util'),
  stream = require('stream');

// 3rd party
var _ = require('lodash'),
  request = require('request');

// variables and functions
var helpers = require('./helpers');
var putCookiesInJar = helpers.putCookiesInJar;
var needAsyncJarHandler = helpers.needAsyncJarHandler;

function Request(params, cache, limit) {
  var self = this;

  // inherit from stream
  // set Request instance to be readable and writable
  // remove any reserved functions from the params object
  // extend the Requestor instance with any non-reserved properties
  // call init

  var reserved = Object.keys(Request.prototype);
  var nonReserved = _.omit(params, reserved);

  params = _.omit(params, function(prop) {
    return reserved.indexOf(prop) > -1 && _.isFunction(prop);
  });

  stream.Stream.call(self);
  util._extend(self, nonReserved);
  self.readable = true;
  self.writable = true;

  // self.initSteps = ['init', 'cache', 'throttle', 'handleAsyncCookieJar', 'lock', 'makeRequest'];
  self.initSteps = ['init', 'cache', 'throttle', 'handleAsyncCookieJar', 'makeRequest'];
  self.nextStep(params, cache, limit);
}

util.inherits(Request, stream.Stream);

// Debugging
Request.debug = process.env.NODE_DEBUG && /\boniyi-requestor\b/.test(process.env.NODE_DEBUG);

function debug() {
  if (Request.debug) {
    console.error('OniyiRequestor %s', util.format.apply(util, arguments));
  }
}

Request.prototype.nextStep = function() {
  var self = this;
  var nextStep = self.initSteps.shift();
  // debug('%s - next step is: %s', self.uri.href, nextStep);
  self[nextStep].apply(self, arguments);
};

Request.prototype.startCallbackChain = function() {
  var self = this;

  if (!Array.isArray(self.callbacks) || self.callbacks.length < 1) {
    return self.callback.apply(self, arguments);
  }

  var callback = self.callbacks.pop();
  callback(Array.prototype.slice.call(arguments), self.startCallbackChain);
};

Request.prototype.init = function(params, cache, limit) {
  var self = this;

  self.callbacks = [function(args) {
    debug('invoking final callback');
    self.callback.apply(self, args);
  }];

  // self.on('error', self.startCallbackChain.bind());
  // self.on('complete', self.startCallbackChain.bind(self, null));

  if (!self.method) {
    self.method = 'GET';
  }

  self.nextStep(params, cache, limit);
};

Request.prototype.cache = function(params, cache, limit) {
  var self = this;
  if (!cache) {
    return self.nextStep(params, cache, limit);
  }

  // receive an evaluator for this request
  var evaluator = cache.getEvaluator(self.uri.host, self);
  var isRetrievable = evaluator.isRetrievable(self);
  var isStorable = (evaluator.storable !== false);

  // skip caching when request is not retrievable and response is not storable at this point already
  if (!isRetrievable && !isStorable) {
    return self.nextStep(params, cache, limit);
  }

  // hash the request for further interactions with the cache
  self.requestHash = cache.makeHash(self);

  if (isStorable) {
    // add callback that stores the response in cache
    self.callbacks.push(function cacheResponse(args, next) {
      debug('%s - in cache callback', self.uri.href);
      // when we got an error or no response, there is nothing to do with our cache
      if (args[0] || !args[1]) {
        // push a noop to our args so that the original caller get's an executable function for "passBack to Cache"
        // although it doesn't do anything
        args.push(_.noop);
        return next.apply(self, args);
      }
      var response = args[1],
        body = args[2],
        now = Math.round(Date.now() / 1000),
        expireAt = null;

      // abort caching this response if it already came from cache
      if (response.fromCache) {
        args.push(_.noop);
        return next.apply(self, args);
      }

      if (evaluator.isStorable(response)) {

        // determine the expireAt timestamp (either from provided ttl or from response headers)
        if (_.isNumber(params.ttl)) {
          // we have a ttl defined for this request --> use it!
          expireAt = now + params.ttl;
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

          } else if ((response.headers.expires || '') !== '') {
            // no maxage found, try our luck with the expires header
            expireAt = Math.round((new Date(response.headers.expires)).getTime() / 1000);
          }
        }

        // store the serialized response object and the raw response in cache
        return cache.put({
          hash: self.requestHash,
          response: response,
          raw: body,
          expireAt: expireAt
        }, function(err) {
          if (err) {
            debug('an error occurred when storing data in cache for request %s', self.requestHash);
            debug(err);
            // push a noop to our args so that the original caller get's an executable function for "passBack to Cache"
            // although it doesn't do anything
            args.push(_.noop);
            return next.apply(self, args);
          }

          // adding the passback to cache function
          args.push(function(err, result) {
            if (err) {
              // the parsing failed -> there must be something wrong with this content -> better delete it from cache
              return cache.purge(self.requestHash);
            }
            if (typeof result === 'string') {
              cache.put({
                hash: self.requestHash,
                parsed: result,
                expireAt: expireAt
              });
            }
          });

          return next.apply(self, args);
        });
      }

      debug('%s - not storable', self.uri.href);
      args.push(_.noop);
      return next.apply(self, args);
    });
  }

  if (!isRetrievable) {
    return self.nextStep(params, cache, limit);
  }

  cache.get(self.requestHash, function(err, data) {
    if (err) {
      debug('An error occured when retrieving data from cache for {%s}', self.requestHash);
      debug(err);
      return self.nextStep(params, cache, limit);
    }

    // verify that we received the bare minimum from cache (response object and raw data)
    if (!(data && data.response && data.raw)) {
      debug('no data in cache for {%s} --> executing new request', self.requestHash);
      return self.nextStep(params, cache, limit);
    }

    // if we have the received parsed data from cache, respond with that
    if (data.parsed) {
      data.response.parsed = true;
      return self.startCallbackChain(null, data.response, data.parsed);
    }

    // otherwise respond with the raw data
    if (data.raw) {
      return self.startCallbackChain(null, data.response, data.raw);
    }

    // fallback! when all conditions above fail, execute a new request
    return self.nextStep(params, cache, limit);
  });
};

Request.prototype.throttle = function(params, cache, limit) {
  var self = this;
  if (limit) {
    return limit.throttle(function(err) {
      if (err) {
        debug(err);
        return self.emit('error', err);
      }
      self.nextStep(params);
    });
  }
  self.nextStep(params);
};

// "request" does not support async cookie jars. We need to load cookies upfront and make sure we apply
// possible set-cookie headers from the response as well
Request.prototype.handleAsyncCookieJar = function(params, cache, limit) {
  var self = this;
  if (!needAsyncJarHandler(params)) {
    return self.nextStep(params, cache, limit);
  }

  var cookieJar = params.jar;
  // retrieve cookies from jar asynchronously
  return cookieJar.getCookieString(self.uri.href, function(err, cookieString) {    
    if (err) {
      return self.emit('error', err);
    }

    // remove the async jar from properties
    params.jar = null;

    // write cookies from jar to the request headers,
    // don't override existing cookies
    params.headers = params.headers || {};
    params.headers.cookie = cookieString + ((params.headers.cookie) ? '; ' + params.headers.cookie : '');

    // in here we read the response's set-cookie header and apply values to our cookie jar
    self.callbacks.push(function cacheResponse(args, next) {
      debug('%s - in asyncCookieJar callback', self.uri.href);
      if (args[0]) {
        return next.apply(self, args);
      }
      var response = args[1];

      if (response && response.headers && response.headers['set-cookie'] && response.request.uri.href) {
        return putCookiesInJar(response.headers['set-cookie'], response.request.uri.href, cookieJar, function(err) {
          if (err) {
            debug('an error occured when storing cookies in cookieJar {%s}', cookieJar.id);
          }
          return next.apply(self, args);
        });
      }
      return next.apply(self, args);
    });

    return self.nextStep(params, cache, limit);
  });
};

Request.prototype.lock = function(params, cache, limit) {
  var self = this;
  self.nextStep(params, cache, limit);
};

Request.prototype.makeRequest = function(params) {
  var self = this;

  self.req = new request.Request(_.merge(params, {
    uri: self.uri,
    method: self.method,
    callback: function(){
      self.startCallbackChain.apply(self, arguments);
    }
  }));
};

// Request.prototype.pipe = function(dest, opts) {
//   return this.req.pipe(dest, opts);
// };

module.exports = Request;
