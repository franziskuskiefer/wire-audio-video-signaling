/*eslint-disable sort-keys, no-console */
import {WcallLogHandler} from "./avs_wcall";
export type UserMediaHandler = (
  convid: string,
  useAudio: boolean,
  useVideo: boolean,
  useScreenShare: boolean
) => Promise<MediaStream>;

export type MediaStreamHandler = (
  convid: string,
  remote_userid: string,
  remote_clientid: string,
  streams: readonly MediaStream[]
) => void;

type RelayCand = {
    hasRelay: boolean
};

interface PeerConnection {
  self: number;
  convid: string;
  rtc: RTCPeerConnection | null;
  turnServers: any[];
  remote_userid: string;
  remote_clientid: string;
  vstate: number;
  call_type: number;
  sending_video: boolean;
  muted: boolean;
  cands: any[];
}

const ENV_FIREFOX = 1;

let em_module: any;
let logFn: WcallLogHandler | null = null;
let userMediaHandler: UserMediaHandler | null = null;
let mediaStreamHandler: MediaStreamHandler | null = null;
let pc_env = 0;
let pc_envver = 0;


/* The following constants closely reflect the values
 * defined in the the C-land counterpart peerconnection_js.c
 */

const PC_SIG_STATE_UNKNOWN = 0;
const PC_SIG_STATE_STABLE = 1;
const PC_SIG_STATE_LOCAL_OFFER = 2;
const PC_SIG_STATE_LOCAL_PRANSWER = 3;
const PC_SIG_STATE_REMOTE_OFFER = 4;
const PC_SIG_STATE_REMOTE_PRANSWER = 5;
const PC_SIG_STATE_CLOSED = 6;

const PC_GATHER_STATE_UNKNOWN = 0;
const PC_GATHER_STATE_NEW = 1;
const PC_GATHER_STATE_GATHERING = 2;
const PC_GATHER_STATE_COMPLETE = 3;

const PC_VIDEO_STATE_STOPPED     = 0;
const PC_VIDEO_STATE_STARTED     = 1;
const PC_VIDEO_STATE_BAD_CONN    = 2;
const PC_VIDEO_STATE_PAUSED      = 3;
const PC_VIDEO_STATE_SCREENSHARE = 4;

const DC_STATE_CONNECTING = 0;
const DC_STATE_OPEN = 1;
const DC_STATE_CLOSING = 2;
const DC_STATE_CLOSED = 3;
const DC_STATE_ERROR = 4;

const LOG_LEVEL_DEBUG = 0;
const LOG_LEVEL_INFO = 1;
const LOG_LEVEL_WARN = 2;
const LOG_LEVEL_ERROR = 3;

const CALL_TYPE_NORMAL = 0;
const CALL_TYPE_VIDEO = 1;
const CALL_TYPE_FORCED_AUDIO = 2;

const connectionsStore = (() => {
  const peerConnections: (PeerConnection | null)[] = [null];
  const dataChannels: (RTCDataChannel | null)[] = [null];

  const storeItem = <T>(store: T[], item: T) => {
    let index = store.indexOf(item);
    if (index === -1) index = store.push(item) - 1;

    return index;
  };

  const removeItem = <T>(store: (T|null)[], index: number) => {
    store[index] = null;
  };

  const getItem = <T>(store: T[], index: number) => {
    return store[index];
  };

  const existsItem = <T>(store: T[], item: T) => {
    return store.indexOf(item) != -1;
  };

  return {
    storePeerConnection: (pc: PeerConnection) => storeItem(peerConnections, pc),
    getPeerConnection: (index: number) => getItem(peerConnections, index),
    getPeerConnectionByConvid: (convid: string): PeerConnection[] => {
      return peerConnections.filter(pc => {
        return !!pc && pc.convid === convid;
      }) as PeerConnection[];
    },
    removePeerConnection: (index: number) => removeItem(peerConnections, index),
    storeDataChannel: (dataChannel: RTCDataChannel) =>
      storeItem(dataChannels, dataChannel),
    getDataChannel: (index: number) => getItem(dataChannels, index),
    removeDataChannel: (index: number) => removeItem(dataChannels, index)
  };
})();

function pc_log(level: number, msg: string) {
    if (logFn)
	logFn(level, msg, 0);
}

