/* global __filename, Strophe, Promise */

import ComponentsVersions from './modules/version/ComponentsVersions';
import ConnectionQuality from './modules/connectivity/ConnectionQuality';
import { getLogger } from 'jitsi-meet-logger';
import GlobalOnErrorHandler from './modules/util/GlobalOnErrorHandler';
import EventEmitter from 'events';
import * as JitsiConferenceErrors from './JitsiConferenceErrors';
import JitsiConferenceEventManager from './JitsiConferenceEventManager';
import * as JitsiConferenceEvents from './JitsiConferenceEvents';
import JitsiDTMFManager from './modules/DTMF/JitsiDTMFManager';
import JitsiParticipant from './JitsiParticipant';
import JitsiTrackError from './JitsiTrackError';
import * as JitsiTrackErrors from './JitsiTrackErrors';
import * as JitsiTrackEvents from './JitsiTrackEvents';
import * as MediaType from './service/RTC/MediaType';
import ParticipantConnectionStatus
    from './modules/connectivity/ParticipantConnectionStatus';
import RTC from './modules/RTC/RTC';
import Statistics from './modules/statistics/statistics';
import TalkMutedDetection from './modules/TalkMutedDetection';
import Transcriber from './modules/transcription/transcriber';
import VideoType from './service/RTC/VideoType';
import * as XMPPEvents from './service/xmpp/XMPPEvents';

const logger = getLogger(__filename);

/**
 * Creates a JitsiConference object with the given name and properties.
 * Note: this constructor is not a part of the public API (objects should be
 * created using JitsiConnection.createConference).
 * @param options.config properties / settings related to the conference that
 * will be created.
 * @param options.name the name of the conference
 * @param options.connection the JitsiConnection object for this
 * JitsiConference.
 * @constructor
 */
function JitsiConference(options) {
    if (!options.name || options.name.toLowerCase() !== options.name) {
        const errmsg
            = 'Invalid conference name (no conference name passed or it '
                + 'contains invalid characters like capital letters)!';

        logger.error(errmsg);
        throw new Error(errmsg);
    }
    this.eventEmitter = new EventEmitter();
    this.options = options;
    this.eventManager = new JitsiConferenceEventManager(this);
    this._init(options);
    this.componentsVersions = new ComponentsVersions(this);
    this.participants = {};

    /**
     * Jingle session instance for the JVB connection.
     * @type {JingleSessionPC}
     */
    this.jvbJingleSession = null;
    this.lastDominantSpeaker = null;
    this.dtmfManager = null;
    this.somebodySupportsDTMF = false;
    this.authEnabled = false;
    this.startAudioMuted = false;
    this.startVideoMuted = false;
    this.startMutedPolicy = {
        audio: false,
        video: false
    };
    this.availableDevices = {
        audio: undefined,
        video: undefined
    };
    this.isMutedByFocus = false;

    // Flag indicates if the 'onCallEnded' method was ever called on this
    // instance. Used to log extra analytics event for debugging purpose.
    // We need to know if the potential issue happened before or after
    // the restart.
    this.wasStopped = false;

    /**
     * The object which monitors local and remote connection statistics (e.g.
     * sending bitrate) and calculates a number which represents the connection
     * quality.
     */
    this.connectionQuality
        = new ConnectionQuality(this, this.eventEmitter, options);

    /**
     * Indicates whether the connection is interrupted or not.
     */
    this.connectionIsInterrupted = false;

}

// FIXME convert JitsiConference to ES6 - ASAP !
JitsiConference.prototype.constructor = JitsiConference;

/**
 * Initializes the conference object properties
 * @param options {object}
 * @param connection {JitsiConnection} overrides this.connection
 */
JitsiConference.prototype._init = function(options = {}) {
    // Override connection and xmpp properties (Usefull if the connection
    // reloaded)
    if (options.connection) {
        this.connection = options.connection;
        this.xmpp = this.connection.xmpp;

        // Setup XMPP events only if we have new connection object.
        this.eventManager.setupXMPPListeners();
    }

    this.room = this.xmpp.createRoom(this.options.name, this.options.config);

    // Connection interrupted/restored listeners
    this._onIceConnectionInterrupted
        = this._onIceConnectionInterrupted.bind(this);
    this.room.addListener(
        XMPPEvents.CONNECTION_INTERRUPTED, this._onIceConnectionInterrupted);

    this._onIceConnectionRestored = this._onIceConnectionRestored.bind(this);
    this.room.addListener(
        XMPPEvents.CONNECTION_RESTORED, this._onIceConnectionRestored);

    this.room.updateDeviceAvailability(RTC.getDeviceAvailability());

    if (!this.rtc) {
        this.rtc = new RTC(this, options);
        this.eventManager.setupRTCListeners();
    }

    this.participantConnectionStatus
        = new ParticipantConnectionStatus(
                this.rtc, this,
                options.config.peerDisconnectedThroughRtcTimeout);
    this.participantConnectionStatus.init();

    if (!this.statistics) {
        this.statistics = new Statistics(this.xmpp, {
            callStatsID: this.options.config.callStatsID,
            callStatsSecret: this.options.config.callStatsSecret,
            callStatsConfIDNamespace:
                this.options.config.callStatsConfIDNamespace
                    || window.location.hostname,
            callStatsCustomScriptUrl:
                this.options.config.callStatsCustomScriptUrl,
            roomName: this.options.name
        });
    }

    this.eventManager.setupChatRoomListeners();

    // Always add listeners because on reload we are executing leave and the
    // listeners are removed from statistics module.
    this.eventManager.setupStatisticsListeners();

    if (this.options.config.enableTalkWhileMuted) {
        // eslint-disable-next-line no-new
        new TalkMutedDetection(
            this,
            () =>
                this.eventEmitter.emit(JitsiConferenceEvents.TALK_WHILE_MUTED));
    }
};

/**
 * Joins the conference.
 * @param password {string} the password
 */
JitsiConference.prototype.join = function(password) {
    if (this.room) {
        this.room.join(password);
    }
};

/**
 * Check if joined to the conference.
 */
JitsiConference.prototype.isJoined = function() {
    return this.room && this.room.joined;
};

/**
 * Leaves the conference.
 * @returns {Promise}
 */
