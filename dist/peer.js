(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
module.exports.RTCSessionDescription = window.RTCSessionDescription || window.mozRTCSessionDescription;
module.exports.RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
module.exports.RTCIceCandidate = window.RTCIceCandidate || window.mozRTCIceCandidate;

},{}],2:[function(require,module,exports){
const util                                                          = require('./util');
const EventEmitter                                                  = require('eventemitter3');
const Negotiator                                                    = require('./negotiator');
const SystemMessage                                                 = require('@phame/phame-shared/src/message/systemMessage.js');
const {SERIALIZED_JSON, SERIALIZED_BINARY, SERIALIZED_BINARY_UTF8}	= require('./serialization-types');

const {ANSWER, CANDIDATE} = SystemMessage.names;
const ID_PREFIX = 'dc_';

function DataConnection(peer, provider, options) {
  if (!(this instanceof DataConnection)) return new DataConnection(peer, provider, options);
  EventEmitter.call(this);

  this.options = util.extend({serialization: SERIALIZED_BINARY}, options);

  this.open = false;
  this.peer = peer;
  this.provider = provider;

  this.id = this.options.connectionId || ID_PREFIX + util.randomToken();

  this.label = this.options.label || this.id;
  this.metadata = this.options.metadata;
  this.serialization = this.options.serialization;
  this.reliable = this.options.reliable;

  this._buffer = [];
  this._buffering = false;

  this._chunkedData = {};   // For storing large data.

  this._peerBrowser = (this.options._payload) ? this.options._payload.browser : undefined;

  Negotiator.startConnection(this, this.options._payload || {originator: true});
}

util.inherits(DataConnection, EventEmitter);

DataConnection.prototype.setReliableDataChannel = function(reliableDataChannel) {
  this._reliableDataChannel = reliableDataChannel;
  this._configureDataChannel(reliableDataChannel);
  reliableDataChannel.onopen = () => {
    util.log('Reliable data channel connection success');
    this.open = true;
    this.emit('open');
  };
};

DataConnection.prototype.setUnreliableDataChannel = function(unreliableDataChannel) {
  this._unreliableDataChannel = unreliableDataChannel;
  this._configureDataChannel(this._unreliableDataChannel);
};

DataConnection.prototype._configureDataChannel = function(dataChannel) {
  dataChannel.binaryType = 'arraybuffer';
  dataChannel.onmessage = this._handleDataMessage.bind(this);

  dataChannel.onclose = () => {
    util.log('DataChannel closed for:', self.peer);
    this.close();
  };
};

DataConnection.prototype._handleDataMessage = function({data}) {
  switch(this.serialization) {
    case SERIALIZED_BINARY:
    case SERIALIZED_BINARY_UTF8:
      switch(data.constructor) {
        case Blob: // Datatype should never be blob
          util.blobToArrayBuffer(data, ab => this.emit('data', util.unpack(ab)));
          return;
        case ArrayBuffer:
          data = util.unpack(data);
          break;
        case String: // String fallback for binary data for browsers that don't support binary yet
          data = util.unpack(util.binaryStringToArrayBuffer(data));
          break;
        default:
          break;
      }
      break;
    case SERIALIZED_JSON:
      data = JSON.parse(data);
      break;
    default:
      break;
  }

  // Check if we've chunked--if so, piece things back together. We're guaranteed that this isn't 0.
  if (data.__peerData) {
    const id = data.__peerData;
    const chunkInfo = this._chunkedData[id] || {data: [], count: 0, total: data.total};
    chunkInfo.data[data.n] = data.data;

    if (chunkInfo.total === ++chunkInfo.count) {  // We've received all the chunks--time to construct the complete data.
      delete this._chunkedData[id];               // Clean up before making the recursive call to `_handleDataMessage`.
      this._handleDataMessage({data: new Blob(chunkInfo.data)});
    }

    this._chunkedData[id] = chunkInfo;
    return;
  }

  this.emit('data', data);
};

/** Exposed functionality for users.*/

DataConnection.prototype.close = function() {
  if (!this.open) return;

  this.open = false;
  Negotiator.cleanup(this);
  this.emit('close');
};

DataConnection.prototype.sendUnreliably = function (data, chunked) {
  this._send(data, false, chunked);
};

DataConnection.prototype.send = function (data, chunked) {
  this._send(data, true, chunked);
};

DataConnection.prototype._send = function(data, reliable, chunked) {
  if (!this.open) {
    this.emit('error', new Error('Connection is not open. You should listen for the `open` event before sending messages.'));
    return;
  }

  switch(this.serialization) {
    case SERIALIZED_JSON:
      this._bufferedSend({data: JSON.stringify(data), reliable: reliable});
      break;
    case SERIALIZED_BINARY:
    case SERIALIZED_BINARY_UTF8:
      const blob = util.pack(data);

      // For Chrome-Firefox interoperability, we need to make Firefox "chunk" the data it sends out.
      const needsChunking = util.chunkedBrowsers[this._peerBrowser] || util.chunkedBrowsers[util.browser];
      if (needsChunking && !chunked && blob.size > util.chunkedMTU) {
        this._sendChunks({data: blob, reliable: reliable});
        return;
      }

      if (!util.supports.binaryBlob) {
        util.blobToArrayBuffer(blob, (arrayBuffer) => this._bufferedSend({data: arrayBuffer, reliable: reliable})); 	// We only do this if we really need to (e.g. blobs are not supported), because this conversion is costly.
      } else {
        this._bufferedSend({data: blob, reliable: reliable});
      }
      break;
    default:
      this._bufferedSend({data: data, reliable: reliable});
      break;
  }
};

DataConnection.prototype._bufferedSend = function(message) {
  if (this._buffering || !this._trySend(message)) {
    this._buffer.push(message);
  }
};

DataConnection.prototype._trySend = function(message) {
  if (!message.reliable && this._unreliableDataChannel) {
    try {
      this._unreliableDataChannel.send(message.data);
    } catch(e) {}

    return;
  }

  try {
    this._reliableDataChannel.send(message.data);
  } catch (e) {
    this._buffering = true;

    setTimeout(() => {
      this._buffering = false;
      this._tryBuffer(); // Try again.
    }, 100);
    return false;
  }
  return true;
};

DataConnection.prototype._tryBuffer = function() {
  if (this._buffer.length === 0) return;

  if (this._trySend(this._buffer[0])) {
    this._buffer.shift();
    this._tryBuffer();
  }
};

DataConnection.prototype._sendChunks = function(message) {
  util.chunk(message.data).forEach(chunk => this._send(chunk, message.reliable, true));
};

DataConnection.prototype.handleMessage = function({type, name, data}) {
  switch (name) {
    case ANSWER:
      this._peerBrowser = data.browser;
      Negotiator.handleSDP(type, this, data.sdp);
      break;
    case CANDIDATE:
      Negotiator.handleCandidate(this, data.candidate);
      break;
    default:
      util.warn('Unrecognized message type:', type, 'from peer:', this.peer);
      break;
  }
};

module.exports = DataConnection;

},{"./negotiator":5,"./serialization-types":7,"./util":9,"@phame/phame-shared/src/message/systemMessage.js":12,"eventemitter3":16}],3:[function(require,module,exports){
const debugLevels = {
	OFF: 0,
	ERRORS: 1,
	WARNING: 2,
	ALL: 3
};

module.exports = debugLevels;
},{}],4:[function(require,module,exports){
window.Socket = require('./socket');
window.DataConnection = require('./dataconnection');
window.Peer = require('./peer');
window.RTCPeerConnection = require('./adapter').RTCPeerConnection;
window.RTCSessionDescription = require('./adapter').RTCSessionDescription;
window.RTCIceCandidate = require('./adapter').RTCIceCandidate;
window.Negotiator = require('./negotiator');
window.util = require('./util');
window.BinaryPack = require('js-binarypack');

},{"./adapter":1,"./dataconnection":2,"./negotiator":5,"./peer":6,"./socket":8,"./util":9,"js-binarypack":17}],5:[function(require,module,exports){
const util                    = require('./util');
const RTCPeerConnection       = require('./adapter').RTCPeerConnection;
const RTCSessionDescription   = require('./adapter').RTCSessionDescription;
const RTCIceCandidate         = require('./adapter').RTCIceCandidate;
const SystemMessage           = require('@phame/phame-shared/src/message/systemMessage.js');

const ID_PREFIX = 'pc_';
const {OFFER, ANSWER, CANDIDATE} = SystemMessage.names;

const Negotiator = {
  pcs: {}, // {peerId: {pc_id: pc}}.
  queue: [] // connections that are delayed due to a PC being in use.
};

Negotiator.startConnection = function(connection, options) {
  const pc = Negotiator._getPeerConnection(connection, options);
  connection.pc = connection.peerConnection = pc;

  if (options.originator) {
      const reliableDataChannel = pc.createDataChannel(connection.label + '_reliable', {reliable: true});
      const unreliableDataChannel = pc.createDataChannel(connection.label + '_unreliable', {reliable: false, ordered: true, maxRetransmits: 0});

    connection.setReliableDataChannel(reliableDataChannel);
      connection.setUnreliableDataChannel(unreliableDataChannel);

    if (!util.supports.onnegotiationneeded) { //TODO: REMOVE THESE? SEEMS LIKE IT WAS NOT SUPPORTED IN FIREFOX, BUT IS TODAY
      Negotiator._makeOffer(connection);
    }
  } else {
    Negotiator.handleSDP('OFFER', connection, options.sdp);
  }
};

Negotiator._getPeerConnection = function(connection, options) {
  Negotiator.pcs[connection.peer] = Negotiator.pcs[connection.peer] || {};

  const pc  = (options.pc) ? Negotiator.pcs[connection.peer][options.pc] : null;
  return (!pc || pc.signalingState !== 'stable') ? Negotiator._startPeerConnection(connection) : pc;
};

Negotiator._startPeerConnection = function(connection) {
  util.log('Creating RTCPeerConnection.');
  const id = ID_PREFIX + util.randomToken();
  const pc = new RTCPeerConnection(connection.provider.options.config, {});
  Negotiator.pcs[connection.peer][id] = pc;
  Negotiator._setupListeners(connection, pc, id);

  return pc;
};

/** Set up various WebRTC listeners. */
Negotiator._setupListeners = function(connection, pc) {
  const {peer, id, provider} = connection;

  pc.onicecandidate = function(event) {
    if (event.candidate) {
      util.log('Received ICE candidates for:', peer);
      const candidateMessage = new SystemMessage(SystemMessage.names.CANDIDATE, {candidate: event.candidate, connectionId: connection.id});
      candidateMessage.setReceiver(peer);
      provider.socket.send(candidateMessage);
    }
  };

  pc.oniceconnectionstatechange = function() {
    switch (pc.iceConnectionState) {
      case 'failed':
        util.log('iceConnectionState is disconnected, closing connections to ' + peer);
        connection.emit('error', new Error('Negotiation of connection to ' + peer + ' failed.'));
        connection.close();
        break;
      case 'disconnected':
        util.log('iceConnectionState is disconnected, closing connections to ' + peer);
        connection.close();
        break;
      case 'completed':
        pc.onicecandidate = util.noop;
        break;
      default:
        break;
    }
  };

  pc.onnegotiationneeded = function() {	// onNegotiationNeeded (Chrome)
    util.log('`negotiationneeded` triggered');
    (pc.signalingState === 'stable') ? Negotiator._makeOffer(connection) : util.log('onnegotiationneeded triggered when not stable. Is another connection being established?');
  };

  pc.ondatachannel = function(event) {   // Fired between offer and answer, so options should already be saved in the options hash.
    util.log('Received data channel');
    if (event.channel.reliable) {
      provider.getConnection(peer, id).setReliableDataChannel(event.channel);
    } else {
      provider.getConnection(peer, id).setUnreliableDataChannel(event.channel);
    }
  };
};

Negotiator.cleanup = function(connection) {
  const {pc, peer} = connection;
  util.log('Cleaning up PeerConnection to ' + peer);

  if (!!pc && (pc.readyState !== 'closed' || pc.signalingState !== 'closed')) {
    pc.close();
    connection.pc = null;
  }
};

Negotiator._makeOffer = function(connection) {
  const {pc, provider, label, id, reliable, serialization, metadata, peer} = connection;

  const constraints = {
    mandatory: {
      OfferToReceiveAudio: false,
      OfferToReceiveVideo: false
    }
  };

  function createOfferSuccessHandler(offer) {
    util.log('Created offer.');

    function setLocalDescriptionSucccessHandler() {
      util.log('Set localDescription: offer', 'for:', peer);
      const offerMessage = new SystemMessage(OFFER, {sdp: offer, label, reliable, serialization, metadata, connectionId: id, browser: util.browser});
      offerMessage.setReceiver(peer);
      provider.socket.send(offerMessage);
    }

    function setLocalDescriptionErrorHandler() {
      provider.emitError('webrtc', err);
      util.log('Failed to setLocalDescription, ', err);
    }

    pc.setLocalDescription(offer, setLocalDescriptionSucccessHandler, setLocalDescriptionErrorHandler);
  }

  function createOfferErrorHandler(err) {
    provider.emitError('webrtc', err);
    util.log('Failed to create answer, ', err);
  }

  pc.createOffer(createOfferSuccessHandler, createOfferErrorHandler, constraints);
};

Negotiator._makeAnswer = function({pc, peer, id, provider}) {
  function makeAnswerSuccessHandler(answer) {
    function setLocalDescriptionSuccessHandler() {
      util.log('Set localDescription: answer', 'for:', peer);
      const answerMessage = new SystemMessage(ANSWER, {sdp: answer, connectionId: id, browser: util.browser});
      answerMessage.setReceiver(peer);
      provider.socket.send(answerMessage);
    }

    function setLocalDescriptionErrorHandler(err) {
      provider.emitError('webrtc', err);
      util.log('Failed to setLocalDescription, ', err);
    }

    util.log('Created answer.');
    pc.setLocalDescription(answer, setLocalDescriptionSuccessHandler, setLocalDescriptionErrorHandler);
  }

  function makeAnswerErrorHandler(err) {
    provider.emitError('webrtc', err);
    util.log('Failed to create answer, ', err);
  }

  pc.createAnswer(makeAnswerSuccessHandler, makeAnswerErrorHandler);
};

Negotiator.handleSDP = function(type, connection, sdp) {
  const {pc, peer, provider} = connection;
  sdp = new RTCSessionDescription(sdp);

  function setRemoteDescriptionSuccessHandler() {
    util.log('Set remoteDescription for:', peer);

    if (type === 'OFFER') {
      Negotiator._makeAnswer(connection);
    }
  }

  function setRemoteDescriptionErrorHandler(err) {
    provider.emitError('webrtc', err);
    util.log('Failed to setRemoteDescription, ', err);
  }

  util.log('Setting remote description', sdp);
  pc.setRemoteDescription(sdp, setRemoteDescriptionSuccessHandler, setRemoteDescriptionErrorHandler);
};

Negotiator.handleCandidate = function(connection, ice) {
  const {candidate, sdpMLineIndex} = ice;
  const {pc, peer} = connection;

  pc.addIceCandidate(new RTCIceCandidate({sdpMLineIndex, candidate}));
  util.log('Added ICE candidate for:', peer);
};

module.exports = Negotiator;
},{"./adapter":1,"./util":9,"@phame/phame-shared/src/message/systemMessage.js":12}],6:[function(require,module,exports){
const util              = require('./util');
const EventEmitter      = require('eventemitter3');
const Socket            = require('./socket');
const DataConnection    = require('./dataconnection');
const GenericMessage    = require('@phame/phame-shared/src/message/genericMessage.js');
const SystemMessage     = require('@phame/phame-shared/src/message/systemMessage.js');
const {CREATE, JOIN}    = {CREATE: 'create', JOIN: 'join'};//require('@phame/phame-shared/src/configuration/servers.json').signalingServer.actionTypes;
const {OFF} 			= require('./debug-levels');

const {SIGNALING_SERVER_CONNECTION_OPEN, ID_TAKEN, LEAVE, PEER_GONE, OFFER, ANSWER, CANDIDATE} = SystemMessage.names;

/** A peer who can initiate connections with other peers.*/
function Peer(createSession, id, humanFriendlySessionId, options) {
  if (!(this instanceof Peer)) return new Peer(createSession, id, humanFriendlySessionId, options);
  EventEmitter.call(this);

  if (id) {
    id = id.toString(); //Ensure id is a string
  }

  options = util.extend({debug: OFF, token: util.randomToken(), config: util.defaultConfig}, options);
  this.options = options;

  options.secure = (options.secure === undefined) ? util.isSecure() : options.secure;

  util.setLogFunction(options.logFunction || null);
  util.setLogLevel(options.debug);

  if (!util.supports.data ) {
    this._delayedAbort('browser-incompatible', 'The current browser does not support WebRTC');
    return;
  }

  if (!util.validateId(id)) {
    this._delayedAbort('invalid-id', 'ID "' + id + '" is invalid');
    return;
  }

  this.destroyed = false; // Connections have been killed
  this.disconnected = false; // Connection to PeerServer killed but P2P connections still active
  this.open = false; // Sockets and such are not yet open.

  this.connections = {}; // DataConnections for this peer.
  this._lostMessages = {}; // src => [list of messages]

  this._initializeServerConnection();

  (createSession) ? this._initialize(CREATE, id, humanFriendlySessionId) : this._initialize(JOIN, id, humanFriendlySessionId);
}

util.inherits(Peer, EventEmitter);

Peer.prototype._closeHandler = function () {
  if (!this.disconnected) {     // If we haven't explicitly disconnected, emit error.
    this._abort('socket-closed', 'Underlying socket is already closed.');
  }
};

Peer.prototype._disconnectHandler = function () {
  if (!this.disconnected) { // If we haven't explicitly disconnected, emit error and disconnect.
    this.emitError('network', 'Lost connection to server.');
    this.disconnect();
  }
};

Peer.prototype._initializeServerConnection = function() {
  this.socket = new Socket(this.options.secure, this.options.host, this.options.path);
  this.socket.on('message', this._handleMessage.bind(this));
  this.socket.on('error', error => this._abort('socket-error', error));
  this.socket.on('disconnected', this._disconnectHandler.bind(this));
  this.socket.on('close', this._closeHandler.bind(this));
};

/** Initialize a connection with the server. */
Peer.prototype._initialize = function(action, id, humanFriendlySessionId) {
  this.id = id;
  this.humanFriendlySessionId = humanFriendlySessionId;
  this.socket.start(action, this.id, this.options.token, humanFriendlySessionId);
};

/** Handles messages from the server. */
Peer.prototype._handleMessage = function(message) {
  const {data, sender, name, type} = message;
  let connection;

  if (type === GenericMessage.types.SYSTEM_MESSAGE) {
    switch(name) {
      case SIGNALING_SERVER_CONNECTION_OPEN:  // The connection to the server is open.
          this.emit('open', this.id, this.humanFriendlySessionId);
          this.open = true;
          break;
      case ID_TAKEN:
        this._abort('unavailable-id', 'ID `' + this.id + '` is taken');
          break;
      case LEAVE: // Another peer has closed its connection to this peer.
        util.log('Received leave message from', sender);
        this._cleanupPeer(sender);
        break;
      case PEER_GONE:
        this.emit('peer-gone', data.id);
        break;
      case OFFER: // we should consider switching this to CALL/CONNECT, but this is the least breaking option.
        var connectionId = data.connectionId;
        connection = this.getConnection(sender, connectionId);

        if (connection) {
          util.warn('Offer received for existing Connection ID:', connectionId);
        } else {
            connection = new DataConnection(sender, this, {
              connectionId,
              _payload: data,
              metadata: data.metadata,
              label: data.label,
              serialization: data.serialization,
              reliable: data.reliable
            });
            this._addConnection(sender, connection);
            this.emit('connection', connection);
            this._getMessages(connectionId).forEach(connection.handleMessage.bind(this));
        }
        break;
      case CANDIDATE:
      case ANSWER:
        var id = data.connectionId;
        connection = this.getConnection(sender, id);

        if (connection && connection.pc) {
          connection.handleMessage(message);
        } else {
          id ? this._storeMessage(id, message) : util.warn('You received an unrecognized message:', message);
        }
        break;
      default:
        util.warn('Unknown message received: ', message);
        break;
    }
  }
};

/** Stores messages without a set up connection, to be claimed later. */
Peer.prototype._storeMessage = function(connectionId, message) {
  this._lostMessages[connectionId] = this._lostMessages[connectionId] || [];
  this._lostMessages[connectionId].push(message);
};

/** Retrieve messages from lost message store */
Peer.prototype._getMessages = function(connectionId) {
  const messages = this._lostMessages[connectionId] || [];
  delete this._lostMessages[connectionId];
  return messages;
};

/** Returns a DataConnection to the specified peer. */
Peer.prototype.connect = function(peer, options) {
  if (this.disconnected) {
    util.warn('You cannot connect to a new Peer because you called .disconnect() on this Peer and ended your connection with the server.');
    this.emitError('disconnected', 'Cannot connect to new Peer after disconnecting from server.');
    return;
  }
  const connection = new DataConnection(peer, this, options);
  this._addConnection(peer, connection);
  return connection;
};

/** Add a data connection to this peer. */
Peer.prototype._addConnection = function(peer, connection) {
  this.connections[peer] = this.connections[peer] || [];
  this.connections[peer].push(connection);
};

/** Retrieve a data connection for this peer. */
Peer.prototype.getConnection = function(peer, id) {
  const connections = this.connections[peer];
  return connections ? connections.find(connection => connection.id === id) || null : null;
};

Peer.prototype._delayedAbort = function(type, message) {
  setTimeout(() => this._abort(type, message), 0);
};

/** Destroys the Peer and emits an error message. The Peer is not destroyed if it's in a disconnected state, in which case
 * 	it retains its disconnected state and its existing connections. */
Peer.prototype._abort = function(type, message) {
  util.error('Aborting!');
  this._lastServerId ? this.disconnect() : this.destroy();
  this.emitError(type, message);
};

/** Emits a typed error message. */
Peer.prototype.emitError = function(type, err) {
  util.error('Error:', err);
  err = (typeof err === 'string') ? new Error(err) : err;
  err.type = type;
  this.emit('error', err);
};

/** Destroys the Peer: closes all active connections as well as the connection to the server.
 *  Warning: The peer can no longer create or accept connections after being destroyed. */
Peer.prototype.destroy = function() {
  if (!this.destroyed) {
    this._cleanup();
    this.disconnect();
    this.destroyed = true;
  }
};

/** Disconnects every connection on this peer. */
Peer.prototype._cleanup = function() {
  Object.keys(this.connections || {}).forEach(this._cleanupPeer.bind(this));
  this.emit('close');
};

/** Closes all connections to this peer. */
Peer.prototype._cleanupPeer = function(peer) {
  (this.connections[peer] || []).forEach(connection => connection.close());
};

/** Disconnects the Peer's connection to the PeerServer. Does not close any active connections.
 * Warning: The peer can no longer create or accept connections after being disconnected. It also cannot reconnect to the server. */
Peer.prototype.disconnect = function() {
  setTimeout(() => {
    if (!this.disconnected) {
      this.disconnected = true;
      this.open = false;
      this.socket ? this.socket.close() : null;
      this.emit('disconnected', this.id);
      this._lastServerId = this.id;
      this.id = null;
    }
  }, 0);
};

/** Persist on server that the peer has left the session. Only needed if the peer wasn't able to communicate it directly
 *  to its peers, presumably because they were temporarily away. */
Peer.prototype.persistGone = function() {
  (this.socket) ? this.socket.send(new SystemMessage(SystemMessage.names.PERSIST_GONE, {id: this.id})) : null ;
};

/** Attempts to reconnect with the same ID. */
Peer.prototype.reconnect = function(action) {
  if (this.disconnected && !this.destroyed) {
    util.log('Attempting reconnection to server with ID ' + this._lastServerId);
    this.disconnected = false;
    this._initializeServerConnection();
    this._initialize(action, this._lastServerId);
  } else if (this.destroyed) {
    throw new Error('This peer cannot reconnect to the server. It has already been destroyed.');
  } else if (!this.disconnected && !this.open) {
    util.error('In a hurry? We\'re still trying to make the initial connection!');     // Do nothing. We're still connecting the first time.
  } else {
    throw new Error('Peer ' + this.id + ' cannot reconnect because it is not disconnected from the server!');
  }
};

module.exports = Peer;
},{"./dataconnection":2,"./debug-levels":3,"./socket":8,"./util":9,"@phame/phame-shared/src/message/genericMessage.js":10,"@phame/phame-shared/src/message/systemMessage.js":12,"eventemitter3":16}],7:[function(require,module,exports){
const serializationTypes = {
	SERIALIZED_JSON: 'json',
	SERIALIZED_BINARY: 'binary',
	SERIALIZED_BINARY_UTF8: 'binary-utf8'
};

module.exports = serializationTypes;
},{}],8:[function(require,module,exports){
const util            = require('./util');
const EventEmitter    = require('eventemitter3');
const GenericMessage  = require('@phame/phame-shared/src/message/genericMessage.js');

/** An abstraction on top of WebSockets to provide fastest possible connection for peers.*/
function Socket(secure, host) {
  if (!(this instanceof Socket)) return new Socket(secure, host);
  EventEmitter.call(this);

  this.disconnected = false; // Whether is has been disconnected manually.
  this._queue = [];

  this._wsUrl = (secure ? 'wss://' : 'ws://') + host + '/ws?';
}

util.inherits(Socket, EventEmitter); //Important to be this before defining start below... otherwise it does not work for some reason!

/** Check in with ID or get one from server. */
Socket.prototype.start = function(action, id, token, humanFriendlySessionId) {
  this.id = id;
  this._wsUrl += '&action=' + action + '&id=' + id + '&token=' + token + '&humanFriendlySessionId=' + humanFriendlySessionId;
  this._startWebSocket();
};


/** Start up websocket communications. */
Socket.prototype._startWebSocket = function() {
  if (this._socket) return;

  this._socket = new WebSocket(this._wsUrl);

  this._socket.onmessage = (event) => {
    try {
      this.emit('message', new GenericMessage().fromJSON(JSON.parse(event.data)));
    } catch(e) {
      util.log('Invalid server message', event.data);
      return;
    }
  };

  this._socket.onclose = () => {
    util.log('Socket closed.');
    this.disconnected = true;
    this.emit('disconnected');
  };


  this._socket.onopen = () => {
    this._sendQueuedMessages();
    util.log('Socket open');
  };
};

Socket.prototype._wsOpen = function() {
  return this._socket && this._socket.readyState == 1;
};

Socket.prototype._sendQueuedMessages = function() {
  this._queue.forEach(this.send.bind(this));
};

/** Exposed send for DC & Peer. */
Socket.prototype.send = function(message) {
  if (this.disconnected) return;

  if (!this.id || !this._wsOpen()) {
    this._queue.push(message);
    return;
  }

  if (this._wsOpen()) {
    this._socket.send(JSON.stringify(message.toJSON()));
  }
};

Socket.prototype.close = function() {
  if (!this.disconnected && this._wsOpen()) {
    this._socket.close();
    this.disconnected = true;
  }
};

module.exports = Socket;
},{"./util":9,"@phame/phame-shared/src/message/genericMessage.js":10,"eventemitter3":16}],9:[function(require,module,exports){
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
    if (typeof window.RTCPeerConnection === 'undefined') return {};

    let data = true;
    let binaryBlob = false;
    let sctp = false;
    let onnegotiationneeded = !!window.webkitRTCPeerConnection;
    let pc, dc;

    try {
      pc = new window.RTCPeerConnection(defaultConfig, {optional: [{RtpDataChannels: true}]});
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
      const reliablePC = new window.RTCPeerConnection(defaultConfig, {});
      try {
        const reliableDC = reliablePC.createDataChannel('_PEERJSRELIABLETEST', {});
        sctp = reliableDC.reliable;
      } catch (e) {}
      reliablePC.close();
    }

    if (!onnegotiationneeded && data) {
      const negotiationPC = new window.RTCPeerConnection(defaultConfig, {optional: [{RtpDataChannels: true}]});
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

},{"./adapter":1,"js-binarypack":17}],10:[function(require,module,exports){
'use strict';

var miscUtils   = require('../utils/miscUtils.js');
var objectUtils = require('../utils/objectUtils.js');

/**
 * Message to be send between devices.
 *
 * @param {string} type             The type of the Message. Must be one of the <code>Message.types</code> properties.
 * @param {string} name             The name of the Message (instruction name or event name, whether built/in or custom).
 * @param {*} [data]                Optional. The data to send along
 * @param {*} [metadata]            Optional. Metadata to send along. Could be the name of the current controller, when a device sends
 *                                  a controllerEvent to the game.
 * @param {string} [isResponseTo]   Optional. The id of the Message that this Message is a response. If null, this Message is not a response
 * @returns {Message} The Message object.
 */
var Message = function (type, expectResponse, name, data, metadata, isResponseTo) {
    this.type = type;
    this.expectResponse = expectResponse;
    this.name = name;
    this.data = data;
    this.metadata = metadata;
    this.isResponseTo = isResponseTo;
    this.id = miscUtils.createGuid();
    this.sender = null;
    this.receiver = null;
    //No point in using high resolution performance.now() as it returns time since navigationStart which won't be comparable between devices
    this.timeStamp = Date.now();
};

Message.prototype.clone = function () {
    return new Message().fromJSON(this.toJSON());
};

Message.prototype.addOffsetToTimestamp = function (offset) {
    this.timeStamp += offset;
};

Message.prototype.toString = () => {
    return 'Message (type: ' + this.type + ') from: ' + this.sender + ' to ' + this.receiver + ': ' + JSON.stringify(this.data) + ' and metadata was: ' + JSON.stringify(this.metadata);
};

Message.prototype.setSender = function (sender) {
    this.sender = sender;
    return this;
};

Message.prototype.setReceiver = function (receiver) {
    this.receiver = receiver;
    return this;
};

Message.prototype.toJSON = function () {
    return {
        "id": this.id,
        "sender": this.sender,
        "receiver": this.receiver,
        "expectResponse": this.expectResponse,
        "isResponseTo": this.isResponseTo,
        "type": this.type,
        "name": this.name,
        "data": this.data,
        "metadata": this.metadata,
        "timeStamp": this.timeStamp
    };
};

Message.prototype.fromJSON = function (json) {
    this.id = json.id;
    this.sender = json.sender;
    this.receiver = json.receiver;
    this.expectResponse = json.expectResponse;
    this.isResponseTo = json.isResponseTo;
    this.type = json.type;
    this.name = json.name;
    this.data = json.data;
    this.metadata = json.metadata;
    this.timeStamp = json.timeStamp;
    return this;
};

Message.prototype.addMetaData = function (newProps) {
    newProps = newProps || {};
    this.metadata = this.metadata || {};
    objectUtils.extend(this.metadata, newProps);
};

Message.prototype.createResponse = function (responseData) {
    if (this.expectResponse) {
        var Response = require('./response.js');
        var response = new Response(this.name, responseData, {}, this.id);
        response.setSender(this.receiver);
        response.setReceiver(this.sender);
        return response;
    } else {
        console.log('Can\'t respond to a Message of type: ', this.type);
    }
};

Message.types = {};
Message.types.SYSTEM_MESSAGE = 'systemMessage';                                             //For system Messages (handshaking, etc. Stuff the game developer is unaware of)
Message.types.BUILT_IN_INSTRUCTION = 'builtInInstruction';                                  //For built in instructions triggered by the developer (e.g setController)
Message.types.CUSTOM_INSTRUCTION = 'customInstruction';                                     //Custom instruction, e.g. annotated function in the controller
Message.types.BUILT_IN_CONTROLLER_EVENT = 'builtInControllerEvent';                         //Built in controller event. Like 'pause'.
Message.types.CUSTOM_CONTROLLER_EVENT = 'CustomControllerEvent';                            //Custom Controller event
Message.types.RESPONSE = 'response';                                                        //A response (to some sort of Message from the game to the controller - custom, built in or system).
Message.types.CONTROLLER_SPECIAL_FEATURE_INVOKATION = 'controllerSpecialFeatureInvokation'; //A message sent from the controller to it's wrapper (and sometimes eventually the native app) to invoke special features enabled by phame
                                                                                            //(such as computer vision related stuff, vibration for iOS etc.)

module.exports = Message;


},{"../utils/miscUtils.js":13,"../utils/objectUtils.js":14,"./response.js":11}],11:[function(require,module,exports){
'use strict';

var GenericMessage = require('./genericMessage');

//A response to an instruction (builtInInstruction, customInstruction or systemMessage)
function Response(name, data, metadata, isResponseTo) {
    GenericMessage.call(this, GenericMessage.types.RESPONSE, false, name, data, metadata, isResponseTo);
}

Response.prototype = Object.create(GenericMessage.prototype);

//The names of the responses will be the same as the names of the message it is a reply to.

module.exports = Response;
},{"./genericMessage":10}],12:[function(require,module,exports){
'use strict';

var GenericMessage = require('./genericMessage');

//A system message used for handshaking a similar stuff transparent to the developer.
function SystemMessage(name, data, metadata) {
    GenericMessage.call(this, GenericMessage.types.SYSTEM_MESSAGE, true, name, data, metadata);
}

SystemMessage.prototype = Object.create(GenericMessage.prototype);

//Note that system message names must not be the same as any of the builtInInstruction or controllerSpecialFeatureInvokation names!
SystemMessage.names = {};
SystemMessage.names.CLOCK_SYNCHRONIZATION_RESULT = 'clockSynchronizationResult';

//Sent from the controller web app to the native wrapper
SystemMessage.names.CONTROLLER_WEB_APP_READY = 'controllerWebAppReady';
SystemMessage.names.START_VISION_TRACKING_ENGINE = 'startVisionTrackingEngine';
SystemMessage.names.STOP_VISION_TRACKING_ENGINE = 'stopVisionTrackingEngine';
SystemMessage.names.START_PEER_TO_PEER_SOCKET_SERVER = 'startPeerToPeerSocketServer';
SystemMessage.names.SEND_PEER_TO_PEER_SOCKET_MESSAGE = 'sendPeerToPeerSocketMessage';
SystemMessage.names.CLOSE_PEER_TO_PEER_SOCKET_SERVER = 'closePeerToPeerSocketServer';

//Sent from the native wrapper or simulator to the controller web app
SystemMessage.names.REFRESH_CONTROLLER = 'refreshController';

//Sent from the simulator to the controller web app
SystemMessage.names.SIMULATED_ROTATION_EVENT = 'simulatedRotationEvent';

//Sent from controller web app to main
SystemMessage.names.CLOCK_SYNCHRONIZATION = 'clockSynchronization';
SystemMessage.names.PROJECTION_MATRIX = 'projectionMatrix';
SystemMessage.names.VIDEO_BACKGROUND_SIZE = 'videoBackgroundSize';
SystemMessage.names.DEVICE_SCREEN_SIZE = 'deviceScreenSize';
SystemMessage.names.GONE_REQUEST = 'goneRequest';

//Sent from main to controller web app
SystemMessage.names.CONTROLLER_PATHS = 'controllerPaths';
SystemMessage.names.SET_REMOTE_SUBSCRIPTIONS = 'setRemoteSubscriptions';
SystemMessage.names.SET_VISION_TRACKING_FRAME_DATA = 'setVisionTrackingFrameData';
SystemMessage.names.DECLINE_CONNECTION = 'declineConnection';
SystemMessage.names.BE_GONE = 'beGone';

//Sent from controller to controller web app
SystemMessage.names.SET_LOCAL_SUBSCRIPTIONS = 'setLocalSubscriptions';
SystemMessage.names.OPEN_PHAME_MENU = 'openPhameMenu';
SystemMessage.names.TOUCH_EVENT = 'touchEvent';
SystemMessage.names.HAMMER_EVENT = 'hammerEvent';

//Sent from controller, through web app, to main
SystemMessage.names.HAMMER_JS_NOT_ENABLED_WARNING = 'hammerJSNotEnabledWarning';

//Sent from the controller web app to the controller
SystemMessage.names.START_TOUCH_ENGINE = 'startTouchEngine';
SystemMessage.names.STOP_TOUCH_ENGINE = 'stopTouchEngine';
SystemMessage.names.START_HAMMER_RECOGNIZER = 'startHammerRecognizer';
SystemMessage.names.STOP_HAMMER_RECOGNIZER = 'stopHammerRecognizer';

//Sent from websocketSignalingServer to main
SystemMessage.names.WEBSOCKET_SESSION_CREATION_ERROR = 'websocketSessionCreationError';
SystemMessage.names.WEBSOCKET_SESSION_CONTROLLER_JOINED = 'webSocketControllerJoined';

//Sent from websocketSignalingServer to native controller
SystemMessage.names.INVALID_SESSION_GUID = 'invalidSessionGuid';

//Sent from signaling servers to controller web app and to phame
SystemMessage.names.SESSION_IDS = 'sessionIDs';
SystemMessage.names.PEER_GONE = 'peerGone';

//Sent from websocketSignalingServer to controller web app (client server websocket connection)
SystemMessage.names.WEBSOCKET_CONNECTION_OPEN_END_TO_END = 'websocketConnectionOpenEndToEnd';
SystemMessage.names.PARTNER_LEFT_WEBSOCKET_CONNECTION = 'partnerLeftWebsocketConnection';

//Sent from nativeWrapper and from websocket relay server to main
SystemMessage.names.PING = 'ping';

//Sent from main to all signaling servers
SystemMessage.names.HEARTBEAT = 'heartbeat';
SystemMessage.names.END_SESSION = 'endSession';

//Sent from controller web app to websocket signaling server
SystemMessage.names.TRANSFER_WEBSOCKET_URI = 'transferWebsocketUri';

//Sent from main to websocket signaling server
SystemMessage.names.REQUEST_WEBSOCKET_URI = 'requestWebsocketUri';
SystemMessage.names.REQUEST_DIFFERENT_WEBSOCKET_URI = 'requestDifferentWebsocketUri';

//Sent from main and or controller web app to signaling servers
SystemMessage.names.LEAVE = 'leave';
SystemMessage.names.CANDIDATE = 'candidate';
SystemMessage.names.OFFER = 'offer';
SystemMessage.names.ANSWER = 'answer';
SystemMessage.names.ID_TAKEN = 'idTaken';
SystemMessage.names.SIGNALING_SERVER_CONNECTION_OPEN = 'signalingServerConnectionOpen';
SystemMessage.names.PERSIST_GONE = 'persistGone';
SystemMessage.names.PERSIST_SESSION_ENDED = 'persistSessionEnded';

module.exports = SystemMessage;
},{"./genericMessage":10}],13:[function(require,module,exports){
'use strict';

var typeUtils           = require('./typeUtils.js');

/**
 * Given a relative url (relative to the current document) this function returns the absolute url. Dependency on global
 * document object.
 *
 * See: http://grack.com/blog/2009/11/17/absolutizing-url-in-javascript/
 *
 * @param {string} url  The relative url
 * @returns {string} The absolute version of the given url.
 */
function canonicalize(url) {
    var div = document.createElement('div');
    div.innerHTML = "<a></a>";
    div.firstChild.href = url; // Ensures that the href is properly escaped
    div.innerHTML = div.innerHTML; // Run the current innerHTML back through the parser
    return div.firstChild.href;
}

/**
 * Creates a globally unique identifier
 *
 * @returns {string} A globally unique identifier.
 */
function createGuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
        var r = Math.random()*16|0, v = c === "x" ? r : (r&0x3|0x8);
        return v.toString(16);;
    });
}