function replace_track(pc: PeerConnection, newTrack: MediaStreamTrack) {
    const rtc = pc.rtc;

    if (!rtc)
	return false;

    const senders = rtc.getSenders();
    if (!senders)
	return false;
    
    for (const sender of senders) {
	if (!sender)
	    continue;

	if (!sender.track)
            continue;

	if (sender.track.kind === newTrack.kind) {
	    const oldTrack = sender.track;

	    if (!oldTrack) {
		pc_log(LOG_LEVEL_DEBUG, 'replace_track: oldtrack null');
	    }
	    else {			
		const enabled = oldTrack.enabled;

		sender.replaceTrack(newTrack);
		sender.track.enabled = enabled;
		pc_log(LOG_LEVEL_DEBUG, `replace_track: kind=${newTrack.kind} enabled=${sender.track.enabled}`);

		return true;
	    }
	}
    }

    return false;
}
function update_tracks(pc: PeerConnection, stream: MediaStream) {

    const rtc = pc.rtc;
    const tracks = stream.getTracks();
    let found = false;
   

    pc_log(LOG_LEVEL_INFO, `update_tracks: pc=${pc.self} tracks=${tracks.length}`);
    
    if (!rtc)
	return;
    
    const senders = rtc.getSenders();    
    for (const sender of senders) {
	found = false;
	if (!sender)
	    continue;
	
	if (!sender.track) {
	    rtc.removeTrack(sender);
	    continue;
	}

	for (const track of tracks) {
	    if (track)
		pc_log(LOG_LEVEL_DEBUG, `update_tracks: kind=${track.kind} sender=${sender.track.kind}`);
	    else
		pc_log(LOG_LEVEL_DEBUG, `update_tracks: sender.track=${sender.track} track=${track}`);

	    if (sender.track) {
		if (sender.track.kind === track.kind) {
		    found = true;
		    sender.track.enabled = true;
		    break;
		}
	    }
	}
	if (!found) {
	    if (sender.track)
		sender.track.enabled = false;
	}
    }
    
    tracks.forEach(track => {
	if (track.kind === 'video') {
	    pc.sending_video = true;
	}
	else {
	    track.enabled = !pc.muted;
	}
	if (!replace_track(pc, track)) {
	    pc_log(LOG_LEVEL_INFO, `update_tracks: adding track of kind=${track.kind}`);
	    rtc.addTrack(track, stream);
	}
    });
}


function sigState(stateStr: string) {
  let state = PC_SIG_STATE_UNKNOWN;

  switch (stateStr) {
    case "stable":
      state = PC_SIG_STATE_STABLE;
      break;

    case "have-local-offer":
      state = PC_SIG_STATE_LOCAL_OFFER;
      break;

    case "have-remote-offer":
      state = PC_SIG_STATE_REMOTE_OFFER;
      break;

    case "have-local-pranswer":
      state = PC_SIG_STATE_LOCAL_PRANSWER;
      break;

    case "have-remote-pranswer":
      state = PC_SIG_STATE_REMOTE_PRANSWER;
      break;

    case "closed":
      state = PC_SIG_STATE_CLOSED;
      break;
  }

  return state;
}

function ccallLocalSdpHandler(
  pc: PeerConnection,
  err: number,
  type: string,
  sdp: string
) {
  em_module.ccall(
    "pc_local_sdp_handler",
    null,
    ["number", "number", "string", "string", "string"],
    [pc.self, err, "avs", type, sdp]
  );
}

function ccallStartGatherHandler(
  pc: PeerConnection
) {
  em_module.ccall(
    "pc_start_gather_handler",
    null,
    ["number"],
    [pc.self]
  );
}


function ccallSignallingHandler(pc: PeerConnection, state: number) {
  em_module.ccall(
    "pc_signalling_handler",
    null,
    ["number", "number"],
    [pc.self, state]
  );
}

function ccallGatheringHandler(pc: PeerConnection, type: string, sdp: string) {
  em_module.ccall(
    "pc_gather_handler",
    null,
    ["number", "string", "string"],
    [pc.self, type, sdp]
  );
}

function ccallConnectionHandler(pc: PeerConnection, state: string) {
  em_module.ccall(
    "pc_connection_handler",
    null,
    ["number", "string"],
    [pc.self, state]
  );
}

/* Data-channel helpers */

function ccallDcEstabHandler(pc: PeerConnection, dc: number) {
  em_module.ccall(
    "dc_estab_handler",
    null,
    ["number", "number"],
    [pc.self, dc]
  );
}

