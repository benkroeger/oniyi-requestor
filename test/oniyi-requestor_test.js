/*global describe,it*/
'use strict';

var oniyiRequestor = require('../');

var requestor = new oniyiRequestor({
  redis: {},
  throttle: {
    'greenhouse.lotus.com': {
      limit: 2000,
      duration: 20000
    }
  },
  cache: {
    'greenhouse.lotus.com': {
      storePrivate: true,
      storeNoStore: true
        /*,
          requestValidators: [
            function(requestOptions, evaluator) {
              evaluator.flagStorable(true);
              evaluator.flagRetrievable(true);
              return true;
            }
          ]
        */
    }
  }
});

setTimeout(function() {
  for (var i = 0; i < 3000; i++) {
    setTimeout(function() {
      requestor.get('https://greenhouse.lotus.com/profiles/atom/profileEntry.do', {
        qs: {
          userid: 'e806ef40-8a8a-1030-98c1-eb597bcfee57'
        },
        headers: {
          'user-agent': 'Mozilla/5.0'
        },
        'auth': {
          'user': 'benjamin.kroeger@de.ibm.com',
          'pass': 'be8185kr',
          'sendImmediately': false
        },
        ttl: 60
          /*,
                  authenticatedUser: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                    var r = Math.random() * 16 | 0,
                      v = c === 'x' ? r : (r & 0x3 || 0x8);
                    return v.toString(16);
                  })*/
      }, function(err, response, body, passback) {
        if (err) {
          return console.log('Failed: %s', err);
        }
        console.log(body);
        console.log('received profileEntry {fromCache: %s}', (response.fromCache || false));
        if (typeof passback === 'function') {
          passback(null, 'some nice data here');
        }
      });
    }, i * 100);
  }

  setTimeout(function() {
    console.log('Received requests: %d', requestor.receivedRequests);
    console.log('Served from cache: %d', requestor.servedFromCache);
    console.log('Missed cache lookups: %d', requestor.cacheMiss);
  }, 3001 * 100 + 5000);
}, 2000);