JitsiConference.prototype.leave = function() {
    if (this.participantConnectionStatus) {
        this.participantConnectionStatus.dispose();
        this.participantConnectionStatus = null;
    }

    this.getLocalTracks().forEach(track => this.onLocalTrackRemoved(track));

    this.rtc.closeAllDataChannels();
    if (this.statistics) {
        this.statistics.dispose();
    }

    // leave the conference
    if (this.room) {
        const room = this.room;

        // Unregister connection state listeners
        room.removeListener(
            XMPPEvents.CONNECTION_INTERRUPTED,
            this._onIceConnectionInterrupted);
        room.removeListener(
            XMPPEvents.CONNECTION_RESTORED,
            this._onIceConnectionRestored);

        this.room = null;

        return room.leave().catch(() => {
            // remove all participants because currently the conference won't
            // be usable anyway. This is done on success automatically by the
            // ChatRoom instance.
            this.getParticipants().forEach(
                participant => this.onMemberLeft(participant.getJid()));

            // Close the JingleSession
            if (this.jvbJingleSession) {
                this.jvbJingleSession.close();
                this.jvbJingleSession = null;
            }
        });
    }

    // If this.room == null we are calling second time leave().
    return Promise.reject(
        new Error('The conference is has been already left'));
};

/**
 * Returns name of this conference.
 */
JitsiConference.prototype.getName = function() {
    return this.options.name;
};

/**
 * Check if authentication is enabled for this conference.
 */
JitsiConference.prototype.isAuthEnabled = function() {
    return this.authEnabled;
};

/**
 * Check if user is logged in.
 */
JitsiConference.prototype.isLoggedIn = function() {
    return Boolean(this.authIdentity);
};

/**
 * Get authorized login.
 */
JitsiConference.prototype.getAuthLogin = function() {
    return this.authIdentity;
};

/**
 * Check if external authentication is enabled for this conference.
 */
JitsiConference.prototype.isExternalAuthEnabled = function() {
    return this.room && this.room.moderator.isExternalAuthEnabled();
};

/**
 * Get url for external authentication.
 * @param {boolean} [urlForPopup] if true then return url for login popup,
 *                                else url of login page.
 * @returns {Promise}
 */
JitsiConference.prototype.getExternalAuthUrl = function(urlForPopup) {
    return new Promise((resolve, reject) => {
        if (!this.isExternalAuthEnabled()) {
            reject();

            return;
        }
        if (urlForPopup) {
            this.room.moderator.getPopupLoginUrl(resolve, reject);
        } else {
            this.room.moderator.getLoginUrl(resolve, reject);
        }
    });
};

/**
 * Returns the local tracks of the given media type, or all local tracks if no
 * specific type is given.
 * @param {MediaType} [mediaType] Optional media type (audio or video).
 */
JitsiConference.prototype.getLocalTracks = function(mediaType) {
    let tracks = [];

    if (this.rtc) {
        tracks = this.rtc.getLocalTracks(mediaType);
    }

    return tracks;
};

/**
 * Obtains local audio track.
 * @return {JitsiLocalTrack|null}
 */
JitsiConference.prototype.getLocalAudioTrack = function() {
    return this.rtc ? this.rtc.getLocalAudioTrack() : null;
};

/**
 * Obtains local video track.
 * @return {JitsiLocalTrack|null}
 */
JitsiConference.prototype.getLocalVideoTrack = function() {
    return this.rtc ? this.rtc.getLocalVideoTrack() : null;
};

/**
 * Attaches a handler for events(For example - "participant joined".) in the
 * conference. All possible event are defined in JitsiConferenceEvents.
 * @param eventId the event ID.
 * @param handler handler for the event.
 *
 * Note: consider adding eventing functionality by extending an EventEmitter
 * impl, instead of rolling ourselves
 */
JitsiConference.prototype.on = function(eventId, handler) {
    if (this.eventEmitter) {
        this.eventEmitter.on(eventId, handler);
    }
};

/**
 * Removes event listener
 * @param eventId the event ID.
 * @param [handler] optional, the specific handler to unbind
 *
 * Note: consider adding eventing functionality by extending an EventEmitter
 * impl, instead of rolling ourselves
 */
JitsiConference.prototype.off = function(eventId, handler) {
    if (this.eventEmitter) {
        this.eventEmitter.removeListener(eventId, handler);
    }
};

// Common aliases for event emitter
JitsiConference.prototype.addEventListener = JitsiConference.prototype.on;
JitsiConference.prototype.removeEventListener = JitsiConference.prototype.off;

/**
 * Receives notifications from other participants about commands / custom events
 * (sent by sendCommand or sendCommandOnce methods).
 * @param command {String} the name of the command
 * @param handler {Function} handler for the command
 */
JitsiConference.prototype.addCommandListener = function(command, handler) {
    if (this.room) {
        this.room.addPresenceListener(command, handler);
    }
};

/**
  * Removes command  listener
  * @param command {String} the name of the command
  */
JitsiConference.prototype.removeCommandListener = function(command) {
    if (this.room) {
        this.room.removePresenceListener(command);
    }
};

/**
 * Sends text message to the other participants in the conference
 * @param message the text message.
 */
JitsiConference.prototype.sendTextMessage = function(message) {
    if (this.room) {
        this.room.sendMessage(message);
    }
};

/**
 * Send presence command.
 * @param name {String} the name of the command.
 * @param values {Object} with keys and values that will be sent.
 **/
JitsiConference.prototype.sendCommand = function(name, values) {
    if (this.room) {
        this.room.addToPresence(name, values);
        this.room.sendPresence();
    }
};

/**
 * Send presence command one time.
 * @param name {String} the name of the command.
 * @param values {Object} with keys and values that will be sent.
 **/
JitsiConference.prototype.sendCommandOnce = function(name, values) {
    this.sendCommand(name, values);
    this.removeCommand(name);
};

/**
 * Removes presence command.
 * @param name {String} the name of the command.
 **/
JitsiConference.prototype.removeCommand = function(name) {
    if (this.room) {
        this.room.removeFromPresence(name);
    }
};

/**
 * Sets the display name for this conference.
 * @param name the display name to set
 */