/**
 * Gets the string value of parameter with the given name from the query string
 *
 * @param {String} name             The name of the parameter
 * @param {String} [url]            Optional url. If none is provided, window.location will be used
 * @returns {string} The string value of the given parameter (empty string if parameter wasn't found)
 */
function getQueryParameterByName(name, url) {
    name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
    var regex = new RegExp("[\\?&]" + name + "=([^&#]*)"),
        results = regex.exec(url || window.location);
    return results === null ? "" : decodeURIComponent(results[1].replace(/\+/g, " "));
}

/**
 * Gets the string values of parameters with the given names from the query string
 *
 * @param {Array} names             The names of the parameters
 * @param {String} [url]            Optional url. If none is provided, window.location will be used
 * @returns {Array} The string values of the given parameters (empty string if parameter wasn't found). Returned in the given order
 */
function getQueryParametersByNames(names, url) {
    return names.map(n => getQueryParameterByName(n, url));
}

/**
 * Returns a copy of the given url where the given key/value is added as a query string parameter. If the given
 * value is null or undefined the original url is returned unchanged.
 *
 * @param {string} url      The url
 * @param {string} key      The key
 * @param {*} val           The value (if it is JSON it will be stringified and encoded)
 * @returns {string} The url with query parameter added.
 */
function addQueryParameter(url, key, val) {
    let prefixChar = url.indexOf('?') === -1 ? '?' : '&';
    if (!typeUtils.isNullOrUndefined(val)) {
        var value = typeUtils.isObject(val) ? encodeURIComponent(JSON.stringify(val)) : encodeURIComponent(val);
        return url + prefixChar + key + '=' + value;
    }

    return url;
}

