import * as mediasoupClient from "mediasoup-client";
import protooClient from "protoo-client";
import { debug as newDebug } from "debug";
import EventEmitter from "eventemitter3";
import trtcSDK from "trtc-js-sdk";
import { MediaDevices } from "./utils/media-devices-utils";

// Used for VP9 webcam video.
//const VIDEO_KSVC_ENCODINGS = [{ scalabilityMode: "S3T3_KEY" }];

// Used for VP9 desktop sharing.
//const VIDEO_SVC_ENCODINGS = [{ scalabilityMode: "S3T3", dtx: true }];

// TODO
// - look into requestConsumerKeyframe
// - look into applyNetworkThrottle
// SFU todo
// - remove active speaker stuff
// - remove score stuff

// Based upon mediasoup-demo RoomClient

const debug = newDebug("naf-dialog-adapter:debug");
//const warn = newDebug("naf-dialog-adapter:warn");
const error = newDebug("naf-dialog-adapter:error");
const info = newDebug("naf-dialog-adapter:info");

const trtcDebug = newDebug("naf-dialog-adapter:trtc:debug");
const trtcError = newDebug("naf-dialog-adapter:trtc:error");

const PC_PROPRIETARY_CONSTRAINTS = {
  optional: [{ googDscp: true }]
};

// Used for simulcast screen sharing.
const SCREEN_SHARING_SIMULCAST_ENCODINGS = [
  { dtx: true, maxBitrate: 1500000 },
  { dtx: true, maxBitrate: 6000000 }
];

export const DIALOG_CONNECTION_CONNECTED = "dialog-connection-connected";
export const DIALOG_CONNECTION_ERROR_FATAL = "dialog-connection-error-fatal";

export class DialogAdapter extends EventEmitter {
  constructor() {
    super();

    this._micShouldBeEnabled = false;
    this._shareProducer = null;
    this._localMediaStream = null;
    this._consumers = new Map();
    this._pendingMediaRequests = new Map();
    this._blockedClients = new Map();
    this._forceTcp = false;
    this._forceTurn = false;
    this._iceTransportPolicy = null;
    this.scene = null;
    this._serverParams = {};
    this._consumerStats = {};

    /*
     * For TRTC SDK
     */
    this._trtcClient = null;
    this._trtcRoomId = null;
    this._trtcUserId = null;
    this._trtcLocalStream = null;
    this._trtcRemoteStreams = new Map();
  }

  get consumerStats() {
    return this._consumerStats;
  }

  get downlinkBwe() {
    return this._downlinkBwe;
  }

  getIceServers(host, port, turn) {
    const iceServers = [];

    this._serverUrl = `wss://${host}:${port}`;

    if (turn && turn.enabled) {
      turn.transports.forEach(ts => {
        // Try both TURN DTLS and TCP/TLS
        if (!this._forceTcp) {
          iceServers.push({
            urls: `turns:${host}:${ts.port}`,
            username: turn.username,
            credential: turn.credential
          });
        }

        iceServers.push({
          urls: `turns:${host}:${ts.port}?transport=tcp`,
          username: turn.username,
          credential: turn.credential
        });
      });
      iceServers.push({ urls: "stun:stun1.l.google.com:19302" });
    } else {
      iceServers.push({ urls: "stun:stun1.l.google.com:19302" }, { urls: "stun:stun2.l.google.com:19302" });
    }

    return iceServers;
  }

  /**
   * Gets transport/consumer/producer stats on the server side.
   */
  async getServerStats() {
    if (!this._protoo.connected) {
      // Signaling channel not connected, no reason to get remote RTC stats.
      return;
    }

    const result = {};
    try {
      if (!this._sendTransport?._closed) {
        const sendTransport = (result[this._sendTransport.id] = {});
        sendTransport.name = "Send";
        sendTransport.stats = await this._protoo.request("getTransportStats", {
          transportId: this._sendTransport.id
        });
        result[this._sendTransport.id]["producers"] = {};
        for (const producer of this._sendTransport._producers) {
          const id = producer[0];
          result[this._sendTransport.id]["producers"][id] = await this._protoo.request("getProducerStats", {
            producerId: id
          });
        }
      }
      if (!this._recvTransport?._closed) {
        const recvTransport = (result[this._recvTransport.id] = {});
        recvTransport.name = "Receive";
        recvTransport.stats = await this._protoo.request("getTransportStats", {
          transportId: this._recvTransport.id
        });
        result[this._recvTransport.id]["consumers"] = {};
        for (const consumer of this._recvTransport._consumers) {
          const id = consumer[0];
          result[this._recvTransport.id]["consumers"][id] = await this._protoo.request("getConsumerStats", {
            consumerId: id
          });
        }
      }
      return result;
    } catch (e) {
      this.emitRTCEvent("error", "Adapter", () => `Error getting the server status: ${e}`);
      return { error: `Error getting the server status: ${e}` };
    }
  }