JitsiConference.prototype.setDisplayName = function(name) {
    if (this.room) {
        // remove previously set nickname
        this.room.removeFromPresence('nick');

        this.room.addToPresence('nick', {
            attributes: { xmlns: 'http://jabber.org/protocol/nick' },
            value: name
        });
        this.room.sendPresence();
    }
};

/**
 * Set new subject for this conference. (available only for moderator)
 * @param {string} subject new subject
 */
JitsiConference.prototype.setSubject = function(subject) {
    if (this.room && this.isModerator()) {
        this.room.setSubject(subject);
    }
};

/**
 * Get a transcriber object for all current participants in this conference
 * @return {Transcriber} the transcriber object
 */
JitsiConference.prototype.getTranscriber = function() {
    if (this.transcriber === undefined) {
        this.transcriber = new Transcriber();

        // add all existing local audio tracks to the transcriber
        const localAudioTracks = this.getLocalTracks(MediaType.AUDIO);

        for (const localAudio of localAudioTracks) {
            this.transcriber.addTrack(localAudio);
        }

        // and all remote audio tracks
        const remoteAudioTracks = this.rtc.getRemoteTracks(MediaType.AUDIO);

        for (const remoteTrack of remoteAudioTracks) {
            this.transcriber.addTrack(remoteTrack);
        }
    }

    return this.transcriber;
};

/**
 * Adds JitsiLocalTrack object to the conference.
 * @param track the JitsiLocalTrack object.
 * @returns {Promise<JitsiLocalTrack>}
 * @throws {Error} if the specified track is a video track and there is already
 * another video track in the conference.
 */
JitsiConference.prototype.addTrack = function(track) {
    if (track.isVideoTrack()) {
        // Ensure there's exactly 1 local video track in the conference.
        const localVideoTrack = this.rtc.getLocalVideoTrack();

        if (localVideoTrack) {
            // Don't be excessively harsh and severe if the API client happens
            // to attempt to add the same local video track twice.
            if (track === localVideoTrack) {
                return Promise.resolve(track);
            }

            return Promise.reject(new Error(
                    'cannot add second video track to the conference'));

        }
    }

    return this.replaceTrack(null, track);
};

/**
 * Fires TRACK_AUDIO_LEVEL_CHANGED change conference event.
 * @param audioLevel the audio level
 */
JitsiConference.prototype._fireAudioLevelChangeEvent = function(audioLevel) {
    this.eventEmitter.emit(
        JitsiConferenceEvents.TRACK_AUDIO_LEVEL_CHANGED,
        this.myUserId(), audioLevel);
};

/**
 * Fires TRACK_MUTE_CHANGED change conference event.
 * @param track the JitsiTrack object related to the event.
 */
JitsiConference.prototype._fireMuteChangeEvent = function(track) {
    // check if track was muted by focus and now is unmuted by user
    if (this.isMutedByFocus && track.isAudioTrack() && !track.isMuted()) {
        this.isMutedByFocus = false;

        // unmute local user on server
        this.room.muteParticipant(this.room.myroomjid, false);
    }
    this.eventEmitter.emit(JitsiConferenceEvents.TRACK_MUTE_CHANGED, track);
};

/**
 * Clear JitsiLocalTrack properties and listeners.
 * @param track the JitsiLocalTrack object.
 */
JitsiConference.prototype.onLocalTrackRemoved = function(track) {
    track._setConference(null);
    this.rtc.removeLocalTrack(track);
    track.removeEventListener(JitsiTrackEvents.TRACK_MUTE_CHANGED,
        track.muteHandler);
    track.removeEventListener(JitsiTrackEvents.TRACK_AUDIO_LEVEL_CHANGED,
        track.audioLevelHandler);

    // send event for stopping screen sharing
    // FIXME: we assume we have only one screen sharing track
    // if we change this we need to fix this check
    if (track.isVideoTrack() && track.videoType === VideoType.DESKTOP) {
        this.statistics.sendScreenSharingEvent(false);
    }

    this.eventEmitter.emit(JitsiConferenceEvents.TRACK_REMOVED, track);
};

/**
 * Removes JitsiLocalTrack from the conference and performs
 * a new offer/answer cycle.
 * @param {JitsiLocalTrack} track
 * @returns {Promise}
 */
JitsiConference.prototype.removeTrack = function(track) {
    return this.replaceTrack(track, null);
};

/**
 * Replaces oldTrack with newTrack and performs a single offer/answer
 *  cycle after both operations are done.  Either oldTrack or newTrack
 *  can be null; replacing a valid 'oldTrack' with a null 'newTrack'
 *  effectively just removes 'oldTrack'
 * @param {JitsiLocalTrack} oldTrack the current stream in use to be replaced
 * @param {JitsiLocalTrack} newTrack the new stream to use
 * @returns {Promise} resolves when the replacement is finished
 */
JitsiConference.prototype.replaceTrack = function(oldTrack, newTrack) {
    // First do the removal of the oldTrack at the JitsiConference level
    if (oldTrack) {
        if (oldTrack.disposed) {
            return Promise.reject(
                new JitsiTrackError(JitsiTrackErrors.TRACK_IS_DISPOSED));
        }
    }
    if (newTrack) {
        if (newTrack.disposed) {
            return Promise.reject(
                new JitsiTrackError(JitsiTrackErrors.TRACK_IS_DISPOSED));
        }
    }

    // Now replace the stream at the lower levels
    return this._doReplaceTrack(oldTrack, newTrack)
        .then(() => {
            if (oldTrack) {
                this.onLocalTrackRemoved(oldTrack);
            }
            if (newTrack) {
                // Now handle the addition of the newTrack at the
                // JitsiConference level
                this._setupNewTrack(newTrack);
            }

            return Promise.resolve();
        }, error => Promise.reject(new Error(error)));
};

/**
 * Replaces the tracks at the lower level by going through the Jingle session
 * and WebRTC peer connection. The method will resolve immediately if there is
 * currently no JingleSession started.
 * @param {JitsiLocalTrack|null} oldTrack the track to be removed during
 * the process or <tt>null</t> if the method should act as "add track"
 * @param {JitsiLocalTrack|null} newTrack the new track to be added or
 * <tt>null</tt> if the method should act as "remove track"
 * @return {Promise} resolved when the process is done or rejected with a string
 * which describes the error.
 * @private
 */