/**
 * Returns a string representation of a random number consisting of the given number of digits.
 *
 * @param {Number} digits   The desired number of digits
 * @returns {string} A string representation of the random number with given number of digits.
 */
function createRandomNumberAsString(digits) {
    var n = '';
    for (var i = 0; i < digits; i++) {
        n += Math.floor(Math.random() * 10);
    }

    return n;
}

function onDomReady(fn) {
    return new Promise(function (resolve) {
        if (document.readyState === 'interactive' || document.readyState === 'complete') {
            fn();
            resolve();
        } else {
            document.addEventListener('DOMContentLoaded', function () {
                fn();
                resolve();
            }, false);
        }
    });
}

module.exports ={
    canonicalize: canonicalize,
    createGuid: createGuid,
    createRandomNumberAsString: createRandomNumberAsString,
    getQueryParameterByName: getQueryParameterByName,
    getQueryParametersByNames: getQueryParametersByNames,
    addQueryParameter: addQueryParameter,
    onDomReady: onDomReady
};
},{"./typeUtils.js":15}],14:[function(require,module,exports){
'use strict';

var typeUtils       = require('./typeUtils.js');

/**
 * Given a object and a description of a nested property, this function returns a list of the corresponding values.
 * The nested property descriptor can either be an array, i.e ["propertyNameLevel1", "propertyNameLevel2"], or a string where
 * each property name is separated by dot, i.e. "propertyNameLevel1.propertyNameLevel2". If either of the properties
 * holds an array, all values in the array will be included, which is why multiple values may be returned.
 *
 * Example:
 * var obj = {
     *      arrayProp: [
     *          {
     *              stringProp: 'Foo'
     *          },
     *          {
     *              stringProp: 'Bar'
     *          }
     *      ]
     * }
 *
 * Calling getNestedValue(obj, 'arrayProp.stringProp') will the return ['Foo', 'Bar']
 *
 * @param {Object} rootObject The object to search.
 * @param {Array | String} propertyDescriptor   A descriptor of the nested property.
 * @returns {Array} The values corresponding to the
 */
function getNestedValues(rootObject, propertyDescriptor) {
    var propertyList = (Array.isArray(propertyDescriptor)) ? propertyDescriptor : propertyDescriptor.split('.'),
        values = [],
        object = rootObject;

    propertyList.every(function (property, i) {
        object = object[property];

        if (typeUtils.isUndefined(object)) {
            return;
        }

        if (Array.isArray(object)) {
            object.forEach(function (obj) {
                values = values.concat(getNestedValues(obj, propertyList.slice(i + 1)));
            });

            return;
        }

        if (i === propertyList.length - 1) {
            values.push(object);
        }

        return true;
    });

    return values;
}

/**
 * Given two objects, all of the properties of the latter are copied to the former (overwriting in case of name collisions)
 *
 * @param {Object} destObj      The object to copy into
 * @param {Object} sourceObj    The object to copy from
 */
function extend(destObj, sourceObj) {
    for (let prop of Object.keys(sourceObj)) {
        destObj[prop] = sourceObj[prop];
    }
}

function isStringifyable(obj) {
    try {
        JSON.stringify(obj);
    } catch(e) {
        return false;
    }

    return true;
}

function getValues(obj) {
    const values = [];
    for (let prop of Object.keys(obj)) {
        values.push(obj[prop]);
    }

    return values;
}

module.exports = {
    getNestedValues: getNestedValues,
    isStringifyable: isStringifyable,
    getValues: getValues,
    extend: extend
};

},{"./typeUtils.js":15}],15:[function(require,module,exports){
'use strict';

/**
 * Checks whether or not the given value is a boolean
 *
 * @param {*} val  The value
 * @returns {boolean} True is the given value is a boolean, false otherwise.
 */
function isBoolean(val) {
    return typeof(val) === 'boolean';
}

/**
 * Checks whether or not the given value is a string
 *
 * @param {*} val  The value
 * @returns {boolean} True is the given value is a string, false otherwise.
 */
function isString(val) {
    return typeof(val) === 'string';
}

/**
 * Returns whether or not the given value is an object. Note that this includes all javascript types (including functions, etc.),
 * not just POJOs. See isPOJO below.
 *
 * @param val The value
 * @returns {boolean} True if the given value is an object, false otherwise.
 */
function isObject (val) {
    return (val !== null && typeof val === 'object');
}

/**
 * Returns whether or not the given value is an empty object (POJO).
 *
 * @param val The value
 * @returns {boolean} True if the given value is an empty object, false otherwise.
 */
function isEmptyPOJO(val) {
    return isPOJO(val) && Object.getOwnPropertyNames(val).length == 0;
}

/**
 * Returns whether or not the given value is a function.
 *
 * @param {*} val The value
 * @returns {boolean} True if the given value is a function, false otherwise.
 */
function isFunction (val) {
    var getType = {};
    return !!(val && getType.toString.call(val) === '[object Function]');
}

/**
 * Checks if the given value is an array
 *
 * @param {*} val   The value
 * @returns {boolean} True if it is an array, false otherwise.
 */
function isArray(val) {
    return Array.isArray(val);
}

function isUndefined(val) {
    return typeof val === "undefined"
}

function isNullOrUndefined(val) {
    return isUndefined(val) || val === null;
}

function isFiniteNumber(val) {
    return (typeof val === "number" && Math.abs(val) !== Infinity);
}

function isStrictPositiveFiniteNumber(val) {
    return isFiniteNumber(val) && val > 0;
}

function isStrictNegativeFiniteNumber(val) {
    return isFiniteNumber(val) && val < 0;
}

function isInteger(val) {
    return Number(val)===val && val%1===0;
}

function isIntegerInRange(range, val) {
    return isInteger(val) && val >= range[0] && val <= range[1];
}

function isAnInfinity(val) {
    return Math.abs(val) === Infinity;
}

function isPOJO(val) {
    if (val === null || typeof val !== "object") {
        return false;
    }
    return Object.getPrototypeOf(val) === Object.prototype;
}

//Returns true if it is a DOM element
function isDOMElement(o){
    return (typeof HTMLElement === "object" ? o instanceof HTMLElement : o && typeof o === "object" && o !== null && o.nodeType === 1 && typeof o.nodeName==="string");
}

module.exports = {
    isFunction: isFunction,
    isDOMElement: isDOMElement,
    isString: isString,
    isUndefined: isUndefined,
    isNullOrUndefined: isNullOrUndefined,
    isBoolean: isBoolean,
    isArray: isArray,
    isObject: isObject,
    isEmptyPOJO: isEmptyPOJO,
    isPOJO: isPOJO,
    isFiniteNumber: isFiniteNumber,
    isStrictPositiveFiniteNumber: isStrictPositiveFiniteNumber,
    isStrictNegativeFiniteNumber: isStrictNegativeFiniteNumber,
    isAnInfinity: isAnInfinity,
    isInteger: isInteger,
    isIntegerInRange: isIntegerInRange
};

},{}],16:[function(require,module,exports){
'use strict';

/**
 * Representation of a single EventEmitter function.
 *
 * @param {Function} fn Event handler to be called.
 * @param {Mixed} context Context for function execution.
 * @param {Boolean} once Only emit once
 * @api private
 */
function EE(fn, context, once) {
  this.fn = fn;
  this.context = context;
  this.once = once || false;
}

/**
 * Minimal EventEmitter interface that is molded against the Node.js
 * EventEmitter interface.
 *
 * @constructor
 * @api public
 */
function EventEmitter() { /* Nothing to set */ }

/**
 * Holds the assigned EventEmitters by name.
 *
 * @type {Object}
 * @private
 */
EventEmitter.prototype._events = undefined;

/**
 * Return a list of assigned event listeners.
 *
 * @param {String} event The events that should be listed.
 * @returns {Array}
 * @api public
 */
EventEmitter.prototype.listeners = function listeners(event) {
  if (!this._events || !this._events[event]) return [];
  if (this._events[event].fn) return [this._events[event].fn];

  for (var i = 0, l = this._events[event].length, ee = new Array(l); i < l; i++) {
    ee[i] = this._events[event][i].fn;
  }

  return ee;
};

/**
 * Emit an event to all registered event listeners.
 *
 * @param {String} event The name of the event.
 * @returns {Boolean} Indication if we've emitted an event.
 * @api public
 */
EventEmitter.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
  if (!this._events || !this._events[event]) return false;

  var listeners = this._events[event]
    , len = arguments.length
    , args
    , i;

  if ('function' === typeof listeners.fn) {
    if (listeners.once) this.removeListener(event, listeners.fn, true);

    switch (len) {
      case 1: return listeners.fn.call(listeners.context), true;
      case 2: return listeners.fn.call(listeners.context, a1), true;
      case 3: return listeners.fn.call(listeners.context, a1, a2), true;
      case 4: return listeners.fn.call(listeners.context, a1, a2, a3), true;
      case 5: return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
      case 6: return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
    }

    for (i = 1, args = new Array(len -1); i < len; i++) {
      args[i - 1] = arguments[i];
    }

    listeners.fn.apply(listeners.context, args);
  } else {
    var length = listeners.length
      , j;

    for (i = 0; i < length; i++) {
      if (listeners[i].once) this.removeListener(event, listeners[i].fn, true);

      switch (len) {
        case 1: listeners[i].fn.call(listeners[i].context); break;
        case 2: listeners[i].fn.call(listeners[i].context, a1); break;
        case 3: listeners[i].fn.call(listeners[i].context, a1, a2); break;
        default:
          if (!args) for (j = 1, args = new Array(len -1); j < len; j++) {
            args[j - 1] = arguments[j];
          }

          listeners[i].fn.apply(listeners[i].context, args);
      }
    }
  }

  return true;
};

/**
 * Register a new EventListener for the given event.
 *
 * @param {String} event Name of the event.
 * @param {Functon} fn Callback function.
 * @param {Mixed} context The context of the function.
 * @api public
 */
EventEmitter.prototype.on = function on(event, fn, context) {
  var listener = new EE(fn, context || this);

  if (!this._events) this._events = {};
  if (!this._events[event]) this._events[event] = listener;
  else {
    if (!this._events[event].fn) this._events[event].push(listener);
    else this._events[event] = [
      this._events[event], listener
    ];
  }

  return this;
};

/**
 * Add an EventListener that's only called once.
 *
 * @param {String} event Name of the event.
 * @param {Function} fn Callback function.
 * @param {Mixed} context The context of the function.
 * @api public
 */
EventEmitter.prototype.once = function once(event, fn, context) {
  var listener = new EE(fn, context || this, true);

  if (!this._events) this._events = {};
  if (!this._events[event]) this._events[event] = listener;
  else {
    if (!this._events[event].fn) this._events[event].push(listener);
    else this._events[event] = [
      this._events[event], listener
    ];
  }

  return this;
};

/**
 * Remove event listeners.
 *
 * @param {String} event The event we want to remove.
 * @param {Function} fn The listener that we need to find.
 * @param {Boolean} once Only remove once listeners.
 * @api public
 */
EventEmitter.prototype.removeListener = function removeListener(event, fn, once) {
  if (!this._events || !this._events[event]) return this;

  var listeners = this._events[event]
    , events = [];

  if (fn) {
    if (listeners.fn && (listeners.fn !== fn || (once && !listeners.once))) {
      events.push(listeners);
    }
    if (!listeners.fn) for (var i = 0, length = listeners.length; i < length; i++) {
      if (listeners[i].fn !== fn || (once && !listeners[i].once)) {
        events.push(listeners[i]);
      }
    }
  }

  //
  // Reset the array, or remove it completely if we have no more listeners.
  //
  if (events.length) {
    this._events[event] = events.length === 1 ? events[0] : events;
  } else {
    delete this._events[event];
  }

  return this;
};

/**
 * Remove all listeners or only the listeners for the specified event.
 *
 * @param {String} event The event want to remove all listeners for.
 * @api public
 */
EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
  if (!this._events) return this;

  if (event) delete this._events[event];
  else this._events = {};

  return this;
};