  async iceRestart(transport) {
    // Force an ICE restart to gather new candidates and trigger a reconnection
    this.emitRTCEvent(
      "log",
      "RTC",
      () => `Restarting ${transport.id === this._sendTransport.id ? "send" : "receive"} transport ICE`
    );
    const iceParameters = await this._protoo.request("restartIce", { transportId: transport.id });
    await transport.restartIce({ iceParameters });
  }

  async recreateSendTransport(iceServers) {
    this.emitRTCEvent("log", "RTC", () => `Recreating send transport ICE`);
    await this.closeSendTransport();
    await this.createSendTransport(iceServers);
  }

  /**
   * Restart ICE in the underlying send peerconnection.
   */
  async restartSendICE() {
    // Do not restart ICE if Signaling is disconnected.
    if (!this._protoo || !this._protoo.connected) {
      return;
    }

    try {
      if (!this._sendTransport?._closed) {
        await this.iceRestart(this._sendTransport);
      } else {
        // If the transport is closed but the signaling is connected, we try to recreate
        const { host, port, turn } = this._serverParams;
        const iceServers = this.getIceServers(host, port, turn);
        await this.recreateSendTransport(iceServers);
      }
    } catch (err) {
      this.emitRTCEvent("error", "RTC", () => `Send transport [recreate] failed: ${err}`);
    }
  }

  /**
   * Checks the Send Transport ICE status and restarts it in case is in failed state.
   * This is called by the Send Transport "connectionstatechange" event listener.
   * @param {boolean} connectionState The transport connnection state (ICE connection state)
   */
  checkSendIceStatus(connectionState) {
    // If the ICE connection state is failed, we force an ICE restart
    if (connectionState === "failed") {
      this.restartSendICE();
    }
  }

  async recreateRecvTransport(iceServers) {
    this.emitRTCEvent("log", "RTC", () => `Recreating receive transport ICE`);
    await this.closeRecvTransport();
    await this.createRecvTransport(iceServers);
    await this._protoo.request("refreshConsumers");
  }

  /**
   * Restart ICE in the underlying receive peerconnection.
   * @param {boolean} force Forces the execution of the reconnect.
   */
  async restartRecvICE() {
    if (!this._protoo || !this._protoo.connected) {
      return;
    }

    try {
      if (!this._recvTransport?._closed) {
        await this.iceRestart(this._recvTransport);
      } else {
        // If the transport is closed but the signaling is connected, we try to recreate
        const { host, port, turn } = this._serverParams;
        const iceServers = this.getIceServers(host, port, turn);
        await this.recreateRecvTransport(iceServers);
      }
    } catch (err) {
      this.emitRTCEvent("error", "RTC", () => `Receive transport [recreate] failed: ${err}`);
    }
  }

  /**
   * Checks the ReeceiveReeceive Transport ICE status and restarts it in case is in failed state.
   * This is called by the Reeceive Transport "connectionstatechange" event listener.
   * @param {boolean} connectionState The transport connection state (ICE connection state)
   */
  checkRecvIceStatus(connectionState) {
    // If the ICE connection state is failed, we force an ICE restart
    if (connectionState === "failed") {
      this.restartRecvICE();
    }
  }

