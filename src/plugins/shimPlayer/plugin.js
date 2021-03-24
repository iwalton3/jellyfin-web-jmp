import { playbackManager } from '../../components/playback/playbackmanager';
import { Events } from 'jellyfin-apiclient';
import ServerConnections, { setShimEventCallback, shimRequest, shimTarget } from '../../components/ServerConnections';

const shimMessage = (api, name, payload = {}) => {
    payload.ControllingUserId = api.getCurrentUserId();
    payload.ServerId = api.serverId();

    return shimRequest("/mpv_shim_message", {
        name,
        payload
    });
}

function getActivePlayerId() {
    const info = playbackManager.getPlayerInfo();
    return info ? info.id : null;
}

function sendPlayCommand(apiClient, options, playType) {
    const ids = options.ids || options.items.map(function (i) {
        return i.Id;
    });

    const remoteOptions = {
        ItemIds: ids,
        PlayCommand: playType
    };

    if (options.startPositionTicks) {
        remoteOptions.StartPositionTicks = options.startPositionTicks;
    }

    if (options.mediaSourceId) {
        remoteOptions.MediaSourceId = options.mediaSourceId;
    }

    if (options.audioStreamIndex != null) {
        remoteOptions.AudioStreamIndex = options.audioStreamIndex;
    }

    if (options.subtitleStreamIndex != null) {
        remoteOptions.SubtitleStreamIndex = options.subtitleStreamIndex;
    }

    if (options.startIndex != null) {
        remoteOptions.StartIndex = options.startIndex;
    }

    return shimMessage(apiClient, "Play", remoteOptions);
}

function sendPlayStateCommand(apiClient, command, options = {}) {
    options.Command = command;
    shimMessage(apiClient, "Playstate", options);
}

function getCurrentApiClient(instance) {
    const currentServerId = instance.currentServerId;

    if (currentServerId) {
        return ServerConnections.getApiClient(currentServerId);
    }

    return ServerConnections.currentApiClient();
}

function sendCommandByName(instance, name, options) {
    const command = {
        Name: name
    };

    if (options) {
        command.Arguments = options;
    }

    return shimMessage(getCurrentApiClient(instance), "GeneralCommand", command);
}

function processUpdatedSessions(instance, session, apiClient) {
    const serverId = apiClient.serverId();

    if (session.NowPlayingItem) {
        session.NowPlayingItem.ServerId = serverId;
    }

    normalizeImages(session, apiClient);

    const eventNames = getChangedEvents(instance.lastPlayerData, session);
    instance.lastPlayerData = session;

    for (let i = 0, length = eventNames.length; i < length; i++) {
        Events.trigger(instance, eventNames[i], [session]);
    }
}

function getChangedEvents(state1, state2) {
    const names = [];

    if (!state1) {
        names.push('statechange');
        names.push('timeupdate');
        names.push('pause');

        return names;
    }

    // TODO: Trim these down to prevent the UI from over-refreshing
    names.push('statechange');
    names.push('timeupdate');
    names.push('pause');

    return names;
}

function normalizeImages(state, apiClient) {
    if (state && state.NowPlayingItem) {
        const item = state.NowPlayingItem;

        if (!item.ImageTags || !item.ImageTags.Primary) {
            if (item.PrimaryImageTag) {
                item.ImageTags = item.ImageTags || {};
                item.ImageTags.Primary = item.PrimaryImageTag;
            }
        }
        if (item.BackdropImageTag && item.BackdropItemId === item.Id) {
            item.BackdropImageTags = [item.BackdropImageTag];
        }
        if (item.BackdropImageTag && item.BackdropItemId !== item.Id) {
            item.ParentBackdropImageTags = [item.BackdropImageTag];
            item.ParentBackdropItemId = item.BackdropItemId;
        }
        if (!item.ServerId) {
            item.ServerId = apiClient.serverId();
        }
    }
}

class ShimPlayer {
    constructor() {
        const self = this;

        this.name = 'mpv';
        this.type = 'mediaplayer';
        this.isLocalPlayer = false;
        this.id = 'mpv';
    }

    beginPlayerUpdates() {
        const apiClient = getCurrentApiClient(this);

        setShimEventCallback((session) => {
            processUpdatedSessions(this, session, apiClient);
        });
    }

    endPlayerUpdates() {
        this.isUpdating = true;
        setShimEventCallback(() => {});
    }

    getPlayerState() {
        return this.lastPlayerData || {};
    }

    sendCommand(command) {
        sendCommandByName(this, command);
    }

    async play(options) {
        options = Object.assign({}, options);
        const apiClient = getCurrentApiClient(this);

        if (options.items) {
            options.ids = options.items.map(function (i) {
                return i.Id;
            });

            options.items = null;
        }

        // playbackManager doesn't resolve the queue for remote players.
        // The server normally would.
        const result = await playbackManager.getItemsForPlayback(options.serverId || apiClient.serverId(), {
            Ids: options.ids.join(',')
        });
        const items = await playbackManager.translateItemsForPlayback(result.Items, options);
        const ids = items.map((i) => i.Id);
        
        options.ids = ids;
        
        return await sendPlayCommand(apiClient, options, 'PlayNow');
    }

