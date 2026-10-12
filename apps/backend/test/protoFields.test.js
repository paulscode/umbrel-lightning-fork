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
