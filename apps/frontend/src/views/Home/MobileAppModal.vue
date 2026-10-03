<template>
  <b-modal
    id="mobile-app-modal"
    size="lg"
    centered
    hide-footer
    @show="open"
    @hidden="close"
  >
    <template v-slot:modal-header="{ close }">
      <div class="px-2 px-sm-3 pt-2 d-flex justify-content-between w-100">
        <h3 class="m-0">Mobile app</h3>
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
      <!-- Pairing a phone -->
      <div v-if="pairing" class="text-center">
        <p class="mb-3">
          In the Lightning Fork app, tap <b>Scan pairing code</b> and point it
          at this code. It works once and expires in
          <b>{{ countdown }}</b>.
        </p>
        <div class="d-flex justify-content-center mb-3">
          <qr-code :value="pairing.qr" :size="236" level="M" :show-logo="false"></qr-code>
        </div>
        <a :href="appLink" class="d-inline-block mb-3"
          >On this phone? Open in the app</a
        >
        <div v-if="!pairing.pairing.onion" class="text-left mb-3">
          <small class="text-muted d-block">{{ noOnionHint }}</small>
        </div>
        <div class="text-left mb-3" v-if="addresses.length">
          <small class="font-weight-bold d-block mb-1">The phone will reach your node at</small>
          <small
            v-for="a in addresses"
            :key="a.label"
            class="text-muted d-block text-truncate"
            :title="a.value"
            >{{ a.label }} · {{ a.value }}</small
          >
        </div>
        <b-button variant="outline-secondary" size="sm" @click="cancelPairing"
          >Cancel</b-button
        >
      </div>

      <!-- Devices -->
      <div v-else>
        <p class="text-muted mb-3">
          Check your balances, send and receive from your phone with the
          Lightning Fork app for Android. Each phone gets a key of its own,
          which you can remove here at any time.
        </p>
        <small v-if="error" class="text-danger d-block mb-2">{{ error }}</small>
        <small v-if="notice" class="text-success d-block mb-2">{{ notice }}</small>
        <div v-if="loading && !devices.length" class="text-muted py-3 text-center">
          Loading…
        </div>
        <div
          v-else-if="!devices.length"
          class="text-muted py-3 text-center"
        >
          No phones paired yet.
        </div>
        <div
          v-for="device in devices"
          :key="device.id"
          class="neu-card p-3 mb-2 d-flex justify-content-between align-items-center"
        >
          <div class="mr-2" style="min-width: 0;">
            <div v-if="editing === device.id" class="d-flex mb-1">
              <b-form-input
                v-model="editLabel"
                size="sm"
                class="neu-input mr-2"
                maxlength="64"
                @keyup.enter="saveLabel(device)"
              ></b-form-input>
              <b-button size="sm" variant="success" @click="saveLabel(device)"
                >Save</b-button
              >
            </div>
            <div v-else class="text-truncate font-weight-bold">
              {{ device.label || (device.status === "pending" ? "Waiting to pair…" : "Unnamed phone") }}
            </div>
            <small class="text-muted d-block">
              <span v-if="device.status === 'pending'">Pairing code not used yet</span>
              <span v-else>
                Last seen {{ ago(device.lastUsed) }}<span v-if="device.lastTransport">
                  · {{ device.lastTransport === "tor" ? "over Tor" : "on the local network" }}</span
                >
              </span>
            </small>
          </div>
          <div class="flex-shrink-0">
            <b-button
              v-if="device.status === 'active' && editing !== device.id"
              variant="link"
              size="sm"
              class="text-muted"
              @click="startEdit(device)"
              >Rename</b-button
            >
            <b-button
              variant="link"
              size="sm"
              class="text-danger"
              :disabled="busyId === device.id"
              @click="remove(device)"
              >{{ confirmId === device.id ? "Confirm remove" : "Remove" }}</b-button
            >
          </div>
        </div>
        <div v-if="away" class="mt-3">
          <small class="d-block">
            <span class="font-weight-bold">Away from home: </span>
            <span v-if="away.onion" class="text-success">ready</span>
            <span v-else class="text-warning">not set up</span>
          </small>
          <small class="text-muted d-block">{{ awayHint }}</small>
        </div>
        <div class="d-flex justify-content-between align-items-center mt-3">
          <small class="text-muted"
            >Get the app:
            <a
              href="https://github.com/paulscode/lightning-fork-android/releases"
              target="_blank"
              rel="noopener noreferrer"
              >Android</a
            ></small
          >
          <b-button variant="success" :disabled="starting" @click="startPairing"
            >{{ starting ? "Starting…" : "Pair a phone" }}</b-button
          >
        </div>
      </div>
    </div>
  </b-modal>
