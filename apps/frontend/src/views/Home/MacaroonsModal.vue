<template>
  <b-modal
    id="macaroons-modal"
    size="lg"
    centered
    hide-footer
    @show="open"
    @hidden="forget"
  >
    <template v-slot:modal-header="{ close }">
      <div class="px-2 px-sm-3 pt-2 d-flex justify-content-between w-100">
        <h3 class="m-0">{{ title }}</h3>
        <!-- Emulate built in modal header close button action -->
        <a href="#" class="align-self-center" v-on:click.stop.prevent="close">
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M13.6003 4.44197C13.3562 4.19789 12.9605 4.19789 12.7164 4.44197L9.02116 8.1372L5.32596 4.442C5.08188 4.19792 4.68615 4.19792 4.44207 4.442C4.198 4.68607 4.198 5.0818 4.44207 5.32588L8.13728 9.02109L4.44185 12.7165C4.19777 12.9606 4.19777 13.3563 4.44185 13.6004C4.68592 13.8445 5.08165 13.8445 5.32573 13.6004L9.02116 9.90497L12.7166 13.6004C12.9607 13.8445 13.3564 13.8445 13.6005 13.6004C13.8446 13.3563 13.8446 12.9606 13.6005 12.7165L9.90505 9.02109L13.6003 5.32585C13.8444 5.08178 13.8444 4.68605 13.6003 4.44197Z"
              fill="#6c757d"
            />
          </svg>
        </a>
      </div>
    </template>

    <div class="px-2 px-sm-3 pb-2 pb-sm-3">
      <!-- The list -->
      <div v-if="view === 'list'">
        <p class="text-muted mb-3">
          A macaroon lets an app use your node with only the access you choose.
          Make one for each app, so that you can revoke it on its own without
          affecting the others.
        </p>
        <b-button variant="success" size="sm" class="mb-3" @click="startCreate"
          >New macaroon</b-button
        >
        <small v-if="error" class="text-danger d-block mb-2">{{ error }}</small>
        <div v-if="loading && !keys.length" class="text-muted py-3 text-center">
          Loading macaroons…
        </div>
        <div
          v-else-if="!keys.length"
          class="neu-card p-3 text-muted text-center"
        >
          No macaroons made here yet.
        </div>
        <div v-for="key in keys" :key="key.id" class="neu-card p-3 mb-2">
          <div class="d-flex justify-content-between align-items-start">
            <div class="mr-2" style="min-width: 0;">
              <div class="text-truncate font-weight-bold">
                {{ key.label }}
                <b-badge v-if="key.expired" variant="secondary" class="ml-1"
                  >Expired</b-badge
                >
                <b-badge
                  v-else-if="key.stale"
                  variant="warning"
                  class="ml-1"
                  title="The node's macaroons were renewed after this one was made (on StartOS, by the Revoke Macaroons action), which revokes it. Revoke it here and make a new one if an app still needs access."
                  >May no longer work</b-badge
                >
              </div>
              <small class="text-muted d-block">{{
                describe(key.permissions)
              }}</small>
              <small class="text-muted d-block">
                Made {{ formatDate(key.createdAt) }} ·
                <span v-if="key.expiresAt"
                  >{{ key.expired ? "expired" : "expires" }}
                  {{ formatDate(key.expiresAt) }}</span
                >
                <span v-else>never expires</span>
              </small>
            </div>
            <b-button
              v-if="confirmRevoke !== key.id"
              variant="link"
              size="sm"
              class="text-danger flex-shrink-0 p-0"
              @click="confirmRevoke = key.id"
              >Revoke</b-button
            >
          </div>
          <div
            v-if="confirmRevoke === key.id"
            class="mt-2 pt-2 macaroon-divider"
          >
            <small class="d-block mb-2"
              >Revoke “{{ key.label }}”? Any app using it loses access at once.
              This can't be undone.</small
            >
            <b-button
              variant="danger"
              size="sm"
              class="mr-2"
              :disabled="busyId === key.id"
              @click="revoke(key)"
              >{{ busyId === key.id ? "Revoking…" : "Revoke" }}</b-button
            >
            <b-button variant="link" size="sm" @click="confirmRevoke = ''"
              >Cancel</b-button
            >
          </div>
        </div>
        <small class="text-muted d-block mt-3">
          Only macaroons made here are listed. The node's own (admin, read-only
          and invoice) and the bridge's are managed where they are made.
        </small>
      </div>

      <!-- Making one -->
      <div v-else-if="view === 'create'">
        <label class="mb-1 d-block" for="macaroon-label"
          ><small class="font-weight-bold">Name</small></label
        >
        <b-form-input
          id="macaroon-label"
          v-model="form.label"
          size="sm"
          class="neu-input mb-1"
          placeholder="What it is for, such as BTCPay Server"
          maxlength="64"
          autocomplete="off"
        ></b-form-input>
        <small class="text-muted d-block mb-3"
          >Only for you, to tell your macaroons apart.</small
        >

        <small class="font-weight-bold d-block mb-1">Access</small>
        <div class="row mx-n1 mb-2">
          <div
            v-for="preset in presets"
            :key="preset.id"
            class="col-12 col-sm-6 px-1 mb-2"
          >
            <div
              class="neu-card p-3 h-100 macaroon-choice"
              :class="{ chosen: form.preset === preset.id }"
              role="radio"
              tabindex="0"
              :aria-checked="form.preset === preset.id ? 'true' : 'false'"
              @click="choosePreset(preset.id)"
              @keyup.enter.space="choosePreset(preset.id)"
            >
              <div class="font-weight-bold">{{ preset.name }}</div>
              <small class="text-muted d-block">{{ preset.blurb }}</small>
            </div>
          </div>
        </div>

        <!-- Every permission, editable once Custom is chosen -->
        <div v-if="form.preset === 'custom'" class="neu-card p-3 mb-3">
          <small class="text-muted d-block mb-2"
            >Started from your last choice. Tick what the app needs, and nothing
            more.</small
          >
          <div v-for="row in rows" :key="row.entity" class="py-2 macaroon-row">
            <div
              class="d-flex justify-content-between align-items-start flex-wrap"
            >
              <div class="mr-2" style="min-width: 10rem;">
                <div class="font-weight-bold small">{{ row.name }}</div>
              </div>
              <div class="d-flex flex-wrap">
                <b-form-checkbox
                  v-for="action in row.actions"
                  :key="action.action"
                  v-model="form.pairs"
                  :value="row.entity + ':' + action.action"
                  class="mr-3 small"
                >
                  {{ actionName(action.action) }}
                  <span
                    v-if="risk(row.entity, action.action) === 'high'"
                    class="text-warning"
                    title="Can move funds or take control"
                    >⚠</span
                  >
                </b-form-checkbox>
              </div>
            </div>
            <small
              v-for="action in row.actions"
              :key="'d' + action.action"
              class="text-muted d-block"
              >{{ actionName(action.action) }}:
              {{ pairText(row.entity, action.action) }}
              <a
                href="#"
                class="text-muted"
                @click.prevent="toggleCalls(row.entity + ':' + action.action)"
                >({{ action.methods.length }} call{{
                  action.methods.length === 1 ? "" : "s"
                }})</a
              >
              <span
                v-if="shownCalls === row.entity + ':' + action.action"
                class="d-block macaroon-calls"
                >{{ action.methods.map(shortMethod).join(", ") }}</span
              >
            </small>
          </div>

          <a
            href="#"
            class="small d-inline-block mt-2"
            @click.prevent="showMethods = !showMethods"
            >{{ showMethods ? "Hide" : "Or allow" }} specific calls only{{
              form.methods.length ? ` (${form.methods.length} chosen)` : ""
            }}</a
          >
          <div v-if="showMethods" class="mt-2">
            <small class="text-muted d-block mb-1"
              >Each call allowed here works whatever is ticked above: the
              narrowest macaroon is one with a few calls and nothing
              else.</small
            >
            <b-form-input
              v-model="methodFilter"
              size="sm"
              class="neu-input mb-2"
              placeholder="Search calls, such as AddInvoice"
              autocomplete="off"
            ></b-form-input>
            <div class="macaroon-methods">
              <b-form-checkbox
                v-for="m in filteredMethods"
                :key="m.uri"
                v-model="form.methods"
                :value="m.uri"
                class="small"
                >{{ m.uri }}</b-form-checkbox
              >
            </div>
          </div>
        </div>

        <!-- What it can do, in words -->
        <div class="neu-card p-3 mb-3 small">
          <div class="font-weight-bold mb-1">This macaroon can</div>
          <div v-if="!chosenPermissions.length" class="text-muted">
            Nothing yet: choose its access above.
          </div>
          <ul v-else class="mb-0 pl-3">
            <li
              v-for="line in canDo"
              :key="line.key"
              :class="{ 'text-warning': line.risk === 'high' }"
            >
              {{ line.text }}
            </li>
          </ul>
          <b-alert
            v-if="fullControl"
            show
            variant="warning"
            class="mt-2 mb-0 small"
          >
            Whoever holds this macaroon can spend your funds or make macaroons
            of their own. Only give it to software you would trust with your
            wallet.
          </b-alert>
        </div>

        <div class="row">
          <div class="col-12 col-sm-6">
            <label class="mb-1 d-block" for="macaroon-expiry"
              ><small class="font-weight-bold">Expires</small></label
            >
            <b-form-select
              id="macaroon-expiry"
              v-model="form.expiresInDays"
              size="sm"
              class="mb-1"
              :options="expiryOptions"
            ></b-form-select>
            <small class="text-muted d-block mb-3"
              >You can revoke it any time either way.</small
            >
          </div>
          <div v-if="passwordEnabled" class="col-12 col-sm-6">
            <label class="mb-1 d-block" for="macaroon-password"
              ><small class="font-weight-bold">Dashboard password</small></label
            >
            <b-form-input
              id="macaroon-password"
              v-model="form.password"
              type="password"
              size="sm"
              class="neu-input mb-1"
              autocomplete="current-password"
              @keyup.enter="create"
            ></b-form-input>
            <small class="text-muted d-block mb-3"
              >Asked again because a macaroon outlasts this session.</small
            >
          </div>
        </div>

        <small v-if="error" class="text-danger d-block mb-2">{{ error }}</small>
        <div class="d-flex justify-content-end">
          <b-button variant="link" size="sm" class="mr-2" @click="backToList"
            >Cancel</b-button
          >
          <b-button
            variant="success"
            size="sm"
            :disabled="!canCreate || creating"
            @click="create"
            >{{ creating ? "Making…" : "Make macaroon" }}</b-button
          >
        </div>
      </div>

      <!-- The new macaroon, once -->
      <div v-else-if="view === 'result' && made">
        <b-alert show variant="warning" class="small">
          Copy or download it now: it is shown only this once. If it is lost,
          revoke it and make another.
        </b-alert>
        <p class="small text-muted mb-2">
          {{ describe(made.permissions) }} ·
          {{
            made.expiresAt
              ? `expires ${formatDate(made.expiresAt)}`
              : "never expires"
          }}
        </p>
        <b-form-radio-group
          v-model="format"
          :options="formats"
          buttons
          button-variant="outline-secondary"
          size="sm"
          class="mb-3 flex-wrap"
        ></b-form-radio-group>

        <div v-if="format === 'hex'">
          <small class="text-muted d-block mb-1"
            >Most apps ask for this, often as “macaroon (hex)”.</small
          >
          <input-copy size="sm" :value="made.macaroonHex"></input-copy>
        </div>
        <div v-else-if="format === 'base64'">
          <small class="text-muted d-block mb-1"
            >For apps that ask for a base64 macaroon.</small
          >
          <input-copy size="sm" :value="made.macaroonBase64"></input-copy>
        </div>
        <div v-else-if="format === 'file'">
          <small class="text-muted d-block mb-2"
            >For apps that read a macaroon file, as lncli does.</small
          >
          <b-button variant="outline-primary" size="sm" @click="download"
            >Download {{ fileName }}</b-button
          >
        </div>
        <div v-else-if="format === 'connect'" class="row">
          <div class="col-12 col-lg-auto mb-3">
            <qr-code
              :value="connectUrl"
              :size="240"
              level="M"
              :showLogo="false"
              class="qr-image mx-auto"
            ></qr-code>
          </div>
          <div class="col-12 col-lg">
            <small class="text-muted d-block mb-2"
              >Scan it in a wallet such as Zeus: it connects with this
              macaroon's access, not full access.</small
            >
            <b-form-select
              v-model="connectMode"
              size="sm"
              class="mb-2"
              :options="availableConnectModes"
            ></b-form-select>
            <input-copy size="sm" :value="connectUrl"></input-copy>
          </div>
        </div>

        <div class="d-flex justify-content-end mt-3">
          <b-button variant="success" size="sm" @click="backToList"
            >Done</b-button
          >
        </div>
      </div>
    </div>
  </b-modal>