function ccallDcStateChangeHandler(pc: PeerConnection, state: number) {
  em_module.ccall(
    "dc_state_handler",
    null,
    ["number", "number"],
    [pc.self, state]
  );
}

function ccallDcDataHandler(pc: PeerConnection, data: string) {
  em_module.ccall(
    "dc_data_handler",
    null,
    ["number", "string", "number"],
    [pc.self, data, data.length]
  );
}

function gatheringHandler(pc: PeerConnection) {
  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }
  const state = rtc.iceGatheringState;

  pc_log(LOG_LEVEL_INFO, `ice gathering state=${state}`);

  switch (state) {
    case "new":
      break;

    case "gathering":
      break;

    case "complete":
      const sdp = rtc.localDescription;
      if (!sdp) {
        return;
      }
      ccallGatheringHandler(pc, sdp.type.toString(), sdp.sdp.toString());
      break;
  }
}

function negotiationHandler(pc: PeerConnection) {
  pc_log(LOG_LEVEL_INFO, `negotiationHandler: ${pc.self}`);    
}


function signallingHandler(pc: PeerConnection) {
  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }
  const stateStr = rtc.signalingState;

  pc_log(LOG_LEVEL_INFO, `signalingHandler: state: ${stateStr}`);

  ccallSignallingHandler(pc, sigState(stateStr));
}

function setMute(pc: PeerConnection) {
  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }

  const senders = rtc.getSenders();
  for (const sender of senders) {
    const track = sender.track;
    if (track && track.kind === "audio") {
      track.enabled = !pc.muted;
    }
  }
}

function candidateHandler(pc: PeerConnection, cand: RTCIceCandidate | null) {    
    const mindex = cand ? cand.sdpMLineIndex : null;

    if (cand !== null)
	pc_log(LOG_LEVEL_DEBUG, `candidateHandler: cand=${cand.candidate} type=${cand.type} mindex=${mindex}`);
    else {
	pc_log(LOG_LEVEL_DEBUG, `candidateHandler: cand=NULL`);
    }

    if (!pc || !pc.rtc)
	return;
    
    if (!cand) {
	pc_log(LOG_LEVEL_INFO, 'candidateHandler: end-of-candidates');
	
	const sdp = pc.rtc.localDescription;

	if (sdp)
	    ccallGatheringHandler(pc, sdp.type.toString(), sdp.sdp.toString());

	return;
    }

    if (pc_env === ENV_FIREFOX) {
	if (mindex != null) {
	    const cmid = pc.cands[mindex];
	    if (!cmid) {
		pc_log(LOG_LEVEL_DEBUG, `candidateHandler: adding mindex=${mindex}`);
		pc.cands[mindex] = {
		    mindex: mindex,
		    hasRelay: false
		}
	    }
	}
    }

    if (cand.type === 'relay') {
	const sdp = pc.rtc.localDescription;
	if (!sdp) {
            return;
	}

	if (pc_env == ENV_FIREFOX) {
	    if (mindex != null) {
		const rmid = pc.cands[mindex];
		if (rmid)
		    rmid.hasRelay = true;
	    }
	
	    for (const cc of pc.cands) {
		if (cc && !cc.hasRelay) {
		    pc_log(LOG_LEVEL_DEBUG, `candidateHandler: mindex=${cc.mindex} still missing relay`);
		    return;
		}
	    }
	}

	pc_log(LOG_LEVEL_INFO, 'candidateHandler: relay(s) found, finished gathering');
	ccallGatheringHandler(pc, sdp.type.toString(), sdp.sdp.toString());
    }
}

function connectionHandler(pc: PeerConnection) {
  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }
  const state = rtc.iceConnectionState;

  pc_log(LOG_LEVEL_INFO, `connectionHandler state: ${state}`);

  ccallConnectionHandler(pc, state);

  setMute(pc);
}

