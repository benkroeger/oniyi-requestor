/*global describe,it*/
'use strict';
// var assert = require('assert'),
//   oniyiRequestor = require('../lib/oniyi-requestor.js');

// describe('oniyi-requestor node module.', function() {
//   it('must be awesome', function() {
//     assert( oniyiRequestor.awesome(), 'awesome');
//   });
// });

var redis = require('redis');
var limit = require('../lib/limiter');

var client = redis.createClient();

var limiter = new limit({
  id: 'testing',
  redisClient: client,
  limit: 10,
  duration: 10000,
});

for (var i = 0; i < 60; i++) {
  setTimeout(function(){
    limiter.getBucket(function(err, bucket){
    if (err) {
      console.log(err);
    }
    // if (bucket.remaining > 0) {
    //   return console.log('can run');
    // }
    // console.log('bucket limit {%d} reached, please retry after {%s}', bucket.limit, new Date(parseInt(bucket.reset, null)));
  });
  }, i * 500);
}