</template>

<script>
import API from "@/helpers/api";
import getErrorMessage from "@/helpers/error-message";
import QrCode from "@/components/Utility/QrCode";
import InputCopy from "@/components/Utility/InputCopy";

const BASE = () => `${process.env.VUE_APP_API_BASE_URL}/v1/lnd/macaroons`;

// What each permission LND knows allows, in words. Anything not here (a
// permission a newer LND adds) is shown by its own name.
const ENTITIES = {
  info: {
    name: "Node info",
    read: "See the node's ID, version, sync state and the network graph",
    write: "Stop the node and change its log levels"
  },
  invoices: {
    name: "Invoices",
    read: "See invoices and whether they were paid",
    write: "Create and cancel invoices, to receive payments"
  },
  offchain: {
    name: "Lightning",
    read: "See channels, Lightning balances and payments",
    write: "Send Lightning payments, and change or close channels"
  },
  onchain: {
    name: "On-chain wallet",
    read: "See the on-chain balance and transactions",
    write: "Send on-chain funds, and open and close channels"
  },
  address: {
    name: "Addresses",
    read: "See the wallet's addresses",
    write: "Make new on-chain addresses, to receive funds"
  },
  peers: {
    name: "Peers",
    read: "See connected peers",
    write: "Connect to and disconnect peers, and change the node's announcement"
  },
  message: {
    name: "Messages",
    read: "Check messages signed by other nodes",
    write: "Sign messages as this node"
  },
  signer: {
    name: "Signer",
    read: "Read the keys the wallet signs with",
    generate: "Sign anything with the wallet's keys"
  },
  macaroon: {
    name: "Macaroons",
    read: "List macaroons and the permissions LND has",
    write: "Revoke macaroons, including the node's own",
    generate: "Make new macaroons with any access"
  }
};

