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
      const config = (util.supports.sctp) ? {} : {reliable: options.reliable};
      const dc = pc.createDataChannel(connection.label, config);
      connection.initialize(dc);

    if (!util.supports.onnegotiationneeded) {
      Negotiator._makeOffer(connection);
    }
  } else {
    Negotiator.handleSDP('OFFER', connection, options.sdp);
  }
};

Negotiator._getPeerConnection = function(connection, options) {
  Negotiator.pcs[connection.peer] = Negotiator.pcs[connection.peer] || {};

  let pc  = (options.pc) ? Negotiator.pcs[connection.peer][options.pc] : null;
  return (!pc || pc.signalingState !== 'stable') ? Negotiator._startPeerConnection(connection) : pc;
};

Negotiator._startPeerConnection = function(connection) {
  util.log('Creating RTCPeerConnection.');
  const id = ID_PREFIX + util.randomToken();
  const optional = (!util.supports.sctp) ? {optional: [{RtpDataChannels: true}]} : {};

  const pc = new RTCPeerConnection(connection.provider.options.config, optional);
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
    provider.getConnection(peer, id).initialize(event.channel);
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
  pc.createOffer(function(offer) {
    util.log('Created offer.');
    offer.sdp = (!util.supports.sctp && connection.reliable) ? Reliable.higherBandwidthSDP(offer.sdp) : offer.sdp;

    pc.setLocalDescription(offer, function() {
      util.log('Set localDescription: offer', 'for:', peer);
      const offerMessage = new SystemMessage(OFFER, {sdp: offer, label, reliable, serialization, metadata, connectionId: id, browser: util.browser});
      offerMessage.setReceiver(peer);
      provider.socket.send(offerMessage);
    }, function(err) {
      provider.emitError('webrtc', err);
      util.log('Failed to setLocalDescription, ', err);
    });
  }, function(err) {
    provider.emitError('webrtc', err);
    util.log('Failed to createOffer, ', err);
  }, connection.options.constraints);
};

Negotiator._makeAnswer = function({pc, peer, id, provider, reliable}) {
  pc.createAnswer(function(answer) {
    util.log('Created answer.');
    answer.sdp = (!util.supports.sctp && reliable) ? Reliable.higherBandwidthSDP(answer.sdp) : answer.sdp;

    pc.setLocalDescription(answer, function() {
      util.log('Set localDescription: answer', 'for:', peer);
      const answerMessage = new SystemMessage(ANSWER, {sdp: answer, connectionId: id, browser: util.browser});
      answerMessage.setReceiver(peer);
      provider.socket.send(answerMessage);
    }, function(err) {
      provider.emitError('webrtc', err);
      util.log('Failed to setLocalDescription, ', err);
    });
  }, function(err) {
    provider.emitError('webrtc', err);
    util.log('Failed to create answer, ', err);
  });
};

Negotiator.handleSDP = function(type, connection, sdp) {
  const {pc, peer, provider} = connection;
  sdp = new RTCSessionDescription(sdp);

  util.log('Setting remote description', sdp);
  pc.setRemoteDescription(sdp, function() {
    util.log('Set remoteDescription for:', peer);

    if (type === 'OFFER') {
      Negotiator._makeAnswer(connection);
    }
  }, function(err) {
    provider.emitError('webrtc', err);
    util.log('Failed to setRemoteDescription, ', err);
  });
};

Negotiator.handleCandidate = function(connection, ice) {
  const {candidate, sdpMLineIndex} = ice;
  const {pc, peer} = connection;

  pc.addIceCandidate(new RTCIceCandidate({sdpMLineIndex, candidate}));
  util.log('Added ICE candidate for:', peer);
};

module.exports = Negotiator;