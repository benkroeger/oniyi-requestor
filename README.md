#  [![Build Status](https://secure.travis-ci.org/benkroeger/oniyi-requestor.png?branch=master)](http://travis-ci.org/benkroeger/oniyi-requestor)

> A redis cache implementation for the popular request package
> stores raw and optionally parsed responses from request results in a redis database; Automatically responses to subsequent requests for the same resource with in the ttl with data from redis cache.


## Getting Started

Install the module with: `npm install oniyi-requestor`

```js
var requestor = new oniyiRequestor({
  redis: {},
  disableCache: true,
  throttle: {
    'some.host.name': {
      limit: 20,
      duration: 20000
    }
  },
  cache: {
    'some.host.name': {
      storePrivate: true,
      storeNoStore: true,
      ignoreNoLastMod: true,
      requestValidators: [
        function(requestOptions, evaluator) {
          evaluator.flagStorable(true);
          evaluator.flagRetrievable(true);
          return true;
        }
      ],
      responseValidators: [
      function(response, evaluator){
        evaluator.flagStorable(true);
        return true;
      }]
    }
  }
});

requestor.get('https://some.host.name/my/url.html', {
  ttl: 1800,
  headers: {
    auth: 'Bearer mybearertoken'
  },
  someOtherRequestOption: 'withValue'
}, function(err, response, body, addParsedResponseToCache){
  // addParsedResponseToCache is a convenience function to store the parsed result back into the redis cache
  // it takes (err, result, type) as arguments. When err is provided, it will indicate to oniyi-requestor, that the received
  // response body was not parseable and should be removed from cache
  // "result" will be a stringified version of the parsed result, "type" is for future use. currently we only support string values, but in future, it might be possible to provide xml documents, buffers, JSON Objects and such.
  if (response.fromCache && response.processed) {
    // response is processed / parsed already, can continue doing your actual application logic
  } else {
    // parse result here and put the parsed result back to cache
    var parsedResult = JSON.stringify({parsedBody: body});
    addParsedResponseToCache(null, parsedResult, 'string');
  }
});
```




## Documentation

request wrapper with throttling and caching

uses extendable rfc 2616 compliant caching config
uses redis for throttling
locks equal cache-retrievable requests when on is in progress already --> redis pub-sub to notify when lock is released and then leverage on any storable response or re-execute the request

determines cache expiry time either by a provided ttl (can be set when starting the request), the responses cache-control header (s-maxage superseeds max-age) or the response's expiry header

supports private caches by setting "authenticatedUser" when executing the request --> this attribute will be part of the request hash calculation
--> use this if you have e.g. groups of users (anonymous, authenticated, role-xyz) to take advantage of a shared cache

supports different cache settings and evaluators per called endpoint
--> be rfc compliant when calling e.g. google api's
--> ignore certain cache information when talking to your own backend

setting disableCache to "true" when creating a requestor instance will disable caching completels

setting disableCache to "true" when starting a new request will force the very first request evaluator to set retrievable and storable to false --> skip caching (incl. locking) and directly proceed to throttling


## Examples

_(Coming soon)_


## Todo's
enhance Storage API, currently Storage is only used to calculate a hash for requestOptions (using xxhash). Future plans are to move receiving and storing of responses to this component

automatically release request lock after an expiry time
--> simply using an expires infor at redis cache key level won't work because this doesn't notify "waiting" clients that the lock was released
--> thinking of something like a timed-out delete call and upon success, use pub-sub similar to the success callback

write better and comprehensive test cases

## Debugging

DEBUG=oniyi-requestor:*

## Contributing

In lieu of a formal styleguide, take care to maintain the existing coding style. Add unit tests for any new or changed functionality. Lint and test your code using [Grunt](http://gruntjs.com).


## License

Copyright (c) 2014 Benjamin Kroeger
Licensed under the MIT license.
