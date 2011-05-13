// Simple Proxy - a simple HTTP proxy that records the requests and responses to disk
// Yes, this has all been done before but I wanted to learn some things about Node.js
// Most of the guts of the proxy server itself were pulled from nodejitsu's node-http-proxy
// but modified to handle just the case I wanted to run.  Also, I needed a way to intercept
// response headers and the chunked body before it was written out to the proxy client (probably
// cleaner ways to do this exist)
// TODO: get this working for proxying HTTPS, where this server autogenerates a custom cert for each 
// request and signed with a root CA. This would allow MITM style ssl session recording

var util = require('util'),
    fs = require('fs'),
    sys = require('sys'),
    events = require('events'),
    colors = require('colors'),
    https = require('https'),
    http = require('http');

//
// ### function createServer ([port, host, options, handler])
// #### @port {number} **Optional** Port to use on the proxy target host.
// #### @host {string} **Optional** Host of the proxy target.
// #### @options {Object} **Optional** Options for the HttpProxy instance used
// #### @handler {function} **Optional** Request handler for the server
// Returns a server that manages an instance of HttpProxy. Flexible arguments allow for:
//
// * `httpProxy.createServer(9000, 'localhost')`
// * `httpProxy.createServer(9000, 'localhost', options)
// * `httpPRoxy.createServer(function (req, res, proxy) { ... })`
//
function createServer (options, callback) {
  var port, host, forward, silent, proxy, server; 

  proxy = new HttpProxy();
  
  handler = function (req, res) {
    callback(req, res, proxy);
  };
  
  server = options.https 
    ? https.createServer(options.https, handler)
    : http.createServer(handler);
  
  server.on('close', function () {
    proxy.close();
  });

  //
  // Set the proxy on the server so it is available
  // to the consumer of the server
  //
  server.proxy = proxy;
  
  return server;
};

var HttpProxy = exports.HttpProxy = function (options) {
  events.EventEmitter.call(this);
  var self     = this;
  options      = options || {};

}

util.merge = function(a,b) {
  for(var i in b) {
    if (b.hasOwnProperty(i)) {
      a[i] = b[i];
    }
  }
}


util.merge(HttpProxy.prototype, { 

  //
  // ### function _getProtocol (secure, outgoing) 
  // #### @secure {Object|boolean} Settings for `https`
  // #### @outgoing {Object} Outgoing request options
  // Returns the appropriate protocol based on the settings in 
  // `secure`. If the protocol is `https` this function will update
  // the options in `outgoing` as appropriate by adding `ca`, `key`,
  // and `cert` if they exist in `secure`.
  //
  _getProtocol: function (secure, outgoing) {
    var protocol = secure ? https : http;

    if (typeof secure === 'object') {
      outgoing = outgoing || {};
      ['ca', 'cert', 'key'].forEach(function (prop) {
        if (secure[prop]) {
          outgoing[prop] = secure[prop];
        }
      })
    }
    return protocol;
  },

  //
  // ### function _getAgent (host, port, secure)
  // #### @host {string} Host of the agent to get
  // #### @port {number} Port of the agent to get
  // #### @secure {boolean} Value indicating whether or not to use HTTPS
  // Retreives an agent from the `http` or `https` module
  // and sets the `maxSockets` property appropriately.
  //
  _getAgent: function (host, port, secure) {
    var options = { host: host, port: port };
    var agent = !secure ? http.getAgent(options) : https.getAgent(options);

    agent.maxSockets = 100;
    return agent;
  },

  proxyRequest: function (req, res, recorder) {
    var self = this, errState = false, location, outgoing, protocol, reverseProxy;

    //
    // Add `x-forwarded-for` header to availible client IP to apps behind proxy
    //
    req.headers['x-forwarded-for'] = req.connection.remoteAddress;

    //
    // Emit the `start` event indicating that we have begun the proxy operation.
    //
    recorder.emit('start', req);

    // #### function proxyError (err)
    // #### @err {Error} Error contacting the proxy target
    // Short-circuits `res` in the event of any error when 
    // contacting the proxy target at `host` / `port`.
    function proxyError (err) {
      errState = true;
      res.writeHead(500, { 'Content-Type': 'text/plain' });

      if (req.method !== 'HEAD') {
        res.write('An error has occurred: ' + JSON.stringify(err));
      }
      res.end();
    }

    outgoing = {
      host: req.headers['host'],
      port: req.headers['port'],
      agent: self._getAgent(req.headers['host'], req.headers['port'], req.https),
      method: req.method,
      path: req.url,
      headers: req.headers
    };
      
    // Force the `connection` header to be 'close' until
    // node.js core re-implements 'keep-alive'.
    outgoing.headers['connection'] = 'close';
    
    protocol = self._getProtocol(req.https, outgoing);
    
    // Open new HTTP request to internal resource with will act as a reverse proxy pass
    reverseProxy = protocol.request(outgoing, function (response) {
      
      // Process the `reverseProxy` `response` when it's received.
      if (response.headers.connection) {
        if (req.headers.connection) response.headers.connection = req.headers.connection;
        else response.headers.connection = 'close';
      }

      // Set the headers of the client response
      res.writeHead(response.statusCode, response.headers);
      recorder.emit('responseHead', { 'statusCode': response.statusCode, 'headers': response.headers } );

      // `response.statusCode === 304`: No 'data' event and no 'end'
      if (response.statusCode === 304) {
        return res.end();
      }

      // For each data `chunk` received from the `reverseProxy`
      // `response` write it to the outgoing `res`.
      response.on('data', function (chunk) {
        if (req.method !== 'HEAD') {
          res.write(chunk);
          recorder.emit('responseBody', chunk );
        }
      });

      // When the `reverseProxy` `response` ends, end the
      // corresponding outgoing `res` unless we have entered
      // an error state. In which case, assume `res.end()` has
      // already been called and the 'error' event listener
      // removed.
      response.on('end', function () {
        if (!errState) {
          reverseProxy.removeListener('error', proxyError);
          res.end();
          
          // Emit the `end` event now that we have completed proxying
          recorder.emit('end', req, res);
        }
      });
    });
    
    // Handle 'error' events from the `reverseProxy`.
    reverseProxy.once('error', proxyError);

    // For each data `chunk` received from the incoming 
    // `req` write it to the `reverseProxy` request.
    req.on('data', function (chunk) {
      if (!errState) {
        reverseProxy.write(chunk);
      }
    });

    //
    // When the incoming `req` ends, end the corresponding `reverseProxy` 
    // request unless we have entered an error state. 
    //
    req.on('end', function () {
      if (!errState) {
        reverseProxy.end();
      }
    });

  }
});

