const util                                                          = require('./util');
const EventEmitter                                                  = require('eventemitter3');
const Negotiator                                                    = require('./negotiator');
const Reliable                                                      = require('reliable');
const SystemMessage                                                 = require('@phame/phame-shared/src/message/systemMessage.js');
const {SERIALIZED_JSON, SERIALIZED_BINARY, SERIALIZED_BINARY_UTF8}	= require('./serialization-types');

const {ANSWER, CANDIDATE} = SystemMessage.names;
const ID_PREFIX = 'dc_';

function DataConnection(peer, provider, options) {
  if (!(this instanceof DataConnection)) return new DataConnection(peer, provider, options);
  EventEmitter.call(this);

  this.options = util.extend({serialization: SERIALIZED_BINARY, reliable: false}, options);

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

DataConnection._idPrefix = 'dc_';

/** Called by the Negotiator when the DataChannel is ready. */
DataConnection.prototype.initialize = function(dc) {
  this._dc = dc;
  this._configureDataChannel();
};

DataConnection.prototype._configureDataChannel = function() {
  this._dc.binaryType = (util.supports.sctp) ? 'arraybuffer' : this._dc.binaryType;

  this._dc.onopen = () => {
    util.log('Data channel connection success');
    this.open = true;
    this.emit('open');
  };

  if (!util.supports.sctp && this.reliable) {   // Use the Reliable shim for non Firefox browsers
    this._reliable = new Reliable(this._dc, util.debug);
  }

  if (this._reliable) {
    this._reliable.onmessage = (msg) => this.emit('data', msg);
  } else {
    this._dc.onmessage = this._handleDataMessage.bind(this);
  }

  this._dc.onclose = () => {
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

DataConnection.prototype.send = function(data, chunked) {
  if (!this.open) {
    this.emit('error', new Error('Connection is not open. You should listen for the `open` event before sending messages.'));
    return;
  }

  if (this._reliable) {    // Note: reliable shim sending will make it so that you cannot customize serialization.
    this._reliable.send(data);
    return;
  }

  switch(this.serialization) {
    case SERIALIZED_JSON:
      this._bufferedSend(JSON.stringify(data));
      break;
    case SERIALIZED_BINARY:
    case SERIALIZED_BINARY_UTF8:
      const blob = util.pack(data);

      // For Chrome-Firefox interoperability, we need to make Firefox "chunk" the data it sends out.
      const needsChunking = util.chunkedBrowsers[this._peerBrowser] || util.chunkedBrowsers[util.browser];
      if (needsChunking && !chunked && blob.size > util.chunkedMTU) {
        this._sendChunks(blob);
        return;
      }

      // DataChannel currently only supports strings. (YT: Comment from original library. Don't believe this is true (anymore...))
      if (!util.supports.sctp) {
        util.blobToBinaryString(blob, this._bufferedSend.bind(this));
      } else if (!util.supports.binaryBlob) {
        util.blobToArrayBuffer(blob, this._bufferedSend.bind(this)); 	// We only do this if we really need to (e.g. blobs are not supported), because this conversion is costly.
      } else {
        this._bufferedSend(blob);
      }
      break;
    default:
      this._bufferedSend(data);
      break;
  }
};

DataConnection.prototype._bufferedSend = function(msg) {
  if (this._buffering || !this._trySend(msg)) {
    this._buffer.push(msg);
  }
};

DataConnection.prototype._trySend = function(message) {
  try {
    this._dc.send(message);
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

DataConnection.prototype._sendChunks = function(blob) {
  util.chunk(blob).forEach(chunk => this.send(chunk, true))
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
