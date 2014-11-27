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
    'w3-connections.ibm.com': {
      limit: 10,
      duration: 10000
    }
  }
});

for (var i = 0; i < 60; i++) {
  setTimeout(function(){
    requestor.get('https://w3-connections.ibm.com/profiles/atom/profileEntry.do', {
      qs: {
        email: 'bkroeger@sg.ibm.com'
      },
      headers: {
        'user-agent': 'Mozilla/5.0'
      },
      ttl: 2
    }, function(err, response, body){
      if (err) {
        return console.log('Failed: %s', err);
      }
      console.log('received profileEntry {fromCache: %s}', (response.fromCache || false));
    });
  }, i * 200);
}