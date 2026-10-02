<template>
  <b-modal id="peers-modal" size="lg" centered hide-footer @show="refresh">
    <template v-slot:modal-header="{ close }">
      <div class="px-2 px-sm-3 pt-2 d-flex justify-content-between w-100">
        <h3 class="m-0">Peers</h3>
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
      <p class="text-muted mb-3">
        Connect to another node without opening a channel, so that it can open
        one to you, or so that you can find each other's channels.
      </p>

      <!-- Connect -->
      <label class="mb-1 d-block" for="peer-address"
        ><small class="font-weight-bold">Node address</small></label
      >
      <div class="d-flex mb-1">
        <b-form-input
          id="peer-address"
          v-model="address"
          size="sm"
          class="neu-input mr-2"
          placeholder="pubkey@host:port"
          autocomplete="off"
          spellcheck="false"
          :disabled="connecting"
          @keyup.enter="connect"
        ></b-form-input>
        <b-button
          variant="success"
          size="sm"
          :disabled="connecting || !address.trim()"
          @click="connect"
          >{{ connecting ? "Connecting…" : "Connect" }}</b-button
        >
      </div>
      <small class="text-muted d-block mb-2"
        >The port is 9735 when left out. A peer you have no channel with is
        not reconnected after a restart.</small
      >
      <small v-if="connectError" class="text-danger d-block mb-2">{{
        connectError
      }}</small>
      <small v-if="connected" class="text-success d-block mb-2">{{
        connected
      }}</small>

      <!-- List -->
      <div class="d-flex justify-content-between align-items-center mt-3 mb-2">
        <small class="font-weight-bold"
          >Connected ({{ peers.length }})</small
        >
        <b-button
          variant="link"
          size="sm"
          class="p-0"
          :disabled="loading"
          @click="refresh"
          >Refresh</b-button
        >
      </div>
      <small v-if="error" class="text-danger d-block mb-2">{{ error }}</small>
      <div
        v-if="loading && !peers.length"
        class="text-muted py-3 text-center"
      >
        Loading peers…
      </div>
      <div v-else-if="!peers.length" class="text-muted py-3 text-center">
        No peers connected.
      </div>
      <div
        v-for="peer in peers"
        :key="peer.pubKey"
        class="neu-card p-3 mb-2 d-flex justify-content-between align-items-center"
      >
        <div class="mr-2" style="min-width: 0;">
          <div class="text-truncate font-weight-bold">
            {{ peer.alias || shortKey(peer.pubKey) }}
          </div>
          <small class="text-muted d-block text-truncate" :title="peer.pubKey">
            {{ peer.pubKey }}
          </small>
          <small class="text-muted d-block">
            {{ peer.inbound ? "Connected to you" : "You connected" }}
            <span v-if="peer.address"> · {{ peer.address }}</span>
            ·
            <span v-if="peer.channels"
              >{{ peer.channels }} channel{{
                peer.channels === 1 ? "" : "s"
              }}</span
            >
            <span v-else>no channel</span>
          </small>
        </div>
        <b-button
          v-if="!peer.channels"
          variant="link"
          size="sm"
          class="text-muted flex-shrink-0"
          :disabled="busyKey === peer.pubKey"
          @click="disconnect(peer)"
          >Disconnect</b-button
        >
      </div>
    </div>
  </b-modal>
</template>

<script>
import API from "@/helpers/api";
import getErrorMessage from "@/helpers/error-message";

export default {
  data() {
    return {
      peers: [],
      loading: false,
      error: "",
      address: "",
      connecting: false,
      connectError: "",
      connected: "",
      busyKey: ""
    };
  },
  methods: {
    shortKey(pubKey) {
      return `${pubKey.slice(0, 10)}…${pubKey.slice(-6)}`;
    },
    async refresh() {
      this.loading = true;
      this.error = "";
      try {
        const res = await API.get(
          `${process.env.VUE_APP_API_BASE_URL}/v1/lnd/peers`
        );
        if (!Array.isArray(res)) {
          throw new Error("Unable to load peers.");
        }
        // Channel peers first, then by name.
        this.peers = res.sort(
          (a, b) =>
            b.channels - a.channels ||
            (a.alias || a.pubKey).localeCompare(b.alias || b.pubKey)
        );
      } catch (error) {
        this.error = getErrorMessage(error, "Unable to load peers.");
      }
      this.loading = false;
    },
    async connect() {
      const address = this.address.trim();
      if (!address || this.connecting) {
        return;
      }
      this.connecting = true;
      this.connectError = "";
      this.connected = "";
      try {
        await API.post(
          `${process.env.VUE_APP_API_BASE_URL}/v1/lnd/peers/connect`,
          { address }
        );
        this.address = "";
        this.connected = "Connected.";
        await this.refresh();
        this.$store.dispatch("lightning/getLndPageData");
      } catch (error) {
        this.connectError = getErrorMessage(error, "Unable to connect.");
      }
      this.connecting = false;
    },
    async disconnect(peer) {
      this.busyKey = peer.pubKey;
      this.error = "";
      this.connected = "";
      try {
        await API.post(
          `${process.env.VUE_APP_API_BASE_URL}/v1/lnd/peers/disconnect`,
          { pubKey: peer.pubKey }
        );
        await this.refresh();
        this.$store.dispatch("lightning/getLndPageData");
      } catch (error) {
        this.error = getErrorMessage(error, "Unable to disconnect.");
      }
      this.busyKey = "";
    }
  }
};
</script>