function setupDataChannel(pc: PeerConnection, dc: RTCDataChannel) {
  const dcHnd = connectionsStore.storeDataChannel(dc);
  dc.onopen = () => {
    pc_log(LOG_LEVEL_DEBUG, "dc-opened");
    ccallDcStateChangeHandler(pc, DC_STATE_OPEN);
  };
  dc.onclose = () => {
    pc_log(LOG_LEVEL_DEBUG, "dc-closed");
    ccallDcStateChangeHandler(pc, DC_STATE_CLOSED);
  };
  dc.onerror = () => {
    pc_log(LOG_LEVEL_DEBUG, "dc-error");
    ccallDcStateChangeHandler(pc, DC_STATE_ERROR);
  };
  dc.onmessage = event => {
    pc_log(LOG_LEVEL_DEBUG, `dc-onmessage: data=${event.data.length}`);
    ccallDcDataHandler(pc, event.data.toString());
  };

  return dcHnd;
}

function dataChannelHandler(pc: PeerConnection, event: RTCDataChannelEvent) {
  const dc = event.channel;
  pc_log(LOG_LEVEL_INFO, `dataChannelHandler: ${dc}`);

  const dcHnd = setupDataChannel(pc, dc);

  ccallDcEstabHandler(pc, dcHnd);
}

function pc_SetEnv(env: number) {
    pc_env = env;
}

function pc_New(self: number, convidPtr: number) {
  pc_log(LOG_LEVEL_DEBUG, "pc_New");

  const pc: PeerConnection = {
    self: self,
    convid: em_module.UTF8ToString(convidPtr),
    rtc: null,
    turnServers: [],
    remote_userid: "",
    remote_clientid: "",
    vstate: PC_VIDEO_STATE_STOPPED,
    sending_video: false,
    call_type: CALL_TYPE_NORMAL,  
    muted: false,
    cands: [null, null, null],
  };

  const hnd = connectionsStore.storePeerConnection(pc);

  return hnd;
}

function pc_Create(hnd: number, privacy: number) {
  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
    return;
  }

  const transportPolicy = privacy !== 0 ? "relay" : "all";
    
  const config: RTCConfiguration = {
    bundlePolicy: "max-bundle",
      iceServers: pc.turnServers,
    rtcpMuxPolicy: 'require',
    iceTransportPolicy: transportPolicy,
  };

  pc_log(
    LOG_LEVEL_INFO,
    `pc_Create: configuring: ${pc.turnServers.length} TURN servers`
  );

  const rtc = new RTCPeerConnection(config);

  rtc.onicegatheringstatechange = () => gatheringHandler(pc);
  rtc.oniceconnectionstatechange = () => connectionHandler(pc);
  rtc.onicecandidate = (event) => candidateHandler(pc, event.candidate);  
  rtc.onsignalingstatechange = event => signallingHandler(pc);
  rtc.ondatachannel = event => dataChannelHandler(pc, event);
  rtc.onnegotiationneeded = () => negotiationHandler(pc);  

  rtc.ontrack = event => {
      pc_log(LOG_LEVEL_INFO, `onTrack: self=${pc.self} convid=${pc.convid} userid=${pc.remote_userid}/${pc.remote_clientid} streams=${event.streams.length}`);
      if (event.streams && event.streams.length > 0) {
	  for (const stream of event.streams) {
	      pc_log(LOG_LEVEL_INFO, `onTrack: convid=${pc.convid} stream=${stream}`);
	      for (const track of stream.getTracks()) {
		  if (track)
		      pc_log(LOG_LEVEL_INFO, `onTrack: convid=${pc.convid} track=${track.kind}`);
	      }
	  }
      }
      if (mediaStreamHandler != null) {
	  mediaStreamHandler(
	      pc.convid,
	      pc.remote_userid,
	      pc.remote_clientid,
	      event.streams);
      }
  };

  pc.rtc = rtc;
}

function pc_Close(hnd: number) {
  pc_log(LOG_LEVEL_INFO, `pc_Close: hnd=${hnd}`);

  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
    return;
  }

  connectionsStore.removePeerConnection(hnd);
    
  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }
    
  rtc.close();
  pc.rtc = null;
}

function pc_AddTurnServer(
  hnd: number,
  urlPtr: number,
  usernamePtr: number,
  passwordPtr: number
) {
  pc_log(LOG_LEVEL_INFO, `pc_AddTurnServer: hnd=${hnd}`);

  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
    return;
  }

  const url = em_module.UTF8ToString(urlPtr);
  const username = em_module.UTF8ToString(usernamePtr);
  const credential = em_module.UTF8ToString(passwordPtr);

  pc_log(LOG_LEVEL_INFO, `pc_AddTurnServer: hnd=${hnd} adding: ${username}:${credential}@${url}`);

  const server = {
    urls: url,
    username: username,
    credential: credential
  };

  pc.turnServers.push(server);
}