</template>

<script>
import API from "@/helpers/api";
import getErrorMessage from "@/helpers/error-message";
import QrCode from "@/components/Utility/QrCode.vue";

const POLL_MS = 2500;

export default {
  components: { QrCode },
  data() {
    return {
      devices: [],
      // {onion}: whether the node has an address for phones away from home.
      away: null,
      loading: false,
      error: "",
      notice: "",
      starting: false,
      pairing: null,
      // When the code expires by this browser's clock: the server says how
      // long it lasts, so a skewed clock does not cut it short.
      expiresAt: 0,
      now: Date.now(),
      timer: null,
      poller: null,
      editing: "",
      editLabel: "",
      busyId: "",
      confirmId: ""
    };
  },
  computed: {
    countdown() {
      if (!this.pairing) {
        return "";
      }
      const left = Math.max(0, Math.round((this.expiresAt - this.now) / 1000));
      return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    },
    // The pairing code for a dashboard opened on the phone itself, which
    // cannot scan its own screen.
    appLink() {
      if (!this.pairing) {
        return "#";
      }
      const b64 = btoa(unescape(encodeURIComponent(this.pairing.qr)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      return `lightningfork://pair?c=${b64}`;
    },
    addresses() {
      if (!this.pairing) {
        return [];
      }
      const p = this.pairing.pairing;
      return [
        p.lan && { label: "Local network", value: p.lan.replace(/^https:\/\//, "") },
        p.ip && { label: "Local IP", value: p.ip.replace(/^https:\/\//, "") },
        p.onion && { label: "Tor", value: p.onion.replace(/^https?:\/\//, "") }
      ].filter(Boolean);
    },
    noOnionHint() {
      return this.$store.state.system.platform === "startos"
        ? "This dashboard has no onion address, so the phone can reach your node only on your local network. To use the app anywhere, give the Dashboard interface an onion address with SSL off (Lightning Fork's task in StartOS does this); a phone paired now picks it up the next time it opens at home."
        : "Your node has no onion address for the app yet, so the phone can reach it only on your local network. Tor publishes one shortly after Lightning Fork is installed; a phone paired now picks it up the next time it opens at home, or cancel and pair again in a minute.";
    },
    awayHint() {
      if (!this.away) {
        return "";
      }
      if (this.away.onion) {
        return "Away from your local network, the app reaches your node through its own built-in Tor. Phones paired before this was set up pick it up the next time they open at home.";
      }
      return this.$store.state.system.platform === "startos"
        ? "The app reaches your node only on your local network until the Dashboard has an onion address. In StartOS, run the task on Lightning Fork's page that adds one (it opens Tor with the Dashboard selected and SSL off), or add a Tor address to Lightning Fork's Dashboard interface yourself, with SSL off. Phones already paired pick it up the next time they open at home."
        : "The app reaches your node only on your local network until Tor publishes the app's onion address, which it does within a few minutes of installing or updating Lightning Fork. If this still says not set up after that, restart Lightning Fork from the Umbrel home screen.";
    }
  },
  methods: {
    ago(ms) {
      if (!ms) {
        return "never";
      }
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return "just now";
      if (s < 3600) return `${Math.round(s / 60)} min ago`;
      if (s < 86400) return `${Math.round(s / 3600)} h ago`;
      return `${Math.round(s / 86400)} d ago`;
    },
    async open() {
      this.error = "";
      this.notice = "";
      await this.refresh();
    },
    close() {
      // An unused code stops working when the screen closes.
      if (this.pairing) {
        this.cancelPairing();
      }
      this.stopPairing();
      this.editing = "";
      this.confirmId = "";
    },
    async refresh() {
      this.loading = true;
      const res = await API.get(`${process.env.VUE_APP_API_BASE_URL}/v1/devices`);
      this.loading = false;
      if (res && Array.isArray(res.devices)) {
        this.devices = res.devices;
        this.away = res.away || null;
        return res.devices;
      }
      this.error = "Unable to load the paired phones.";
      return null;
    },
    async startPairing() {
      this.starting = true;
      this.error = "";
      this.notice = "";
      try {
        const res = await API.post(`${process.env.VUE_APP_API_BASE_URL}/v1/devices`, {});
        this.pairing = res.data;
        this.now = Date.now();
        this.expiresAt = this.now + (res.data.expiresInMs || this.pairing.pairing.exp - this.now);
        this.timer = setInterval(() => {
          this.now = Date.now();
          if (this.pairing && this.now > this.expiresAt) {
            this.stopPairing();
            this.refresh();
          }
        }, 1000);
        this.poller = setInterval(this.checkPaired, POLL_MS);
      } catch (error) {
        this.error = getErrorMessage(error, "Unable to start pairing.");
      }
      this.starting = false;
    },
    async checkPaired() {
      if (!this.pairing) {
        return;
      }
      const id = this.pairing.device.id;
      const list = await API.get(`${process.env.VUE_APP_API_BASE_URL}/v1/devices`);
      if (!list || !Array.isArray(list.devices) || !this.pairing) {
        return;
      }
      const device = list.devices.find(d => d.id === id);
      if (!device || device.status === "active") {
        this.stopPairing();
        this.devices = list.devices;
        if (device) {
          this.notice = `Paired with ${device.label || "your phone"}.`;
        }
      }
    },
    cancelPairing() {
      const id = this.pairing && this.pairing.device.id;
      this.stopPairing();
      // The unused code stops working at once; a phone that paired in the
      // meantime is kept (pending=1 removes only an unpaired device).
      if (id) {
        API.delete(`${process.env.VUE_APP_API_BASE_URL}/v1/devices/${id}?pending=1`).finally(this.refresh);
      }
    },
    stopPairing() {
      clearInterval(this.timer);
      clearInterval(this.poller);
      this.timer = null;
      this.poller = null;
      this.pairing = null;
    },
    startEdit(device) {
      this.editing = device.id;
      this.editLabel = device.label;
    },
    async saveLabel(device) {
      try {
        await API.post(`${process.env.VUE_APP_API_BASE_URL}/v1/devices/${device.id}/label`, {
          label: this.editLabel
        });
        this.editing = "";
        await this.refresh();
      } catch (error) {
        this.error = getErrorMessage(error, "Unable to rename.");
      }
    },
    async remove(device) {
      if (this.confirmId !== device.id) {
        this.confirmId = device.id;
        return;
      }
      this.confirmId = "";
      this.busyId = device.id;
      this.error = "";
      try {
        await API.delete(`${process.env.VUE_APP_API_BASE_URL}/v1/devices/${device.id}`);
        this.notice = `Removed ${device.label || "the phone"}. It can no longer reach your node.`;
        await this.refresh();
      } catch (error) {
        this.error = getErrorMessage(error, "Unable to remove.");
      }
      this.busyId = "";
    }
  },
  beforeDestroy() {
    if (this.pairing) {
      this.cancelPairing();
    }
    this.stopPairing();
  }
};
</script>
