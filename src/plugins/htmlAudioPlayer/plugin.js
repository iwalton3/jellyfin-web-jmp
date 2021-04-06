import { Events } from 'jellyfin-apiclient';
import * as htmlMediaHelper from '../../components/htmlMediaHelper';

let fadeTimeout;
function fade(instance, elem, startingVolume) {
    instance._isFadingOut = true;

    // Need to record the starting volume on each pass rather than querying elem.volume
    // This is due to iOS safari not allowing volume changes and always returning the system volume value
    const newVolume = Math.max(0, startingVolume - 15);
    console.debug('fading volume to ' + newVolume);
    window.channel.objects.player.setVolume(newVolume);

    if (newVolume <= 0) {
        instance._isFadingOut = false;
        return Promise.resolve();
    }

    return new Promise(function (resolve, reject) {
        cancelFadeTimeout();
        fadeTimeout = setTimeout(function () {
            fade(instance, null, newVolume).then(resolve, reject);
        }, 100);
    });
}

function cancelFadeTimeout() {
    const timeout = fadeTimeout;
    if (timeout) {
        clearTimeout(timeout);
        fadeTimeout = null;
    }
}

function supportsFade() {
    return true;
}

class HtmlAudioPlayer {
    constructor() {
        const self = this;

        self.name = 'Html Audio Player';
        self.type = 'mediaplayer';
        self.id = 'htmlaudioplayer';

        self._duration = undefined;
        self._currentTime = undefined;
        self._paused = false;
        self._volume = htmlMediaHelper.getSavedVolume() * 100;
        self._playRate = 1;

        // Let any players created by plugins take priority
        self.priority = 1;

        self.play = function (options) {
            self._started = false;
            self._timeUpdated = false;
            self._currentTime = null;

            const player = window.channel.objects.player;
            player.playing.connect(onPlaying);
            player.positionUpdate.connect(onTimeUpdate);
            player.finished.connect(onEnded);
            player.updateDuration.connect(onDuration);
            player.error.connect(onError);
            player.paused.connect(onPause);

            return setCurrentSrc(options);
        };

        function setCurrentSrc(options) {
            return new Promise((resolve) => {
                let val = options.url;
                self._currentSrc = val;
                console.debug('playing url: ' + val);

                // Convert to seconds
                const ms = (options.playerStartPositionTicks || 0) / 10000;
                self._currentPlayOptions = options;

                const player = window.channel.objects.player;
                player.load(val,
                    { startMilliseconds: ms, autoplay: true },
                    {type: "audio", headers: {"User-Agent": "JellyfinMediaPlayer"}, frameRate: 0, media: {}},
                    "#1",
                    "",
                    resolve);
            });
        }

        self.onEndedInternal = function() {
            const stopInfo = {
                src: self._currentSrc
            };
    
            Events.trigger(self, 'stopped', [stopInfo]);
    
            self._currentTime = null;
            self._currentSrc = null;
            self._currentPlayOptions = null;
        }

        self.stop = function (destroyPlayer) {
            console.log("die");
            cancelFadeTimeout();

            const src = self._currentSrc;

            if (src) {
                const originalVolume = self._volume;

                return fade(self, null, self._volume).then(function () {
                    self.pause();
                    self.setVolume(originalVolume, false);

                    self.onEndedInternal();

                    if (destroyPlayer) {
                        self.destroy();
                    }
                });
            }
            return Promise.resolve();
        };

        self.destroy = function () {
            window.channel.objects.player.stop();

            const player = window.channel.objects.player;
            player.playing.disconnect(onPlaying);
            player.positionUpdate.disconnect(onTimeUpdate);
            player.finished.disconnect(onEnded);
            self._duration = undefined;
            player.updateDuration.disconnect(onDuration);
            player.error.disconnect(onError);
            player.paused.disconnect(onPause);
        };

        function onDuration(duration) {
            self._duration = duration;
        }

        function onEnded() {
            self.onEndedInternal();
        }

        function onTimeUpdate(time) {
            // Don't trigger events after user stop
            if (!self._isFadingOut) {
                self._currentTime = time;
                Events.trigger(self, 'timeupdate');
            }
        }

        function onPlaying(e) {
            if (!self._started) {
                self._started = true;
            }

            self.setPlaybackRate(1);
            self.setMute(false);
            
            if (self._paused) {
                self._paused = false;
                Events.trigger(self, 'unpause');
            }

            Events.trigger(self, 'playing');
        }

        function onPause() {
            self._paused = true;
            Events.trigger(self, 'pause');
        }

        function onWaiting() {
            Events.trigger(self, 'waiting');
        }

        function onError() {
            console.error(`media element error: ${error}`);

            htmlMediaHelper.onErrorInternal(self, 'mediadecodeerror');
        }
    }

