'use strict';

var XXHash = require('xxhash');

var result = XXHash.hash(new Buffer('huihuhuhuhu'), 0xCAFEBABE);

console.log(result);