  async connect({ serverUrl, roomId, serverParams, scene, clientId, forceTcp, forceTurn, iceTransportPolicy }) {
    this._serverUrl = serverUrl;
    this._roomId = roomId;
    this._serverParams = serverParams;
    this._clientId = clientId;
    this.scene = scene;
    this._forceTcp = forceTcp;
    this._forceTurn = forceTurn;
    this._iceTransportPolicy = iceTransportPolicy;

    this._trtcRoomId = roomId;
    this._trtcUserId = clientId;

    const urlWithParams = new URL(this._serverUrl);
    urlWithParams.searchParams.append("roomId", this._roomId);
    urlWithParams.searchParams.append("peerId", this._clientId);

    // TODO: Establishing connection could take a very long time.
    //       Inform the user if we are stuck here.
    const protooTransport = new protooClient.WebSocketTransport(urlWithParams.toString(), {
      retry: { retries: 2 }
    });
    this._protoo = new protooClient.Peer(protooTransport);

    this._protoo.on("disconnected", () => {
      this.emitRTCEvent("info", "Signaling", () => `Disconnected`);
      this.cleanUpLocalState();
    });

    this._protoo.on("failed", attempt => {
      this.emitRTCEvent("error", "Signaling", () => `Failed: ${attempt}, retrying...`);
    });

    this._protoo.on("close", async () => {
      // We explicitly disconnect event handlers when closing the socket ourselves,
      // so if we get into here, we were not the ones closing the connection.
      this.emitRTCEvent("error", "Signaling", () => `Closed`);
      this._retryConnectWithNewHost();
    });

    // eslint-disable-next-line no-unused-vars
    this._protoo.on("request", async (request, accept, reject) => {
      this.emitRTCEvent("info", "Signaling", () => `Request [${request.method}]: ${request.data?.id}`);
      debug('proto "request" event [method:%s, data:%o]', request.method, request.data?.id);

      switch (request.method) {
        case "newConsumer": {
          const { peerId, producerId, id, kind, rtpParameters, /*type, */ appData /*, producerPaused */ } =
            request.data;

          try {
            const consumer = await this._recvTransport.consume({
              id,
              producerId,
              kind,
              rtpParameters,
              appData: { ...appData, peerId } // Trick.
            });

            // Store in the map.
            this._consumers.set(consumer.id, consumer);

            consumer.on("transportclose", () => {
              this.emitRTCEvent("error", "RTC", () => `Consumer transport closed`);
              this.removeConsumer(consumer.id);
            });

            if (kind === "video") {
              const { spatialLayers, temporalLayers } = mediasoupClient.parseScalabilityMode(
                consumer.rtpParameters.encodings[0].scalabilityMode
              );

              this._consumerStats[consumer.id] = this._consumerStats[consumer.id] || {};
              this._consumerStats[consumer.id]["spatialLayers"] = spatialLayers;
              this._consumerStats[consumer.id]["temporalLayers"] = temporalLayers;
            }

            // We are ready. Answer the protoo request so the server will
            // resume this Consumer (which was paused for now if video).
            accept();

            this.resolvePendingMediaRequestForTrack(peerId, consumer.track);

            // Notify of an stream update event
            this.emit("stream_updated", peerId, kind);
          } catch (err) {
            this.emitRTCEvent("error", "Adapter", () => `Error: ${err}`);
            error('"newConsumer" request failed:%o', err);

            throw err;
          }

          break;
        }
      }
    });

    this._protoo.on("notification", notification => {
      debug('proto "notification" event [method:%s, data:%o]', notification.method, notification.data);

      switch (notification.method) {
        case "newPeer": {
          break;
        }

        case "peerClosed": {
          const { peerId } = notification.data;
          this.closePeer(peerId);

          break;
        }

        case "consumerClosed": {
          const { consumerId } = notification.data;
          const consumer = this._consumers.get(consumerId);

          if (!consumer) {
            info(`consumerClosed event received without related consumer: ${consumerId}`);
            break;
          }

          consumer.close();
          this.removeConsumer(consumer.id);

          break;
        }

        case "peerBlocked": {
          const { peerId } = notification.data;
          this.trtcMuteRemoteStream(clientId);
          document.body.dispatchEvent(new CustomEvent("blocked", { detail: { clientId: peerId } }));

          break;
        }

        case "peerUnblocked": {
          const { peerId } = notification.data;
          this.trtcUnmuteRemoteStream(peerId);
          document.body.dispatchEvent(new CustomEvent("unblocked", { detail: { clientId: peerId } }));

          break;
        }

        case "downlinkBwe": {
          this._downlinkBwe = notification.data;
          break;
        }

        case "consumerLayersChanged": {
          const { consumerId, spatialLayer, temporalLayer } = notification.data;

          const consumer = this._consumers.get(consumerId);

          if (!consumer) {
            info(`consumerLayersChanged event received without related consumer: ${consumerId}`);
            break;
          }

          this._consumerStats[consumerId] = this._consumerStats[consumerId] || {};
          this._consumerStats[consumerId]["spatialLayer"] = spatialLayer;
          this._consumerStats[consumerId]["temporalLayer"] = temporalLayer;

          // TODO: If spatialLayer/temporalLayer are null, that's probably because the current downlink
          // it's not enough forany spatial layer bitrate. In that case the server has paused the consumer.
          // At this point we it would be nice to give the user some visual cue that this stream is paused.
          // ie. A grey overlay with some icon or replacing the video stream por a generic person image.
          break;
        }

        case "consumerScore": {
          const { consumerId, score } = notification.data;

          const consumer = this._consumers.get(consumerId);

          if (!consumer) {
            info(`consumerScore event received without related consumer: ${consumerId}`);
            break;
          }

          this._consumerStats[consumerId] = this._consumerStats[consumerId] || {};
          this._consumerStats[consumerId]["score"] = score;
        }
      }
    });

    return new Promise((resolve, reject) => {
      this._protoo.on("open", async () => {
        this.emitRTCEvent("info", "Signaling", () => `Open`);

        try {
          await this._joinRoom();
          await this._trtcJoinRoom();
          resolve();
          this.emit(DIALOG_CONNECTION_CONNECTED);
        } catch (err) {
          this.emitRTCEvent("warn", "Adapter", () => `Error during connect: ${error}`);
          reject(err);
          this.emit(DIALOG_CONNECTION_ERROR_FATAL);
        }
      });
    });
  }