JitsiConference.prototype._doReplaceTrack = function(oldTrack, newTrack) {
    if (this.jvbJingleSession) {
        return this.jvbJingleSession.replaceTrack(oldTrack, newTrack);
    }
    logger.info('_doReplaceTrack - no JVB JingleSession');

    return Promise.resolve();
};

/**
 * Operations related to creating a new track
 * @param {JitsiLocalTrack} newTrack the new track being created
 */
JitsiConference.prototype._setupNewTrack = function(newTrack) {
    if (newTrack.isAudioTrack() || (newTrack.isVideoTrack()
            && newTrack.videoType !== VideoType.DESKTOP)) {
        // Report active device to statistics
        const devices = RTC.getCurrentlyAvailableMediaDevices();
        const device
            = devices.find(
                d =>
                    d.kind === `${newTrack.getTrack().kind}input`
                        && d.label === newTrack.getTrack().label);

        if (device) {
            Statistics.sendActiveDeviceListEvent(
                RTC.getEventDataForActiveDevice(device));
        }
    }
    if (newTrack.isVideoTrack()) {
        this.removeCommand('videoType');
        this.sendCommand('videoType', {
            value: newTrack.videoType,
            attributes: {
                xmlns: 'http://jitsi.org/jitmeet/video'
            }
        });
    }
    this.rtc.addLocalTrack(newTrack);

    if (newTrack.startMuted) {
        newTrack.mute();
    }

    // ensure that we're sharing proper "is muted" state
    if (newTrack.isAudioTrack()) {
        this.room.setAudioMute(newTrack.isMuted());
    } else {
        this.room.setVideoMute(newTrack.isMuted());
    }

    newTrack.muteHandler = this._fireMuteChangeEvent.bind(this, newTrack);
    newTrack.audioLevelHandler = this._fireAudioLevelChangeEvent.bind(this);
    newTrack.addEventListener(JitsiTrackEvents.TRACK_MUTE_CHANGED,
                           newTrack.muteHandler);
    newTrack.addEventListener(JitsiTrackEvents.TRACK_AUDIO_LEVEL_CHANGED,
                           newTrack.audioLevelHandler);

    newTrack._setConference(this);

    // send event for starting screen sharing
    // FIXME: we assume we have only one screen sharing track
    // if we change this we need to fix this check
    if (newTrack.isVideoTrack() && newTrack.videoType === VideoType.DESKTOP) {
        this.statistics.sendScreenSharingEvent(true);
    }

    this.eventEmitter.emit(JitsiConferenceEvents.TRACK_ADDED, newTrack);
};

/* eslint-disable max-params */

/**
 * Add track stream.
 * @param {JitsiLocalTrack} track the local track that will be added as part of
 * the unmute operation.
 * @return {Promise} resolved when the process is done or rejected with a string
 * which describes the error.
 */
JitsiConference.prototype._addLocalTrackAsUnmute = function(track) {
    if (this.jvbJingleSession) {
        return this.jvbJingleSession.addTrackAsUnmute(track);
    }

    // We are done immediately
    logger.warn(
        'Add local MediaStream as unmute - no JingleSession started yet');

    return Promise.resolve();
};

/**
 * Removes given local track, as part of the mute operation.
 * @param {JitsiLocalTrack} track the local track that will be removed.
 * @return {Promise}
 */
JitsiConference.prototype._removeTrackAsMute = function(track) {
    if (this.jvbJingleSession) {
        return this.jvbJingleSession.removeTrackAsMute(track);
    }

    // We are done immediately
    logger.warn(
        'Remove local MediaStream - no JVBJingleSession started yet');

    return Promise.resolve();
};

/* eslint-enable max-params */

/**
 * Get role of the local user.
 * @returns {string} user role: 'moderator' or 'none'
 */
JitsiConference.prototype.getRole = function() {
    return this.room.role;
};

/**
 * Check if local user is moderator.
 * @returns {boolean|null} true if local user is moderator, false otherwise. If
 * we're no longer in the conference room then <tt>null</tt> is returned.
 */
JitsiConference.prototype.isModerator = function() {
    return this.room ? this.room.isModerator() : null;
};

/**
 * Set password for the room.
 * @param {string} password new password for the room.
 * @returns {Promise}
 */
JitsiConference.prototype.lock = function(password) {
    if (!this.isModerator()) {
        return Promise.reject();
    }

    return new Promise((resolve, reject) => {
        this.room.lockRoom(
            password || '',
            () => resolve(),
            err => reject(err),
            () => reject(JitsiConferenceErrors.PASSWORD_NOT_SUPPORTED));
    });
};

/**
 * Remove password from the room.
 * @returns {Promise}
 */
JitsiConference.prototype.unlock = function() {
    return this.lock();
};

/**
 * Elects the participant with the given id to be the selected participant in
 * order to receive higher video quality (if simulcast is enabled).
 * Or cache it if channel is not created and send it once channel is available.
 * @param participantId the identifier of the participant
 * @throws NetworkError or InvalidStateError or Error if the operation fails.
 */
JitsiConference.prototype.selectParticipant = function(participantId) {
    this.rtc.selectEndpoint(participantId);
};

/**
 * Elects the participant with the given id to be the pinned participant in
 * order to always receive video for this participant (even when last n is
 * enabled).
 * @param participantId the identifier of the participant
 * @throws NetworkError or InvalidStateError or Error if the operation fails.
 */
JitsiConference.prototype.pinParticipant = function(participantId) {
    this.rtc.pinEndpoint(participantId);
};

/**
 * Selects a new value for "lastN". The requested amount of videos are going
 * to be delivered after the value is in effect. Set to -1 for unlimited or
 * all available videos.
 * @param lastN the new number of videos the user would like to receive.
 * @throws Error or RangeError if the given value is not a number or is smaller
 * than -1.
 */
JitsiConference.prototype.setLastN = function(lastN) {
    if (!Number.isInteger(lastN) && !Number.parseInt(lastN, 10)) {
        throw new Error(`Invalid value for lastN: ${lastN}`);
    }
    const n = Number(lastN);

    if (n < -1) {
        throw new RangeError('lastN cannot be smaller than -1');
    }
    this.rtc.setLastN(n);
};

