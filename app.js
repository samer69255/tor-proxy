/**
 * Module dependencies.
 */

var net = require('net');
var url = require('url');
var http = require('http');
var assert = require('assert');
var debug = require('debug')('proxy');
var util = require('util');
var _ = require('underscore');
var requireNew = require('require-new');

// log levels
debug.request = require('debug')('proxy ← ← ←');
debug.response = require('debug')('proxy → → →');
debug.proxyRequest = require('debug')('proxy ↑ ↑ ↑');
debug.proxyResponse = require('debug')('proxy ↓ ↓ ↓');
debug.session = require('debug')('');
const USE_CONTROL_PORT = false;
const TOR_CONTROL_PORT = 30320;
const TOR_CONTROL_PASS = "wM0XZoaJ6urBtW";
const TOR_PORT = 17500;
const MAX_CONNECTIONS = 100;
const PROXY_PORT = 80;

var sessions = [];
for (var i = 0; i < MAX_CONNECTIONS; i++)
  sessions[i] = {
    tor: TOR_PORT + i,
    control: TOR_CONTROL_PORT + i,
    busy: false,
    lastUse: new Date()
  };

function setupTorSession(sessionKey) {
  var sessionQuery = {
    busy: false
  };
  if (sessionKey)
    sessionQuery.key = sessionKey;
  var torSession = _.findWhere(_.sortBy(sessions, 'lastUse'), sessionQuery);
  if (sessionKey && !torSession) {
    torSession = _.findWhere(_.sortBy(sessions, 'lastUse'), {
      busy: false
    });
    torSession.key = sessionKey;
  }
  torSession.busy = true;
  torSession.lastUse = new Date();
  var tr = requireNew('tor-request');
  tr.setTorAddress('localhost', torSession.tor);
  //console.log('Using tor session', torSession);
  tr.end = function () {
    torSession.busy = false;
  }
  tr.session = torSession;
  return tr;
}
// hostname
var hostname = require('os').hostname();

/**
 * Sets up an `http.Server` or `https.Server` instance with the necessary
 * "request" and "connect" event listeners in order to make the server act as an
 * HTTP proxy.
 *
 * @param {http.Server|https.Server} server
 * @param {Object} options
 * @api public
 */

function setup(server, options) {
  if (!server) {
    server = http.createServer();
    server.listen(process.env.port||PROXY_PORT);
    console.log('Server listening on port %s', process.env.port);
  }

  server.on('request', onrequest);
  server.on('connect', onconnect);
  return server;
}
setup();

function torRequest(options, done, session) {
  let tr = setupTorSession(session);
  return tr.request(options, function (err, res, body) {
    tr.end();
    return done(err, res, body);
  });
}

/**
 * 13.5.1 End-to-end and Hop-by-hop Headers
 *
 * Hop-by-hop headers must be removed by the proxy before passing it on to the
 * next endpoint. Per-request basis hop-by-hop headers MUST be listed in a
 * Connection header, (section 14.10) to be introduced into HTTP/1.1 (or later).
 */

var hopByHopHeaders = [
  'Connection',
  'Keep-Alive',
  'Proxy-Authenticate',
  'Proxy-Authorization',
  'TE',
  'Trailers',
  'Transfer-Encoding',
  'Upgrade',
  'X-Session'
];

// create a case-insensitive RegExp to match "hop by hop" headers
var isHopByHop = new RegExp('^(' + hopByHopHeaders.join('|') + ')$', 'i');

/**
 * Iterator function for the request/response's "headers".
 * Invokes `fn` for "each" header entry in the request.
 *
 * @api private
 */

function eachHeader(obj, fn) {
  if (Array.isArray(obj.rawHeaders)) {
    // ideal scenario... >= node v0.11.x
    // every even entry is a "key", every odd entry is a "value"
    var key = null;
    obj.rawHeaders.forEach(function (v) {
      if (key === null) {
        key = v;
      } else {
        fn(key, v);
        key = null;
      }
    });
  } else {
    // otherwise we can *only* proxy the header names as lowercase'd
    var headers = obj.headers;
    if (!headers) return;
    Object.keys(headers).forEach(function (key) {
      var value = headers[key];
      if (Array.isArray(value)) {
        // set-cookie
        value.forEach(function (val) {
          fn(key, val);
        });
      } else {
        fn(key, value);
      }
    });
  }
}

function parseHeaders(req) {
  let headers = {};
  let sessionKey = null;
  eachHeader(req, function (key, value) {
    var keyLower = key.toLowerCase();
    if (keyLower === 'x-session') sessionKey = value;

    if (isHopByHop.test(key)) {
      debug.proxyRequest('ignoring hop-by-hop header "%s"', key);
    } else {
      var v = headers[key];
      if (Array.isArray(v)) {
        v.push(value);
      } else if (null != v) {
        headers[key] = [v, value];
      } else {
        headers[key] = value;
      }
    }
  });
  return {
    headers: headers,
    session: sessionKey
  };
}