// Records a proxy session to disk as the request and response stream through the server
var RecordingSession = function(req, id) {
  // Start a new file to stream responses in to
  var buffer = [],
      ended = false, 
      responded = false,
      fd = fs.openSync(id + '.txt', 'w');

  function write(s) { if (s === undefined) s = ''; buffer.push(s) }
  function writeln(s) { if (s === undefined) s = ''; buffer.push(s + '\n') }

  writeln(req.url);
  for (var h in req.headers) { writeln(h + ": " + req.headers[h]) }
  req.on('data', function (chunk) {
    write(chunk);
  });

  this.recordHead = function(data) {
    if (!responded) {
      writeln('');
      writeln('RESPONSE');
      writeln('================================================');
      responded = true;
    }
    writeln("Status: " + data['statusCode']);
    for (var h in data.headers) { writeln(h + ": " + req.headers[h]) }
  }
  this.recordBody = function(data) {
    write(data);
  }
  // Close the file, but wait for the buffered log writer to finish up
  this.end = function() {
    ended = true;
  }
  // Small buffered log writer, allows process ticks while writing to the file.  Potential for buffer overflow
  // if data is coming over the network faster than the disk can write (maybe a better solution built in to node?)
  function writeLog() {
    var l;
    if (buffer.length == 0 && ended) {
      fs.close(fd);
      return;
    }
    if ((l = buffer.shift()) !== undefined)
      fs.write(fd, new Buffer(l), 0, l.length, null, writeLog);
    else
      setTimeout(writeLog, 1); 
  }
  writeLog();
}
// Inherit from events.EventEmitter
util.inherits(RecordingSession, events.EventEmitter);
// Sets up the request/response recording machinery and returns an object suitable for raising
// response lifecycle events on (i.e. responseHead, responseBody, end etc)
RecordingSession.newSession = function(req) {
  RecordingSession.nextId = RecordingSession.nextId === undefined ? 0 : RecordingSession.nextId + 1;
  var s = new RecordingSession(req, RecordingSession.nextId);
  s.on('responseHead', function(data) { s.recordHead(data) });
  s.on('responseBody', function(data) { s.recordBody(data) });
  s.on('end', function() { s.end() });
  console.log("Serving request " + RecordingSession.nextId + ' for ' + req.url);
  return s;
}

// Make everything run
var httpServerPort = 8080;
createServer({}, function (req, res, proxy) {
  var session = RecordingSession.newSession(req);
  proxy.proxyRequest(req, res, session);
}).listen(httpServerPort);
console.log("Proxy server started on " + httpServerPort);
