import browser from '../../scripts/browser';
import { Events } from 'jellyfin-apiclient';
import { appHost } from '../../components/apphost';
import loading from '../../components/loading/loading';
import dom from '../../scripts/dom';
import { playbackManager } from '../../components/playback/playbackmanager';
import { appRouter } from '../../components/appRouter';
import {
    bindEventsToHlsPlayer,
    destroyHlsPlayer,
    destroyFlvPlayer,
    destroyCastPlayer,
    getCrossOriginValue,
    enableHlsJsPlayer,
    applySrc,
    playWithPromise,
    onEndedInternal,
    saveVolume,
    seekOnPlaybackStart,
    onErrorInternal,
    handleHlsJsMediaError,
    getSavedVolume,
    isValidDuration,
    getBufferedRanges
} from '../../components/htmlMediaHelper';
import itemHelper from '../../components/itemHelper';
import Screenfull from 'screenfull';
import globalize from '../../scripts/globalize';
import ServerConnections from '../../components/ServerConnections';
import profileBuilder from '../../scripts/browserDeviceProfile';
import { getIncludeCorsCredentials } from '../../scripts/settings/webSettings';

/* eslint-disable indent */

function tryRemoveElement(elem) {
        const parentNode = elem.parentNode;
        if (parentNode) {
            // Seeing crashes in edge webview
            try {
                parentNode.removeChild(elem);
            } catch (err) {
                console.error(`error removing dialog element: ${err}`);
            }
        }
    }

    function enableNativeTrackSupport(currentSrc, track) {
        return true;
    }

    function requireHlsPlayer(callback) {
        callback();
    }

    function getMediaStreamAudioTracks(mediaSource) {
        return mediaSource.MediaStreams.filter(function (s) {
            return s.Type === 'Audio';
        });
    }

    function getMediaStreamTextTracks(mediaSource) {
        return mediaSource.MediaStreams.filter(function (s) {
            return s.Type === 'Subtitle';
        });
    }

    function normalizeTrackEventText(text, useHtml) {
        const result = text.replace(/\\N/gi, '\n').replace(/\r/gi, '');
        return useHtml ? result.replace(/\n/gi, '<br>') : result;
    }

    function getTextTrackUrl(track, item, format) {
        if (itemHelper.isLocalItem(item) && track.Path) {
            return track.Path;
        }

        let url = playbackManager.getSubtitleUrl(track, item.ServerId);
        if (format) {
            url = url.replace('.vtt', format);
        }

        return url;
    }

    function getDefaultProfile() {
        return profileBuilder({});
    }

    export class HtmlVideoPlayer {
        /**
         * @type {string}
         */
        name;
        /**
         * @type {string}
         */
        type = 'mediaplayer';
        /**
         * @type {string}
         */
        id = 'htmlvideoplayer';
        /**
         * Let any players created by plugins take priority
         *
         * @type {number}
         */
        priority = 1;
        /**
         * @type {boolean}
         */
        isFetching = false;

        /**
         * @type {HTMLDivElement | null | undefined}
         */
        #videoDialog;
        /**
         * @type {number | undefined}
         */
        #subtitleTrackIndexToSetOnPlaying;
        /**
         * @type {number | null}
         */
        #audioTrackIndexToSetOnPlaying;
        /**
         * @type {null | undefined}
         */
        #currentClock;
        /**
         * @type {any | null | undefined}
         */
        #currentSubtitlesOctopus;
        /**
         * @type {null | undefined}
         */
        #currentAssRenderer;
        /**
         * @type {number | undefined}
         */
        #customTrackIndex;
        /**
         * @type {boolean | undefined}
         */
        #showTrackOffset;
        /**
         * @type {number | undefined}
         */
        #currentTrackOffset;
        /**
         * @type {HTMLElement | null | undefined}
         */
        #videoSubtitlesElem;
        /**
         * @type {any | null | undefined}
         */
        #currentTrackEvents;
        /**
         * @type {string[] | undefined}
         */
        #supportedFeatures;
        /**
         * @type {HTMLVideoElement | null | undefined}
         */
        #mediaElement;
        /**
         * @type {number}
         */
        #fetchQueue = 0;
        /**
         * @type {string | undefined}
         */
        #currentSrc;
        /**
         * @type {boolean | undefined}
         */
        #started;
        /**
         * @type {boolean | undefined}
         */
        #timeUpdated;
        /**
         * @type {number | null | undefined}
         */
        #currentTime;
        /**
         * @type {any | undefined}
         */
        #flvPlayer;
        /**
         * @private (used in other files)
         * @type {any | undefined}
         */
        _hlsPlayer;
        /**
         * @private (used in other files)
         * @type {any | null | undefined}
         */
        _castPlayer;
        /**
         * @private (used in other files)
         * @type {any | undefined}
         */
        _currentPlayOptions;
        /**
         * @type {any | undefined}
         */
        #lastProfile;
        /**
         * @type {number | undefined}
         */
        #duration;
        /**
         * @type {MutationObserver | IntersectionObserver | undefined} (Unclear observer typing)
         */
        #resizeObserver;

        constructor() {
            if (browser.edgeUwp) {
                this.name = 'Windows Video Player';
            } else {
                this.name = 'Html Video Player';
            }
        }

        currentSrc() {
            return this.#currentSrc;
        }

        /**
         * @private
         */
        incrementFetchQueue() {
            if (this.#fetchQueue <= 0) {
                this.isFetching = true;
                Events.trigger(this, 'beginFetch');
            }

            this.#fetchQueue++;
        }

        /**
         * @private
         */
        decrementFetchQueue() {
            this.#fetchQueue--;

            if (this.#fetchQueue <= 0) {
                this.isFetching = false;
                Events.trigger(this, 'endFetch');
            }
        }

        play(options) {
            this.#started = false;
            this.#timeUpdated = false;

            this.#currentTime = null;

            this.resetSubtitleOffset();
            loading.show();
            return this.createMediaElement(options).then(elem => {
                return this.setCurrentSrc(elem, options);
            });
        }

        /**
         * @private
         */
        setCurrentSrc(elem, options) {
            return new Promise((resolve) => {
                let val = options.url;
                console.debug(`playing url: ${val}`);

                // Convert to seconds
                const ms = (options.playerStartPositionTicks || 0) / 10000;

                this.#subtitleTrackIndexToSetOnPlaying = options.mediaSource.DefaultSubtitleStreamIndex == null ? -1 : options.mediaSource.DefaultSubtitleStreamIndex;
                if (this.#subtitleTrackIndexToSetOnPlaying != null && this.#subtitleTrackIndexToSetOnPlaying >= 0) {
                    const initialSubtitleStream = options.mediaSource.MediaStreams[this.#subtitleTrackIndexToSetOnPlaying];
                    if (!initialSubtitleStream || initialSubtitleStream.DeliveryMethod === 'Encode') {
                        this.#subtitleTrackIndexToSetOnPlaying = -1;
                    }
                }

                this.#audioTrackIndexToSetOnPlaying = options.playMethod === 'Transcode' ? null : options.mediaSource.DefaultAudioStreamIndex;

                this._currentPlayOptions = options;
                const player = window.channel.objects.player;
                player.load(val,
                    { startMilliseconds: ms, autoplay: true },
                    {type: "video", headers: {"User-Agent": "JellyfinMediaPlayer"}, frameRate: 0, media: {}},
                    this.#audioTrackIndexToSetOnPlaying != -1 ? this.#audioTrackIndexToSetOnPlaying : "",
                    this.#subtitleTrackIndexToSetOnPlaying != -1 ? this.#subtitleTrackIndexToSetOnPlaying : "",
                    resolve);
            });
        }

        setSubtitleStreamIndex(index) {
            this.setCurrentTrackElement(index);
        }

        resetSubtitleOffset() {
            this.#currentTrackOffset = 0;
            this.#showTrackOffset = false;
        }

        enableShowingSubtitleOffset() {
            this.#showTrackOffset = true;
        }

        disableShowingSubtitleOffset() {
            this.#showTrackOffset = false;
        }

        isShowingSubtitleOffsetEnabled() {
            return this.#showTrackOffset;
        }

        /**
         * @private
         */
        getTextTrack() {
            const videoElement = this.#mediaElement;
            if (videoElement) {
                return Array.from(videoElement.textTracks)
                    .find(function (trackElement) {
                        // get showing .vtt textTack
                        return trackElement.mode === 'showing';
                    });
            } else {
                return null;
            }
        }

        /**
         * @private
         */
        setSubtitleOffset(offset) {
            const offsetValue = parseFloat(offset);

            // if .ass currently rendering
            if (this.#currentSubtitlesOctopus) {
                this.updateCurrentTrackOffset(offsetValue);
                this.#currentSubtitlesOctopus.timeOffset = (this._currentPlayOptions.transcodingOffsetTicks || 0) / 10000000 + offsetValue;
            } else {
                const trackElement = this.getTextTrack();
                // if .vtt currently rendering
                if (trackElement) {
                    this.setTextTrackSubtitleOffset(trackElement, offsetValue);
                } else if (this.#currentTrackEvents) {
                    this.setTrackEventsSubtitleOffset(this.#currentTrackEvents, offsetValue);
                } else {
                    console.debug('No available track, cannot apply offset: ', offsetValue);
                }
            }
        }

        /**
         * @private
         */
        updateCurrentTrackOffset(offsetValue) {
            let relativeOffset = offsetValue;
            const newTrackOffset = offsetValue;
            if (this.#currentTrackOffset) {
                relativeOffset -= this.#currentTrackOffset;
            }
            this.#currentTrackOffset = newTrackOffset;
            // relative to currentTrackOffset
            return relativeOffset;
        }

        /**
         * @private
         */
        setTextTrackSubtitleOffset(currentTrack, offsetValue) {
            if (currentTrack.cues) {
                offsetValue = this.updateCurrentTrackOffset(offsetValue);
                Array.from(currentTrack.cues)
                    .forEach(function (cue) {
                        cue.startTime -= offsetValue;
                        cue.endTime -= offsetValue;
                    });
            }
        }

        /**
         * @private
         */
        setTrackEventsSubtitleOffset(trackEvents, offsetValue) {
            if (Array.isArray(trackEvents)) {
                offsetValue = this.updateCurrentTrackOffset(offsetValue) * 1e7; // ticks
                trackEvents.forEach(function (trackEvent) {
                    trackEvent.StartPositionTicks -= offsetValue;
                    trackEvent.EndPositionTicks -= offsetValue;
                });
            }
        }

        getSubtitleOffset() {
            return this.#currentTrackOffset;
        }

        /**
         * @private
         */
        isAudioStreamSupported(stream, deviceProfile) {
            const codec = (stream.Codec || '').toLowerCase();

            if (!codec) {
                return true;
            }

            if (!deviceProfile) {
                // This should never happen
                return true;
            }

            const profiles = deviceProfile.DirectPlayProfiles || [];

            return profiles.filter(function (p) {
                if (p.Type === 'Video') {
                    if (!p.AudioCodec) {
                        return true;
                    }

                    return p.AudioCodec.toLowerCase().includes(codec);
                }

                return false;
            }).length > 0;
        }

        /**
         * @private
         */
        getSupportedAudioStreams() {
            const profile = this.#lastProfile;

            return getMediaStreamAudioTracks(this._currentPlayOptions.mediaSource).filter((stream) => {
                return this.isAudioStreamSupported(stream, profile);
            });
        }

        setAudioStreamIndex(index) {
            const streams = this.getSupportedAudioStreams();

            if (streams.length < 2) {
                // If there's only one supported stream then trust that the player will handle it on it's own
                return;
            }

            let audioIndex = -1;

            for (const stream of streams) {
                audioIndex++;

                if (stream.Index === index) {
                    break;
                }
            }

            if (audioIndex === -1) {
                return;
            }

            const elem = this.#mediaElement;
            if (!elem) {
                return;
            }

            // https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/audioTracks

            /**
             * @type {ArrayLike<any>|any[]}
             */
            const elemAudioTracks = elem.audioTracks || [];
            console.debug(`found ${elemAudioTracks.length} audio tracks`);

            for (const [i, audioTrack] of Array.from(elemAudioTracks).entries()) {
                if (audioIndex === i) {
                    console.debug(`setting audio track ${i} to enabled`);
                    audioTrack.enabled = true;
                } else {
                    console.debug(`setting audio track ${i} to disabled`);
                    audioTrack.enabled = false;
                }
            }
        }

        stop(destroyPlayer) {
            const elem = this.#mediaElement;
            const src = this.#currentSrc;

            if (elem) {
                if (src) {
                    elem.pause();
                }

                onEndedInternal(this, elem, this.onError);

                if (destroyPlayer) {
                    this.destroy();
                }
            }

            this.destroyCustomTrack(elem);

            return Promise.resolve();
        }

        destroy() {
            appRouter.setTransparency('none');
            document.body.classList.remove('hide-scroll');


            this.#mediaElement = null;

            const player = window.channel.objects.player;
            player.playing.disconnect(this.onPlaying);
            player.positionUpdate.disconnect(this.onTimeUpdate);
            player.finished.disconnect(this.onEnded);
            this.#duration = undefined;
            player.updateDuration.disconnect(this.onDuration);

            videoElement.parentNode.removeChild(videoElement);


            const dlg = this.#videoDialog;
            if (dlg) {
                this.#videoDialog = null;
                dlg.parentNode.removeChild(dlg);
            }

            if (Screenfull.isEnabled) {
                Screenfull.exit();
            } else {
                // iOS Safari
                if (document.webkitIsFullScreen && document.webkitCancelFullscreen) {
                    document.webkitCancelFullscreen();
                }
            }
        }

        /**
         * @private
         * @param e {Event} The event received from the `<video>` element
         */
        onEnded = (e) => {
            /**
             * @type {HTMLMediaElement}
             */
            const elem = e.target;
            this.destroyCustomTrack(elem);
            onEndedInternal(this, elem, this.onError);
        };

        /**
         * @private
         * @param e {Event} The event received from the `<video>` element
         */
        onTimeUpdate = (time) => {
            if (time && !this.#timeUpdated) {
                this.#timeUpdated = true;
            }

            this.#currentTime = time;

            const currentPlayOptions = this._currentPlayOptions;
            // Not sure yet how this is coming up null since we never null it out, but it is causing app crashes
            if (currentPlayOptions) {
                let timeMs = time * 1000;
                timeMs += ((currentPlayOptions.transcodingOffsetTicks || 0) / 10000);
            }

            Events.trigger(this, 'timeupdate');
        };

        /**
         * @private
         * @param e {Event} The event received from the `<video>` element
         */
        onVolumeChange = (e) => {
            /**
             * @type {HTMLMediaElement}
             */
            const elem = e.target;
            saveVolume(elem.volume);
            Events.trigger(this, 'volumechange');
        };

        /**
         * @private
         */
        onNavigatedToOsd = () => {
            const dlg = this.#videoDialog;
            if (dlg) {
                dlg.classList.remove('videoPlayerContainer-onTop');

                this.onStartedAndNavigatedToOsd();
            }
        };

        /**
         * @private
         */
        onStartedAndNavigatedToOsd() {
            // If this causes a failure during navigation we end up in an awkward UI state
            this.setCurrentTrackElement(this.#subtitleTrackIndexToSetOnPlaying);

            if (this.#audioTrackIndexToSetOnPlaying != null && this.canSetAudioStreamIndex()) {
                this.setAudioStreamIndex(this.#audioTrackIndexToSetOnPlaying);
            }
        }

        /**
         * @private
         * @param e {Event} The event received from the `<video>` element
         */
        onPlaying = (e) => {
            if (!this.#started) {
                this.#started = true;

                loading.hide();

                if (this._currentPlayOptions.fullscreen) {
                    appRouter.showVideoOsd().then(this.onNavigatedToOsd);
                } else {
                    appRouter.setTransparency('backdrop');
                    this.#videoDialog.classList.remove('videoPlayerContainer-onTop');

                    this.onStartedAndNavigatedToOsd();
                }
            }
            Events.trigger(this, 'playing');
        };

        /**
         * @private
         */
        onPlay = () => {
            Events.trigger(this, 'unpause');
        };

        /**
         * @private
         */
        ensureValidVideo(elem) {
            if (elem !== this.#mediaElement) {
                return;
            }

            if (elem.videoWidth === 0 && elem.videoHeight === 0) {
                const mediaSource = (this._currentPlayOptions || {}).mediaSource;

                // Only trigger this if there is media info
                // Avoid triggering in situations where it might not actually have a video stream (audio only live tv channel)
                if (!mediaSource || mediaSource.RunTimeTicks) {
                    onErrorInternal(this, 'mediadecodeerror');
                }
            }
        }

        /**
         * @private
         */
        onClick = () => {
            Events.trigger(this, 'click');
        };

        /**
         * @private
         */
        onDblClick = () => {
            Events.trigger(this, 'dblclick');
        };

        /**
         * @private
         */
        onPause = () => {
            Events.trigger(this, 'pause');
        };

        onWaiting() {
            Events.trigger(this, 'waiting');
        }

        /**
         * @private
         * @param e {Event} The event received from the `<video>` element
         */
        onError = (e) => {
            /**
             * @type {HTMLMediaElement}
             */
            const elem = e.target;
            const errorCode = elem.error ? (elem.error.code || 0) : 0;
            const errorMessage = elem.error ? (elem.error.message || '') : '';
            console.error(`media element error: ${errorCode} ${errorMessage}`);

            let type;

            switch (errorCode) {
                case 1:
                    // MEDIA_ERR_ABORTED
                    // This will trigger when changing media while something is playing
                    return;
                case 2:
                    // MEDIA_ERR_NETWORK
                    type = 'network';
                    break;
                case 3:
                    // MEDIA_ERR_DECODE
                    if (this._hlsPlayer) {
                        handleHlsJsMediaError(this);
                        return;
                    } else {
                        type = 'mediadecodeerror';
                    }
                    break;
                case 4:
                    // MEDIA_ERR_SRC_NOT_SUPPORTED
                    type = 'medianotsupported';
                    break;
                default:
                    // seeing cases where Edge is firing error events with no error code
                    // example is start playing something, then immediately change src to something else
                    return;
            }

            onErrorInternal(this, type);
        };

        /**
         * @private
         */
        destroyCustomTrack(videoElement) {
            if (this.#resizeObserver) {
                this.#resizeObserver.disconnect();
                this.#resizeObserver = null;
            }

            if (this.#videoSubtitlesElem) {
                const subtitlesContainer = this.#videoSubtitlesElem.parentNode;
                if (subtitlesContainer) {
                    tryRemoveElement(subtitlesContainer);
                }
                this.#videoSubtitlesElem = null;
            }

            this.#currentTrackEvents = null;

            if (videoElement) {
                const allTracks = videoElement.textTracks || []; // get list of tracks
                for (const track of allTracks) {
                    if (track.label.includes('manualTrack')) {
                        track.mode = 'disabled';
                    }
                }
            }

            this.#customTrackIndex = -1;
            this.#currentClock = null;
            this._currentAspectRatio = null;

            const octopus = this.#currentSubtitlesOctopus;
            if (octopus) {
                octopus.dispose();
            }
            this.#currentSubtitlesOctopus = null;

            const renderer = this.#currentAssRenderer;
            if (renderer) {
                renderer.setEnabled(false);
            }
            this.#currentAssRenderer = null;
        }

        /**
         * @private
         */
        fetchSubtitlesUwp(track) {
            return Windows.Storage.StorageFile.getFileFromPathAsync(track.Path).then(function (storageFile) {
                return Windows.Storage.FileIO.readTextAsync(storageFile);
            }).then(function (text) {
                return JSON.parse(text);
            });
        }

        /**
         * @private
         */
        async fetchSubtitles(track, item) {
            if (window.Windows && itemHelper.isLocalItem(item)) {
                return this.fetchSubtitlesUwp(track, item);
            }

            this.incrementFetchQueue();
            try {
                const response = await fetch(getTextTrackUrl(track, item, '.js'));

                if (!response.ok) {
                    throw new Error(response);
                }

                return response.json();
            } finally {
                this.decrementFetchQueue();
            }
        }

        /**
         * @private
         */
        setTrackForDisplay(videoElement, track) {
            if (!track) {
                this.destroyCustomTrack(videoElement);
                return;
            }

            // skip if already playing this track
            if (this.#customTrackIndex === track.Index) {
                return;
            }

            this.resetSubtitleOffset();
            const item = this._currentPlayOptions.item;

            this.destroyCustomTrack(videoElement);
            this.#customTrackIndex = track.Index;
            this.renderTracksEvents(videoElement, track, item);
        }

        /**
         * @private
         */
        renderSsaAss(videoElement, track, item) {
            const avaliableFonts = [];
            const attachments = this._currentPlayOptions.mediaSource.MediaAttachments || [];
            const apiClient = ServerConnections.getApiClient(item);
            attachments.map(function (i) {
                // embedded font url
                return avaliableFonts.push(apiClient.getUrl(i.DeliveryUrl));
            });
            const fallbackFontList = apiClient.getUrl('/FallbackFont/Fonts', {
                api_key: apiClient.accessToken()
            });
            const htmlVideoPlayer = this;
            const options = {
                video: videoElement,
                subUrl: getTextTrackUrl(track, item),
                fonts: avaliableFonts,
                workerUrl: `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker.js`,
                legacyWorkerUrl: `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker-legacy.js`,
                onError() {
                    onErrorInternal(htmlVideoPlayer, 'mediadecodeerror');
                },
                timeOffset: (this._currentPlayOptions.transcodingOffsetTicks || 0) / 10000000,

                // new octopus options; override all, even defaults
                renderMode: 'blend',
                dropAllAnimations: false,
                libassMemoryLimit: 40,
                libassGlyphLimit: 40,
                targetFps: 24,
                prescaleTradeoff: 0.8,
                softHeightLimit: 1080,
                hardHeightLimit: 2160,
                resizeVariation: 0.2,
                renderAhead: 90
            };
            import('libass-wasm').then(({default: SubtitlesOctopus}) => {
                apiClient.getNamedConfiguration('encoding').then(config => {
                    if (config.EnableFallbackFont) {
                        apiClient.getJSON(fallbackFontList).then((fontFiles = []) => {
                            fontFiles.forEach(font => {
                                const fontUrl = apiClient.getUrl(`/FallbackFont/Fonts/${font.Name}`, {
                                    api_key: apiClient.accessToken()
                                });
                                avaliableFonts.push(fontUrl);
                            });
                            this.#currentSubtitlesOctopus = new SubtitlesOctopus(options);
                        });
                    } else {
                        this.#currentSubtitlesOctopus = new SubtitlesOctopus(options);
                    }
                });
            });
        }

        /**
         * @private
         */
        requiresCustomSubtitlesElement() {
            // after a system update, ps4 isn't showing anything when creating a track element dynamically
            // going to have to do it ourselves
            if (browser.ps4) {
                return true;
            }

            // This is unfortunate, but we're unable to remove the textTrack that gets added via addTextTrack
            if (browser.firefox || browser.web0s) {
                return true;
            }

            if (browser.edge) {
                return true;
            }

            if (browser.iOS) {
                const userAgent = navigator.userAgent.toLowerCase();
                // works in the browser but not the native app
                if ((userAgent.includes('os 9') || userAgent.includes('os 8')) && !userAgent.includes('safari')) {
                    return true;
                }
            }

            return false;
        }

        /**
         * @private
         */
        renderSubtitlesWithCustomElement(videoElement, track, item) {
            this.fetchSubtitles(track, item).then((data) => {
                if (!this.#videoSubtitlesElem) {
                    const subtitlesContainer = document.createElement('div');
                    subtitlesContainer.classList.add('videoSubtitles');
                    subtitlesContainer.innerHTML = '<div class="videoSubtitlesInner"></div>';
                    this.#videoSubtitlesElem = subtitlesContainer.querySelector('.videoSubtitlesInner');
                    this.setSubtitleAppearance(subtitlesContainer, this.#videoSubtitlesElem);
                    videoElement.parentNode.appendChild(subtitlesContainer);
                    this.#currentTrackEvents = data.TrackEvents;
                }
            });
        }

        /**
         * @private
         */
        setSubtitleAppearance(elem, innerElem) {
            Promise.all([import('../../scripts/settings/userSettings'), import('../../components/subtitlesettings/subtitleappearancehelper')]).then(([userSettings, subtitleAppearanceHelper]) => {
                subtitleAppearanceHelper.applyStyles({
                    text: innerElem,
                    window: elem
                }, userSettings.getSubtitleAppearanceSettings());
            });
        }

        /**
         * @private
         */
        getCueCss(appearance, selector) {
            return `${selector}::cue {
                ${appearance.text.map((s) => s.value !== undefined && s.value !== '' ? `${s.name}:${s.value}!important;` : '').join('')}
            }`;
        }

        /**
         * @private
         */
        setCueAppearance() {
            Promise.all([import('../../scripts/settings/userSettings'), import('../../components/subtitlesettings/subtitleappearancehelper')]).then(([userSettings, subtitleAppearanceHelper]) => {
                const elementId = `${this.id}-cuestyle`;

                let styleElem = document.querySelector(`#${elementId}`);
                if (!styleElem) {
                    styleElem = document.createElement('style');
                    styleElem.id = elementId;
                    document.getElementsByTagName('head')[0].appendChild(styleElem);
                }

                styleElem.innerHTML = this.getCueCss(subtitleAppearanceHelper.getStyles(userSettings.getSubtitleAppearanceSettings()), '.htmlvideoplayer');
            });
        }

        /**
         * @private
         */
        renderTracksEvents(videoElement, track, item) {
            if (!itemHelper.isLocalItem(item) || track.IsExternal) {
                const format = (track.Codec || '').toLowerCase();
                if (format === 'ssa' || format === 'ass') {
                    this.renderSsaAss(videoElement, track, item);
                    return;
                }

                if (this.requiresCustomSubtitlesElement()) {
                    this.renderSubtitlesWithCustomElement(videoElement, track, item);
                    return;
                }
            }

            let trackElement = null;
            if (videoElement.textTracks && videoElement.textTracks.length > 0) {
                trackElement = videoElement.textTracks[0];

                // This throws an error in IE, but is fine in chrome
                // In IE it's not necessary anyway because changing the src seems to be enough
                try {
                    trackElement.mode = 'showing';
                    while (trackElement.cues.length) {
                        trackElement.removeCue(trackElement.cues[0]);
                    }
                } catch (e) {
                    console.error('error removing cue from textTrack');
                }

                trackElement.mode = 'disabled';
            } else {
                // There is a function addTextTrack but no function for removeTextTrack
                // Therefore we add ONE element and replace its cue data
                trackElement = videoElement.addTextTrack('subtitles', 'manualTrack', 'und');
            }

            // download the track json
            this.fetchSubtitles(track, item).then(function (data) {
                import('../../scripts/settings/userSettings').then((userSettings) => {
                    // show in ui
                    console.debug(`downloaded ${data.TrackEvents.length} track events`);

                    const subtitleAppearance = userSettings.getSubtitleAppearanceSettings();
                    const cueLine = parseInt(subtitleAppearance.verticalPosition, 10);

                    // add some cues to show the text
                    // in safari, the cues need to be added before setting the track mode to showing
                    for (const trackEvent of data.TrackEvents) {
                        const trackCueObject = window.VTTCue || window.TextTrackCue;
                        const cue = new trackCueObject(trackEvent.StartPositionTicks / 10000000, trackEvent.EndPositionTicks / 10000000, normalizeTrackEventText(trackEvent.Text, false));

                        if (cue.line === 'auto') {
                            cue.line = cueLine;
                        }

                        trackElement.addCue(cue);
                    }

                    trackElement.mode = 'showing';
                });
            });
        }

        /**
         * @private
         */
        setCurrentTrackElement(streamIndex) {
            console.debug(`setting new text track index to: ${streamIndex}`);

            const mediaStreamTextTracks = getMediaStreamTextTracks(this._currentPlayOptions.mediaSource);

            let track = streamIndex === -1 ? null : mediaStreamTextTracks.filter(function (t) {
                return t.Index === streamIndex;
            })[0];

            this.setTrackForDisplay(this.#mediaElement, track);
            if (enableNativeTrackSupport(this.#currentSrc, track)) {
                if (streamIndex !== -1) {
                    this.setCueAppearance();
                }
            } else {
                // null these out to disable the player's native display (handled below)
                streamIndex = -1;
                track = null;
            }
        }

        /**
         * @private
         */
        createMediaElement(options) {
            const dlg = document.querySelector('.videoPlayerContainer');

            if (!dlg) {
                return import('./style.css').then(() => {
                    loading.show();

                    const dlg = document.createElement('div');

                    dlg.classList.add('videoPlayerContainer');

                    if (options.fullscreen) {
                        dlg.classList.add('videoPlayerContainer-onTop');
                    }

                    let html = '';

                    dlg.innerHTML = html;

                    document.body.insertBefore(dlg, document.body.firstChild);
                    this.#videoDialog = dlg;
                    const player = window.channel.objects.player;
                    player.playing.connect(this.onPlaying);
                    player.positionUpdate.connect(this.onTimeUpdate);
                    player.finished.connect(this.onEnded);
                    player.updateDuration.disconnect(this.onDuration);


                    if (options.fullscreen) {
                        // At this point, we must hide the scrollbar placeholder, so it's not being displayed while the item is being loaded
                        document.body.classList.add('hide-scroll');
                    }
                });
            } else {
                // we need to hide scrollbar when starting playback from page with animated background
                if (options.fullscreen) {
                    document.body.classList.add('hide-scroll');
                }

                return Promise.resolve();
            }
        }

    /**
     * @private
     */
    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'video';
    }

    /**
     * @private
     */
    supportsPlayMethod(playMethod, item) {
        if (appHost.supportsPlayMethod) {
            return appHost.supportsPlayMethod(playMethod, item);
        }

        return true;
    }

    /**
     * @private
     */
    getDeviceProfile(item, options) {
        return Promise.resolve({
            "Name": "Jellyfin Media Player",
            "MusicStreamingTranscodingBitrate": 1280000,
            "TimelineOffsetSeconds": 5,
            "TranscodingProfiles": [
                {"Type": "Audio"},
                {
                    "Container": "ts",
                    "Type": "Video",
                    "Protocol": "hls",
                    "AudioCodec": "aac,mp3,ac3,opus,flac,vorbis",
                    "VideoCodec": "h264,h265,hevc,mpeg4,mpeg2video",
                    "MaxAudioChannels": "6",
                },
                {"Container": "jpeg", "Type": "Photo"},
            ],
            "DirectPlayProfiles": [{"Type": "Video"}, {"Type": "Audio"}, {"Type": "Photo"}],
            "ResponseProfiles": [],
            "ContainerProfiles": [],
            "CodecProfiles": [],
            "SubtitleProfiles": [
                {"Format": "srt", "Method": "External"},
                {"Format": "srt", "Method": "Embed"},
                {"Format": "ass", "Method": "External"},
                {"Format": "ass", "Method": "Embed"},
                {"Format": "sub", "Method": "Embed"},
                {"Format": "sub", "Method": "External"},
                {"Format": "ssa", "Method": "Embed"},
                {"Format": "ssa", "Method": "External"},
                {"Format": "smi", "Method": "Embed"},
                {"Format": "smi", "Method": "External"},
                {"Format": "pgssub", "Method": "Embed"},
                {"Format": "dvdsub", "Method": "Embed"},
                {"Format": "pgs", "Method": "Embed"},
            ],
        });
    }

    /**
     * @private
     */
    static getDeviceProfileInternal(item, options) {
        if (appHost.getDeviceProfile) {
            return appHost.getDeviceProfile(item, options);
        }

        return getDefaultProfile();
    }

    /**
     * @private
     */
    static getSupportedFeatures() {
        const list = [];

        const video = document.createElement('video');
        if (
            // Check non-standard Safari PiP support
            typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture') && typeof video.webkitSetPresentationMode === 'function'
            // Check standard PiP support
            || document.pictureInPictureEnabled
        ) {
            list.push('PictureInPicture');
        } else if (window.Windows) {
            if (Windows.UI.ViewManagement.ApplicationView.getForCurrentView().isViewModeSupported(Windows.UI.ViewManagement.ApplicationViewMode.compactOverlay)) {
                list.push('PictureInPicture');
            }
        }

        if (browser.safari || browser.iOS || browser.iPad) {
            list.push('AirPlay');
        }

        if (typeof video.playbackRate === 'number') {
            list.push('PlaybackRate');
        }

        list.push('SetBrightness');
        list.push('SetAspectRatio');

        return list;
    }

    supports(feature) {
        if (!this.#supportedFeatures) {
            this.#supportedFeatures = HtmlVideoPlayer.getSupportedFeatures();
        }

        return this.#supportedFeatures.includes(feature);
    }

    // Save this for when playback stops, because querying the time at that point might return 0
    currentTime(val) {
        if (val != null) {
            window.channel.objects.player.seekTo(val);
            return;
        }

        return this.#currentTime;
    }

    onDuration(duration) {
        this.#duration = duration;
    }

    duration() {
        if (this.#duration) {
            return this.#duration;
        }

        return null;
    }

    canSetAudioStreamIndex() {
        if (browser.tizen || browser.orsay) {
            return true;
        }

        const video = this.#mediaElement;
        if (video) {
            if (video.audioTracks) {
                return true;
            }
        }

        return false;
    }

    static onPictureInPictureError(err) {
        console.error(`Picture in picture error: ${err}`);
    }

    setPictureInPictureEnabled(isEnabled) {
        const video = this.#mediaElement;

        if (document.pictureInPictureEnabled) {
            if (video) {
                if (isEnabled) {
                    video.requestPictureInPicture().catch(HtmlVideoPlayer.onPictureInPictureError);
                } else {
                    document.exitPictureInPicture().catch(HtmlVideoPlayer.onPictureInPictureError);
                }
            }
        } else if (window.Windows) {
            this.isPip = isEnabled;
            if (isEnabled) {
                Windows.UI.ViewManagement.ApplicationView.getForCurrentView().tryEnterViewModeAsync(Windows.UI.ViewManagement.ApplicationViewMode.compactOverlay);
            } else {
                Windows.UI.ViewManagement.ApplicationView.getForCurrentView().tryEnterViewModeAsync(Windows.UI.ViewManagement.ApplicationViewMode.default);
            }
        } else {
            if (video && video.webkitSupportsPresentationMode && typeof video.webkitSetPresentationMode === 'function') {
                video.webkitSetPresentationMode(isEnabled ? 'picture-in-picture' : 'inline');
            }
        }
    }

    isPictureInPictureEnabled() {
        if (document.pictureInPictureEnabled) {
            return !!document.pictureInPictureElement;
        } else if (window.Windows) {
            return this.isPip || false;
        } else {
            const video = this.#mediaElement;
            if (video) {
                return video.webkitPresentationMode === 'picture-in-picture';
            }
        }

        return false;
    }

    isAirPlayEnabled() {
        if (document.AirPlayEnabled) {
            return !!document.AirplayElement;
        }

        return false;
    }

    setAirPlayEnabled(isEnabled) {
        const video = this.#mediaElement;

        if (document.AirPlayEnabled) {
            if (video) {
                if (isEnabled) {
                    video.requestAirPlay().catch(function(err) {
                        console.error('Error requesting AirPlay', err);
                    });
                } else {
                    document.exitAirPLay().catch(function(err) {
                        console.error('Error exiting AirPlay', err);
                    });
                }
            }
        } else {
            video.webkitShowPlaybackTargetPicker();
        }
    }

    setBrightness(val) {
        const elem = this.#mediaElement;

        if (elem) {
            val = Math.max(0, val);
            val = Math.min(100, val);

            let rawValue = val;
            rawValue = Math.max(20, rawValue);

            const cssValue = rawValue >= 100 ? 'none' : (rawValue / 100);
            elem.style['-webkit-filter'] = `brightness(${cssValue})`;
            elem.style.filter = `brightness(${cssValue})`;
            elem.brightnessValue = val;
            Events.trigger(this, 'brightnesschange');
        }
    }

    getBrightness() {
        const elem = this.#mediaElement;
        if (elem) {
            const val = elem.brightnessValue;
            return val == null ? 100 : val;
        }
    }

    seekable() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            const seekable = mediaElement.seekable;
            if (seekable && seekable.length) {
                let start = seekable.start(0);
                let end = seekable.end(0);

                if (!isValidDuration(start)) {
                    start = 0;
                }
                if (!isValidDuration(end)) {
                    end = 0;
                }

                return (end - start) > 0;
            }

            return false;
        }
    }

    pause() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.pause();
        }
    }

    // This is a retry after error
    resume() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.play();
        }
    }

    unpause() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.play();
        }
    }

    paused() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.paused;
        }

        return false;
    }

    setPlaybackRate(value) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.playbackRate = value;
        }
    }

    getPlaybackRate() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.playbackRate;
        }
        return null;
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

    setVolume(val) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.volume = val / 100;
        }
    }

    getVolume() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return Math.min(Math.round(mediaElement.volume * 100), 100);
        }
    }

    volumeUp() {
        this.setVolume(Math.min(this.getVolume() + 2, 100));
    }

    volumeDown() {
        this.setVolume(Math.max(this.getVolume() - 2, 0));
    }

    setMute(mute) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.muted = mute;
        }
    }

    isMuted() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.muted;
        }
        return false;
    }

    setAspectRatio(val) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            if (val === 'auto') {
                mediaElement.style.removeProperty('object-fit');
            } else {
                mediaElement.style['object-fit'] = val;
            }
        }
        this._currentAspectRatio = val;
    }

    getAspectRatio() {
        return this._currentAspectRatio || 'auto';
    }

    getSupportedAspectRatios() {
        return [{
            name: globalize.translate('Auto'),
            id: 'auto'
        }, {
            name: globalize.translate('AspectRatioCover'),
            id: 'cover'
        }, {
            name: globalize.translate('AspectRatioFill'),
            id: 'fill'
        }];
    }

    togglePictureInPicture() {
        return this.setPictureInPictureEnabled(!this.isPictureInPictureEnabled());
    }

    toggleAirPlay() {
        return this.setAirPlayEnabled(!this.isAirPlayEnabled());
    }

    getBufferedRanges() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return getBufferedRanges(this, mediaElement);
        }

        return [];
    }

    getStats() {
        const mediaElement = this.#mediaElement;
        const playOptions = this._currentPlayOptions || [];

        const categories = [];

        if (!mediaElement) {
            return Promise.resolve({
                categories: categories
            });
        }

        const mediaCategory = {
            stats: [],
            type: 'media'
        };
        categories.push(mediaCategory);

        if (playOptions.url) {
            //  create an anchor element (note: no need to append this element to the document)
            let link = document.createElement('a');
            //  set href to any path
            link.setAttribute('href', playOptions.url);
            const protocol = (link.protocol || '').replace(':', '');

            if (protocol) {
                mediaCategory.stats.push({
                    label: globalize.translate('LabelProtocol'),
                    value: protocol
                });
            }

            link = null;
        }

        if (this._hlsPlayer) {
            mediaCategory.stats.push({
                label: globalize.translate('LabelStreamType'),
                value: 'HLS'
            });
        } else {
            mediaCategory.stats.push({
                label: globalize.translate('LabelStreamType'),
                value: 'Video'
            });
        }

        const videoCategory = {
            stats: [],
            type: 'video'
        };
        categories.push(videoCategory);

        const rect = mediaElement.getBoundingClientRect ? mediaElement.getBoundingClientRect() : {};
        let height = parseInt(rect.height);
        let width = parseInt(rect.width);

        // Don't show player dimensions on smart TVs because the app UI could be lower resolution than the video and this causes users to think there is a problem
        if (width && height && !browser.tv) {
            videoCategory.stats.push({
                label: globalize.translate('LabelPlayerDimensions'),
                value: `${width}x${height}`
            });
        }

        height = mediaElement.videoHeight;
        width = mediaElement.videoWidth;

        if (width && height) {
            videoCategory.stats.push({
                label: globalize.translate('LabelVideoResolution'),
                value: `${width}x${height}`
            });
        }

        if (mediaElement.getVideoPlaybackQuality) {
            const playbackQuality = mediaElement.getVideoPlaybackQuality();

            const droppedVideoFrames = playbackQuality.droppedVideoFrames || 0;
            videoCategory.stats.push({
                label: globalize.translate('LabelDroppedFrames'),
                value: droppedVideoFrames
            });

            const corruptedVideoFrames = playbackQuality.corruptedVideoFrames || 0;
            videoCategory.stats.push({
                label: globalize.translate('LabelCorruptedFrames'),
                value: corruptedVideoFrames
            });
        }

        const audioCategory = {
            stats: [],
            type: 'audio'
        };
        categories.push(audioCategory);

        const sinkId = mediaElement.sinkId;
        if (sinkId) {
            audioCategory.stats.push({
                label: 'Sink Id:',
                value: sinkId
            });
        }

        return Promise.resolve({
            categories: categories
        });
    }
    }
/* eslint-enable indent */

export default HtmlVideoPlayer;