  async _retryConnectWithNewHost() {
    this.cleanUpLocalState();
    this._protoo.removeAllListeners();
    const serverParams = await APP.hubChannel.getHost();
    const { host, port } = serverParams;
    const newServerUrl = `wss://${host}:${port}`;
    if (this._serverUrl === newServerUrl) {
      console.error("Reconnect to dialog failed.");
      this.emit(DIALOG_CONNECTION_ERROR_FATAL);
      return;
    }
    console.log(`The Dialog server has changed to ${newServerUrl}, reconnecting with the new server...`);
    await this.connect({
      serverUrl: newServerUrl,
      roomId: this._roomId,
      serverParams,
      scene: this.scene,
      clientId: this._clientId,
      forceTcp: this._forceTcp,
      forceTurn: this._forceTurn,
      iceTransportPolicy: this._iceTransportPolicy
    });
  }

  closePeer(peerId) {
    const pendingMediaRequests = this._pendingMediaRequests.get(peerId);

    if (pendingMediaRequests) {
      const msg = "The user disconnected before the media stream was resolved.";
      info(msg);

      if (pendingMediaRequests.audio) {
        pendingMediaRequests.audio.resolve(null);
      }

      if (pendingMediaRequests.video) {
        pendingMediaRequests.video.resolve(null);
      }

      this._pendingMediaRequests.delete(peerId);
    }
  }

  resolvePendingMediaRequestForTrack(clientId, track) {
    const requests = this._pendingMediaRequests.get(clientId);

    if (requests && requests[track.kind]) {
      const resolve = requests[track.kind].resolve;
      delete requests[track.kind];
      resolve(new MediaStream([track]));
    }

    if (requests && Object.keys(requests).length === 0) {
      this._pendingMediaRequests.delete(clientId);
    }
  }

  removeConsumer(consumerId) {
    this.emitRTCEvent("info", "RTC", () => `Consumer removed: ${consumerId}`);
    this._consumers.delete(consumerId);
  }

  getMediaStream(clientId, kind = "audio") {
    let track;

    if (this._clientId === clientId) {
      if (this._trtcLocalStream) {
        if (kind === "audio") {
          track = this._trtcLocalStream.getAudioTrack();
        } else {
          track = this._trtcLocalStream.getVideoTrack();
        }
      } else if (kind === "video") {
        if (this._shareProducer && !this._shareProducer.closed) {
          track = this._shareProducer.track;
        }
      }
    } else {
      if (kind === "audio") {
        track = this._trtcRemoteStreams.get(clientId)?.get("audio")?.getAudioTrack();
      } else {
        track = this._trtcRemoteStreams.get(clientId)?.get("video")?.getVideoTrack();
        if (!track) {
          this._consumers.forEach(consumer => {
            if (consumer.appData.peerId === clientId && kind == consumer.track.kind) {
              track = consumer.track;
            }
          });
        }
      }
    }

    if (track) {
      debug(`Already had ${kind} for ${clientId}`);
      return Promise.resolve(new MediaStream([track]));
    } else {
      debug(`Waiting on ${kind} for ${clientId}`);
      if (!this._pendingMediaRequests.has(clientId)) {
        this._pendingMediaRequests.set(clientId, {});
      }

      const requests = this._pendingMediaRequests.get(clientId);
      const promise = new Promise((resolve, reject) => (requests[kind] = { resolve, reject }));
      requests[kind].promise = promise;
      promise.catch(e => {
        this.emitRTCEvent("error", "Adapter", () => `getMediaStream error: ${e}`);
        console.warn(`${clientId} getMediaStream Error`, e);
      });
      return promise;
    }
  }

