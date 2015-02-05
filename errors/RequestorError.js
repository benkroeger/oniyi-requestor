var messages = require('./messages.json');

function RequestorError (code, message) {
  Error.call(this, message);
  this.name = "RequestorError";
  this.message = messages[code] || 'Unknown Error Message for code { ' + code + ' }';
  this.code = code;
  this.status = 500;
  this.details = message;
}

RequestorError.prototype = Object.create(Error.prototype);
RequestorError.prototype.constructor = RequestorError;

module.exports = RequestorError;
