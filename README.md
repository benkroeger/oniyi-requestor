#  [![NPM version][npm-image]][npm-url]

> A RFC2616 compliant http cache implementation for the popular request package with redis as storage engine 


## Install

```sh
$ npm install --save oniyi-requestor
```


## Usage

make sure, your redis server is running. you can define redis connection options in `requestorOptions.redis` as you are used to from the npm module *redis*


```js
var OniyiRequestor = require('oniyi-requestor');

var requestorOptions = {
  redis: {},
  throttle: {
    'registry.npmjs.org': {
      limit: 20,
      duration: 20000
    }
  },
  cache: {
    'registry.npmjs.org': {
      disable: false,
      storePrivate: false,
      storeNoStore: false,
      requestValidators: [],
      responseValidators: []
    }
  }
};

var request = new OniyiRequestor(requestorOptions);

request.get('https://registry.npmjs.org/oniyi-requestor', {
	headers: {
		'user-agent': 'Mozilla/5.0'
	},
	json: true
}, function(error, response, body, passBackToCache) {
	// handle everything exactly as you are used to from the request/request module
	// then parse your body and if needed, pass it pack to the cache
	if (response.fromCache) {
		console.log('this response was received from cache');
	}
	if(response.processed) {
		console.log('this response was processed / parsed before --> body is now the stringified version of what was passed back to "passBacktoCache" before');
	} else {
		var parsedResponseBody = body.maintainers.name;
		passBackToCache(/* there was no error */ null, parsedResponseBody);
	}
});

```



we implemented a fully rfc 2616 compliant http cache in redis.

additionally, every request can define it's own request / response cache validators that define weather the request is retrievable or the response is storable.

The really neat trick is to allow  caching of the response after it was parsed.
e.g. 
--> retrieve the atom xml from IBM Connections that holds the information about a user's profile entry (which itself can contain a vcard string depending on chosen output format)
--> parse the atom into json object
--> store the json in cache

--> next request will receive the parsed json object directly without talking to IBM Connections or the need to parse xml

the client doesn't even need to know that there is a cache implementation in between, all he cares about is getting the json object

cache hashes a request leveraging "xxhash" (extremely fast non-cryptographic hash algorithm). one of the hashed request properties is "authenticatedUser"... which can be treated like an audience. when undefined, the cache entry is public, when defined, only requests with the exact same value for "authenticatedUser" will retrieve the cached response.

## License

MIT © [Benjamin Kroeger]()


[npm-url]: https://npmjs.org/package/oniyi-requestor
[npm-image]: https://badge.fury.io/js/oniyi-requestor.svg
