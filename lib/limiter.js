'use strict';
var assert = require('assert');
var util = require('util');

var debug = require('debug'),
  moduleName = 'oniyi-requestor:limiter';

var logError = debug(moduleName + ':error');
// set this namespace to log via console.error
logError.log = console.error.bind(console); // don't forget to bind to console!

var logWarn = debug(moduleName + ':warn');
// set all output to go via console.warn
logWarn.log = console.warn.bind(console);

var logDebug = debug(moduleName + ':debug');
// set all output to go via console.warn
logDebug.log = console.warn.bind(console);

function Limiter(opts) {
  this.id = opts.id;
  this.redisClient = opts.redisClient;
  assert(this.id, '.id required');
  assert(this.redisClient, '.redisClient required');
  this.limit = opts.limit || 2500;
  this.duration = opts.duration || 60000; // these are milliseconds
  this.prefix = util.format('%s:%s:', moduleName, this.id);

  this.keys = {
    remaining: this.prefix + 'remaining',
    limit: this.prefix + 'limit',
    reset: this.prefix + 'reset'
  };

  logDebug('Created a new limiter instance: %s', this.id);
}

Limiter.prototype.inspect = function() {
  return JSON.stringify({
    id: this.id,
    duration: this.duration,
    limit: this.limit
  });
};

Limiter.prototype.createBucket = function(callback) {
  var self = this;
  var expiresAt = Date.now() + self.duration;

  self.redisClient.multi()
  // No need to set expiry on the "remaining" key --> since we're using "decr" in the getBucket function,
  // it would be created when not exists anyway
  // more importantly, we must not expect that the "remaining" key does not exist ("NX" option).
  .set(self.keys.remaining, self.limit - 1)
    .set(self.keys.limit, self.limit, 'PX', self.duration, 'NX')
    .set(self.keys.reset, expiresAt, 'PX', self.duration, 'NX')
    .exec(function(err, res) {
      if (err) {
        logError('{%s} - Failed to create bucket: %j', self.id, err);
        return callback(err);
      }

      // If the request has failed, it means the values already
      // exist in which case we need to get the latest values.
      if (!res || !res[1] || !res[2]) {
        logDebug('{%s} - Failed to create new bucket. Redis command results: remaining {%s}; limit {%s}, reset {%s}', self.id, res[0], res[2], res[2]);
        return self.getBucket(callback);
      }

      logDebug('{%s} - created new bucket: remaining {%s}; limit {%s}, reset {%s}', self.id, self.limit - 1, self.limit, new Date(parseInt(expiresAt, null)));
      callback(null, {
        remaining: self.limit - 1,
        limit: self.limit,
        reset: expiresAt
      });
    });
}

Limiter.prototype.getBucket = function(callback) {
  var self = this;
  if (!self.redisClient.connected) {
    logWarn('{%s} - Redis client is not connected', self.id);
    if (!self.localBucket) {
      self.localBucket = {
        remaining: self.limit,
        limit: self.limit,
        reset: Date.now() + self.duration
      };
      setTimeout(function() {
        delete self.localBucket;
      }, self.duration);
    }
    self.localBucket.remaining--;
    return callback(null, self.localBucket);
  }

  self.redisClient.multi()
    .decr(self.keys.remaining)
    .mget(self.keys.remaining, self.keys.limit, self.keys.reset)
    .exec(function(err, res) {
      if (err) {
        logError('{%s} - Failed to receive bucket from redis: %j', self.id, err);
        return callback(err);
      }
      // the reset key does not exist --> we don't have an active bucket
      // res[1] is the result-set from the mget command above
      if (!res[1][2]) {
        logDebug('{%s} - "reset" key does not exist --> creating new bucket', self.id);
        return self.createBucket(callback);
      }
      // no "remaining" left
      if (res[0] < 0) {
        logDebug('{%s} - Bucket limit {%d} reached, remaining calls in this period {%d}', self.id, res[1][1], 0);
        return callback(null, {
          remaining: -1,
          limit: res[1][1],
          reset: res[1][2]
        });
      }

      logDebug('{%s} - Bucket loaded from redis: remaining {%s}; limit {%s}, reset {%s}', self.id, res[0], res[1][1], new Date(parseInt(res[1][2], null)));
      return callback(null, {
        remaining: res[0],
        limit: res[1][1],
        reset: res[1][2]
      });
    });
}

module.exports = Limiter;