function pc_HasVideo(hnd: number) : number {
  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
      return 0;
  }

    pc_log(LOG_LEVEL_INFO, `pc_HasVideo(${hnd}): sending=${pc.sending_video}`)

    const senders = pc.rtc ? pc.rtc.getSenders() : [];
    pc_log(LOG_LEVEL_DEBUG, "pc_HasVideo: " + senders.length + " senders")
    for (const sender of senders) {
	pc_log(LOG_LEVEL_DEBUG, "pc_HasVideo: track=" + sender.track)
	if (sender.track) {
	    const track = sender.track;
	    pc_log(LOG_LEVEL_DEBUG, "pc_HasVideo: track.kind=" + track.kind + " enabled=" + track.enabled);

	    if (track.kind === 'video' && track.enabled)
		return 1;
	}
    }

    const txrxs = pc.rtc ? pc.rtc.getTransceivers() : [];
    for (const txrx of txrxs) {
	if (!txrx) {
	    pc_log(LOG_LEVEL_DEBUG, "pc_HasVideo: no txrx");
	    continue;
	}
	const rx = txrx.receiver;
	const tx = txrx.sender;
	pc_log(LOG_LEVEL_DEBUG, `pc_HasVideo: txrx dir=${txrx.direction}/${txrx.currentDirection} rx=${rx} tx=${tx}`);
    }
    
    return 0;
} 

function pc_SetVideoState(hnd: number, vstate: number) {
  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
      return;
  }

  pc_log(LOG_LEVEL_INFO, `pc_SetVideoState: hnd=${hnd} vstate=${vstate}/${pc.vstate} callType=${pc.call_type} active=${pc.sending_video}`);
    
    if (pc.vstate === vstate)
	return;

    let active = false;

    switch(vstate) {
    case PC_VIDEO_STATE_STARTED:
    case PC_VIDEO_STATE_SCREENSHARE:
	active = true;
	break;

    default:
	active = false;
	break;
    }
    
    const rtc = pc.rtc;
    if (!rtc)
	return;
    
    let should_update = false;

    if (pc.vstate === PC_VIDEO_STATE_SCREENSHARE)
	should_update = true;
    else if (active && (pc.call_type !== CALL_TYPE_VIDEO || !pc.sending_video))
	should_update = true;
    else if (!active && (pc.call_type === CALL_TYPE_VIDEO || pc.sending_video))
	should_update = true;
    else if (vstate === PC_VIDEO_STATE_SCREENSHARE)
	should_update = true;

    pc_log(LOG_LEVEL_DEBUG, `pc_SetVideoState: should_update=${should_update} vstate=${vstate} active=${active}`);
    if (should_update && userMediaHandler) {
	const use_video = vstate === PC_VIDEO_STATE_STARTED;
	const use_ss = vstate === PC_VIDEO_STATE_SCREENSHARE;
	pc_log(LOG_LEVEL_DEBUG, `pc_SetVideoState: calling umh(1, ${use_video}, ${use_ss})`);
	userMediaHandler(pc.convid, true, use_video, use_ss)
	    .then((stream: MediaStream) => {
		update_tracks(pc, stream);
	    });
	pc.sending_video = use_video || use_ss;
    }
    
    pc.vstate = vstate
}

function sdpMap(sdp: string, local: boolean, bundle: boolean): string {
    const sdpLines:  string[] = [];
    
    sdp.split('\r\n').forEach(sdpLine => {
	let outline: string | null;

	outline = sdpLine;

	if (local && !bundle) {
	    outline = sdpLine.replace(/^m=(application|video) 0/, 'm=$1 9');
	}
	else if (local && bundle) {
	    outline = sdpLine.replace(/^m=(application|video) 9/, 'm=$1 0');
	}
	else {
	    if(sdpLine.startsWith('a=sctpmap:')) {
		outline = 'a=sctp-port:5000';
	    }
	}
      
	if (outline != null) {
            sdpLines.push(outline);
	}
    });

    return sdpLines.join('\r\n');
}
    

