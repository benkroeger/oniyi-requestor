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

var client1 = redis.createClient();
var client2 = redis.createClient();


// client.multi()
// .decr('counter')
// .mget('counter', 'doesNotExist')
// .exec(function(err, result){
//   console.log(err);
//   console.log(result);
//   if (!result[1][1]) {
//     console.log('doesNotExist');
//   }
// });

setTimeout(function() {
  client1.watch('aaa');

  client2.set('aaa', 'initial');

  setTimeout(function() {
    client1.multi().set('aaa', 'modified').exec(function(err, result) {
      console.log(err);
      console.log(result);
    });
  }, 3000);
}, 2000);