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
    .set(self.keys.remaining, self.limit -1, 'PX', self.duration, 'NX')
    .set(self.keys.limit, self.limit, 'PX', self.duration, 'NX')
    .set(self.keys.reset, expiresAt, 'PX', self.duration, 'NX')
    .exec(function(err, res) {
      if (err) {
        logError('{%s} - Failed to create bucket: %j', self.id, err);
        return callback(err);
      }

      // If the request has failed, it means the values already
      // exist in which case we need to get the latest values.
      if (!res || !res[0] || !res[1] || !res[2]) {
        logDebug('{%s} - Failed to create new bucket. Redis command results: remaining {%s}; limit {%s}, reset {%s}', self.id, res[0], res[2], res[2]);
        return self.getBucket(callback);
      }

      logDebug('{%s} - created new bucket: remaining {%s}; limit {%s}, reset {%s}', self.id, self.limit -1, self.limit, new Date(parseInt(expiresAt, null)));
      callback(null, {
        remaining: self.limit -1,
        limit: self.limit,
        reset: expiresAt
      });
    });
}

Limiter.prototype.getBucket = function(callback) {
  var self = this;
  self.redisClient.watch(self.keys.remaining, function(err) {
    if (err) {
      logError('{%s} - Failed to watch remaining: %j', self.id, err);
      return callback(err);
    }
    self.redisClient.mget(self.keys.remaining, self.keys.limit, self.keys.reset, function(err, res) {
      if (err) {
        logError('{%s} - Failed to receive bucket from redis: %j', self.id, err);
        return callback(err);
      }
      if (!res[0] && res[0] !== 0) {
        logDebug('{%s} - "remaining" key does not exist --> creating new bucket', self.id)
        return self.createBucket(callback);
      }
      logDebug('{%s} - Bucket loaded from redis: remaining {%s}; limit {%s}, reset {%s}', self.id, res[0], res[1], new Date(parseInt(res[2], null)));
      self.decreaseRemaining(res, callback);
    });
  });
}

Limiter.prototype.decreaseRemaining = function(bucket, callback) {
  var self = this;

  var remaining = ~~bucket[0];
  var limit = ~~bucket[1];
  var expiresAt = bucket[2];
  var expireIn = expiresAt - Date.now();

  function done() {
    callback(null, {
      remaining: remaining < 0 ? 0 : remaining,
      limit: limit,
      reset: expiresAt
    });
  }

  if (remaining <= 0) {
    logDebug('{%s} - Bucket limit {%d} reached, remaining calls in this period {%d}', self.id, limit, remaining);
    return done();
  }

  self.redisClient.multi()
    .set(self.keys.remaining, remaining - 1, 'PX', expireIn, 'XX')
    .exec(function(err, res) {
      if (err) {
        logError('{%s} - Failed to decrease "remaining" value: %j', self.id, err);
        return callback(err);
      }
      // If the request has failed, it means the key did not exist
      // in which case we call the getBucket which will create a new bucket if appropriate
      if (!res || !res[0]) {
        logDebug('{%s} - Could not decrease the "remaining" key because it doesn\'t exist --> calling "getBucket"', self.id)
        return self.getBucket(callback);
      }
      remaining = remaining - 1;
      done();
    });
}

module.exports = Limiter;