function createSdp(
  pc: PeerConnection,
  callType: number,
  vstate:  number,
  isOffer: boolean
) {
    const rtc = pc.rtc;
    if (!rtc) {
	return;
    }

    pc.call_type = callType;
    pc.vstate = vstate;

    const use_video = vstate === PC_VIDEO_STATE_STARTED;
    const use_ss = vstate === PC_VIDEO_STATE_SCREENSHARE;
    
    pc_log(LOG_LEVEL_DEBUG, `createSdp: calling umh(1, ${use_video}, ${use_ss})`);

    pc.sending_video = use_video || use_ss;
    
    if (userMediaHandler) {
	userMediaHandler(pc.convid, true, use_video, use_ss)
	    .then((stream: MediaStream) => {
		update_tracks(pc, stream);

		const doSdp: (options: RTCOfferOptions) => Promise<RTCSessionDescriptionInit> = isOffer
		      ? rtc.createOffer
		      : rtc.createAnswer;

		const offerVideoRx: RTCOfferOptions = isOffer ? {offerToReceiveVideo: true} : {};

		ccallStartGatherHandler(pc);

		doSdp
		    .bind(rtc)(offerVideoRx)
		    .then(sdp => {
			const typeStr = sdp.type;
			const sdpStr = sdp.sdp || '';

			//pc_log(LOG_LEVEL_DEBUG, `createSdp: type=${typeStr} sdp=${sdpStr}`);
			
			const modSdp = sdpMap(sdpStr, true, false);
			ccallLocalSdpHandler(pc, 0, typeStr, modSdp);
		    })
		    .catch((err: any) => {
			ccallLocalSdpHandler(pc, 1, "sdp-error", err.toString());
		    })
	    })
	    .catch((err: any) => {
		ccallLocalSdpHandler(pc, 1, "media-error", err.toString());
	    });
    }
}

function pc_CreateOffer(hnd: number, callType: number, vstate: number) {
  const pc = connectionsStore.getPeerConnection(hnd);

  if (pc == null) {
    return;
  }

  pc_log(
    LOG_LEVEL_INFO,
    `pc_CreateOffer: hnd=${hnd} self=${pc.self.toString(16)} call_type=${callType}`
  );

  createSdp(pc, callType, vstate, true);
}

function pc_CreateAnswer(hnd: number, callType: number, vstate: number) {
  pc_log(LOG_LEVEL_INFO, `pc_CreateAnswer: ${hnd} callType=${callType}`);

  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
    return;
  }

  createSdp(pc, callType, vstate, false);
}

function pc_SetRemoteDescription(hnd: number, typePtr: number, sdpPtr: number) {
  pc_log(LOG_LEVEL_INFO, `pc_SetRemoteDescription: hnd=${hnd}`);

  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
    return;
  }

  const type = em_module.UTF8ToString(typePtr);
  let sdp = em_module.UTF8ToString(sdpPtr);

  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }

  let sdpStr = sdp;
  if (pc_env === ENV_FIREFOX) {
      sdpStr = sdp.replace(/ DTLS\/SCTP (5000|webrtc-datachannel)/, ' UDP/DTLS/SCTP webrtc-datachannel');
      sdpStr = sdpMap(sdpStr, false, false);
  }
    
  rtc
    .setRemoteDescription({ type: type, sdp: sdpStr })
    .then(() => {})
    .catch((err: any) => {
      pc_log(LOG_LEVEL_WARN, "setRemoteDescription failed: " + err);
    });
}

function pc_SetLocalDescription(hnd: number, typePtr: number, sdpPtr: number) {
  pc_log(LOG_LEVEL_INFO, `pc_SetLocalDescription: hnd=${hnd}`);

  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
    return;
  }

  const type = em_module.UTF8ToString(typePtr);
  const sdp = em_module.UTF8ToString(sdpPtr);

  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }

  let sdpStr = '';

    if (pc_env === ENV_FIREFOX)
	sdpStr = sdpMap(sdp, true, false);
    else
	sdpStr = sdp;
    

    //pc_log(LOG_LEVEL_DEBUG, `pc_SetLocalDesription: type=${type} sdp=${sdpStr}`);
  rtc
    .setLocalDescription({ type: type, sdp: sdpStr })
    .then(() => {})
    .catch((err: any) => {
      pc_log(LOG_LEVEL_INFO, "setLocalDescription failed: " + err);
    });
}

