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
};

Evaluator.prototype.flagRetrievable = function(flag) {
  if (typeof this.retrievable !== 'undefined') {
    return;
  }

  return this.retrievable = (typeof flag === 'undefined') ? true : !!flag;
};


Evaluator.prototype.isRetrievable = function(requestOptions) {
  var self = this;
  if (typeof self.retrievable === 'undefined') {
    self.requestValidators.concat(validators.requestValidators).some(function(validator) {
      return validator(requestOptions, self);
    });
  }

  return self.retrievable;
}

Evaluator.prototype.isStorable = function(response) {
  var self = this;
  if (typeof self.storable === 'undefined') {
    self.responseValidators.concat(validators.responseValidators).some(function(validator) {
      return validator(response, self);
    });
  }

  return self.storable;
}

module.exports = Evaluator;