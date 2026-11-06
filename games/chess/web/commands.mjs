// Keep the original request across reloads and lost responses. Never generate a
// replacement identity for an uncertain command or retarget it to another head.
function commandId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
}
export function commandRequest(state, action) {
  return {command_id: commandId(),
    session_id: state.session.id, profile: state.session.profile,
    expected_block: state.session.block_hash, expected_cursor: state.session.actions, action};
}
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export class CommandClient {
  constructor(request, storage, channel) { this.request = request; this.storage = storage; this.channel = channel; }
  key() {
    const channel = this.channel();
    if (!channel) throw Error("Missing authenticated command channel.");
    return `chess:command:${channel}`;
  }
  pending() {
    const value = this.storage.getItem(this.key());
    return value === null ? null : JSON.parse(value);
  }
  finish(original, result) {
    const report = result.command, entry = report?.entry;
    if (!entry || report.command_id !== original.command_id || report.session_id !== original.session_id
        || hex(entry.original.identity.id) !== original.command_id
        || hex(entry.original.scope.session_id) !== original.session_id
        || hex(entry.original.scope.application_profile) !== original.profile) throw Error('Command result has the wrong identity or scope.');
    const intent = JSON.parse(new TextDecoder().decode(new Uint8Array(entry.original.canonical_command)));
    if (intent.expected_cursor !== original.expected_cursor || intent.expected_block !== original.expected_block
        || JSON.stringify(canonical(intent.action)) !== JSON.stringify(canonical(original.action))) throw Error('Command result differs from the original intent.');
    if (!entry.status?.Committed?.outcome) throw Error('Command outcome is pending. Reconnect to resolve the original command.');
    this.storage.removeItem(this.key());
    return result;
  }
  async recover(state) {
    const original = this.pending();
    if (!original) return state;
    const report = await this.request(`commands/${original.session_id}/${original.command_id}`);
    if (report.entry?.status?.Committed?.outcome) {
      // Creation is committed in the old journal before target preparation.
      // Finish the same materialization before clearing the pending request.
      if (original.action.type === "new_game") {
        return this.finish(original, await this.request("new", original));
      }
      return this.finish(original, {...await this.request('state'), command: report});
    }
    if (!report.entry) {
      const current = await this.request('state');
      if (current.session.id !== original.session_id || current.session.profile !== original.profile
          || current.session.block_hash !== original.expected_block || current.session.actions !== original.expected_cursor) {
        // No admission exists and the original construction head is obsolete;
        // even a delayed request cannot now pass the native exact-head check.
        this.storage.removeItem(this.key());
        throw Error('The board changed before this command was admitted. Review it before making another move.');
      }
    }
    return this.finish(original, await this.request(original.action.type === 'new_game' ? 'new' : 'action', original));
  }
  async submit(state, action) {
    return this.submitOriginal(state, commandRequest(state, action));
  }
  async submitOriginal(state, original) {
    if (this.pending()) throw Error("Resolve the previous command before submitting another.");
    this.storage.setItem(this.key(), JSON.stringify(original));
    try { return this.finish(original, await this.request(original.action.type === 'new_game' ? 'new' : 'action', original)); }
    catch { return this.recover(state); }
  }
}

// Room preparation supplies the exact native session/profile/head. Once a full
// intent is saved, every retry uses it; routing metadata is not a second journal.
export class RoomClient extends CommandClient {
  constructor(api, storage, channel) {
    super((name, body) => {
      const original = body || this.pending();
      if (!original) throw Error("Missing original room command.");
      const base = "/games/chess/api/rooms", room = original.action.room_id;
      if (name === "action") return api(original.action.type === "create_room" ? base : `${base}/${room}/join`, body);
      return api(`${base}/${room}/${name === "state" ? "admission" : name}`);
    }, storage, channel);
    this.api = api;
  }
  admitted(result) {
    const rejected = result.command?.entry?.status?.Committed?.outcome?.Rejected;
    if (rejected) throw Error(new TextDecoder().decode(new Uint8Array(rejected)));
    if (!result.room?.color) throw Error("The requested seat was not admitted.");
    return result;
  }
  async recover(state) {
    if (!this.pending()) return state;
    return this.admitted(await super.recover(state));
  }
  async create(color) {
    if (this.pending()) return this.recover(null);
    const id = commandId();
    const prepared = await this.api(`/games/chess/api/rooms/prepare/${id}/${color}`, {});
    const original = {...commandRequest(prepared, {type:"create_room",room_id:prepared.proposal.id,color}),command_id:id};
    return this.admitted(await this.submitOriginal(prepared, original));
  }
  async join(room) {
    if (this.pending()) return this.recover(null);
    const prepared = await this.api(`/games/chess/api/rooms/${room}/admission`);
    if (prepared.room?.color) return prepared; // Rejoining an existing seat is a read.
    if (!prepared.proposal?.color) throw Error("Both seats are already taken.");
    return this.admitted(await this.submit(prepared, {type:"join_room",room_id:room,color:prepared.proposal.color}));
  }
}