// What can move funds or take the node over.
const HIGH_RISK = new Set([
  "onchain:write",
  "offchain:write",
  "signer:generate",
  "macaroon:generate",
  "macaroon:write"
]);

const ACTION_NAMES = { read: "Read", write: "Write", generate: "Generate" };

export default {
  components: { QrCode, InputCopy },
  data() {
    return {
      view: "list",
      keys: [],
      catalog: { pairs: [], methods: [] },
      loading: false,
      error: "",
      busyId: "",
      confirmRevoke: "",
      creating: false,
      session: 0,
      showMethods: false,
      methodFilter: "",
      shownCalls: "",
      form: this.emptyForm(),
      made: null,
      format: "hex",
      connectMode: "restTor",
      expiryOptions: [
        { value: 0, text: "Never" },
        { value: 1, text: "In 1 day" },
        { value: 7, text: "In 7 days" },
        { value: 30, text: "In 30 days" },
        { value: 90, text: "In 90 days" },
        { value: 365, text: "In 1 year" }
      ],
      connectModes: [
        { value: "restTor", text: "REST (Tor)" },
        { value: "restLocal", text: "REST (Local Network)" },
        { value: "grpcTor", text: "gRPC (Tor)" },
        { value: "grpcLocal", text: "gRPC (Local Network)" }
      ]
    };
  },
  computed: {
    passwordEnabled() {
      return Boolean(this.$store.state.system.auth.passwordEnabled);
    },
    title() {
      if (this.view === "create") return "New macaroon";
      if (this.view === "result" && this.made)
        return `“${this.made.label}” is ready`;
      return "Macaroons";
    },
    allPairs() {
      return this.catalog.pairs.map(p => `${p.entity}:${p.action}`);
    },
    presets() {
      const has = key => this.allPairs.includes(key);
      const pick = keys => keys.filter(has);
      const reads = this.allPairs.filter(k => k.endsWith(":read"));
      return [
        {
          id: "readonly",
          name: "Read only",
          blurb:
            "See balances, channels, payments and invoices. Can't move funds.",
          pairs: reads
        },
        {
          id: "invoice",
          name: "Receive payments",
          blurb:
            "Create invoices and addresses, and see if they were paid. Can't spend.",
          pairs: pick([
            "invoices:read",
            "invoices:write",
            "address:read",
            "address:write",
            "onchain:read"
          ])
        },
        {
          id: "lightning",
          name: "Lightning wallet",
          blurb:
            "See everything, receive, and send Lightning payments. Can't send on-chain.",
          pairs: [
            ...new Set([
              ...reads,
              ...pick(["invoices:write", "offchain:write", "address:write"])
            ])
          ]
        },
        {
          id: "admin",
          name: "Full access",
          blurb:
            "Everything, like the admin macaroon. Only for software you trust with your funds.",
          pairs: this.allPairs
        },
        {
          id: "custom",
          name: "Custom",
          blurb:
            "Choose each permission yourself, or allow only specific calls.",
          pairs: null
        }
      ];
    },
    rows() {
      const byEntity = {};
      for (const p of this.catalog.pairs) {
        if (!byEntity[p.entity]) byEntity[p.entity] = [];
        byEntity[p.entity].push(p);
      }
      const order = Object.keys(ENTITIES);
      return Object.keys(byEntity)
        .sort((a, b) => {
          const ia = order.indexOf(a) < 0 ? 99 : order.indexOf(a);
          const ib = order.indexOf(b) < 0 ? 99 : order.indexOf(b);
          return ia - ib || a.localeCompare(b);
        })
        .map(entity => ({
          entity,
          name: (ENTITIES[entity] && ENTITIES[entity].name) || entity,
          actions: byEntity[entity].sort(
            (a, b) =>
              Object.keys(ACTION_NAMES).indexOf(a.action) -
              Object.keys(ACTION_NAMES).indexOf(b.action)
          )
        }));
    },
    filteredMethods() {
      const q = this.methodFilter.trim().toLowerCase();
      const list = this.catalog.methods;
      return q ? list.filter(m => m.uri.toLowerCase().includes(q)) : list;
    },
    chosenPermissions() {
      const pairs = this.form.pairs.map(key => {
        const [entity, action] = key.split(":");
        return { entity, action };
      });
      const methods = this.form.methods.map(uri => ({
        entity: "uri",
        action: uri
      }));
      return [...pairs, ...methods];
    },
    canDo() {
      const lines = this.form.pairs
        .slice()
        .sort((a, b) => this.allPairs.indexOf(a) - this.allPairs.indexOf(b))
        .map(key => {
          const [entity, action] = key.split(":");
          return {
            key,
            text: this.pairText(entity, action),
            risk: this.risk(entity, action)
          };
        });
      // Specific calls, the risky ones (those that need a permission
      // which can move funds or take control) on lines of their own.
      const risky = this.form.methods.filter(this.riskyMethod);
      const other = this.form.methods.filter(m => !this.riskyMethod(m));
      if (risky.length) {
        lines.push({
          key: "risky-methods",
          text: `Make ${
            risky.length === 1 ? "this call" : "these calls"
          }, which can move funds or take control: ${risky
            .map(this.shortMethod)
            .join(", ")}`,
          risk: "high"
        });
      }
      if (other.length) {
        lines.push({
          key: "methods",
          text: `Make ${other.length} specific call${
            other.length === 1 ? "" : "s"
          }: ${other.map(this.shortMethod).join(", ")}`,
          risk: "low"
        });
      }
      return lines;
    },
    fullControl() {
      return (
        this.form.pairs.some(key => HIGH_RISK.has(key)) ||
        this.form.methods.some(this.riskyMethod)
      );
    },
    canCreate() {
      return (
        this.form.label.trim().length > 0 &&
        this.chosenPermissions.length > 0 &&
        (!this.passwordEnabled || this.form.password.length > 0)
      );
    },
    formats() {
      const out = [
        { value: "hex", text: "Hex" },
        { value: "base64", text: "Base64" },
        { value: "file", text: "File" }
      ];
      if (this.made && this.made.lndconnect) {
        out.push({ value: "connect", text: "Connect a wallet" });
      }
      return out;
    },
    // Only the addresses the node has: no onion yet, no Tor entry.
    availableConnectModes() {
      const urls = (this.made && this.made.lndconnect) || {};
      return this.connectModes.filter(m => urls[m.value]);
    },
    connectUrl() {
      return (
        (this.made &&
          this.made.lndconnect &&
          this.made.lndconnect[this.connectMode]) ||
        ""
      );
    },
    fileName() {
      const base = (this.made && this.made.label ? this.made.label : "app")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      return `${base || "app"}.macaroon`;
    }
  },
  methods: {
    emptyForm() {
      return {
        label: "",
        preset: "readonly",
        pairs: [],
        methods: [],
        expiresInDays: 0,
        password: ""
      };
    },
    async open() {
      this.view = "list";
      this.error = "";
      this.confirmRevoke = "";
      await Promise.all([this.refresh(), this.loadCatalog()]);
    },
    // What LND can grant, which the list uses to name a preset.
    async loadCatalog() {
      const res = await API.get(`${BASE()}/catalog`);
      if (res && Array.isArray(res.pairs)) {
        this.catalog = res;
      }
      return Boolean(res && Array.isArray(res.pairs));
    },
    // The macaroon and the password leave memory with the modal, and a
    // macaroon still being made when it closes is not shown later.
    forget() {
      this.session += 1;
      this.made = null;
      this.form = this.emptyForm();
      this.view = "list";
    },
    async refresh() {
      this.loading = true;
      this.error = "";
      try {
        const res = await API.get(BASE());
        if (!Array.isArray(res)) {
          throw new Error("Unable to load macaroons. Is the wallet unlocked?");
        }
        this.keys = res;
      } catch (error) {
        this.error = getErrorMessage(error, "Unable to load macaroons.");
      }
      this.loading = false;
    },
    async startCreate() {
      this.error = "";
      if (!this.catalog.pairs.length && !(await this.loadCatalog())) {
        this.error =
          "Unable to read what LND can grant. Is the wallet unlocked?";
        return;
      }
      this.form = this.emptyForm();
      this.choosePreset("readonly");
      this.showMethods = false;
      this.methodFilter = "";
      this.view = "create";
    },
    choosePreset(id) {
      const preset = this.presets.find(p => p.id === id);
      this.form.preset = id;
      // Custom starts from what was chosen, so a preset can be adjusted.
      if (preset && preset.pairs) {
        this.form.pairs = preset.pairs.slice();
        this.form.methods = [];
      }
    },
    backToList() {
      this.made = null;
      this.form = this.emptyForm();
      this.error = "";
      this.view = "list";
      this.refresh();
    },
    async create() {
      if (!this.canCreate || this.creating) return;
      this.creating = true;
      this.error = "";
      const session = this.session;
      try {
        const res = await API.post(BASE(), {
          label: this.form.label.trim(),
          permissions: this.chosenPermissions,
          expiresInDays: this.form.expiresInDays || null,
          password: this.passwordEnabled ? this.form.password : undefined
        });
        if (session !== this.session) {
          // Closed while it was being made: it is in the list, revocable,
          // but not shown here.
          this.creating = false;
          return;
        }
        this.made = res.data;
        this.form.password = "";
        this.format = "hex";
        if (this.availableConnectModes.length) {
          this.connectMode = this.availableConnectModes[0].value;
        }
        this.view = "result";
      } catch (error) {
        this.form.password = "";
        this.error = getErrorMessage(error, "Unable to make the macaroon.");
      }
      this.creating = false;
    },
    async revoke(key) {
      this.busyId = key.id;
      this.error = "";
      try {
        await API.delete(`${BASE()}/${encodeURIComponent(key.id)}`);
        this.confirmRevoke = "";
        await this.refresh();
      } catch (error) {
        this.error = getErrorMessage(error, "Unable to revoke the macaroon.");
      }
      this.busyId = "";
    },
    download() {
      const hex = this.made.macaroonHex;
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/octet-stream" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = this.fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    toggleCalls(key) {
      this.shownCalls = this.shownCalls === key ? "" : key;
    },
    risk(entity, action) {
      return HIGH_RISK.has(`${entity}:${action}`) ? "high" : "low";
    },
    actionName(action) {
      return ACTION_NAMES[action] || action;
    },
    pairText(entity, action) {
      const e = ENTITIES[entity];
      return (e && e[action]) || `${entity}: ${action}`;
    },
    // Whether a call needs a permission that can move funds or take
    // control, by what LND says it needs.
    riskyMethod(uri) {
      const method = this.catalog.methods.find(m => m.uri === uri);
      return Boolean(
        method &&
          method.permissions.some(p => HIGH_RISK.has(`${p.entity}:${p.action}`))
      );
    },
    shortMethod(uri) {
      return uri.split("/").pop();
    },
    // A one-line summary of a macaroon's permissions.
    describe(permissions) {
      const keys = (permissions || [])
        .filter(p => p.entity !== "uri")
        .map(p => `${p.entity}:${p.action}`)
        .sort();
      const calls = (permissions || []).filter(p => p.entity === "uri").length;
      const same = list =>
        list.length === keys.length &&
        [...list].sort().every((k, i) => k === keys[i]);
      const preset = this.presets.find(
        p => p.pairs && p.pairs.length && same(p.pairs)
      );
      const parts = [];
      if (preset && this.catalog.pairs.length) {
        parts.push(preset.name);
      } else if (keys.length) {
        parts.push(`${keys.length} permission${keys.length === 1 ? "" : "s"}`);
      }
      if (calls) parts.push(`${calls} specific call${calls === 1 ? "" : "s"}`);
      const riskyCall = (permissions || []).some(
        p => p.entity === "uri" && this.riskyMethod(p.action)
      );
      if (keys.some(k => HIGH_RISK.has(k)) || riskyCall) {
        parts.push("can move funds");
      }
      return parts.join(" · ") || "No access";
    },
    formatDate(ms) {
      return new Date(ms).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric"
      });
    }
  }
};
</script>

<style scoped>
.macaroon-choice {
  cursor: pointer;
  border: 2px solid rgba(128, 128, 128, 0.25);
}
.macaroon-choice.chosen {
  border-color: var(--success, #28a745);
}
.macaroon-choice:focus {
  outline: none;
  border-color: var(--primary, #5351fb);
}
.macaroon-divider {
  border-top: 1px solid rgba(128, 128, 128, 0.25);
}
.macaroon-row + .macaroon-row {
  border-top: 1px solid rgba(128, 128, 128, 0.2);
}
.macaroon-calls {
  word-break: break-word;
}
.macaroon-methods {
  max-height: 14rem;
  overflow-y: auto;
}
</style>
