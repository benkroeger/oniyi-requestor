'use strict';
var _ = require('lodash'),
  XXHash = require('xxhash');

function Storage(options) {
  options = options || {};
}

Storage.prototype.hash = function(request) {
  return XXHash.hash(new Buffer(JSON.stringify(_.merge(_.pick(request, ['uri', 'qs', 'method', 'authenticatedUser']), {
    headers: _.omit(request.headers, ['cookie'])
  }))), 0xCAFEBABE);
};

// @TODO: implement cache-getter
Storage.prototype.get = function(requestHash) {

}

// @TODO: implement option to put response to cache --> parsedResponse will be tricky here!
Storage.prototype.put = function(requestHash, body, type) {

}

module.exports = Storage;