/**
 * @return Array<JitsiParticipant> an array of all participants in this
 * conference.
 */
JitsiConference.prototype.getParticipants = function() {
    return Object.keys(this.participants).map(function(key) {
        return this.participants[key];
    }, this);
};

/**
 * Returns the number of participants in the conference, including the local
 * participant.
 * @param countHidden {boolean} Whether or not to include hidden participants
 * in the count. Default: false.
 **/
JitsiConference.prototype.getParticipantCount
    = function(countHidden = false) {

        let participants = this.getParticipants();

        if (!countHidden) {
            participants = participants.filter(p => !p.isHidden());
        }

        // Add one for the local participant.
        return participants.length + 1;
    };

/**
 * @returns {JitsiParticipant} the participant in this conference with the
 * specified id (or undefined if there isn't one).
 * @param id the id of the participant.
 */
JitsiConference.prototype.getParticipantById = function(id) {
    return this.participants[id];
};

/**
 * Kick participant from this conference.
 * @param {string} id id of the participant to kick
 */
JitsiConference.prototype.kickParticipant = function(id) {
    const participant = this.getParticipantById(id);

    if (!participant) {
        return;
    }
    this.room.kick(participant.getJid());
};

/**
 * Mutes a participant.
 * @param {string} id The id of the participant to mute.
 */
JitsiConference.prototype.muteParticipant = function(id) {
    const participant = this.getParticipantById(id);

    if (!participant) {
        return;
    }
    this.room.muteParticipant(participant.getJid(), true);
};

/* eslint-disable max-params */

/**
 * Notifies this JitsiConference that a new member has joined its chat room.
 *
 * FIXME This should NOT be exposed!
 *
 * @param jid the jid of the participant in the MUC
 * @param nick the display name of the participant
 * @param role the role of the participant in the MUC
 * @param isHidden indicates if this is a hidden participant (system
 * participant for example a recorder).
 */
JitsiConference.prototype.onMemberJoined = function(jid, nick, role, isHidden) {
    const id = Strophe.getResourceFromJid(jid);

    if (id === 'focus' || this.myUserId() === id) {
        return;
    }
    const participant = new JitsiParticipant(jid, this, nick, isHidden);

    participant._role = role;
    this.participants[id] = participant;
    this.eventEmitter.emit(
        JitsiConferenceEvents.USER_JOINED,
        id,
        participant);
    this.xmpp.caps.getFeatures(jid)
        .then(features => {
            participant._supportsDTMF = features.has('urn:xmpp:jingle:dtmf:0');
            this.updateDTMFSupport();
        },
        error => logger.error(error));
};

/* eslint-enable max-params */

JitsiConference.prototype.onMemberLeft = function(jid) {
    const id = Strophe.getResourceFromJid(jid);

    if (id === 'focus' || this.myUserId() === id) {
        return;
    }
    const participant = this.participants[id];

    delete this.participants[id];

    const removedTracks = this.rtc.removeRemoteTracks(id);

    removedTracks.forEach(
        track =>
            this.eventEmitter.emit(JitsiConferenceEvents.TRACK_REMOVED, track));

    // there can be no participant in case the member that left is focus
    if (participant) {
        this.eventEmitter.emit(
            JitsiConferenceEvents.USER_LEFT, id, participant);
    }
};

/**
 * Method called on local MUC role change.
 * @param {string} role the name of new user's role as defined by XMPP MUC.
 */
JitsiConference.prototype.onLocalRoleChanged = function(role) {
    // Emit role changed for local  JID
    this.eventEmitter.emit(
        JitsiConferenceEvents.USER_ROLE_CHANGED, this.myUserId(), role);
};

JitsiConference.prototype.onUserRoleChanged = function(jid, role) {
    const id = Strophe.getResourceFromJid(jid);
    const participant = this.getParticipantById(id);

    if (!participant) {
        return;
    }
    participant._role = role;
    this.eventEmitter.emit(JitsiConferenceEvents.USER_ROLE_CHANGED, id, role);
};

JitsiConference.prototype.onDisplayNameChanged = function(jid, displayName) {
    const id = Strophe.getResourceFromJid(jid);
    const participant = this.getParticipantById(id);

    if (!participant) {
        return;
    }

    if (participant._displayName === displayName) {
        return;
    }

    participant._displayName = displayName;
    this.eventEmitter.emit(
        JitsiConferenceEvents.DISPLAY_NAME_CHANGED,
        id,
        displayName);
};

/**
 * Notifies this JitsiConference that a JitsiRemoteTrack was added into
 * the conference.
 *
 * @param {JitsiRemoteTrack} track the JitsiRemoteTrack which was added to this
 * JitsiConference
 */
JitsiConference.prototype.onRemoteTrackAdded = function(track) {
    const id = track.getParticipantId();
    const participant = this.getParticipantById(id);

    if (!participant) {
        logger.error(`No participant found for id: ${id}`);

        return;
    }

    // Add track to JitsiParticipant.
    participant._tracks.push(track);

    if (this.transcriber) {
        this.transcriber.addTrack(track);
    }

    const emitter = this.eventEmitter;

    track.addEventListener(
        JitsiTrackEvents.TRACK_MUTE_CHANGED,
        () => emitter.emit(JitsiConferenceEvents.TRACK_MUTE_CHANGED, track));
    track.addEventListener(
        JitsiTrackEvents.TRACK_AUDIO_LEVEL_CHANGED,
        audioLevel => {
            emitter.emit(
                JitsiConferenceEvents.TRACK_AUDIO_LEVEL_CHANGED,
                id,
                audioLevel);
        }
    );

    emitter.emit(JitsiConferenceEvents.TRACK_ADDED, track);
};

/**
 * Callback called by the Jingle plugin when 'session-answer' is received.
 * @param {JingleSessionPC} session the Jingle session for which an answer was
 * received.
 * @param {jQuery} answer a jQuery selector pointing to 'jingle' IQ element
 */
// eslint-disable-next-line no-unused-vars
JitsiConference.prototype.onCallAccepted = function(session, answer) {
    // JVB conference does not care
    logger.error('onAcceptedCall - not implemented in JVB conference');
};