/**
 * HTTP GET/POST/DELETE/PUT, etc. proxy requests.
 */

function onrequest(req, res) {
  var originalReq = req;
  debug.request('%s %s HTTP/%s ', req.method, req.url, req.httpVersion);
  var server = this;
  var socket = req.socket;

  // pause the socket during authentication so no data is lost
  socket.pause();

  authenticate(server, req, function (err, auth) {
    socket.resume();
    if (err) {
      // an error occured during login!
      res.writeHead(500);
      res.end((err.stack || err.message || err) + '\n');
      return;
    }
    if (!auth) return requestAuthorization(req, res);
    var parsed = url.parse(req.url);

    // proxy the request HTTP method
    parsed.method = req.method;

    // setup outbound proxy request HTTP headers
    var parseResult = parseHeaders(req);
    var headers = parseResult.headers;
    var sessionKey = parseResult.session;

    parsed.headers = headers;

    // custom `http.Agent` support, set `server.agent`
    var agent = server.agent;
    if (null != agent) {
      debug.proxyRequest('setting custom `http.Agent` option for proxy request: %s', agent);
      parsed.agent = agent;
      agent = null;
    }

    if (null == parsed.port) {
      // default the port number if not specified, for >= node v0.11.6...
      // https://github.com/joyent/node/issues/6199
      parsed.port = 80;
    }

    if ('http:' != parsed.protocol) {
      // only "http://" is supported, "https://" should use CONNECT method
      res.writeHead(400);
      res.end('Only "http:" protocol prefix is supported\n');
      return;
    }
    parsed.url = parsed.href;

    var gotResponse = false;
    var torReq = torRequest(parsed, function (err, proxyReq, body) {
      if (err) return onerror(err);
      debug.proxyRequest('%s %s HTTP/1.1 ', proxyReq.method, proxyReq.path);

      proxyReq.on('response', function (proxyRes) {
        debug.proxyResponse('HTTP/1.1 %s', proxyRes.statusCode);
        gotResponse = true;

        var headers = {};
        eachHeader(proxyRes, function (key, value) {
          debug.proxyResponse('Proxy Response Header: "%s: %s"', key, value);
          if (isHopByHop.test(key)) {
            debug.response('ignoring hop-by-hop header "%s"', key);
          } else {
            var v = headers[key];
            if (Array.isArray(v)) {
              v.push(value);
            } else if (null != v) {
              headers[key] = [v, value];
            } else {
              headers[key] = value;
            }
          }
        });

        debug.response('HTTP/1.1 %s', proxyRes.statusCode);
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
        res.on('finish', onfinish);
      });

      function onerror(err) {
        debug.proxyResponse('proxy HTTP request "error" event\n%s', err.stack || err);
        cleanup();
        if (gotResponse) {
          debug.response('already sent a response, just destroying the socket...');
          socket.destroy();
        } else if ('ENOTFOUND' == err.code) {
          debug.response('HTTP/1.1 404 Not Found');
          res.writeHead(404);
          res.end();
        } else {
          debug.response('HTTP/1.1 500 Internal Server Error');
          res.writeHead(500);
          res.end();
        }
      }

      proxyReq.on('error', onerror);

      // if the client closes the connection prematurely,
      // then close the upstream socket
      function onclose() {
        debug.request('client socket "close" event, aborting HTTP request to "%s"', req.url);
        proxyReq.destroy();
        cleanup();
      }
      socket.on('close', onclose);

      function onfinish() {
        debug.response('"finish" event');
        cleanup();
      }

      function cleanup() {
        debug.response('cleanup');
        socket.removeListener('close', onclose);
        res.removeListener('finish', onfinish);
      }
    }, sessionKey);
    torReq.pipe(res);
  });

}

/**
 * HTTP CONNECT proxy requests.
 */

