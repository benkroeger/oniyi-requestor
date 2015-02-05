'use strict';

var redis = require('redis'),
	_ = require('lodash');

var validRedisOptions = [
	'unixSocket', // if this is presented, host and port are ignored
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

module.exports = function makeRedisClient(args) {
	// pre-requisite validation
	if (!_.isPlainObject(args)) {
		args = {};
	}
	if (!_.isFunction(args.logError)) {
		args.logError = _.noop;
	}
	if (!_.isFunction(args.logDebug)) {
		args.logDebug = _.noop;
	}

	var redisClient;
	var redisOptions = _.merge({
		host: '127.0.0.1',
		port: 6379,
		max_attempts: 5,
		retry_max_delay: 5000
	}, _.pick((args.redis || {}), validRedisOptions));

	// make unixSocket superseed host and port information
	if (redisOptions.unixSocket) {
		redisClient = redis.createClient(redisOptions.unixSocket, redisOptions);
	} else {
		redisClient = redis.createClient(redisOptions.port, redisOptions.host, redisOptions);
	}

  // BK: I think this can be ignored, since it would get called automatically, when options.auth_pass is presented
  // if auth information was provided, call redisClient.auth with provided parameters
  // details see here: https://github.com/mranney/node_redis#clientauthpassword-callback
  // if (redisOpts.auth && redisOpts.auth.password) {
  //   this.redisClient.auth(redisOpts.auth.password, redisOpts.auth.callback);
  // }

	redisClient.on('error', function(err) {
		args.logError('Failed to connecto to redis: %j', redisOptions);
		args.logDebug(err);
	});

	return redisClient;
};