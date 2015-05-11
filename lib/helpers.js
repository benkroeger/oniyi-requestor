'use strict';
var url = require('url');
var async = require('async'),
  request = require('request');

var requestJar = request.jar();
var requestJarPrototype = Object.getPrototypeOf(requestJar);

function paramsHaveRequestBody(params) {
  return (
    params.body ||
    params.requestBodyStream ||
    (params.json && typeof params.json !== 'boolean') ||
    params.multipart
  );
}

function putCookiesInJar(setCookieHeaders, completeRequestURI, cookieJar, callback) {
  if (typeof setCookieHeaders === 'string') {
    setCookieHeaders = [setCookieHeaders];
  }
  async.each(setCookieHeaders, function(setCookieHeader, callback) {
    cookieJar.setCookie(setCookieHeader, completeRequestURI, callback);
  }, callback);
}

function parseUri(params) {
  // People use this property instead all the time, so support it
  if (!params.uri && params.url) {
    params.uri = params.url;
    delete params.url;
  }

  // If there's a baseUrl, then use it as the base URL (i.e. uri must be
  // specified as a relative path and is appended to baseUrl).
  if (params.baseUrl) {
    if (typeof params.baseUrl !== 'string') {
      return params.emit('error', new Error('options.baseUrl must be a string'));
    }

    if (typeof params.uri !== 'string') {
      return params.emit('error', new Error('options.uri must be a string when using options.baseUrl'));
    }

    if (params.uri.indexOf('//') === 0 || params.uri.indexOf('://') !== -1) {
      return params.emit('error', new Error('options.uri must be a path when using options.baseUrl'));
    }

    // Handle all cases to make sure that there's only one slash between
    // baseUrl and uri.
    var baseUrlEndsWithSlash = (params.baseUrl.lastIndexOf('/') === params.baseUrl.length - 1);
    var uriStartsWithSlash = (params.uri.indexOf('/') === 0);

    if (baseUrlEndsWithSlash && uriStartsWithSlash) {
      params.uri = params.baseUrl + params.uri.slice(1);
    } else if (baseUrlEndsWithSlash || uriStartsWithSlash) {
      params.uri = params.baseUrl + params.uri;
    } else if (params.uri === '') {
      params.uri = params.baseUrl;
    } else {
      params.uri = params.baseUrl + '/' + params.uri;
    }
    delete params.baseUrl;
  }

  // A URI is needed by this point, throw if we haven't been able to get one
  if (!params.uri) {
    return params.emit('error', new Error('options.uri is a required argument'));
  }

  // If a string URI/URL was given, parse it into a URL object
  if (typeof params.uri === 'string') {
    params.uri = url.parse(params.uri);
  }

  return params;
}

function needAsyncJarHandler(params) {
  if (['undefined', 'boolean'].indexOf(typeof params.jar) > -1) {
    return false;
  }
  return (Object.getPrototypeOf(params.jar) !== requestJarPrototype);
}

exports.paramsHaveRequestBody = paramsHaveRequestBody;
exports.putCookiesInJar = putCookiesInJar;
exports.parseUri = parseUri;
exports.needAsyncJarHandler = needAsyncJarHandler;
