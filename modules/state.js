// The whole of what QuickTS knows, as one immutable snapshot.
//
// Every apply* function takes a state and returns a new one; none of them
// mutates. Subscribers are handed a whole snapshot plus a list of what moved,
// so there is no per-property notification order to get wrong — which is the
// second thing modules/model.js exists to make impossible.
//
// This file imports only other pure modules.

import { REASON } from './errors.js';
import { exitNodeOf, normalisePeers, sortNodes } from './peers.js';

/** BackendState strings, from ipn/backend.go's stateStrings. */
export const BACKEND = Object.freeze({
    NO_STATE: 'NoState',
    IN_USE_OTHER_USER: 'InUseOtherUser',
    NEEDS_LOGIN: 'NeedsLogin',
    NEEDS_MACHINE_AUTH: 'NeedsMachineAuth',
    STOPPED: 'Stopped',
    STARTING: 'Starting',
    RUNNING: 'Running',
});

/** The empty state, before anything has been read. */
export function initialState() {
    return Object.freeze({
        // Whether the last request to the daemon succeeded, and why not.
        reachable: false,
        errorReason: '',

        // From /status.
        backendState: BACKEND.NO_STATE,
        authUrl: '',
        health: [],
        magicDNSSuffix: '',
        tailnetName: '',
        selfName: '',
        selfIps: [],

        // From /prefs.
        running: false,
        acceptRoutes: false,
        acceptDNS: false,
        allowLanAccess: false,
        shieldsUp: false,
        ssh: false,
        exitNodeId: '',

        // The routes this machine offers. Being an exit node is the presence
        // of both default routes in here, not a preference of its own — see
        // modules/routes.js.
        advertiseRoutes: [],

        // Derived from exitNodeId and nodes. Never assigned directly; see
        // derive(). Typed as a string throughout — upstream declares this a
        // string GObject property and then assigns null to it.
        exitNodeName: '',

        nodes: [],

        // From /profiles/ and /profiles/current.
        profiles: [],
        currentProfileId: '',
    });
}

/**
 * Recompute everything that follows from something else.
 *
 * This is the whole reason exitNodeName cannot go stale. Upstream recomputes
 * the name only inside the branch that notices the *id* changed, and emits
 * notify::exit-node before computing it — so a handler reading the name during
 * that notification gets the previous one, and a peer list that arrives after
 * the preferences leaves the name empty until the id happens to change again.
 *
 * Here the name is not a field that is kept up to date. It is a function of
 * the snapshot, evaluated whenever the snapshot is rebuilt, so the two cannot
 * be observed disagreeing.
 *
 * @param {object} state A state whose primary fields are already set.
 * @returns {object} The same state with derived fields filled in, frozen.
 */
function derive(state) {
    // isExitNode follows exitNodeId, so a preferences change re-marks the
    // nodes that were normalised against the previous one.
    const marked = state.nodes.map(node =>
        node.isExitNode === (node.id !== '' && node.id === state.exitNodeId)
            ? node
            : { ...node, isExitNode: node.id !== '' && node.id === state.exitNodeId },
    );

    // Re-sorted because the exit node sorts first, and it may have moved.
    const nodes = sortNodes(marked);

    return Object.freeze({
        ...state,
        nodes: Object.freeze(nodes),
        exitNodeName: exitNodeOf(nodes)?.name ?? '',
    });
}

/**
 * Fold a /status response into the state.
 *
 * @param {object} state Current state.
 * @param {object} status Parsed /status response.
 * @returns {object} A new state.
 */
export function applyStatus(state, status) {
    const self = status?.Self ?? null;

    // ?peers=false answers with Peer: null, which must leave the nodes alone
    // rather than emptying the menu. An actually-empty tailnet sends {}.
    const nodes =
        status?.Peer === null || status?.Peer === undefined
            ? state.nodes
            : normalisePeers(status.Peer, {
                  exitNodeId: state.exitNodeId,
                  magicDNSSuffix: status?.MagicDNSSuffix ?? state.magicDNSSuffix,
              });

    return derive({
        ...state,
        reachable: true,
        errorReason: '',

        backendState: status?.BackendState ?? BACKEND.NO_STATE,
        authUrl: status?.AuthURL ?? '',

        // Health is absent when there is nothing wrong, not empty.
        health: Object.freeze(Array.isArray(status?.Health) ? [...status.Health] : []),

        // Falls back to what is already known, matching the peer-naming
        // context above. A response that omitted the suffix would otherwise
        // discard it, and every node name depends on it — they would all
        // silently grow their tailnet suffix back.
        magicDNSSuffix: status?.MagicDNSSuffix ?? state.magicDNSSuffix,
        tailnetName: status?.CurrentTailnet?.Name ?? '',
        selfName: self?.HostName ?? '',
        selfIps: Object.freeze(
            Array.isArray(self?.TailscaleIPs) ? [...self.TailscaleIPs] : [],
        ),

        nodes,
    });
}

/**
 * Fold a /prefs response into the state.
 *
 * @param {object} state Current state.
 * @param {object} prefs Parsed /prefs response.
 * @returns {object} A new state.
 */
export function applyPrefs(state, prefs) {
    return derive({
        ...state,
        reachable: true,
        errorReason: '',

        running: prefs?.WantRunning === true,
        acceptRoutes: prefs?.RouteAll === true,
        acceptDNS: prefs?.CorpDNS === true,
        allowLanAccess: prefs?.ExitNodeAllowLANAccess === true,
        shieldsUp: prefs?.ShieldsUp === true,
        ssh: prefs?.RunSSH === true,
        exitNodeId: prefs?.ExitNodeID ?? '',

        // Null rather than empty when nothing is advertised.
        advertiseRoutes: Object.freeze(
            Array.isArray(prefs?.AdvertiseRoutes) ? [...prefs.AdvertiseRoutes] : [],
        ),
    });
}

