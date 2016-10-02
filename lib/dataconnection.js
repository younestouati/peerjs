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
