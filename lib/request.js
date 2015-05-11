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

function OniyiRequest(params, cache, limit) {
  var self = this;

  // inherit from stream
  // set OniyiRequest instance to be readable and writable
  // remove any reserved functions from the params object
  // extend the OniyiRequestor instance with any non-reserved properties
  // call init

  var reserved = Object.keys(OniyiRequest.prototype);
  var nonReserved = _.omit(params, reserved);

  params = _.omit(params, function(prop) {
    return reserved.indexOf(prop) > -1 && _.isFunction(prop);
  });

  stream.Stream.call(self);
  util._extend(self, nonReserved);
  self.readable = true;
  self.writable = true;


  self.init(params, cache, limit);
}

util.inherits(OniyiRequest, stream.Stream);

// Debugging
OniyiRequest.debug = process.env.NODE_DEBUG && /\boniyi-requestor\b/.test(process.env.NODE_DEBUG);

function debug() {
  if (OniyiRequest.debug) {
    console.error('OniyiRequestor %s', util.format.apply(util, arguments));
  }
}

OniyiRequest.prototype.next = function() {
  var nextStep = this.initSteps.shift();
  this[nextStep].apply(this, arguments);
};

OniyiRequest.prototype.callbackSequence = function() {
  var self = this;

  if (!Array.isArray(self.callbacks) ||  self.callbacks.length < 1) {
    return self._callback.apply(self, arguments);
  }

  var callback = self.callbacks.pop();
  callback(Array.prototype.slice.call(arguments), self.callbackSequence);
};

OniyiRequest.prototype.init = function(params, cache, limit) {
  var self = this;

  // self.initSteps = ['cache', 'throttle', 'handleAsyncCookieJar', 'lock', 'makeRequest'];
  self.initSteps = ['cache', 'throttle', 'handleAsyncCookieJar', 'makeRequest'];


  self._callback = self.callback;
  self.callback = null;
  self.callbacks = [function(args) {
    debug('%s final callback', self.uri.href);
    self._callback.apply(self, args);
  }];

  self.on('error', self.callbackSequence.bind(self));
  self.on('complete', self.callbackSequence.bind(self, null));

  if (!self.method) {
    self.method = 'GET';
  }

  if (!self.headers) {
    self.headers = {};
  }

  self.dests = [];
  self.next(params, cache, limit);
};

OniyiRequest.prototype.cache = function(params, cache, limit) {
  var self = this;
  if (!cache) {
    return self.next(params, cache, limit);
  }

  // receive an evaluator for this request
  var evaluator = cache.getEvaluator(self.uri.host, self);
  var isRetrievable = evaluator.isRetrievable(self);
  var isStorable = (evaluator.storable !== false);

  // skip caching when request is not retrievable and response is not storable at this point already
  if (!isRetrievable && !isStorable) {
    return self.next(params, cache, limit);
  }

  // hash the request for further interactions with the cache
  self.requestHash = cache.makeHash(self);

  if (isStorable) {
    // add callback that stores the response in cache
    self.callbacks.push(function cacheResponse(args, next) {
      debug('%s - cache callback', self.uri.href);
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
        debug('%s - response is already from cache, nothing to do for us here', self.uri.href);
        args.push(_.noop);
        return next.apply(self, args);
      }

      if (evaluator.isStorable(response)) {
        debug('%s - response is storable', self.uri.href);

        // determine the expireAt timestamp (either from provided ttl or from response headers)
        if (_.isNumber(params.ttl)) {
          debug('%s - using ttl from options %d', self.uri.href, params.ttl);
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
            debug('%s - got a maxage header', self.uri.href);
            // maxage was found
            expireAt = now + parseInt(maxAge[1], null);
          } else if ((response.headers.expires || '') !== '') {
            debug('%s - got an expires header', self.uri.href);
            // no maxage found, try our luck with the expires header
            expireAt = Math.round((new Date(response.headers.expires)).getTime() / 1000);
          }
        }

        debug('%s - response expires at %s', self.uri.href, expireAt);


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
    return self.next(params, cache, limit);
  }

  cache.get(self.requestHash, function(err, data) {
    if (err) {
      debug('An error occured when retrieving data from cache for {%s}', self.requestHash);
      debug(err);
      return self.next(params, cache, limit);
    }

    // verify that we received the bare minimum from cache (response object and raw data)
    if (!(data && data.response && data.raw)) {
      debug('no data in cache for {%s} --> executing new request', self.requestHash);
      return self.next(params, cache, limit);
    }

    self.response = data.response;



    // if we have the received parsed data from cache, respond with that
    if (data.parsed) {
      self.response.parsed = true;
      self.dests.forEach(function(dest) {
        self.pipeDest(dest);
      });
      self._destdata = true;
      self.emit('data', data.parsed);
      return self.callbackSequence(null, data.response, data.parsed);
    }

    // otherwise respond with the raw data
    if (data.raw) {
      self.dests.forEach(function(dest) {
        self.pipeDest(dest);
      });
      self._destdata = true;
      self.emit('data', data.raw);
      return self.callbackSequence(null, data.response, data.raw);
    }

    // fallback! when all conditions above fail, execute a new request
    return self.next(params, cache, limit);
  });
};

OniyiRequest.prototype.throttle = function(params, cache, limit) {
  var self = this;
  if (limit) {
    return limit.throttle(function(err) {
      if (err) {
        return self.emit('error', err);
      }
      self.next(params);
    });
  }
  self.next(params);
};

// "request" does not support async cookie jars. We need to load cookies upfront and make sure we apply
// possible set-cookie headers from the response as well
OniyiRequest.prototype.handleAsyncCookieJar = function(params, cache, limit) {
  var self = this;
  if (!needAsyncJarHandler(params)) {
    return self.next(params, cache, limit);
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

    return self.next(params, cache, limit);
  });
};

