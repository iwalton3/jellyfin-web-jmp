import { ConnectionManager, Credentials, ApiClient, Events } from 'jellyfin-apiclient';
import { appHost } from './apphost';
import Dashboard from '../scripts/clientUtils';
import { setUserInfo } from '../scripts/settings/userSettings';
import { playbackManager } from './playback/playbackmanager';
import globalize from '../scripts/globalize';

// BEGIN Patches for MPV Shim
// I thought this approach would help things. But evidently not.

let shimEventCallback = () => {};
let mainEventCallbacks = {};

const clientData = JSON.parse(window.atob(document.getElementById("clientData").innerHTML));

export const setShimEventCallback = (callback) => {
    shimEventCallback = callback;
};

export const shimRequest = (url, options = {}) => new Promise((resolve, reject) => {
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = (e) => {
        if (xhr.readyState === 4 && xhr.status !== 200) {
            reject(xhr.status);
        }
    };
    xhr.ontimeout = () => {
        reject('timeout');
    };
    xhr.onloadend = (result) => {
        var res = JSON.parse(result.target.response);
        resolve(res);
    };
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
    xhr.send(JSON.stringify(options));
});

const setMainEventCallback = (ServerId, callback) => {
    mainEventCallbacks[ServerId] = callback;
}

let hasStartedPoll = false;

const triggerPoll = async () => {
    try {
        const msg = await shimRequest("/mpv_shim_event");

        if (msg.dest == "ws" && mainEventCallbacks.hasOwnProperty(msg.ServerId))
            mainEventCallbacks[msg.ServerId](msg);
        else if (msg.dest == "player") 
            shimEventCallback(msg);
        triggerPoll();
    } catch (e) {
        console.error("Shim poll failed.", e);
        setTimeout(triggerPoll, 5000);
    }
};

export const shimTarget = () => ({
    name: globalize.translate('HeaderMyDevice'),
    id: 'mpv',
    playerName: 'mpv',
    playableMediaTypes: ['Video', 'Audio'],
    isLocalPlayer: false,
    supportedCommands: [
        "MoveUp","MoveDown","MoveLeft","MoveRight","Select",
        "Back","ToggleFullscreen",
        "GoHome","GoToSettings","TakeScreenshot",
        "VolumeUp","VolumeDown","ToggleMute",
        "SetAudioStreamIndex","SetSubtitleStreamIndex",
        "Mute","Unmute","SetVolume","DisplayContent",
        "Play","Playstate","PlayNext","PlayMediaSource",
    ]
});

// We need to proxy all websocket events through the shim.

ApiClient.prototype.closeWebSocket = function() {
    console.log("Handle web socket close.");
    this.wsOpen = false;
    setMainEventCallback(this.serverId(), () => {});
    shimRequest("/mpv_shim_teardown");

    // lies
    Events.trigger(this, 'websocketclose');
};

ApiClient.prototype.sendWebSocketMessage = function(name, payload) {
    // lies
    shimRequest("/mpv_shim_wsmessage", {
        name,
        payload,
        ServerId: this.serverId()
    });
};

ApiClient.prototype.reportCapabilities = function() {
    // more lies
    return Promise.resolve();
}

ApiClient.prototype.isWebSocketOpenOrConnecting = function() {
    // more lies
    return this.wsOpen;
}

ApiClient.prototype.isWebSocketOpen = function() {
    // more lies
    return this.wsOpen;
}

ApiClient.prototype.joinSyncPlayGroup = function(options = {}) {
    return new Promise((resolve) => {
        // Syncplay Join Group
        shimRequest("/mpv_shim_syncplay_join", options);
        resolve();
    });
};
// END Patches for MPV Shim

class ServerConnections extends ConnectionManager {
    constructor() {
        super(...arguments);
        this.localApiClient = null;

        Events.on(this, 'localusersignedout', function () {
            setUserInfo(null, null);
        });
    }

    initApiClient(server) {
        console.debug('creating ApiClient singleton');

        const apiClient = new ApiClient(
            server,
            clientData.appName,
            clientData.appVersion,
            clientData.deviceName,
            clientData.deviceId
        );

        apiClient.enableAutomaticNetworking = false;
        apiClient.manualAddressOnly = true;

        this.addApiClient(apiClient);

        this.setLocalApiClient(apiClient);

        console.debug('loaded ApiClient singleton');
    }

    setLocalApiClient(apiClient) {
        if (apiClient) {
            this.localApiClient = apiClient;
            window.ApiClient = apiClient;
        }
    }

    getLocalApiClient() {
        return this.localApiClient;
    }

    currentApiClient() {
        let apiClient = this.getLocalApiClient();

        if (!apiClient) {
            const server = this.getLastUsedServer();

            if (server) {
                apiClient = this.getApiClient(server.Id);
            }
        }

        return apiClient;
    }

    onLocalUserSignedIn(user) {
        const apiClient = this.getApiClient(user.ServerId);
        this.setLocalApiClient(apiClient);
        return setUserInfo(user.Id, apiClient);
    }
}

const credentials = new Credentials();

const capabilities = Dashboard.capabilities(appHost);

const serverConnections = new ServerConnections(
    credentials,
    clientData.appName,
    clientData.appVersion,
    clientData.deviceName,
    clientData.deviceId,
    capabilities);

export default serverConnections;

// More Patches

ApiClient.prototype.openWebSocket = function() {
    console.log("Handle web socket open.");
    this.wsOpen = true;
    
    setMainEventCallback(this.serverId(), (msg) => {
        Events.trigger(this, 'message', [msg]);
    });

    serverConnections.user(this).then(user => {
        shimRequest("/mpv_shim_session", {
            address: this.serverAddress(),
            AccessToken: this.serverInfo().AccessToken,
            UserId: this.getCurrentUserId(),
            Name: this.serverName(),
            Id: this.serverId(),
            username: user.localUser.Name,
            DateLastAccessed: (new Date()).toISOString(),
            uuid: this.serverId()
        }).catch(() => {
            alert("MPV Shim Session Fail");
        });
    });

    playbackManager.setDefaultPlayerActive();

    if (!hasStartedPoll) {
        hasStartedPoll = true;
        triggerPoll();
    }

    // lies
    Events.trigger(this, 'websocketopen');
};
