#  [![NPM version][npm-image]][npm-url] [![Dependency Status][daviddm-url]][daviddm-image]

> A redis cache implementation for the popular request package


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
	var parsedResponseBody = body.maintainers.name;
	passBackToCache(/* there was no error */ null, parsedResponseBody);
});

```


## License

MIT © [Benjamin Kroeger]()


[npm-url]: https://npmjs.org/package/oniyi-requestor
[npm-image]: https://badge.fury.io/js/oniyi-requestor.svg
[daviddm-url]: https://david-dm.org/benkroeger/oniyi-requestor.svg?theme=shields.io
[daviddm-image]: https://david-dm.org/benkroeger/oniyi-requestor