/**
 * Callback called by the Jingle plugin when 'transport-info' is received.
 * @param {JingleSessionPC} session the Jingle session for which the IQ was
 * received
 * @param {jQuery} transportInfo a jQuery selector pointing to 'jingle' IQ
 * element
 */
// eslint-disable-next-line no-unused-vars
JitsiConference.prototype.onTransportInfo = function(session, transportInfo) {
    // NOTE right now all transport is received from the bridge in the initial
    // 'session-initiate' IQ. Only P2P implementation cares about this IQs.
    logger.error('onTransportInfo - not implemented in JVB conference');
};

/**
 * Notifies this JitsiConference that a JitsiRemoteTrack was removed from
 * the conference.
 *
 * @param {JitsiRemoteTrack} removedTrack
 */
JitsiConference.prototype.onRemoteTrackRemoved = function(removedTrack) {
    let consumed = false;

    this.getParticipants().forEach(participant => {
        const tracks = participant.getTracks();

        for (let i = 0; i < tracks.length; i++) {
            if (tracks[i] === removedTrack) {
                // Since the tracks have been compared and are
                // considered equal the result of splice can be ignored.
                participant._tracks.splice(i, 1);

                this.eventEmitter.emit(
                    JitsiConferenceEvents.TRACK_REMOVED, removedTrack);

                if (this.transcriber) {
                    this.transcriber.removeTrack(removedTrack);
                }

                consumed = true;

                break;
            }
        }
    }, this);

    if (!consumed) {
        // FIXME Technically 'p2pEstablished' field does not exist in plain
        // JitsiConference, but moving to subclass is hard and it's only a log
        // message which could potentially be removed once things get more
        // stable.
        if ((this.p2pEstablished && !removedTrack.isP2P)
             || (!this.p2pEstablished && removedTrack.isP2P)) {
            // This track has been removed explicitly by P2PEnabledConference
            return;
        }
        logger.error(
            'Failed to match remote track on remove'
                + ' with any of the participants',
            removedTrack.getStreamId(),
            removedTrack.getParticipantId());
    }
};

/**
 * Handles incoming call event.
 */
JitsiConference.prototype.onIncomingCall
= function(jingleSession, jingleOffer, now) {
    if (!this.room.isFocus(jingleSession.peerjid)) {
        this._rejectIncomingCall(jingleSession);

        return;
    }

    // Accept incoming call
    this.jvbJingleSession = jingleSession;
    this.room.connectionTimes['session.initiate'] = now;

    // Log "session.restart"
    if (this.wasStopped) {
        Statistics.sendEventToAll('session.restart');
    }

    // add info whether call is cross-region
    let crossRegion = null;

    if (window.jitsiRegionInfo) {
        crossRegion = window.jitsiRegionInfo.CrossRegion;
    }
    Statistics.analytics.sendEvent(
        'session.initiate', {
            value: now - this.room.connectionTimes['muc.joined'],
            label: crossRegion
        });
    try {
        jingleSession.initialize(false /* initiator */, this.room, this.rtc);
    } catch (error) {
        GlobalOnErrorHandler.callErrorHandler(error);
    }

    this.rtc.initializeDataChannels(jingleSession.peerconnection);

    // Add local tracks to the session
    try {
        jingleSession.addLocalTracks(this.getLocalTracks()).then(() => {
            jingleSession.acceptOffer(jingleOffer, null,
                error => {
                    GlobalOnErrorHandler.callErrorHandler(error);
                    logger.error(
                        'Failed to accept incoming Jingle session', error);
                }
            );

            // Start callstats as soon as peerconnection is initialized,
            // do not wait for XMPPEvents.PEERCONNECTION_READY, as it may never
            // happen in case if user doesn't have or denied permission to
            // both camera and microphone.
            this.statistics.startCallStats(jingleSession);
            this._startRemoteStats();
        });
    } catch (e) {
        GlobalOnErrorHandler.callErrorHandler(e);
        logger.error(e);
    }
};

/**
 * Rejects incoming Jingle call with 'security-error'. Method should be used to
 * reject calls initiated by unauthorised entities.
 * @param {JingleSessionPC} jingleSession the session instance to be rejected.
 * @private
 */
JitsiConference.prototype._rejectIncomingCallNonModerator
= function(jingleSession) {
    this._rejectIncomingCall(
        jingleSession,
        {
            reasonTag: 'security-error',
            reasonMsg: 'Only focus can start new sessions',
            errorMsg: 'Rejecting session-initiate from non-focus and'
                        + `non-moderator user: ${jingleSession.peerjid}`
        });
};

/**
 * Rejects incoming Jingle call.
 * @param {JingleSessionPC} jingleSession the session instance to be rejected.
 * @param {object} [options]
 * @param {string} options.reasonTag the name of the reason element as defined
 * by Jingle
 * @param {string} options.reasonMsg the reason description which will
 * be included in Jingle 'session-terminate' message.
 * @param {string} options.errorMsg an error message to be logged on global
 * error handler
 * @private
 */
JitsiConference.prototype._rejectIncomingCall
= function(jingleSession, options) {
    if (options && options.errorMsg) {
        GlobalOnErrorHandler.callErrorHandler(new Error(options.errorMsg));
    }

    // Terminate  the jingle session with a reason
    jingleSession.terminate(
        options && options.reasonTag,
        options && options.reasonMsg,
        null /* success callback => we don't care */,
        error => {
            logger.warn(
                'An error occurred while trying to terminate'
                    + ' invalid Jingle session', error);
        });
};

/**
 * Method called to start remote stats for the current peer connection (if
 * available).
 * @private
 */
JitsiConference.prototype._startRemoteStats = function() {
    const activePeerConnection = this.getActivePeerConnection();

    if (activePeerConnection) {
        this.statistics.startRemoteStats(activePeerConnection);
    }
};

/**
 * Tells if the P2P connection is up and running.
 * @return {boolean} <tt>true</tt> if this conference is currently using direct
 * peer to peer connection or <tt>false</tt> if the JVB one is in use.
 */
JitsiConference.prototype.isP2PEstablished = function() {
    return false;
};

