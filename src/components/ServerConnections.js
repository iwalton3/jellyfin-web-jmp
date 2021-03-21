import { ConnectionManager, Credentials, ApiClient, Events } from 'jellyfin-apiclient';
import { appHost } from './apphost';
import Dashboard from '../scripts/clientUtils';
import { setUserInfo } from '../scripts/settings/userSettings';

// BEGIN Patches for MPV Shim
// It's got a new home!
(function() {
    let wsOpen = false;

    ApiClient.prototype.openWebSocket = function() {
        console.log("Handle web socket open.");
        wsOpen = true;
        
        // lies
        Events.trigger(this, 'websocketopen');
    };

    ApiClient.prototype.closeWebSocket = function() {
        console.log("Handle web socket close.");
        wsOpen = false;

        // lies
        Events.trigger(this, 'websocketclose');
    };

    ApiClient.prototype.isWebSocketOpenOrConnecting = function() {
        return wsOpen;
    }

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
})()
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