function pc_LocalDescription(hnd: number, typePtr: number) {
  pc_log(LOG_LEVEL_INFO, `pc_LocalDescription: hnd=${hnd}`);

  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
     return;
  }

  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }
  const sdpDesc = rtc.localDescription;
  if (!sdpDesc) {
    return;
  }

  if (typePtr != null) {
    const type = em_module.UTF8ToString(typePtr);
    if (type != sdpDesc.type) {
      pc_log(LOG_LEVEL_WARN, "pc_LocalDescriptiont: wrong type");
      return null;
    }
  }

  const sdp = sdpDesc.sdp.toString();
  let sdpStr = sdp;

  pc_log(LOG_LEVEL_INFO, `pc_LocalDescription: env=${pc_env}`);
    
  if (pc_env === ENV_FIREFOX) {
      sdpStr = sdp.replace(' UDP/DTLS/SCTP', ' DTLS/SCTP');	    
      sdpStr = sdpMap(sdpStr, true, false);
  }
    
  const sdpLen = em_module.lengthBytesUTF8(sdpStr) + 1; // +1 for '\0'
  const ptr = em_module._malloc(sdpLen);
    
  em_module.stringToUTF8(sdpStr, ptr, sdpLen);

  return ptr;
}

function pc_IceGatheringState(hnd: number) {
  pc_log(LOG_LEVEL_INFO, `pc_IceGatheringState: hnd=${hnd}`);

  const pc = connectionsStore.getPeerConnection(hnd);
  if (!pc) {
    return 0;
  }

  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }
  const stateStr = rtc.iceGatheringState;
  let state = PC_GATHER_STATE_UNKNOWN;

  switch (stateStr) {
    case "new":
      state = PC_GATHER_STATE_NEW;
      break;

    case "gathering":
      state = PC_GATHER_STATE_GATHERING;
      break;

    case "complete":
      state = PC_GATHER_STATE_COMPLETE;
      break;
  }

  return state;
}

function pc_SignalingState(hnd: number) {
  pc_log(LOG_LEVEL_INFO, `pc_SignalingState: hnd=${hnd}`);

  const pc = connectionsStore.getPeerConnection(hnd);
  if (!pc) {
    return 0;
  }

  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }
  const stateStr = rtc.signalingState;
  const state = sigState(stateStr);

  pc_log(
    LOG_LEVEL_INFO,
    `pc_SignalingState: hnd=${hnd} ` + stateStr + " mapped: " + state
  );

  return state;
}

function pc_ConnectionState(hnd: number) {
  pc_log(LOG_LEVEL_INFO, `pc_ConnectionState: hnd=${hnd}`);
  const pc = connectionsStore.getPeerConnection(hnd);
  if (!pc) {
    return 0;
  }

  /* Does this need mapping to an int, if it comes as a string,
   * or we return a string???
   */
  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }
  const state = rtc.connectionState;

  return state;
}

function pc_SetMute(hnd: number, muted: number) {
  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
    return;
  }

  pc.muted = muted !== 0;
  setMute(pc);
}

function pc_GetMute(hnd: number) {
  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
    return;
  }

  return pc.muted;
}

function pc_SetRemoteUserClientId(
  hnd: number,
  useridPtr: number,
  clientidPtr: number
) {
  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
    return;
  }

  pc.remote_userid = em_module.UTF8ToString(useridPtr);
  pc.remote_clientid = em_module.UTF8ToString(clientidPtr);
}

/* Data Channel related */
function pc_CreateDataChannel(hnd: number, labelPtr: number) {
  pc_log(LOG_LEVEL_INFO, `pc_CreateDataChannel: hnd=${hnd}`);
  const pc = connectionsStore.getPeerConnection(hnd);
  if (pc == null) {
    return;
  }

  const rtc = pc.rtc;
  if (!rtc) {
    return;
  }
  const label = em_module.UTF8ToString(labelPtr);
  const dc = rtc.createDataChannel(label);
  let dcHnd = 0;
  if (dc != null) {
    dcHnd = setupDataChannel(pc, dc);
  }

  return dcHnd;
}

function pc_DataChannelId(hnd: number) {
  pc_log(LOG_LEVEL_INFO, `pc_DataChannelId: hnd=${hnd}`);

  const dc = connectionsStore.getDataChannel(hnd);
  if (dc == null) {
    return -1;
  }

  return dc.id;
}

