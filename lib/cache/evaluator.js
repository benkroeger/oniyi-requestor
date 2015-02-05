'use strict';

var validators = require('./validators.js');


function Evaluator(options) {
  options = options || {};
  this.storePrivate = options.storePrivate;
  this.storeNoStore = options.storeNoStore;
  this.ignoreNoLastMod = options.ignoreNoLastMod;
  this.requestValidators = (Array.isArray(options.requestValidators)) ? options.requestValidators : [];
  this.responseValidators = (Array.isArray(options.responseValidators)) ? options.responseValidators : [];
}

Evaluator.prototype.flagStorable = function(flag) {
  if (typeof this.storable !== 'undefined') {
    return;
  }
  this.storable = (typeof flag === 'undefined') ? true : !!flag;

  return this.storable;
};

Evaluator.prototype.flagRetrievable = function(flag) {
  if (typeof this.retrievable !== 'undefined') {
    return;
  }
  this.retrievable = (typeof flag === 'undefined') ? true : !!flag;

  return this.retrievable;
};

Evaluator.prototype.isRetrievable = function(requestOptions) {
  var self = this;
  if (typeof self.retrievable === 'undefined') {
    // concatenate validators from this particular request with the default RFC 2616 cache validators
    self.requestValidators.concat(validators.requestValidators).some(function(validator) {
      return validator(requestOptions, self);
    });
  }
  return self.retrievable;
};

Evaluator.prototype.isStorable = function(response) {
  var self = this;
  if (typeof self.storable === 'undefined') {
    // concatenate validators from this particular request with the default RFC 2616 cache validators
    self.responseValidators.concat(validators.responseValidators).some(function(validator) {
      return validator(response, self);
    });
  }

  return self.storable;
};

module.exports = Evaluator;