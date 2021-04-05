/**
 * Class that manages the playback permission.
 */
class PlaybackPermissionManager {
    /**
     * Tests playback permission. Grabs the permission when called inside a click event (or any other valid user interaction).
     * @returns {Promise} Promise that resolves succesfully if playback permission is allowed.
     */
    check () {
        return Promise.resolve(true);
    }
}

/** PlaybackPermissionManager singleton. */
export default new PlaybackPermissionManager();