function onconnect(req, socket, head) {
  debug.request('%s %s HTTP/%s ', req.method, req.url, req.httpVersion);
  assert(!head || 0 == head.length, '"head" should be empty for proxy requests');

  var res;
  var target;
  var gotResponse = false;
  var parseResult = parseHeaders(req);
  var sessionKey = parseResult.session;
  // define request socket event listeners
  function onclientclose(err) {
    debug.request('HTTP request %s socket "close" event', req.url);
  }
  socket.on('close', onclientclose);

  function onclientend() {
    debug.request('HTTP request %s socket "end" event', req.url);
    cleanup();
  }

  function onclienterror(err) {
    debug.request('HTTP request %s socket "error" event:\n%s', req.url, err.stack || err);
  }
  socket.on('error', onclienterror);

  // define target socket event listeners
  function ontargetclose() {
    debug.proxyResponse('proxy target %s "close" event', req.url);
    cleanup();
    socket.destroy();
  }

  function ontargetend() {
    debug.proxyResponse('proxy target %s "end" event', req.url);
    cleanup();
  }

  function ontargeterror(err) {
    debug.proxyResponse('proxy target %s "error" event:\n%s', req.url, err.stack || err);
    cleanup();
    if (gotResponse) {
      debug.response('already sent a response, just destroying the socket...');
      socket.destroy();
    } else if ('ENOTFOUND' == err.code) {
      debug.response('HTTP/1.1 404 Not Found');
      res.writeHead(404);
      res.end();
    } else {
      debug.response('HTTP/1.1 500 Internal Server Error');
      res.writeHead(500);
      res.end();
    }
  }

  function ontargetconnect() {
    debug.proxyResponse('proxy target %s "connect" event', req.url);
    debug.response('HTTP/1.1 200 Connection established');
    gotResponse = true;
    res.removeListener('finish', onfinish);

    res.writeHead(200, 'Connection established');

    // HACK: force a flush of the HTTP header
    res._send('');
    // relinquish control of the `socket` from the ServerResponse instance
    res.detachSocket(socket);

    // nullify the ServerResponse object, so that it can be cleaned
    // up before this socket proxying is completed
    res = null;

    var parser = new require('stream').Transform();
    parser._transform = function (data, encoding, done) {
      var textChunk = data.toString('utf8');
      this.push(data);
      done();
    };
    socket.pipe(target);


    target.pipe(socket);
  }

  // cleans up event listeners for the `socket` and `target` sockets
  function cleanup() {
    debug.response('cleanup');
    socket.removeListener('close', onclientclose);
    socket.removeListener('error', onclienterror);
    socket.removeListener('end', onclientend);
    if (target) {
      target.removeListener('connect', ontargetconnect);
      target.removeListener('close', ontargetclose);
      target.removeListener('error', ontargeterror);
      target.removeListener('end', ontargetend);
    }
  }

  // create the `res` instance for this request since Node.js
  // doesn't provide us with one :(
  // XXX: this is undocumented API, so it will break some day (ノಠ益ಠ)ノ彡┻━┻

  res = new http.ServerResponse(req);
  res.shouldKeepAlive = false;
  res.chunkedEncoding = false;
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);


  // called for the ServerResponse's "finish" event
  // XXX: normally, node's "http" module has a "finish" event listener that would
  // take care of closing the socket once the HTTP response has completed, but
  // since we're making this ServerResponse instance manually, that event handler
  // never gets hooked up, so we must manually close the socket...
  function onfinish() {
    debug.response('response "finish" event');
    res.detachSocket(socket);
    socket.end();
  }
  res.once('finish', onfinish);
  // pause the socket during authentication so no data is lost
  socket.pause();

  authenticate(this, req, function (err, auth) {
    socket.resume();
    if (err) {
      // an error occured during login!
      res.writeHead(500);
      res.end((err.stack || err.message || err) + '\n');
      return;
    }
    if (!auth) return requestAuthorization(req, res);

    var parts = req.url.split(':');
    var host = parts[0];
    var port = +parts[1];

    var tr = setupTorSession(sessionKey);
    var session = tr.session;
    var Socks = require('socks');
    var options = {
      proxy: {
        ipaddress: "localhost", // tor address
        port: session.tor, // tor port
        type: 5,
      },
      target: {
        host: host, // can be an ip address or domain (4a and 5 only) 
        port: port
      },
      timeout: 60000,
      command: 'connect' // This defaults to connect, so it's optional if you're not using BIND or Associate. 
    };

    Socks.createConnection(options, function (err, socksTarget, info) {
      debug.proxyRequest('connecting to proxy target %j', options);
      if (err) return ontargeterror(err);
      if (!socksTarget) return console.error(new Error("No target socket"));
      target = socksTarget;
      // hack force 'connect' event
      ontargetconnect();
      target.on('connect', ontargetconnect);
      target.on('close', ontargetclose);
      target.on('error', ontargeterror);
      target.on('end', ontargetend);
      target.on('end', function () {
        session.busy = false;
      })
      target.resume();
    });
  });
}

/**
 * Checks `Proxy-Authorization` request headers. Same logic applied to CONNECT
 * requests as well as regular HTTP requests.
 *
 * @param {http.Server} server
 * @param {http.ServerRequest} req
 * @param {Function} fn callback function
 * @api private
 */

function authenticate(server, req, fn) {
  var hasAuthenticate = 'function' == typeof server.authenticate;
  if (hasAuthenticate) {
    debug.request('authenticating request "%s %s"', req.method, req.url);
    server.authenticate(req, fn);
  } else {
    // no `server.authenticate()` function, so just allow the request
    fn(null, true);
  }
}

/**
 * Sends a "407 Proxy Authentication Required" HTTP response to the `socket`.
 *
 * @api private
 */

function requestAuthorization(req, res) {
  // request Basic proxy authorization
  debug.response('requesting proxy authorization for "%s %s"', req.method, req.url);

  // TODO: make "realm" and "type" (Basic) be configurable...
  var realm = 'proxy';

  var headers = {
    'Proxy-Authenticate': 'Basic realm="' + realm + '"'
  };
  res.writeHead(407, headers);
  res.end();
}
