const BinaryPack = require('js-binarypack');
const RTCPeerConnection = require('./adapter').RTCPeerConnection;

const defaultConfig = {'iceServers': [{ 'url': 'stun:stun.l.google.com:19302' }]};
let dataCount = 1;

const util = {
  noop: function() {},
  chunkedBrowsers: {'Chrome': 1}, //Browsers that need chunking
  chunkedMTU: 16300, // The original 60000 bytes setting does not work when sending data from Firefox to Chrome, which is "cut off" after 16384 bytes and delivered individually.
  logLevel: 0,
  setLogLevel: function(level) {
    var debugLevel = parseInt(level, 10);
    if (!isNaN(parseInt(level, 10))) {
      util.logLevel = debugLevel;
    } else {
      // If they are using truthy/falsy values for debug
      util.logLevel = level ? 3 : 0;
    }
    util.log = util.warn = util.error = util.noop;
    if (util.logLevel > 0) {
      util.error = util._printWith('ERROR');
    }
    if (util.logLevel > 1) {
      util.warn = util._printWith('WARNING');
    }
    if (util.logLevel > 2) {
      util.log = util._print;
    }
  },
  setLogFunction: function(fn) {
    util._print = (fn && fn.constructor === Function) ? fn : util._print;
  },
  _printWith: function(prefix) {
    return function() {
      const copy = Array.prototype.slice.call(arguments);
      copy.unshift(prefix);
      util._print.apply(util, copy);
    };
  },
  _print: function () {
    const copy = Array.prototype.slice.call(arguments);
    const err = copy.some(c => c instanceof Error);
    copy.unshift('PeerJS: ');
    copy.map(c => (c instanceof Error) ? '(' + c.name + ') ' + c.message : c);
    err ? console.error.apply(console, copy) : console.log.apply(console, copy);
  },
  defaultConfig: defaultConfig,
  browser: (function() {
    if (window.mozRTCPeerConnection) return 'Firefox';
    if (window.webkitRTCPeerConnection) return 'Chrome';
    if (window.RTCPeerConnection) return 'Supported';
    return 'Unsupported';
  })(),
  supports: (function() {
    if (typeof RTCPeerConnection === 'undefined') return {};

    let data = true;
    let binaryBlob = false;
    let sctp = false;
    let onnegotiationneeded = !!window.webkitRTCPeerConnection;
    let pc, dc;

    try {
      pc = new RTCPeerConnection(defaultConfig, {optional: [{RtpDataChannels: true}]});
    } catch (e) {
      data = false;
    }

    if (data) {
      try {
        dc = pc.createDataChannel('_PEERJSTEST');
      } catch (e) {
        data = false;
      }
    }

    if (data) {
      try {
        dc.binaryType = 'blob';
        binaryBlob = true;
      } catch (e) {}

      // Reliable test. Unfortunately Chrome is a bit unreliable about whether or not they support reliable.
      const reliablePC = new RTCPeerConnection(defaultConfig, {});
      try {
        const reliableDC = reliablePC.createDataChannel('_PEERJSRELIABLETEST', {});
        sctp = reliableDC.reliable;
      } catch (e) {}
      reliablePC.close();
    }

    if (!onnegotiationneeded && data) {
      const negotiationPC = new RTCPeerConnection(defaultConfig, {optional: [{RtpDataChannels: true}]});
      negotiationPC.onnegotiationneeded = function() {
        onnegotiationneeded = true;
        if (util && util.supports) {
          util.supports.onnegotiationneeded = true;
        }
      };
      negotiationPC.createDataChannel('_PEERJSNEGOTIATIONTEST');

      setTimeout(negotiationPC.close, 1000);
    }

    if (pc) {
      pc.close();
    }

    return {
      data,
      binaryBlob,
      binary: sctp, // deprecated; sctp implies binary support.
      reliable: sctp, // deprecated; sctp implies reliable data.
      sctp,
      onnegotiationneeded
    };
  }()),
  validateId: (id) => !id || /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/.exec(id), // Ensure alphanumeric ids (empty ids allowed)
  debug: false,

  inherits: function(ctor, superCtor) {
    ctor.super_ = superCtor;
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  },
  extend: function(dest, source) {
    for(let key in source) {
      if(source.hasOwnProperty(key)) {
        dest[key] = source[key];
      }
    }
    return dest;
  },
  pack: BinaryPack.pack,
  unpack: BinaryPack.unpack,

  log: function () {
    if (util.debug) {
      const copy = Array.prototype.slice.call(arguments);
      const err = copy.some(c => c instanceof Error);
      copy.unshift('PeerJS: ');
      copy.map(c => (c instanceof Error) ? '(' + c.name + ') ' + c.message : c);
      err ? console.error.apply(console, copy) : console.log.apply(console, copy);
    }
  },

  setZeroTimeout: (function(global) {
    const timeouts = [];
    const messageName = 'zero-timeout-message';

    // Like setTimeout, but only takes a function argument.	 There's no time argument (always zero) and no arguments (you have to use a closure).
    function setZeroTimeoutPostMessage(fn) {
      timeouts.push(fn);
      global.postMessage(messageName, '*');
    }

    function handleMessage(event) {
      if (event.source == global && event.data == messageName) {
        event.stopPropagation();
        timeouts.length &&timeouts.shift()();
      }
    }

    global.addEventListener('message', handleMessage, true);
    return setZeroTimeoutPostMessage;
  }(window)),

  // Binary stuff

  // chunks a blob.
  chunk: function(bl) {
    const chunks = [];
    const size = bl.size;
    const total = Math.ceil(size / util.chunkedMTU);
    let index = 0;
    let start = 0;

    while (start < size) {
      let end = Math.min(size, start + util.chunkedMTU);
      let b = bl.slice(start, end);

      const chunk = {
        __peerData: dataCount,
        n: index,
        data: b,
        total
      };

      chunks.push(chunk);
      start = end;
      index += 1;
    }
    dataCount += 1;
    return chunks;
  },

  blobToArrayBuffer: function(blob, cb){
    const fr = new FileReader();
    fr.onload = ({target}) => cb(target.result);
    fr.readAsArrayBuffer(blob);
  },
  blobToBinaryString: function(blob, cb){
    const fr = new FileReader();
    fr.onload = ({target}) => cb(target.result);
    fr.readAsBinaryString(blob);
  },
  binaryStringToArrayBuffer: function(binary) {
    const byteArray = new Uint8Array(binary.length);
    binary.forEach((_, i) => byteArray[i] = binary.charCodeAt(i) & 0xff);
    return byteArray.buffer;
  },
  randomToken: () => Math.random().toString(36).substr(2),
  isSecure: () => location.protocol === 'https:'
};

module.exports = util;
