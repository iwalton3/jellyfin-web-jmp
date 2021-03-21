import { ConnectionManager, Credentials, ApiClient, Events } from 'jellyfin-apiclient';
import { appHost } from './apphost';
import Dashboard from '../scripts/clientUtils';
import { setUserInfo } from '../scripts/settings/userSettings';

// BEGIN Patches for MPV Shim
// It's got a new home!
/*import { playbackManager } from '../components/playback/playbackmanager';
(function() {
    let oldLogout = ApiClient.prototype.logout;
    ApiClient.prototype.logout = function() {
        // Logout Callback
        var xhr = new XMLHttpRequest();
        xhr.open('POST', "/destroy_session", true);
        xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
        xhr.send("{}");

        return oldLogout.bind(this)();
    }

    let oldAuthenticateUserByName = ApiClient.prototype.authenticateUserByName;
    ApiClient.prototype.authenticateUserByName = function(name, password) {
        // Password Provider
        return new Promise((resolve, reject) => {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', "/mpv_shim_password", true);
            xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
            xhr.onloadend = (result) => {
                var res = JSON.parse(result.target.response);
                if (!res.success) {
                    alert("MPV Shim Login Failed");
                    reject();
                }
                oldAuthenticateUserByName.bind(this)(name, password).then(resolve).catch(reject);
            };
            xhr.onerror = () => {
                reject();
            }
            xhr.send(JSON.stringify({
                server: this.serverAddress(),
                username: name,
                password: password
            }));
        })
    }

    let oldOpenWebSocket = ApiClient.prototype.openWebSocket;
    ApiClient.prototype.openWebSocket = function() {
        oldOpenWebSocket.bind(this)();
        let oldOnOpen = this._webSocket.onopen;
        function onOpen() {
            // Auto-Connect
            var xhr = new XMLHttpRequest();
            xhr.open('POST', "/mpv_shim_id", true);
            xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
            xhr.onloadend = function (result) {
                var res = JSON.parse(result.target.response);
                playbackManager.getTargets().then(function (targets) {
                    for (var i = 0; i < targets.length; i++) {
                        if (targets[i].appName == res.appName &&
                            targets[i].deviceName == res.deviceName)
                            playbackManager.trySetActivePlayer(targets[i].playerName, targets[i]);
                    }
                });
            };
            xhr.send("{}");

            oldOnOpen();
        }
        this._webSocket.onopen = onOpen;
    };

    ApiClient.prototype.joinSyncPlayGroup = function(options = {}) {
        return new Promise((resolve) => {
            // Syncplay Join Group
            var xhr = new XMLHttpRequest();
            xhr.open('POST', "/mpv_shim_syncplay_join", true);
            xhr.setRequestHeader('Content-Type', 'application/json; charset=UTF-8');
            xhr.send(JSON.stringify(options));
            resolve();
        })
    };
})()*/
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
            appHost.appName(),
            appHost.appVersion(),
            appHost.deviceName(),
            appHost.deviceId()
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

export default new ServerConnections(
    credentials,
    appHost.appName(),
    appHost.appVersion(),
    appHost.deviceName(),
    appHost.deviceId(),
    capabilities);