OniyiRequest.prototype.lock = function(params, cache, limit) {
  var self = this;
  self.next(params, cache, limit);
};

OniyiRequest.prototype.makeRequest = function(params) {
  var self = this;

  self.requestRequest = new request.Request(_.merge(params, {
    uri: self.uri,
    method: self.method,
    callback: function() {
      self.callbackSequence.apply(self, arguments);
    }
  }));
  self.dests.forEach(function(dest) {
    self.requestRequest.pipe(dest);
  });
};

OniyiRequest.prototype.pipeDest = function(dest) {
  var self = this;
  var response = self.response;
  // Called after the response is received
  if (dest.headers && !dest.headersSent) {
    if (response['content-type']) {
      var ctname = response['content-type'];
      if (dest.setHeader) {
        dest.setHeader(ctname, response.headers[ctname]);
      } else {
        dest.headers[ctname] = response.headers[ctname];
      }
    }

    if (response['content-length']) {
      var clname = response['content-length'];
      if (dest.setHeader) {
        dest.setHeader(clname, response.headers[clname]);
      } else {
        dest.headers[clname] = response.headers[clname];
      }
    }
  }
  if (dest.setHeader && !dest.headersSent) {
    for (var i in response.headers) {
      // If the response content is being decoded, the Content-Encoding header
      // of the response doesn't represent the piped content, so don't pass it.
      if (!self.gzip || i !== 'content-encoding') {
        dest.setHeader(i, response.headers[i]);
      }
    }
    dest.statusCode = response.statusCode;
  }
  dest.parsed = !!response.parsed;
};

OniyiRequest.prototype.pipe = function(dest, opts) {
  var self = this;

  if (self.response) {
    if (self._destdata) {
      throw new Error('You cannot pipe after data has been emitted from the response.');
    } else if (self._ended) {
      throw new Error('You cannot pipe after the response has been ended.');
    } else {
      stream.Stream.prototype.pipe.call(self, dest, opts);
      self.pipeDest(dest);
      return dest;
    }
  } else {
    self.dests.push(dest);
    stream.Stream.prototype.pipe.call(self, dest, opts);
    return dest;
  }
};

OniyiRequest.prototype.write = function(chunk, encoding, callback) {
  console.log(chunk);
};
OniyiRequest.prototype.end = function(chunk, encoding, callback) {
  console.log(chunk);
};

module.exports = OniyiRequest;
