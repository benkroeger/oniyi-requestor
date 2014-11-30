/*global describe,it*/
'use strict';
// var assert = require('assert'),
//   oniyiRequestor = require('../lib/oniyi-requestor.js');

// describe('oniyi-requestor node module.', function() {
//   it('must be awesome', function() {
//     assert( oniyiRequestor.awesome(), 'awesome');
//   });
// });

var oniyiRequestor = require('../lib/oniyi-requestor.js');

var requestor = new oniyiRequestor({
  redis: {},
  throttle: {
    'greenhouse.lotus.com': {
      limit: 20,
      duration: 20000
    }
  },
  cache: {
    'greenhouse.lotus.com': {
      storePrivate: true/*,
      requestValidators: [
        function(requestOptions, evaluator) {
          evaluator.flagStorable(true);
          evaluator.flagRetrievable(true);
          return true;
        }
      ]*/
    }
  }
});

setTimeout(function(){for (var i = 0; i < 30; i++) {
  setTimeout(function() {
    requestor.get('https://greenhouse.lotus.com/profiles/atom/profileEntry.do', {
      qs: {
        email: 'benjamin.kroeger@de.ibm.com'
      },
      headers: {
        'user-agent': 'Mozilla/5.0'
      },
      ttl: 60
      /*,
      authenticatedUser: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0,
          v = c === 'x' ? r : (r & 0x3 || 0x8);
        return v.toString(16);
      })*/
    }, function(err, response, body) {
      if (err) {
        return console.log('Failed: %s', err);
      }
      console.log('received profileEntry {fromCache: %s}', (response.fromCache || false));
    });
  }, i * 100);
}

setTimeout(function(){
  console.log('Received requests: %d', requestor.receivedRequests);
  console.log('Served from cache: %d', requestor.servedFromCache);
  console.log('Missed cache lookups: %d', requestor.cacheMiss);
}, 31*100 + 5000)}, 2000)