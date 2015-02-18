/*global describe,it*/
'use strict';

var oniyiRequestor = require('../');

var requestor = new oniyiRequestor({
  redis: {},
  throttle: {
    'singapptest1.ibm-sba.com': {
      limit: 20,
      duration: 20000
    }
  },
  cache: {
    'singapptest1.ibm-sba.com': {
      disable: false,
      storePrivate: false,
      storeNoStore: false,
      requestValidators: [],
      responseValidators: []
    }
  }
});

function makeRequest(callback) {
  requestor.post('http://singapptest1.ibm-sba.com/SoQ/rest/QA/54e34c23c3f1939c81fc3a84/users', {
    qs: {
      to: 'all',
      count: 10
    },
    body: {
      "users": [{
        uid: '54e20a0253d56cda305ef3cd',
        checked: true,
        connectionsScore: 0
      }]
    },
    headers: {
      'user-agent': 'Mozilla/5.0'
    },
    json: true
  }, function(err, response, data, passBackToCache) {
    if (err) {
      console.log('Failed: %s', err);
      return passBackToCache(err);
    }
    if (200 > response.statusCode > 299 ) {
      console.log('wrong statusCode received: %d', response.statusCode);
      return passBackToCache(response.statusCode);
    }
    console.log(response.statusCode);

    console.log(data);
    if (typeof callback === 'function') {
      callback();
    }
  });
}
setTimeout(function() {
  makeRequest(function(){
    makeRequest();
  });
}, 1000);