    shuffle(item) {
        sendPlayCommand(getCurrentApiClient(this), { ids: [item.Id] }, 'PlayShuffle');
    }

    instantMix(item) {
        sendPlayCommand(getCurrentApiClient(this), { ids: [item.Id] }, 'PlayInstantMix');
    }

    queue(options) {
        sendPlayCommand(getCurrentApiClient(this), options, 'PlayNext');
    }

    queueNext(options) {
        sendPlayCommand(getCurrentApiClient(this), options, 'PlayLast');
    }

    canPlayMediaType(mediaType) {
        mediaType = (mediaType || '').toLowerCase();
        return mediaType === 'video' || mediaType === 'audio';
    }

    canQueueMediaType(mediaType) {
        return this.canPlayMediaType(mediaType);
    }

    stop() {
        sendPlayStateCommand(getCurrentApiClient(this), 'Stop');
    }

    nextTrack() {
        sendPlayStateCommand(getCurrentApiClient(this), 'NextTrack');
    }

    previousTrack() {
        sendPlayStateCommand(getCurrentApiClient(this), 'PreviousTrack');
    }

    seek(positionTicks) {
        sendPlayStateCommand(getCurrentApiClient(this), 'Seek',
            {
                SeekPositionTicks: positionTicks
            });
    }

    currentTime(val) {
        if (val != null) {
            return this.seek(val * 10000);
        }

        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.PositionTicks / 10000;
    }

    duration() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.RunTimeTicks;
    }

    paused() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.IsPaused;
    }

    getVolume() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.VolumeLevel;
    }

    isMuted() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.IsMuted;
    }

    pause() {
        sendPlayStateCommand(getCurrentApiClient(this), 'Pause');
    }

    unpause() {
        sendPlayStateCommand(getCurrentApiClient(this), 'Unpause');
    }

    playPause() {
        sendPlayStateCommand(getCurrentApiClient(this), 'PlayPause');
    }

    setMute(isMuted) {
        if (isMuted) {
            sendCommandByName(this, 'Mute');
        } else {
            sendCommandByName(this, 'Unmute');
        }
    }

    toggleMute() {
        sendCommandByName(this, 'ToggleMute');
    }

    setVolume(vol) {
        sendCommandByName(this, 'SetVolume', {
            Volume: vol
        });
    }

    volumeUp() {
        sendCommandByName(this, 'VolumeUp');
    }

    volumeDown() {
        sendCommandByName(this, 'VolumeDown');
    }

    toggleFullscreen() {
        sendCommandByName(this, 'ToggleFullscreen');
    }

    audioTracks() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        const streams = state.MediaStreams || [];
        return streams.filter(function (s) {
            return s.Type === 'Audio';
        });
    }

    getAudioStreamIndex() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.AudioStreamIndex;
    }

    playTrailers(item) {
        sendCommandByName(this, 'PlayTrailers', {
            ItemId: item.Id
        });
    }

    setAudioStreamIndex(index) {
        sendCommandByName(this, 'SetAudioStreamIndex', {
            Index: index
        });
    }

    subtitleTracks() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        const streams = state.MediaStreams || [];
        return streams.filter(function (s) {
            return s.Type === 'Subtitle';
        });
    }

    getSubtitleStreamIndex() {
        let state = this.lastPlayerData || {};
        state = state.PlayState || {};
        return state.SubtitleStreamIndex;
    }

    setSubtitleStreamIndex(index) {
        sendCommandByName(this, 'SetSubtitleStreamIndex', {
            Index: index
        });
    }

    setRepeatMode(mode) {
        sendCommandByName(this, 'SetRepeatMode', {
            RepeatMode: mode
        });
    }

    getRepeatMode() {
    }

    setQueueShuffleMode(mode) {
        sendCommandByName(this, 'SetShuffleQueue', {
            ShuffleMode: mode
        });
    }

    getQueueShuffleMode() {
    }

    displayContent(options) {
        sendCommandByName(this, 'DisplayContent', options);
    }

    isPlaying(mediaType) {
        const state = this.lastPlayerData || {};
        return state.NowPlayingItem != null && (state.NowPlayingItem.MediaType === mediaType || !mediaType);
    }

    isPlayingVideo() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.MediaType === 'Video';
    }

    isPlayingAudio() {
        let state = this.lastPlayerData || {};
        state = state.NowPlayingItem || {};
        return state.MediaType === 'Audio';
    }

    getPlaylist() {
        return Promise.resolve([]);
    }

    getCurrentPlaylistItemId() {
    }

    setCurrentPlaylistItem(playlistItemId) {
        return Promise.resolve();
    }

    removeFromPlaylist(playlistItemIds) {
        return Promise.resolve();
    }

    tryPair(target) {
        return Promise.resolve();
    }

    getTargets() {
        return [shimTarget()];
    }
}

export default ShimPlayer;