/**
 * Handles the call ended event.
 * @param {JingleSessionPC} jingleSession the jingle session which has been
 * terminated.
 * @param {String} reasonCondition the Jingle reason condition.
 * @param {String|null} reasonText human readable reason text which may provide
 * more details about why the call has been terminated.
 */
JitsiConference.prototype.onCallEnded
= function(jingleSession, reasonCondition, reasonText) {
    if (jingleSession !== this.jingleSession) {
        logger.error(
            'Received onCallEnded for invalid session',
            reasonCondition,
            reasonText);

        return;
    }
    logger.info(`JVB call ended: ${reasonCondition} - ${reasonText}`);
    this.wasStopped = true;

    // Send session.terminate event
    Statistics.sendEventToAll('session.terminate');

    // Stop the stats
    if (this.statistics) {
        this.statistics.stopRemoteStats();
        this.statistics.stopCallStats();
    }

    // Current JVB JingleSession is no longer valid, so set it to null
    this.jvbJingleSession = null;

    // Let the RTC service do any cleanups
    this.rtc.onCallEnded();
};

/**
 * Handles the suspend detected event. Leaves the room and fires suspended.
 */
JitsiConference.prototype.onSuspendDetected = function() {
    this.leave();
    this.eventEmitter.emit(JitsiConferenceEvents.SUSPEND_DETECTED);
};

JitsiConference.prototype.updateDTMFSupport = function() {
    let somebodySupportsDTMF = false;
    const participants = this.getParticipants();

    // check if at least 1 participant supports DTMF
    for (let i = 0; i < participants.length; i += 1) {
        if (participants[i].supportsDTMF()) {
            somebodySupportsDTMF = true;
            break;
        }
    }
    if (somebodySupportsDTMF !== this.somebodySupportsDTMF) {
        this.somebodySupportsDTMF = somebodySupportsDTMF;
        this.eventEmitter.emit(
            JitsiConferenceEvents.DTMF_SUPPORT_CHANGED,
            somebodySupportsDTMF);
    }
};

/**
 * Allows to check if there is at least one user in the conference
 * that supports DTMF.
 * @returns {boolean} true if somebody supports DTMF, false otherwise
 */
JitsiConference.prototype.isDTMFSupported = function() {
    return this.somebodySupportsDTMF;
};

/**
 * Returns the local user's ID
 * @return {string} local user's ID
 */
JitsiConference.prototype.myUserId = function() {
    return (
        this.room
            && this.room.myroomjid
                ? Strophe.getResourceFromJid(this.room.myroomjid)
                : null);
};

JitsiConference.prototype.sendTones = function(tones, duration, pause) {
    if (!this.dtmfManager) {
        const peerConnection = this.getActivePeerConnection();

        if (!peerConnection) {
            logger.warn('cannot sendTones: no peer connection');

            return;
        }

        const localAudio = this.getLocalAudioTrack();

        if (!localAudio) {
            logger.warn('cannot sendTones: no local audio stream');

            return;
        }
        this.dtmfManager = new JitsiDTMFManager(localAudio, peerConnection);
    }

    this.dtmfManager.sendTones(tones, duration, pause);
};

/**
 * Returns true if recording is supported and false if not.
 */
JitsiConference.prototype.isRecordingSupported = function() {
    if (this.room) {
        return this.room.isRecordingSupported();
    }

    return false;
};

/**
 * Returns null if the recording is not supported, "on" if the recording started
 * and "off" if the recording is not started.
 */
JitsiConference.prototype.getRecordingState = function() {
    return this.room ? this.room.getRecordingState() : undefined;
};

/**
 * Returns the url of the recorded video.
 */
JitsiConference.prototype.getRecordingURL = function() {
    return this.room ? this.room.getRecordingURL() : null;
};

/**
 * Starts/stops the recording
 */
JitsiConference.prototype.toggleRecording = function(options) {
    if (this.room) {
        return this.room.toggleRecording(options, (status, error) => {
            this.eventEmitter.emit(
                JitsiConferenceEvents.RECORDER_STATE_CHANGED, status, error);
        });
    }
    this.eventEmitter.emit(
        JitsiConferenceEvents.RECORDER_STATE_CHANGED, 'error',
        new Error('The conference is not created yet!'));
};

/**
 * Returns true if the SIP calls are supported and false otherwise
 */
JitsiConference.prototype.isSIPCallingSupported = function() {
    if (this.room) {
        return this.room.isSIPCallingSupported();
    }

    return false;
};

/**
 * Dials a number.
 * @param number the number
 */
JitsiConference.prototype.dial = function(number) {
    if (this.room) {
        return this.room.dial(number);
    }

    return new Promise((resolve, reject) => {
        reject(new Error('The conference is not created yet!'));
    });
};

/**
 * Hangup an existing call
 */
JitsiConference.prototype.hangup = function() {
    if (this.room) {
        return this.room.hangup();
    }

    return new Promise((resolve, reject) => {
        reject(new Error('The conference is not created yet!'));
    });
};

/**
 * Returns the phone number for joining the conference.
 */
JitsiConference.prototype.getPhoneNumber = function() {
    if (this.room) {
        return this.room.getPhoneNumber();
    }

    return null;
};

/**
 * Returns the pin for joining the conference with phone.
 */
JitsiConference.prototype.getPhonePin = function() {
    if (this.room) {
        return this.room.getPhonePin();
    }

    return null;
};

/**
 * Obtains currently active <tt>TraceablePeerConnection</tt> (if any).
 * @return {TraceablePeerConnection|null}
 * @protected
 */
JitsiConference.prototype.getActivePeerConnection = function() {
    return this.jvbJingleSession
        ? this.jvbJingleSession.peerconnection : null;
};

/**
 * Returns the connection state for the current room. Its ice connection state
 * for its session.
 * NOTE that "completed" ICE state which can appear on the P2P connection will
 * be converted to "connected".
 * @return {string|null} ICE state name or <tt>null</tt> if there is no active
 * peer connection at this time.
 */
JitsiConference.prototype.getConnectionState = function() {
    const peerConnection = this.getActivePeerConnection();

    return peerConnection ? peerConnection.getConnectionState() : null;
};

/**
 * Make all new participants mute their audio/video on join.
 * @param policy {Object} object with 2 boolean properties for video and audio:
 * @param {boolean} audio if audio should be muted.
 * @param {boolean} video if video should be muted.
 */
