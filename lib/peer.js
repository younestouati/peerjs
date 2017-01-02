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