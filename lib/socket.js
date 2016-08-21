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