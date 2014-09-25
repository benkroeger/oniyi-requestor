/*global describe,it*/
'use strict';
var assert = require('assert'),
  oniyiRequestor = require('../lib/oniyi-requestor.js');

describe('oniyi-requestor node module.', function() {
  it('must be awesome', function() {
    assert( oniyiRequestor.awesome(), 'awesome');
  });
});