  async createSendTransport(iceServers) {
    // Create mediasoup Transport for sending (unless we don't want to produce).
    const sendTransportInfo = await this._protoo.request("createWebRtcTransport", {
      producing: true,
      consuming: false,
      sctpCapabilities: undefined
    });

    this._sendTransport = this._mediasoupDevice.createSendTransport({
      id: sendTransportInfo.id,
      iceParameters: sendTransportInfo.iceParameters,
      iceCandidates: sendTransportInfo.iceCandidates,
      dtlsParameters: sendTransportInfo.dtlsParameters,
      sctpParameters: sendTransportInfo.sctpParameters,
      iceServers,
      iceTransportPolicy: this._iceTransportPolicy,
      proprietaryConstraints: PC_PROPRIETARY_CONSTRAINTS
    });

    this._sendTransport.on(
      "connect",
      (
        { dtlsParameters },
        callback,
        errback // eslint-disable-line no-shadow
      ) => {
        this.emitRTCEvent("info", "RTC", () => `Send transport [connect]`);
        this._sendTransport.observer.on("close", () => {
          this.emitRTCEvent("info", "RTC", () => `Send transport [close]`);
        });
        this._sendTransport.observer.on("newproducer", producer => {
          this.emitRTCEvent("info", "RTC", () => `Send transport [newproducer]: ${producer.id}`);
        });
        this._sendTransport.observer.on("newconsumer", consumer => {
          this.emitRTCEvent("info", "RTC", () => `Send transport [newconsumer]: ${consumer.id}`);
        });

        this._protoo
          .request("connectWebRtcTransport", {
            transportId: this._sendTransport.id,
            dtlsParameters
          })
          .then(callback)
          .catch(errback);
      }
    );

    this._sendTransport.on("connectionstatechange", connectionState => {
      let level = "info";
      if (connectionState === "failed" || connectionState === "disconnected") {
        level = "error";
      }
      this.emitRTCEvent(level, "RTC", () => `Send transport [connectionstatechange]: ${connectionState}`);

      this.checkSendIceStatus(connectionState);
    });

    this._sendTransport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
      this.emitRTCEvent("info", "RTC", () => `Send transport [produce]: ${kind}`);
      try {
        // eslint-disable-next-line no-shadow
        const { id } = await this._protoo.request("produce", {
          transportId: this._sendTransport.id,
          kind,
          rtpParameters,
          appData
        });

        callback({ id });
      } catch (error) {
        this.emitRTCEvent("error", "Signaling", () => `[produce] error: ${error}`);
        errback(error);
      }
    });
  }

  async closeSendTransport() {
    // TODO: If _sendTransport is falsey then return
    const transportId = this._sendTransport?.id;
    if (this._sendTransport && !this._sendTransport._closed) {
      this._sendTransport.close();
      this._sendTransport = null;
    }

    if (this._protoo?.connected) {
      try {
        await this._protoo.request("closeWebRtcTransport", { transportId });
      } catch (err) {
        error(err);
      }
    }
  }

  async createRecvTransport(iceServers) {
    // Create mediasoup Transport for sending (unless we don't want to consume).
    const recvTransportInfo = await this._protoo.request("createWebRtcTransport", {
      producing: false,
      consuming: true,
      sctpCapabilities: undefined
    });

    this._recvTransport = this._mediasoupDevice.createRecvTransport({
      id: recvTransportInfo.id,
      iceParameters: recvTransportInfo.iceParameters,
      iceCandidates: recvTransportInfo.iceCandidates,
      dtlsParameters: recvTransportInfo.dtlsParameters,
      sctpParameters: recvTransportInfo.sctpParameters,
      iceServers,
      iceTransportPolicy: this._iceTransportPolicy
    });

    this._recvTransport.on(
      "connect",
      (
        { dtlsParameters },
        callback,
        errback // eslint-disable-line no-shadow
      ) => {
        this.emitRTCEvent("info", "RTC", () => `Receive transport [connect]`);
        this._recvTransport.observer.on("close", () => {
          this.emitRTCEvent("info", "RTC", () => `Receive transport [close]`);
        });
        this._recvTransport.observer.on("newproducer", producer => {
          this.emitRTCEvent("info", "RTC", () => `Receive transport [newproducer]: ${producer.id}`);
        });
        this._recvTransport.observer.on("newconsumer", consumer => {
          this.emitRTCEvent("info", "RTC", () => `Receive transport [newconsumer]: ${consumer.id}`);
        });

        this._protoo
          .request("connectWebRtcTransport", {
            transportId: this._recvTransport.id,
            dtlsParameters
          })
          .then(callback)
          .catch(errback);
      }
    );

    this._recvTransport.on("connectionstatechange", connectionState => {
      let level = "info";
      if (connectionState === "failed" || connectionState === "disconnected") {
        level = "error";
      }
      this.emitRTCEvent(level, "RTC", () => `Receive transport [connectionstatechange]: ${connectionState}`);

      this.checkRecvIceStatus(connectionState);
    });
  }

  async closeRecvTransport() {
    const transportId = this._recvTransport?.id;
    if (this._recvTransport && !this._recvTransport._closed) {
      this._recvTransport.close();
      this._recvTransport = null;
    }
    if (this._protoo?.connected) {
      try {
        await this._protoo.request("closeWebRtcTransport", { transportId });
      } catch (err) {
        error(err);
      }
    }
  }

  async _joinRoom() {
    debug("_joinRoom()");

    this._mediasoupDevice = new mediasoupClient.Device({});

    const routerRtpCapabilities = await this._protoo.request("getRouterRtpCapabilities");

    await this._mediasoupDevice.load({ routerRtpCapabilities });

    const { host, port, turn } = this._serverParams;
    const iceServers = this.getIceServers(host, port, turn);

    await this.createSendTransport(iceServers);
    await this.createRecvTransport(iceServers);

    await this._protoo.request("join", {
      displayName: this._clientId,
      device: this._device,
      rtpCapabilities: this._mediasoupDevice.rtpCapabilities,
      sctpCapabilities: this._useDataChannel ? this._mediasoupDevice.sctpCapabilities : undefined,
      token: APP.hubChannel.token
    });

    if (this._localMediaStream) {
      // TODO: Refactor to be "Create producers"
      await this.setLocalMediaStream(this._localMediaStream);
    }
  }

  async _trtcJoinRoom() {
    trtcDebug("_trtcJoinRoom()");

    let sdkAppId, userSig;

    try {
      const data = await APP.hubChannel.initTRTC(this._trtcUserId)

      sdkAppId = data.sdk_app_id;
      userSig = data.user_sig;
    } catch(e) {
      trtcError(`_trtcJoinRoom(): initTRTC() ${e}`);
      return
    }

    try {
      this._trtcClient = trtcSDK.createClient({
        sdkAppId,
        userSig,
        userId: this._trtcUserId,
        mode: 'rtc',
        useStringRoomId: true,
      })

      await this._trtcClient.join({ roomId: this._trtcRoomId });

      trtcDebug(`_trtcJoinRoom(): joined roomId: ${this._trtcRoomId}, userId: ${this._trtcUserId}`);

      this._trtcClient.on('stream-added', (data) => {
        trtcDebug(`on: event "stream-added": ${data}`)

        const userId = remoteStream.getUserId();
        if (!userId) return

        const remoteStream = data.stream;

        let userStream = this._trtcRemoteStreams.get(userId);
        if (!userStream) userStream = new Map();

        if (remoteStream.hasAudio()) {
          userStream.set('audio', remoteStream);
          this.resolvePendingMediaRequestForTrack(userId, remoteStream.getAudioTrack());
        }
        if (remoteStream.hasVideo()) {
          userStream.set('video', remoteStream);
          this.resolvePendingMediaRequestForTrack(userId, remoteStream.getVideoTrack());
        }

        this._trtcRemoteStreams.set(userId, userStream);
      })

      this._trtcClient.on('stream-updated', (data) => {
        trtcDebug(`on: event "stream-updated": ${data}`);

        const userId = data.stream.getUserId();
        if (!userId) return;

        const remoteStream = data.stream;

        let userStream = this._trtcRemoteStreams.get(userId);
        if (!userStream) userStream = new Map();

        if (remoteStream.hasAudio()) {
          userStream.set('audio', remoteStream);
          this.resolvePendingMediaRequestForTrack(userId, remoteStream.getAudioTrack());
          this.emit('stream_updated', userId, 'audio');
        }
        if (remoteStream.hasVideo()) {
          userStream.set('video', remoteStream);
          this.resolvePendingMediaRequestForTrack(userId, remoteStream.getVideoTrack());
          this.emit('stream_updated', userId, 'video');
        }

        this._trtcRemoteStreams.set(userId, userStream);
      })

      this._trtcClient.on('stream-removed', (data) => {
        trtcDebug(`on: event "stream-removed": ${data}`);

        const userId = data.stream.getUserId();
        if (!userId) return;

        const remoteStream = data.stream;

        if (remoteStream.hasAudio()) {
          this._trtcRemoteStreams.get(userId)?.delete('audio');
        }
        if (remoteStream.hasVideo()) {
          this._trtcRemoteStreams.get(userId)?.delete('video');
        }
      })

      this._trtcClient.on('peer-leave', (data) => {
        this._trtcRemoteStreams.delete(data.userId);
      })
    } catch(e) {
      trtcError(`_trtcJoinRoom(): ${e}`);
    }
  }

  async setLocalMediaStream(stream) {
    if (!this._sendTransport) {
      console.error("Tried to setLocalMediaStream before a _sendTransport existed");
      return;
    }
    this.emitRTCEvent("info", "RTC", () => `Creating missing producers`);
    let sawAudio = false;
    let sawVideo = false;

    await Promise.all(
      stream.getTracks().map(async track => {
        if (track.kind === "audio") {
          sawAudio = true;

          // TODO multiple audio tracks?
          const localStream = await this.getTRTCLocalStream();
          if (localStream.hasAudio()) {
            await localStream.replaceTrack(track);
          } else {
            await localStream.addTrack(track);
          }

          this.emit("mic-state-changed", { enabled: this.isMicEnabled });
        } else {
          sawVideo = true;

          if (track._hubs_contentHint === MediaDevices.SCREEN) {
            await this.disableCamera();
            await this.enableShare(track);
          } else if (track._hubs_contentHint === MediaDevices.CAMERA) {
            await this.disableShare();
            await this.enableCamera(track);
          }
        }

        this.resolvePendingMediaRequestForTrack(this._clientId, track);
      })
    );

    if (!sawAudio) {
      this.disableMicrophone();
    }
    if (!sawVideo) {
      await this.disableCamera();
      await this.disableShare();
    }
    this._localMediaStream = stream;
  }

  async enableCamera(track) {
    const localStream = await this.getTRTCLocalStream();

    if (localStream.hasVideo()) {
      await localStream.replaceTrack(track);
    } else {
      await localStream.addTrack(track);
    }
    localStream.unmuteVideo();
  }

  async disableCamera() {
    if (this._trtcLocalStream?.hasVideo())
      this._trtcLocalStream.muteVideo();
  }

  async enableShare(track) {
    // stopTracks = false because otherwise the track will end during a temporary disconnect
    this._shareProducer = await this._sendTransport.produce({
      track,
      stopTracks: false,
      codecOptions: { videoGoogleStartBitrate: 1000 },
      encodings: SCREEN_SHARING_SIMULCAST_ENCODINGS,
      zeroRtpOnPause: true,
      disableTrackOnPause: true,
      appData: {
        share: true
      }
    });

    this._shareProducer.on("transportclose", () => {
      this.emitRTCEvent("info", "RTC", () => `Desktop Share transport closed`);
      this.disableShare();
    });
    this._shareProducer.observer.on("trackended", () => {
      this.emitRTCEvent("info", "RTC", () => `Desktop Share transport track ended`);
      this.disableShare();
    });
  }

  async disableShare() {
    if (!this._shareProducer) return;

    this._shareProducer.close();

    try {
      if (!this._sendTransport.closed) {
        await this._protoo.request("closeProducer", { producerId: this._shareProducer.id });
      }
    } catch (error) {
      console.error(`disableShare(): ${error}`);
    }

    this._shareProducer = null;
  }

  toggleMicrophone() {
    if (this.isMicEnabled) {
      this.enableMicrophone(false);
    } else {
      this.enableMicrophone(true);
    }
  }

  disableMicrophone() {
    if (this._trtcLocalStream?.hasAudio())
      this._trtcLocalStream.muteAudio();
  }

  enableMicrophone(enabled) {
    if (!this._trtcLocalStream) {
      console.error("Tried to toggle mic but there's no localStream.");
      return;
    }
    if (!this._trtcLocalStream.hasAudio()) {
      console.error("Tried to toggle mic but there's no localStream's audio track.");
      return;
    }

    if (enabled && !this.isMicEnabled) {
      this._trtcLocalStream.unmuteAudio();
      trtcDebug("enableMicrophone: unmuted");
    } else if (!enabled && this.isMicEnabled) {
      this._trtcLocalStream.muteAudio();
      trtcDebug("enableMicrophone: muted");
    }
    this._micShouldBeEnabled = enabled;
    this.emit("mic-state-changed", { enabled: this.isMicEnabled });
  }

  get isMicEnabled() {
    if (!this._trtcLocalStream) return false;
    if (!this._trtcLocalStream.hasAudio()) return false;
    const track = this._trtcLocalStream.getAudioTrack();
    if (!track) return false;
    return track.enabled;
  }

  cleanUpLocalState() {
    this._sendTransport && this._sendTransport.close();
    this._sendTransport = null;
    this._recvTransport && this._recvTransport.close();
    this._recvTransport = null;
    this._shareProducer = null;

    this.trtcCleanUpState();
  }

  trtcCleanUpState() {
    this._trtcRoomId = null;
    this._trtcUserId = null;
    this._trtcLocalStream = null;
    this._trtcRemoteStreams = new Map();

    if (this._trtcClient) {
      this._trtcClient?.leave().finally(() => {
        this._trtcClient.destroy();
        this._trtcClient = null;
      });
    }
  }

  disconnect() {
    debug("disconnect()");
    this.cleanUpLocalState();
    if (this._protoo) {
      this._protoo.removeAllListeners();
      if (this._protoo.connected) {
        this._protoo.close();
        this.emitRTCEvent("info", "Signaling", () => `[close]`);
      }
    }
  }

  kick(clientId) {
    return this._protoo
      .request("kick", {
        room_id: this.room,
        user_id: clientId,
        token: APP.hubChannel.token
      })
      .then(() => {
        document.body.dispatchEvent(new CustomEvent("kicked", { detail: { clientId: clientId } }));
      });
  }

  block(clientId) {
    return this._protoo.request("block", { whom: clientId }).then(() => {
      this._blockedClients.set(clientId, true);
      this.trtcMuteRemoteStream(clientId);
      document.body.dispatchEvent(new CustomEvent("blocked", { detail: { clientId: clientId } }));
    });
  }

  unblock(clientId) {
    return this._protoo.request("unblock", { whom: clientId }).then(() => {
      this._blockedClients.delete(clientId);
      document.body.dispatchEvent(new CustomEvent("unblocked", { detail: { clientId: clientId } }));
    });
  }

  emitRTCEvent(level, tag, msgFunc) {
    if (!window.APP.store.state.preferences.showRtcDebugPanel) return;
    const time = new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    });
    this.scene.emit("rtc_event", { level, tag, time, msg: msgFunc() });
  }

  async getTRTCLocalStream() {
    if (!this._trtcClient) {
      trtcError("getTRTCLocalStream: empty TRTC Client");
      return
    }

    if (!this._trtcLocalStream) {
      this._trtcLocalStream = trtcSDK.createStream({ userId: this._trtcUserId });
      await this._trtcLocalStream.initialize();
      trtcDebug("getTRTCLocalStream: LocalStream initialized");

      await this._trtcClient.publish(this._trtcLocalStream);
      trtcDebug("getTRTCLocalStream: LocalStream published");

      this._trtcLocalStream.on("player-state-changed", (data) => {
        if (data.reason !== 'ended') return;
        this._trtcLocalStream = null;
        this.emitRTCEvent("info", "RTC", () => 'LocalStream closed');
      });
    }
    return this._trtcLocalStream;
  }

  trtcMuteRemoteStream(clientId) {
    const userStream = this._trtcRemoteStreams.get(clientId);
    if (!userStream) return;

    userStream.get("audio")?.muteAudio();
    userStream.get("video")?.muteVideo();
  }

  trtcUnmuteRemoteStream(clientId) {
    const userStream = this._trtcRemoteStreams.get(clientId);
    if (!userStream) return;

    userStream.get("audio")?.unmuteAudio();
    userStream.get("video")?.unmuteVideo();
  }
}