    currentSrc() {
        return this._currentSrc;
    }

    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'audio';
    }

    getDeviceProfile(item) {
        return Promise.resolve({
            "Name": "Jellyfin Media Player",
            "MusicStreamingTranscodingBitrate": 1280000,
            "TimelineOffsetSeconds": 5,
            "TranscodingProfiles": [
                {"Type": "Audio"},
            ],
            "DirectPlayProfiles": [{"Type": "Audio"}],
            "ResponseProfiles": [],
            "ContainerProfiles": [],
            "CodecProfiles": [],
            "SubtitleProfiles": [],
        });
    }

    currentTime(val) {
        if (val != null) {
            window.channel.objects.player.seekTo(val);
            return;
        }

        return this._currentTime;
    }

    currentTimeAsync() {
        return new Promise((resolve) => {
            window.channel.objects.player.getPosition(resolve);
        });
    }

    duration() {
        if (this._duration) {
            return this._duration;
        }

        return null;
    }

    seekable() {
        return Boolean(this._duration);
    }

    getBufferedRanges() {
        return [];
    }

    pause() {
        window.channel.objects.player.pause();
    }

    // This is a retry after error
    resume() {
        this._paused = false;
        window.channel.objects.player.play();
    }

    unpause() {
        window.channel.objects.player.play();
    }

    paused() {
        return this._paused;
    }

    setPlaybackRate(value) {
        this._playRate = value;
        window.channel.objects.player.setPlaybackRate(value * 1000);
    }

    getPlaybackRate() {
        return this._playRate;
    }

    getSupportedPlaybackRates() {
        return [{
            name: '0.5x',
            id: 0.5
        }, {
            name: '0.75x',
            id: 0.75
        }, {
            name: '1x',
            id: 1.0
        }, {
            name: '1.25x',
            id: 1.25
        }, {
            name: '1.5x',
            id: 1.5
        }, {
            name: '1.75x',
            id: 1.75
        }, {
            name: '2x',
            id: 2.0
        }];
    }

    setVolume(val, save = true) {
        this._volume = val;
        if (save) {
            htmlMediaHelper.saveVolume((val || 100) / 100);
            Events.trigger(this, 'volumechange');
        }
        window.channel.objects.player.setVolume(val);
    }

    getVolume() {
        return this._volume;
    }

    volumeUp() {
        this.setVolume(Math.min(this.getVolume() + 2, 100));
    }

    volumeDown() {
        this.setVolume(Math.max(this.getVolume() - 2, 0));
    }

    setMute(mute) {
        this._muted = mute;
        window.channel.objects.player.setMuted(mute);
    }

    isMuted() {
        return this._muted;
    }

    supports(feature) {
        if (!supportedFeatures) {
            supportedFeatures = getSupportedFeatures();
        }

        return supportedFeatures.indexOf(feature) !== -1;
    }
}

let supportedFeatures;

function getSupportedFeatures() {
    return ["PlaybackRate"];
}

export default HtmlAudioPlayer;