function pc_DataChannelState(hnd: number) {
  pc_log(LOG_LEVEL_INFO, `pc_DataChannelState: hnd=${hnd}`);

  const dc = connectionsStore.getDataChannel(hnd);
  if (dc == null) {
    return;
  }

  const str = dc.readyState;
  let state = DC_STATE_ERROR;

  if (str == "connecting") {
    state = DC_STATE_CONNECTING;
  } else if (str == "open") {
    state = DC_STATE_OPEN;
  } else if (str == "closing") {
    state = DC_STATE_CLOSING;
  } else if (str == "closed") {
    state = DC_STATE_CLOSED;
  }

  return state;
}

function pc_DataChannelSend(hnd: number, dataPtr: number, dataLen: number) {
  pc_log(LOG_LEVEL_INFO, `pc_DataChannelSend: hnd=${hnd}`);

  const dc = connectionsStore.getDataChannel(hnd);
  if (dc == null) {
    return;
  }

  if (dc.readyState !== 'open') {
      pc_log(LOG_LEVEL_WARN, `pc_DataChannelSend: hnd=${hnd} not open`);
      return;
  }

  //const data = new Uint8Array(em_module.HEAPU8.buffer, dataPtr, dataLen);
  const data = em_module.UTF8ToString(dataPtr);

  dc.send(data);
}

function pc_DataChannelClose(hnd: number) {
  pc_log(LOG_LEVEL_INFO, `pc_DataChannelClose: hnd=${hnd}`);

  const dc = connectionsStore.getDataChannel(hnd);
  if (dc == null) {
    return;
  }

  dc.close();
}

/* Internal functions, used by avs_wcall directly */

function pc_InitModule(module: any, logh: WcallLogHandler) {
  em_module = module;
  logFn = logh;
    
  pc_log(LOG_LEVEL_INFO, "pc_InitModule");
  const callbacks = [
    [pc_SetEnv, "vn"],
    [pc_New, "nns"],
    [pc_Create, "vn"],
    [pc_Close, "vn"],
    [pc_AddTurnServer, "vnsss"],
    [pc_IceGatheringState, "nn"],
    [pc_SignalingState, "n"],
    [pc_ConnectionState, "n"],
    [pc_CreateDataChannel, "ns"],
    [pc_CreateOffer, "nn"],
    [pc_CreateAnswer, "nn"],
    [pc_SetRemoteDescription, "nss"],
    [pc_SetLocalDescription, "nss"],
    [pc_LocalDescription, "sns"],
    [pc_SetMute, "vnn"],
    [pc_GetMute, "nn"],
    [pc_SetRemoteUserClientId, "vnss"],
    [pc_HasVideo, "nn"],
    [pc_SetVideoState, "vnn"],  
    [pc_DataChannelId, "nn"],
    [pc_DataChannelState, "nn"],
    [pc_DataChannelSend, "vnsn"],
    [pc_DataChannelClose, "vn"]
  ].map(([callback, signature]) => em_module.addFunction(callback, signature));

  em_module.ccall(
    "pc_set_callbacks",
    "null",
    callbacks.map(() => "number"),
    callbacks
  );
}

function pc_SetUserMediaHandler(umh: UserMediaHandler) {
  userMediaHandler = umh;
}

function pc_SetMediaStreamHandler(msh: MediaStreamHandler) {
  mediaStreamHandler = msh;
}

function pc_ReplaceTrack(convid: string, newTrack: MediaStreamTrack) {
  const pcs = connectionsStore.getPeerConnectionByConvid(convid);
  if (pcs.length === 0) return;

  for (const pc of pcs) {
    if (!pc.rtc) {
      continue;
    }

      replace_track(pc, newTrack);
  }
}

function pc_GetStats(convid: string) : Promise<Array<{userid: string, stats: RTCStatsReport}>> {
  const pcs = connectionsStore.getPeerConnectionByConvid(convid);
  const statsPromises = [];

  for (const pc of pcs) {
    const rtc = pc.rtc;
    if (rtc)
      statsPromises.push(rtc.getStats().then(stats => ({userid: pc.remote_userid, stats: stats})));
  }

  return Promise.all(statsPromises) as Promise<Array<{userid: string, stats: RTCStatsReport}>>;
}

export default {
  init: pc_InitModule,
  setUserMediaHandler: pc_SetUserMediaHandler,
  setMediaStreamHandler: pc_SetMediaStreamHandler,
  replaceTrack: pc_ReplaceTrack,
  getStats: pc_GetStats
};
