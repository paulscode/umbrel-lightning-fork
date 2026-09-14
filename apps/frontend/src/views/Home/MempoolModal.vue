<template>
  <b-modal id="mempool-modal" size="md" centered hide-footer @show="load">
    <template v-slot:modal-header="{ close }">
      <div class="px-2 px-sm-3 pt-2 d-flex justify-content-between w-100">
        <h3>Mempool app</h3>
        <a href="#" class="align-self-center" v-on:click.stop.prevent="close">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M13.6003 4.44197C13.3562 4.19789 12.9605 4.19789 12.7164 4.44197L9.02116 8.13721L5.32591 4.44197C5.08183 4.19789 4.68611 4.19789 4.44203 4.44197C4.19795 4.68605 4.19795 5.08178 4.44203 5.32585L8.13728 9.0211L4.44203 12.7163C4.19795 12.9604 4.19795 13.3561 4.44203 13.6002C4.68611 13.8443 5.08183 13.8443 5.32591 13.6002L9.02116 9.90499L12.7164 13.6002C12.9605 13.8443 13.3562 13.8443 13.6003 13.6002C13.8444 13.3561 13.8444 12.9604 13.6003 12.7163L9.90505 9.0211L13.6003 5.32585C13.8444 5.08178 13.8444 4.68605 13.6003 4.44197Z" fill="#6c757d"/>
          </svg>
        </a>
      </div>
    </template>
    <div class="px-2 px-sm-3 pb-2">
      <p class="text-muted">
        Fee rates for sending and for opening channels, and the links behind
        transactions, come from the Mempool app you choose. The rates are the
        ones its own page shows: Low, Medium and High priority. The app has to
        follow this node's chain.
      </p>
      <b-form-radio-group v-model="choice" stacked class="mb-3" :disabled="saving">
        <b-form-radio value="" class="mb-2">
          <span class="font-bold">Your node's own estimate</span>
          <small class="d-block text-muted">
            No app. Transactions link to mempool.guide, a public explorer for
            this chain, after asking.
          </small>
        </b-form-radio>
        <b-form-radio v-for="app in apps" :key="app.id" :value="app.id" class="mb-2">
          <span class="font-bold">{{ app.name }}</span>
          <small class="d-block text-muted">{{ describe(app) }}</small>
        </b-form-radio>
      </b-form-radio-group>
      <p v-if="known && !apps.length" class="text-muted small">
        No Mempool app was found. Install
        {{ isStartOS ? "Mempool or Mempool Pruned" : "Mempool Pruned" }},
        then restart Lightning Fork so it can reach the app.
      </p>
      <b-alert :show="Boolean(error)" variant="warning" class="small">{{ error }}</b-alert>
      <b-alert :show="Boolean(checked)" variant="success" class="small">{{ checked }}</b-alert>
      <div class="d-flex justify-content-end">
        <b-button variant="success" :disabled="saving || choice === selected" @click="save">
          {{ saving ? "Saving..." : "Save" }}
        </b-button>
      </div>
    </div>
  </b-modal>
</template>

<script>
import { mapState } from "vuex";

// Which Mempool app answers for fee rates and transaction links. The
// wrapper tells the dashboard which apps it can reach; the choice is
// kept on the node.
export default {
  data() {
    return {
      choice: "",
      saving: false,
      error: "",
      checked: ""
    };
  },
  computed: {
    ...mapState({
      selected: state => state.system.mempool.selected,
      apps: state => state.system.mempool.apps,
      known: state => state.system.mempool.known,
      mempoolFees: state => state.bitcoin.mempoolFees,
      isStartOS: state => state.system.platform === "startos"
    })
  },
  methods: {
    describe(app) {
      const where = app.uiUrl
        ? app.uiUrl.replace(/^https?:\/\//, "")
        : app.uiPort
        ? `port ${app.uiPort} on this host`
        : "installed";
      return `Installed: ${where}`;
    },
    async load() {
      this.error = "";
      this.checked = "";
      await this.$store.dispatch("system/getMempool");
      this.choice = this.selected;
    },
    async save() {
      this.saving = true;
      this.error = "";
      this.checked = "";
      const message = await this.$store.dispatch("system/setMempool", this.choice);
      if (message) {
        this.error = message;
        this.saving = false;
        return;
      }
      // Read the rates once now: a wrong address shows here rather than
      // at the moment of sending, and an open form drops the old app's.
      await this.$store.dispatch("bitcoin/getMempoolFees");
      if (this.choice) {
        const result = this.mempoolFees;
        if (result && result.fees) {
          const f = result.fees;
          this.checked = `${result.name} answers. Right now: low ${f.hourFee}, medium ${f.halfHourFee}, high ${f.fastestFee} sat/vB.`;
        } else {
          this.error =
            (result && result.error) ||
            "Saved, but the app did not answer. Fees fall back to your node's estimate until it does.";
        }
      } else {
        this.checked = "Saved. Fees come from your node's estimate.";
      }
      this.saving = false;
    }
  }
};
</script>