//
// Alias methods names because people roll like that.
//
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
EventEmitter.prototype.addListener = EventEmitter.prototype.on;

//
// This function doesn't apply anymore.
//
EventEmitter.prototype.setMaxListeners = function setMaxListeners() {
  return this;
};

//
// Expose the module.
//
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.EventEmitter2 = EventEmitter;
EventEmitter.EventEmitter3 = EventEmitter;

//
// Expose the module.
//
module.exports = EventEmitter;

},{}],17:[function(require,module,exports){
var BufferBuilder = require('./bufferbuilder').BufferBuilder;
var binaryFeatures = require('./bufferbuilder').binaryFeatures;

var BinaryPack = {
  unpack: function(data){
    var unpacker = new Unpacker(data);
    return unpacker.unpack();
  },
  pack: function(data){
    var packer = new Packer();
    packer.pack(data);
    var buffer = packer.getBuffer();
    return buffer;
  }
};

module.exports = BinaryPack;

function Unpacker (data){
  // Data is ArrayBuffer
  this.index = 0;
  this.dataBuffer = data;
  this.dataView = new Uint8Array(this.dataBuffer);
  this.length = this.dataBuffer.byteLength;
}

Unpacker.prototype.unpack = function(){
  var type = this.unpack_uint8();
  if (type < 0x80){
    var positive_fixnum = type;
    return positive_fixnum;
  } else if ((type ^ 0xe0) < 0x20){
    var negative_fixnum = (type ^ 0xe0) - 0x20;
    return negative_fixnum;
  }
  var size;
  if ((size = type ^ 0xa0) <= 0x0f){
    return this.unpack_raw(size);
  } else if ((size = type ^ 0xb0) <= 0x0f){
    return this.unpack_string(size);
  } else if ((size = type ^ 0x90) <= 0x0f){
    return this.unpack_array(size);
  } else if ((size = type ^ 0x80) <= 0x0f){
    return this.unpack_map(size);
  }
  switch(type){
    case 0xc0:
      return null;
    case 0xc1:
      return undefined;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xca:
      return this.unpack_float();
    case 0xcb:
      return this.unpack_double();
    case 0xcc:
      return this.unpack_uint8();
    case 0xcd:
      return this.unpack_uint16();
    case 0xce:
      return this.unpack_uint32();
    case 0xcf:
      return this.unpack_uint64();
    case 0xd0:
      return this.unpack_int8();
    case 0xd1:
      return this.unpack_int16();
    case 0xd2:
      return this.unpack_int32();
    case 0xd3:
      return this.unpack_int64();
    case 0xd4:
      return undefined;
    case 0xd5:
      return undefined;
    case 0xd6:
      return undefined;
    case 0xd7:
      return undefined;
    case 0xd8:
      size = this.unpack_uint16();
      return this.unpack_string(size);
    case 0xd9:
      size = this.unpack_uint32();
      return this.unpack_string(size);
    case 0xda:
      size = this.unpack_uint16();
      return this.unpack_raw(size);
    case 0xdb:
      size = this.unpack_uint32();
      return this.unpack_raw(size);
    case 0xdc:
      size = this.unpack_uint16();
      return this.unpack_array(size);
    case 0xdd:
      size = this.unpack_uint32();
      return this.unpack_array(size);
    case 0xde:
      size = this.unpack_uint16();
      return this.unpack_map(size);
    case 0xdf:
      size = this.unpack_uint32();
      return this.unpack_map(size);
  }
}

Unpacker.prototype.unpack_uint8 = function(){
  var byte = this.dataView[this.index] & 0xff;
  this.index++;
  return byte;
};

Unpacker.prototype.unpack_uint16 = function(){
  var bytes = this.read(2);
  var uint16 =
    ((bytes[0] & 0xff) * 256) + (bytes[1] & 0xff);
  this.index += 2;
  return uint16;
}

Unpacker.prototype.unpack_uint32 = function(){
  var bytes = this.read(4);
  var uint32 =
     ((bytes[0]  * 256 +
       bytes[1]) * 256 +
       bytes[2]) * 256 +
       bytes[3];
  this.index += 4;
  return uint32;
}

Unpacker.prototype.unpack_uint64 = function(){
  var bytes = this.read(8);
  var uint64 =
   ((((((bytes[0]  * 256 +
       bytes[1]) * 256 +
       bytes[2]) * 256 +
       bytes[3]) * 256 +
       bytes[4]) * 256 +
       bytes[5]) * 256 +
       bytes[6]) * 256 +
       bytes[7];
  this.index += 8;
  return uint64;
}


Unpacker.prototype.unpack_int8 = function(){
  var uint8 = this.unpack_uint8();
  return (uint8 < 0x80 ) ? uint8 : uint8 - (1 << 8);
};

Unpacker.prototype.unpack_int16 = function(){
  var uint16 = this.unpack_uint16();
  return (uint16 < 0x8000 ) ? uint16 : uint16 - (1 << 16);
}

Unpacker.prototype.unpack_int32 = function(){
  var uint32 = this.unpack_uint32();
  return (uint32 < Math.pow(2, 31) ) ? uint32 :
    uint32 - Math.pow(2, 32);
}

Unpacker.prototype.unpack_int64 = function(){
  var uint64 = this.unpack_uint64();
  return (uint64 < Math.pow(2, 63) ) ? uint64 :
    uint64 - Math.pow(2, 64);
}

Unpacker.prototype.unpack_raw = function(size){
  if ( this.length < this.index + size){
    throw new Error('BinaryPackFailure: index is out of range'
      + ' ' + this.index + ' ' + size + ' ' + this.length);
  }
  var buf = this.dataBuffer.slice(this.index, this.index + size);
  this.index += size;

    //buf = util.bufferToString(buf);

  return buf;
}

Unpacker.prototype.unpack_string = function(size){
  var bytes = this.read(size);
  var i = 0, str = '', c, code;
  while(i < size){
    c = bytes[i];
    if ( c < 128){
      str += String.fromCharCode(c);
      i++;
    } else if ((c ^ 0xc0) < 32){
      code = ((c ^ 0xc0) << 6) | (bytes[i+1] & 63);
      str += String.fromCharCode(code);
      i += 2;
    } else {
      code = ((c & 15) << 12) | ((bytes[i+1] & 63) << 6) |
        (bytes[i+2] & 63);
      str += String.fromCharCode(code);
      i += 3;
    }
  }
  this.index += size;
  return str;
}

Unpacker.prototype.unpack_array = function(size){
  var objects = new Array(size);
  for(var i = 0; i < size ; i++){
    objects[i] = this.unpack();
  }
  return objects;
}

Unpacker.prototype.unpack_map = function(size){
  var map = {};
  for(var i = 0; i < size ; i++){
    var key  = this.unpack();
    var value = this.unpack();
    map[key] = value;
  }
  return map;
}

Unpacker.prototype.unpack_float = function(){
  var uint32 = this.unpack_uint32();
  var sign = uint32 >> 31;
  var exp  = ((uint32 >> 23) & 0xff) - 127;
  var fraction = ( uint32 & 0x7fffff ) | 0x800000;
  return (sign == 0 ? 1 : -1) *
    fraction * Math.pow(2, exp - 23);
}

Unpacker.prototype.unpack_double = function(){
  var h32 = this.unpack_uint32();
  var l32 = this.unpack_uint32();
  var sign = h32 >> 31;
  var exp  = ((h32 >> 20) & 0x7ff) - 1023;
  var hfrac = ( h32 & 0xfffff ) | 0x100000;
  var frac = hfrac * Math.pow(2, exp - 20) +
    l32   * Math.pow(2, exp - 52);
  return (sign == 0 ? 1 : -1) * frac;
}

Unpacker.prototype.read = function(length){
  var j = this.index;
  if (j + length <= this.length) {
    return this.dataView.subarray(j, j + length);
  } else {
    throw new Error('BinaryPackFailure: read index out of range');
  }
}

function Packer(){
  this.bufferBuilder = new BufferBuilder();
}

Packer.prototype.getBuffer = function(){
  return this.bufferBuilder.getBuffer();
}

Packer.prototype.pack = function(value){
  var type = typeof(value);
  if (type == 'string'){
    this.pack_string(value);
  } else if (type == 'number'){
    if (Math.floor(value) === value){
      this.pack_integer(value);
    } else{
      this.pack_double(value);
    }
  } else if (type == 'boolean'){
    if (value === true){
      this.bufferBuilder.append(0xc3);
    } else if (value === false){
      this.bufferBuilder.append(0xc2);
    }
  } else if (type == 'undefined'){
    this.bufferBuilder.append(0xc0);
  } else if (type == 'object'){
    if (value === null){
      this.bufferBuilder.append(0xc0);
    } else {
      var constructor = value.constructor;
      if (constructor == Array){
        this.pack_array(value);
      } else if (constructor == Blob || constructor == File) {
        this.pack_bin(value);
      } else if (constructor == ArrayBuffer) {
        if(binaryFeatures.useArrayBufferView) {
          this.pack_bin(new Uint8Array(value));
        } else {
          this.pack_bin(value);
        }
      } else if ('BYTES_PER_ELEMENT' in value){
        if(binaryFeatures.useArrayBufferView) {
          this.pack_bin(new Uint8Array(value.buffer));
        } else {
          this.pack_bin(value.buffer);
        }
      } else if (constructor == Object){
        this.pack_object(value);
      } else if (constructor == Date){
        this.pack_string(value.toString());
      } else if (typeof value.toBinaryPack == 'function'){
        this.bufferBuilder.append(value.toBinaryPack());
      } else {
        throw new Error('Type "' + constructor.toString() + '" not yet supported');
      }
    }
  } else {
    throw new Error('Type "' + type + '" not yet supported');
  }
  this.bufferBuilder.flush();
}


Packer.prototype.pack_bin = function(blob){
  var length = blob.length || blob.byteLength || blob.size;
  if (length <= 0x0f){
    this.pack_uint8(0xa0 + length);
  } else if (length <= 0xffff){
    this.bufferBuilder.append(0xda) ;
    this.pack_uint16(length);
  } else if (length <= 0xffffffff){
    this.bufferBuilder.append(0xdb);
    this.pack_uint32(length);
  } else{
    throw new Error('Invalid length');
  }
  this.bufferBuilder.append(blob);
}

Packer.prototype.pack_string = function(str){
  var length = utf8Length(str);

  if (length <= 0x0f){
    this.pack_uint8(0xb0 + length);
  } else if (length <= 0xffff){
    this.bufferBuilder.append(0xd8) ;
    this.pack_uint16(length);
  } else if (length <= 0xffffffff){
    this.bufferBuilder.append(0xd9);
    this.pack_uint32(length);
  } else{
    throw new Error('Invalid length');
  }
  this.bufferBuilder.append(str);
}

Packer.prototype.pack_array = function(ary){
  var length = ary.length;
  if (length <= 0x0f){
    this.pack_uint8(0x90 + length);
  } else if (length <= 0xffff){
    this.bufferBuilder.append(0xdc)
    this.pack_uint16(length);
  } else if (length <= 0xffffffff){
    this.bufferBuilder.append(0xdd);
    this.pack_uint32(length);
  } else{
    throw new Error('Invalid length');
  }
  for(var i = 0; i < length ; i++){
    this.pack(ary[i]);
  }
}

Packer.prototype.pack_integer = function(num){
  if ( -0x20 <= num && num <= 0x7f){
    this.bufferBuilder.append(num & 0xff);
  } else if (0x00 <= num && num <= 0xff){
    this.bufferBuilder.append(0xcc);
    this.pack_uint8(num);
  } else if (-0x80 <= num && num <= 0x7f){
    this.bufferBuilder.append(0xd0);
    this.pack_int8(num);
  } else if ( 0x0000 <= num && num <= 0xffff){
    this.bufferBuilder.append(0xcd);
    this.pack_uint16(num);
  } else if (-0x8000 <= num && num <= 0x7fff){
    this.bufferBuilder.append(0xd1);
    this.pack_int16(num);
  } else if ( 0x00000000 <= num && num <= 0xffffffff){
    this.bufferBuilder.append(0xce);
    this.pack_uint32(num);
  } else if (-0x80000000 <= num && num <= 0x7fffffff){
    this.bufferBuilder.append(0xd2);
    this.pack_int32(num);
  } else if (-0x8000000000000000 <= num && num <= 0x7FFFFFFFFFFFFFFF){
    this.bufferBuilder.append(0xd3);
    this.pack_int64(num);
  } else if (0x0000000000000000 <= num && num <= 0xFFFFFFFFFFFFFFFF){
    this.bufferBuilder.append(0xcf);
    this.pack_uint64(num);
  } else{
    throw new Error('Invalid integer');
  }
}

Packer.prototype.pack_double = function(num){
  var sign = 0;
  if (num < 0){
    sign = 1;
    num = -num;
  }
  var exp  = Math.floor(Math.log(num) / Math.LN2);
  var frac0 = num / Math.pow(2, exp) - 1;
  var frac1 = Math.floor(frac0 * Math.pow(2, 52));
  var b32   = Math.pow(2, 32);
  var h32 = (sign << 31) | ((exp+1023) << 20) |
      (frac1 / b32) & 0x0fffff;
  var l32 = frac1 % b32;
  this.bufferBuilder.append(0xcb);
  this.pack_int32(h32);
  this.pack_int32(l32);
}

Packer.prototype.pack_object = function(obj){
  var keys = Object.keys(obj);
  var length = keys.length;
  if (length <= 0x0f){
    this.pack_uint8(0x80 + length);
  } else if (length <= 0xffff){
    this.bufferBuilder.append(0xde);
    this.pack_uint16(length);
  } else if (length <= 0xffffffff){
    this.bufferBuilder.append(0xdf);
    this.pack_uint32(length);
  } else{
    throw new Error('Invalid length');
  }
  for(var prop in obj){
    if (obj.hasOwnProperty(prop)){
      this.pack(prop);
      this.pack(obj[prop]);
    }
  }
}

Packer.prototype.pack_uint8 = function(num){
  this.bufferBuilder.append(num);
}

Packer.prototype.pack_uint16 = function(num){
  this.bufferBuilder.append(num >> 8);
  this.bufferBuilder.append(num & 0xff);
}

Packer.prototype.pack_uint32 = function(num){
  var n = num & 0xffffffff;
  this.bufferBuilder.append((n & 0xff000000) >>> 24);
  this.bufferBuilder.append((n & 0x00ff0000) >>> 16);
  this.bufferBuilder.append((n & 0x0000ff00) >>>  8);
  this.bufferBuilder.append((n & 0x000000ff));
}

Packer.prototype.pack_uint64 = function(num){
  var high = num / Math.pow(2, 32);
  var low  = num % Math.pow(2, 32);
  this.bufferBuilder.append((high & 0xff000000) >>> 24);
  this.bufferBuilder.append((high & 0x00ff0000) >>> 16);
  this.bufferBuilder.append((high & 0x0000ff00) >>>  8);
  this.bufferBuilder.append((high & 0x000000ff));
  this.bufferBuilder.append((low  & 0xff000000) >>> 24);
  this.bufferBuilder.append((low  & 0x00ff0000) >>> 16);
  this.bufferBuilder.append((low  & 0x0000ff00) >>>  8);
  this.bufferBuilder.append((low  & 0x000000ff));
}

Packer.prototype.pack_int8 = function(num){
  this.bufferBuilder.append(num & 0xff);
}

Packer.prototype.pack_int16 = function(num){
  this.bufferBuilder.append((num & 0xff00) >> 8);
  this.bufferBuilder.append(num & 0xff);
}

Packer.prototype.pack_int32 = function(num){
  this.bufferBuilder.append((num >>> 24) & 0xff);
  this.bufferBuilder.append((num & 0x00ff0000) >>> 16);
  this.bufferBuilder.append((num & 0x0000ff00) >>> 8);
  this.bufferBuilder.append((num & 0x000000ff));
}

Packer.prototype.pack_int64 = function(num){
  var high = Math.floor(num / Math.pow(2, 32));
  var low  = num % Math.pow(2, 32);
  this.bufferBuilder.append((high & 0xff000000) >>> 24);
  this.bufferBuilder.append((high & 0x00ff0000) >>> 16);
  this.bufferBuilder.append((high & 0x0000ff00) >>>  8);
  this.bufferBuilder.append((high & 0x000000ff));
  this.bufferBuilder.append((low  & 0xff000000) >>> 24);
  this.bufferBuilder.append((low  & 0x00ff0000) >>> 16);
  this.bufferBuilder.append((low  & 0x0000ff00) >>>  8);
  this.bufferBuilder.append((low  & 0x000000ff));
}

function _utf8Replace(m){
  var code = m.charCodeAt(0);

  if(code <= 0x7ff) return '00';
  if(code <= 0xffff) return '000';
  if(code <= 0x1fffff) return '0000';
  if(code <= 0x3ffffff) return '00000';
  return '000000';
}

function utf8Length(str){
  if (str.length > 600) {
    // Blob method faster for large strings
    return (new Blob([str])).size;
  } else {
    return str.replace(/[^\u0000-\u007F]/g, _utf8Replace).length;
  }
}

},{"./bufferbuilder":18}],18:[function(require,module,exports){
var binaryFeatures = {};
binaryFeatures.useBlobBuilder = (function(){
  try {
    new Blob([]);
    return false;
  } catch (e) {
    return true;
  }
})();

binaryFeatures.useArrayBufferView = !binaryFeatures.useBlobBuilder && (function(){
  try {
    return (new Blob([new Uint8Array([])])).size === 0;
  } catch (e) {
    return true;
  }
})();

module.exports.binaryFeatures = binaryFeatures;
var BlobBuilder = module.exports.BlobBuilder;
if (typeof window != 'undefined') {
  BlobBuilder = module.exports.BlobBuilder = window.WebKitBlobBuilder ||
    window.MozBlobBuilder || window.MSBlobBuilder || window.BlobBuilder;
}

function BufferBuilder(){
  this._pieces = [];
  this._parts = [];
}

BufferBuilder.prototype.append = function(data) {
  if(typeof data === 'number') {
    this._pieces.push(data);
  } else {
    this.flush();
    this._parts.push(data);
  }
};

BufferBuilder.prototype.flush = function() {
  if (this._pieces.length > 0) {
    var buf = new Uint8Array(this._pieces);
    if(!binaryFeatures.useArrayBufferView) {
      buf = buf.buffer;
    }
    this._parts.push(buf);
    this._pieces = [];
  }
};

BufferBuilder.prototype.getBuffer = function() {
  this.flush();
  if(binaryFeatures.useBlobBuilder) {
    var builder = new BlobBuilder();
    for(var i = 0, ii = this._parts.length; i < ii; i++) {
      builder.append(this._parts[i]);
    }
    return builder.getBlob();
  } else {
    return new Blob(this._parts);
  }
};

module.exports.BufferBuilder = BufferBuilder;

},{}]},{},[4]);
