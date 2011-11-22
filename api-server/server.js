/*
 * Simple stubbing proxy server
 *
 * Desc: This code can be used to stub out an API backend. It functions
 * (at least a little bit) as a proxy server, relaying requests to an
 * API_HOST.  When it gets a response back, it saves the body and headers
 * to disk in the stubs/ directory for re-use.
 *
 * The hooks section of the config can be used to inject a bit of bad api
 * behavior, to see how your front end might do if your API gets naughty.
 */

var http = require('http'),
    util = require('util'),
    crypto = require('crypto'),
    fs = require('fs');

var config = {
  PORT: 9006, // where this server runs

  API_HOST: 'api.twitter.com',

  API_PORT: 80,

  // Gets called when a new request comes in, first one that matches wins
  hooks : [
    {
      //test : function(count) { return (count % 10 === 0); },
      handler: function(req, res) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        setTimeout(function() {
          // long request that errors, will get truncated by the API
          res.end("Really long request man\n");
        }, 8000);
      }
    },
    {
      //test : function(count) { return (count % 11 === 0); },
      handler: function(req, res) {
        return function(cb) {
          // simulate a long request
          setTimeout(cb, 2500);
        }
      }
    },
    {
      test : function(count, request) { return (request.url.match(/\/1\/friendships\/create\//)); },
      handler: function(req, res) {
        return function(cb) {
          // simulate a long request
          setTimeout(cb, 4500);
        }
      }
    }
  ]
};

(function() {
  var count = 0, cache = { b : {}, h : {} };

  function l(o) {
    if ( typeof o == 'string' ) {
      util.debug(o);
    }
    else {
      util.debug(util.inspect(o));
    }
  }

  // Returns a unique identifier given some input parameters.
  // TODO: This doesn't work very well for POSTs with body parameters
  //       It also means that order of URL params matters, which it shouldn't
  function nameFromUrl(url, method, body) {
    var hash = crypto.createHash('md5');
    hash.update(url + method);
    if (body && body.length > 0) { hash.update(body) }
    return hash.digest('hex');
  }

  function stubPath(name, kind) {
    return 'stubs/' + name + '.' + kind;
  }

  function readStubFromDisk(name, kind, cb) {
    var path = stubPath(name, kind);
    fs.readFile(path, kind == 'head' ? 'utf8' : 'binary', function(err, data) {
      if ( err ) { if ( cb.error ) { cb.error(err) } }
      else { cb.success(data) }
    });
  }

  function sendResponse(r, b, h) {
    var code = 200, head = {};
    if ( typeof h == "string" ) {
      head = JSON.parse(h);
    }
    else if (h) {
      head = h;
    }
    code = head.code || code;
    delete head['code']
    head['Content-Type'] |= 'text/plain';
    head['Content-Length'] = b.length;
    r.writeHead(code, head);
    r.end(b, 'binary');
  }

  function fetchStubs(name, cb) {
    var body = cache.b[name], head = cache.h[name];
    if ( !body ) {
      readStubFromDisk(name, 'body', {
        success: function(b) {
          cache.b[name] = b;
          readStubFromDisk(name, 'head', {
            success: function(data) {
              cache.h[name] = data;
              cb.success(b, data);
            },
            error: function(err) {
              l("Error fetching headers for " + name + ": " + err);
              cb.success(b);
            }
          });
        },
        error: cb.error
      });
    }
    else {
      cb.success(body, head);
    }
  }

  function fetchOrigin(request, requestBody, cb) {
    var req, responseBody = '', opts = {
      host: config.API_HOST,
      port: config.API_PORT,
      method: request.method,
      path: request.url,
      headers: request.headers
    }
    req = http.request(opts, function(res) {
      res.setEncoding('binary');
      res.on('data', function(data) {
        responseBody += data;
      });
      res.on('end', function() {
        res.headers.code = res.statusCode;
        cb.success(responseBody, JSON.stringify(res.headers));
      });
    });
    if ( requestBody && requestBody.length > 0 ) {
      req.write(requestBody, 'binary');
    }
    req.on('error', function(e) {
      if ( cb.error ) { cb.error(e); }
    });
    req.end();
  }

  function saveStub(name, body, head) {
    l("Saving stub for " + name);
    fs.writeFileSync(stubPath(name, 'body'), body, 'binary');
    if ( head ) { fs.writeFileSync(stubPath(name, 'head'), head); }
  }

  function handleRequest(name, request, requestBody, response) {
    fetchStubs(name, {
      error: function(err) {
        l("No stub found for " + request.url + " (" + name + ")");
        // That's OK, get it from the origin server
        fetchOrigin(request, requestBody, {
          success: function(body, head) {
            saveStub(name, body, head);
            cache.b[name] = body;
            cache.h[name] = head;
            sendResponse(response, body, head);
          },
          error: function(err) {
            l(err);
            msg = 'Something bad happened: ' + err + '\n';
            sendResponse(response, msg, { code: 500 });
          }
        });
      },
      success: function(body, head) {
        l("Sending stubbed response for " + name);
        sendResponse(response, body, head);
      }
    });
  }

  http.createServer(function (request, response) {
    var hook, body = '', i, cb;

    request.on('data', function(chunk) {
      body += chunk;
    });
    request.on('end', function() {
      var name = nameFromUrl(request.url, request.method, body);
      l("Processing request for " + request.method + " " + request.url + " (" + name + ")");
      count += 1;
      for (i=0;i<config.hooks.length;i++) {
        hook = config.hooks[i];
        if ( hook.test && hook.test(count, request) ) {
          l("Using custom handler for request " + count);
          cb = hook.handler(request, response);
          if ( cb ) { cb(function() { handleRequest(name, request, body, response); }); }
          return;
        }
      }
      handleRequest(name, request, body, response);
    });

  }).listen(config.PORT);

  console.log('Server running at http://0.0.0.0:' + config.PORT);

})();