JitsiConference.prototype.setStartMutedPolicy = function(policy) {
    if (!this.isModerator()) {
        return;
    }
    this.startMutedPolicy = policy;
    this.room.removeFromPresence('startmuted');
    this.room.addToPresence('startmuted', {
        attributes: {
            audio: policy.audio,
            video: policy.video,
            xmlns: 'http://jitsi.org/jitmeet/start-muted'
        }
    });
    this.room.sendPresence();
};

/**
 * Returns current start muted policy
 * @returns {Object} with 2 properties - audio and video.
 */
JitsiConference.prototype.getStartMutedPolicy = function() {
    return this.startMutedPolicy;
};

/**
 * Check if audio is muted on join.
 */
JitsiConference.prototype.isStartAudioMuted = function() {
    return this.startAudioMuted;
};

/**
 * Check if video is muted on join.
 */
JitsiConference.prototype.isStartVideoMuted = function() {
    return this.startVideoMuted;
};

/**
 * Get object with internal logs.
 */
JitsiConference.prototype.getLogs = function() {
    const data = this.xmpp.getJingleLog();

    const metadata = {};

    metadata.time = new Date();
    metadata.url = window.location.href;
    metadata.ua = navigator.userAgent;

    const log = this.xmpp.getXmppLog();

    if (log) {
        metadata.xmpp = log;
    }

    data.metadata = metadata;

    return data;
};

/**
 * Returns measured connectionTimes.
 */
JitsiConference.prototype.getConnectionTimes = function() {
    return this.room.connectionTimes;
};

/**
 * Sets a property for the local participant.
 */
JitsiConference.prototype.setLocalParticipantProperty = function(name, value) {
    this.sendCommand(`jitsi_participant_${name}`, { value });
};

/**
 * Sends the given feedback through CallStats if enabled.
 *
 * @param overallFeedback an integer between 1 and 5 indicating the
 * user feedback
 * @param detailedFeedback detailed feedback from the user. Not yet used
 */
JitsiConference.prototype.sendFeedback
= function(overallFeedback, detailedFeedback) {
    this.statistics.sendFeedback(overallFeedback, detailedFeedback);
};

/**
 * Returns true if the callstats integration is enabled, otherwise returns
 * false.
 *
 * @returns true if the callstats integration is enabled, otherwise returns
 * false.
 */
JitsiConference.prototype.isCallstatsEnabled = function() {
    return this.statistics.isCallstatsEnabled();
};


/**
 * Handles track attached to container (Calls associateStreamWithVideoTag method
 * from statistics module)
 * @param {JitsiLocalTrack|JitsiRemoteTrack} track the track
 * @param container the container
 */
JitsiConference.prototype._onTrackAttach = function(track, container) {
    const isLocal = track.isLocal();
    let ssrc = null;

    if (isLocal) {
        // Local tracks have SSRC stored on per peer connection basis
        const peerConnection
            = this.jvbJingleSession && this.jvbJingleSession.peerconnection;

        if (peerConnection) {
            ssrc = peerConnection.getLocalSSRC(track);
        }
    } else {
        ssrc = track.getSSRC();
    }
    if (!container.id || !ssrc) {
        return;
    }
    this.statistics.associateStreamWithVideoTag(
        ssrc, isLocal, track.getUsageLabel(), container.id);
};

/**
 * Logs an "application log" message.
 * @param message {string} The message to log. Note that while this can be a
 * generic string, the convention used by lib-jitsi-meet and jitsi-meet is to
 * log valid JSON strings, with an "id" field used for distinguishing between
 * message types. E.g.: {id: "recorder_status", status: "off"}
 */
JitsiConference.prototype.sendApplicationLog = function(message) {
    Statistics.sendLog(message);
};

/**
 * Checks if the user identified by given <tt>mucJid</tt> is the conference
 * focus.
 * @param mucJid the full MUC address of the user to be checked.
 * @returns {boolean|null} <tt>true</tt> if MUC user is the conference focus,
 * <tt>false</tt> when is not. <tt>null</tt> if we're not in the MUC anymore and
 * are unable to figure out the status or if given <tt>mucJid</tt> is invalid.
 */
JitsiConference.prototype._isFocus = function(mucJid) {
    return this.room ? this.room.isFocus(mucJid) : null;
};

/**
 * Fires CONFERENCE_FAILED event with INCOMPATIBLE_SERVER_VERSIONS parameter
 */
JitsiConference.prototype._fireIncompatibleVersionsEvent = function() {
    this.eventEmitter.emit(JitsiConferenceEvents.CONFERENCE_FAILED,
        JitsiConferenceErrors.INCOMPATIBLE_SERVER_VERSIONS);
};

/**
 * Sends a message via the data channel.
 * @param to {string} the id of the endpoint that should receive the message.
 * If "" the message will be sent to all participants.
 * @param payload {object} the payload of the message.
 * @throws NetworkError or InvalidStateError or Error if the operation fails.
 */
JitsiConference.prototype.sendEndpointMessage = function(to, payload) {
    this.rtc.sendDataChannelMessage(to, payload);
};

/**
 * Sends a broadcast message via the data channel.
 * @param payload {object} the payload of the message.
 * @throws NetworkError or InvalidStateError or Error if the operation fails.
 */
JitsiConference.prototype.broadcastEndpointMessage = function(payload) {
    this.sendEndpointMessage('', payload);
};

JitsiConference.prototype.isConnectionInterrupted = function() {
    return this.connectionIsInterrupted;
};

/**
 * Handles {@link XMPPEvents.CONNECTION_INTERRUPTED}
 * @private
 */
JitsiConference.prototype._onIceConnectionInterrupted = function() {
    this.connectionIsInterrupted = true;
    this.eventEmitter.emit(JitsiConferenceEvents.CONNECTION_INTERRUPTED);
};

/**
 * Handles {@link XMPPEvents.CONNECTION_RESTORED}
 * @private
 */
JitsiConference.prototype._onIceConnectionRestored = function() {
    this.connectionIsInterrupted = false;
    this.eventEmitter.emit(JitsiConferenceEvents.CONNECTION_RESTORED);
};

module.exports = JitsiConference;
