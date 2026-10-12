const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
// protobufjs 5 is what grpc.load parses with; the native grpc module itself
// isn't needed to read the definitions.
const ProtoBuf = require("protobufjs");

// The dashboard's lnd protos are hand-kept copies. A field the backend reads
// must be in them, with lnd's field number, or it silently reads as empty.
const PROTO = path.join(__dirname, "..", "resources", "rpc.proto");

function fieldsOf(messagePath) {
  const builder = ProtoBuf.loadProtoFile(PROTO);
  const type = builder.lookup(["lnrpc", ...messagePath].join("."));
  return type.getChildren(ProtoBuf.Reflect.Message.Field).map((f) => ({ name: f.name, id: f.id }));
}

test("pending channels carry their status flags (lnd field 11)", () => {
  const fields = fieldsOf(["PendingChannelsResponse", "PendingChannel"]);
  assert.deepEqual(
    fields.find((f) => f.name === "chan_status_flags"),
    { name: "chan_status_flags", id: 11 }
  );
});

// Splicing: every field the routes read, with lnd's number.
test("splice fields carry lnd's numbers", () => {
  const want = {
    Channel: { splice_status: 1002, pending_splice: 1003, last_splice: 1004, original_channel_point: 1005, original_chan_id: 1006 },
    PendingSplice: {
      initiator: 1, state: 2, local_delta_sat: 3, remote_delta_sat: 4, fee_sat: 5, our_fee_sat: 6,
      sat_per_vbyte: 7, txid: 8, broadcast_height: 9, confirmations: 10, lock_depth: 11, we_locked: 12,
      peer_locked: 13, dead: 14, relay_status: 15, relay_reason: 16, new_channel_point: 17, new_capacity_sat: 18,
    },
    LastSplice: { initiator: 1, local_delta_sat: 2, remote_delta_sat: 3, txid: 4, time: 5, outcome: 6, reason: 7, reason_from_peer: 8 },
    EstimateSpliceRequest: { channel_point: 1, direction: 2, amount_sat: 3, use_max: 4, sat_per_vbyte: 5, target_conf: 6, addr: 7 },
    EstimateSpliceResponse: {
      fee_sat: 1, vbytes: 2, sat_per_vbyte: 3, amount_sat: 4, min_sat: 5, max_in_sat: 6, max_out_sat: 7,
      min_sat_per_vbyte: 8, fee_estimate_source: 9, anchor_reserve_sat: 10, new_capacity_sat: 11,
      new_local_sat: 12, lock_depth: 13, destination_is_ours: 14, refusal_code: 15,
    },
    SpliceChannelRequest: { channel_point: 1, direction: 2, amount_sat: 3, use_max: 4, sat_per_vbyte: 5, target_conf: 6, addr: 7, force_low_fee: 8 },
    SpliceUpdate: { state: 1, txid: 2, new_channel_point: 3, confirmations: 4, reason: 5, reason_from_peer: 6 },
    SpliceEvent: { channel_point: 1, original_channel_point: 2, kind: 3, txid: 4, reason: 5, reason_from_peer: 6 },
    ChannelBalanceResponse: { pending_splice_in_sat: 1002, pending_splice_to_wallet_sat: 1003 },
    ChannelCloseSummary: { original_channel_point: 1002 },
  };
  for (const [message, fields] of Object.entries(want)) {
    const have = fieldsOf([message]);
    for (const [name, id] of Object.entries(fields)) {
      assert.deepEqual(have.find((f) => f.name === name), { name, id }, `${message}.${name}`);
    }
  }
  assert.deepEqual(
    fieldsOf(["PendingChannelsResponse", "PendingOpenChannel"]).find((f) => f.name === "confirmations_until_active"),
    { name: "confirmations_until_active", id: 7 }
  );
  assert.deepEqual(
    fieldsOf(["PendingChannelsResponse", "PendingChannel"]).find((f) => f.name === "original_channel_point"),
    { name: "original_channel_point", id: 1002 }
  );
});