/**
 * Fold the profile list and the active profile into the state.
 *
 * The active profile is read from /profiles/current rather than inferred.
 * Upstream compares the live prefs' ControlURL and Config.UserProfile.ID
 * against each profile's — an expression that throws whenever a profile has no
 * NetworkProfile, and which it then never calls, because the line that should
 * rebuild the profile list calls the node updater instead.
 *
 * @param {object} state Current state.
 * @param {object[]} profiles Parsed /profiles/ response.
 * @param {object} [current] Parsed /profiles/current response.
 * @returns {object} A new state.
 */
export function applyProfiles(state, profiles, current = null) {
    const list = Array.isArray(profiles) ? profiles : [];

    return derive({
        ...state,
        reachable: true,
        errorReason: '',

        profiles: Object.freeze(
            list.map(profile => ({
                id: profile?.ID ?? '',
                name: profile?.Name ?? '',

                // NetworkProfile is omitempty, and dereferencing it without a
                // guard is upstream issue #42.
                tailnet:
                    profile?.NetworkProfile?.DisplayName ??
                    profile?.NetworkProfile?.DomainName ??
                    '',
            })),
        ),
        currentProfileId: current?.ID ?? state.currentProfileId,
    });
}

/**
 * Record that the daemon could not be reached.
 *
 * The nodes and preferences already read are kept rather than cleared: a menu
 * that empties itself the moment tailscaled is restarted is less useful than
 * one that says it has lost contact and still shows what it last knew.
 *
 * @param {object} state Current state.
 * @param {string} reason One of {@link REASON}.
 * @returns {object} A new state.
 */
export function applyError(state, reason) {
    return derive({
        ...state,
        reachable: false,
        errorReason: reason || REASON.UNKNOWN,
    });
}

/**
 * Which fields differ between two snapshots.
 *
 * Subscribers use this to decide whether they have anything to redraw. The
 * arrays are compared on the fields that are actually rendered rather than
 * with JSON.stringify, which upstream calls on the whole node list on every
 * netmap update — allocating a copy of the tailnet as a string to answer a
 * question about a handful of fields.
 *
 * @param {object} previous Earlier snapshot.
 * @param {object} next Later snapshot.
 * @returns {string[]} Field names that differ, in a stable order.
 */
export function changed(previous, next) {
    const fields = [];

    for (const [name, read] of SCALARS)
        if (read(previous) !== read(next)) fields.push(name);

    if (!sameStrings(previous.health, next.health)) fields.push('health');
    if (!sameStrings(previous.advertiseRoutes, next.advertiseRoutes))
        fields.push('advertiseRoutes');
    if (!sameStrings(previous.selfIps, next.selfIps)) fields.push('selfIps');
    if (!sameNodes(previous.nodes, next.nodes)) fields.push('nodes');
    if (!sameProfiles(previous.profiles, next.profiles)) fields.push('profiles');

    return fields;
}

// Every field that compares with ===, paired with how to read it. Named
// accessors rather than indexing by a variable: a state field is not a lookup
// key, and writing it as one costs the reader the ability to grep for a use.
const SCALARS = Object.freeze([
    ['reachable', s => s.reachable],
    ['errorReason', s => s.errorReason],
    ['backendState', s => s.backendState],
    ['authUrl', s => s.authUrl],
    ['magicDNSSuffix', s => s.magicDNSSuffix],
    ['tailnetName', s => s.tailnetName],
    ['selfName', s => s.selfName],
    ['running', s => s.running],
    ['acceptRoutes', s => s.acceptRoutes],
    ['acceptDNS', s => s.acceptDNS],
    ['allowLanAccess', s => s.allowLanAccess],
    ['shieldsUp', s => s.shieldsUp],
    ['ssh', s => s.ssh],
    ['exitNodeId', s => s.exitNodeId],
    ['exitNodeName', s => s.exitNodeName],
    ['currentProfileId', s => s.currentProfileId],
]);

// All three list comparisons are the same shape — equal lengths, then
// element-wise — so only the per-element test is written out.
const sameBy = (a, b, equal) =>
    a.length === b.length && a.every((value, index) => equal(value, b.at(index)));

const sameStrings = (a, b) => sameBy(a, b, (value, other) => value === other);

// isMullvad and location are compared because they are rendered:
// partitionMullvad splits on the first, and cityOf/countryOf read City and
// CountryCode off the second to label and group the country list. Leaving
// them out meant a node moving city, or gaining the Mullvad tag, produced no
// 'nodes' field and so no redraw — a menu left quietly stale with nothing
// logged.
const sameNodes = (a, b) =>
    sameBy(
        a,
        b,
        (node, other) =>
            node.id === other.id &&
            node.name === other.name &&
            node.online === other.online &&
            node.isExitNode === other.isExitNode &&
            node.canBeExitNode === other.canBeExitNode &&
            node.icon === other.icon &&
            node.taildropTarget === other.taildropTarget &&
            node.isMullvad === other.isMullvad &&
            node.location?.City === other.location?.City &&
            node.location?.CountryCode === other.location?.CountryCode &&
            node.ips.at(0) === other.ips.at(0),
    );

const sameProfiles = (a, b) =>
    sameBy(
        a,
        b,
        (profile, other) =>
            profile.id === other.id &&
            profile.name === other.name &&
            profile.tailnet === other.tailnet,
    );
