<template>
  <b-modal
    id="bitcoin-invoices-modal"
    size="md"
    centered
    hide-footer
    @show="load"
    @hidden="closed"
  >
    <template v-slot:modal-header="{ close }">
      <div class="px-2 px-sm-3 pt-2 d-flex justify-content-between w-100">
        <h3>Paying SHA256 invoices</h3>
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
              d="M13.6003 4.44197C13.3562 4.19789 12.9605 4.19789 12.7164 4.44197L9.02116 8.13721L5.32591 4.44197C5.08183 4.19789 4.68611 4.19789 4.44203 4.44197C4.19795 4.68605 4.19795 5.08178 4.44203 5.32585L8.13728 9.0211L4.44203 12.7163C4.19795 12.9604 4.19795 13.3561 4.44203 13.6002C4.68611 13.8443 5.08183 13.8443 5.32591 13.6002L9.02116 9.90499L12.7164 13.6002C12.9605 13.8443 13.3562 13.8443 13.6003 13.6002C13.8444 13.3561 13.8444 12.9604 13.6003 12.7163L9.90505 9.0211L13.6003 5.32585C13.8444 5.08178 13.8444 4.68605 13.6003 4.44197Z"
              fill="#6c757d"
            />
          </svg>
        </a>
      </div>
    </template>
    <div class="px-2 px-sm-3 pb-2">
      <p class="text-muted">{{ explained }}</p>

      <div v-if="loading && !settings" class="text-muted py-3 text-center">
        Loading…
      </div>

      <template v-else-if="settings">
        <!-- No service yet: add one from its code -->
        <div v-if="!settings.service" class="mb-4">
          <label class="font-weight-bold mb-1" for="bitcoin-invoices-code">
            Add a service
          </label>
          <small class="d-block text-muted mb-2">
            The service's operator gives you a code for it. Paste it here.
          </small>
          <b-form-textarea
            id="bitcoin-invoices-code"
            v-model="code"
            class="neu-input mb-2 code-input"
            rows="3"
            placeholder="Paste the service code"
            spellcheck="false"
            :disabled="adding"
          ></b-form-textarea>
          <div class="d-flex justify-content-end">
            <b-button
              variant="success"
              :disabled="adding || !code.trim()"
              @click="addService"
            >
              {{ adding ? "Checking the service…" : "Add service" }}
            </b-button>
          </div>
        </div>

        <!-- The configured service -->
        <div v-else class="mb-4">
          <small class="d-block text-muted mb-1">Your service</small>
          <div
            class="neu-card p-3 mb-2 d-flex justify-content-between align-items-start"
          >
            <div class="mr-2" style="min-width: 0;">
              <div class="font-weight-bold text-truncate">
                {{ settings.service.label || "Unnamed service" }}
              </div>
              <small
                class="text-muted d-block text-truncate"
                :title="settings.service.node"
              >
                Node key {{ shortKey(settings.service.node) }}
              </small>
              <small
                class="text-muted d-block text-truncate"
                :title="settings.service.url"
              >
                {{
                  settings.service.onion
                    ? "Reached over Tor"
                    : `Reached over the internet at ${host(
                        settings.service.url
                      )}`
                }}
              </small>
            </div>
            <b-button
              variant="link"
              size="sm"
              class="text-danger flex-shrink-0"
              :disabled="removing"
              @click="removeService"
              >{{ confirmRemove ? "Confirm remove" : "Remove" }}</b-button
            >
          </div>
          <small v-if="confirmRemove" class="d-block text-muted mb-2">
            Payments already on their way are not affected. You can add the
            service again later with its code.
          </small>

          <!-- Its terms right now -->
          <div v-if="statusLoading && !status" class="text-muted small py-2">
            Asking the service for its terms…
          </div>
          <template v-else-if="status">
            <small v-if="status.error" class="d-block text-warning mb-2">{{
              status.error
            }}</small>
            <div v-if="status.terms" class="mb-2">
              <div class="d-flex justify-content-between small py-1">
                <span class="text-muted">Status</span>
                <span v-if="status.terms.open" class="text-success"
                  >Paying invoices</span
                >
                <span v-else class="text-warning text-right ml-3"
                  >Not paying right now</span
                >
              </div>
              <small
                v-if="!status.terms.open && status.terms.refusal"
                class="d-block text-muted text-right mb-1"
              >
                {{ status.terms.refusal }}
              </small>
              <div class="d-flex justify-content-between small py-1">
                <span class="text-muted">Rate</span>
                <span class="text-right ml-3">
                  {{ rateText(status.terms.rate) }}
                  <small class="d-block text-muted">{{
                    costPerBitcoinSat(status.terms.rate)
                  }}</small>
                </span>
              </div>
              <div class="d-flex justify-content-between small py-1">
                <span class="text-muted">Service fee</span>
                <span>{{ percent(status.terms.spread) }}</span>
              </div>
              <div class="d-flex justify-content-between small py-1">
                <span class="text-muted">SHA256 invoices it pays</span>
                <span class="text-right ml-3">
                  {{ Number(status.terms.minSat).toLocaleString() }} to
                  {{ sats(status.terms.maxSat) }}
                </span>
              </div>
            </div>
          </template>
        </div>

        <!-- The market rate payments are checked against -->
        <div
          v-if="status && (status.reference || status.referenceError)"
          class="mb-3"
        >
          <small class="d-block text-muted mb-1">Market rate</small>
          <small v-if="status.referenceError" class="d-block text-warning">
            {{ status.referenceError }} Until it is back, nothing is paid.
          </small>
          <template v-else>
            <div class="d-flex justify-content-between small py-1">
              <span class="text-muted"
                >{{
                  status.reference.source
                    ? `On ${status.reference.source}`
                    : "Now"
                }}</span
              >
              <span class="text-right ml-3">{{
                rateText(status.reference.rate)
              }}</span>
            </div>
            <div class="d-flex justify-content-between small py-1">
              <span class="text-muted">Allowed above it right now</span>
              <span class="text-right ml-3">{{
                percent(status.reference.premiumAllowed)
              }}</span>
            </div>
            <small class="d-block text-muted">
              Your premium below, plus the market's own movement over the last
              hour ({{ percent(status.reference.volatilityAllowance) }}).
            </small>
          </template>
        </div>

        <!-- The premium the user allows -->
        <div class="mb-3">
          <label class="font-weight-bold mb-1" for="bitcoin-invoices-premium">
            Most to pay above the market rate
          </label>
          <div class="d-flex align-items-center">
            <b-input-group append="%" class="premium-input mr-2">
              <b-form-input
                id="bitcoin-invoices-premium"
                v-model="premiumInput"
                type="number"
                :min="premiumMinPercent"
                :max="premiumMaxPercent"
                step="0.5"
                class="neu-input"
                :disabled="savingPremium"
                @keyup.enter="savePremium"
              ></b-form-input>
            </b-input-group>
            <b-button
              variant="outline-primary"
              size="sm"
              :disabled="savingPremium || !premiumChanged"
              @click="savePremium"
              >{{ savingPremium ? "Saving…" : "Save" }}</b-button
            >
          </div>
          <small class="d-block text-muted mt-1">
            Between {{ premiumMinPercent }}% and {{ premiumMaxPercent }}%; 5%
            unless you change it. A payment costing more than this over the
            market rate is not made.
          </small>
        </div>
      </template>

      <b-alert :show="Boolean(error)" variant="warning" class="small">{{
        error
      }}</b-alert>
      <b-alert :show="Boolean(notice)" variant="success" class="small">{{
        notice
      }}</b-alert>
    </div>
  </b-modal>
</template>

<script>
import API from "@/helpers/api";
import getErrorMessage from "@/helpers/error-message";
import {
  bitcoinInvoicesUrl,
  BITCOIN_INVOICES_EXPLAINED,
  percent,
  sats,
  rateText,
  costPerBitcoinSat,
  shortKey
} from "@/helpers/bitcoin-invoices";

const toPercent = fraction => Math.round(Number(fraction) * 10000) / 100;

// The service SHA256 invoices are paid through, and how far above the
// market rate a payment may cost. Both are kept on the node.
export default {
  data() {
    return {
      explained: BITCOIN_INVOICES_EXPLAINED,
      settings: null,
      status: null,
      loading: false,
      statusLoading: false,
      statusSeq: 0,
      statusAgain: false,
      code: "",
      adding: false,
      removing: false,
      confirmRemove: false,
      premiumInput: "",
      savingPremium: false,
      error: "",
      notice: ""
    };
  },
  computed: {
    premiumMinPercent() {
      return toPercent(this.settings ? this.settings.premiumMin : 0.005);
    },
    premiumMaxPercent() {
      return toPercent(this.settings ? this.settings.premiumMax : 0.25);
    },
    premiumChanged() {
      return (
        this.settings &&
        this.premiumInput !== "" &&
        Number(this.premiumInput) !== toPercent(this.settings.premium)
      );
    }
  },
  methods: {
    percent,
    sats,
    rateText,
    costPerBitcoinSat,
    shortKey,
    host(url) {
      return String(url || "")
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "");
    },
    async load() {
      this.error = "";
      this.notice = "";
      this.code = "";
      this.confirmRemove = false;
      this.status = null;
      this.loading = true;
      const settings = await API.get(bitcoinInvoicesUrl());
      this.loading = false;
      if (!settings) {
        this.error = "Could not load these settings. Please try again.";
        return;
      }
      this.useSettings(settings);
      this.loadStatus();
    },
    closed() {
      this.confirmRemove = false;
      this.statusSeq++;
    },
    useSettings(settings) {
      this.settings = settings;
      this.premiumInput = String(toPercent(settings.premium));
    },
    // The service's terms and the market rate; asked over Tor this can
    // take a while, so the rest of the screen does not wait for it.
    // One request at a time (the API helper does not repeat a GET still on
    // its way); a change in the meantime asks again once it is back.
    async loadStatus() {
      if (this.statusLoading) {
        this.statusAgain = true;
        return;
      }
      this.statusLoading = true;
      let seq;
      let status;
      do {
        this.statusAgain = false;
        seq = this.statusSeq;
        status = await API.get(bitcoinInvoicesUrl("/status"));
      } while (this.statusAgain);
      this.statusLoading = false;
      if (seq !== this.statusSeq) {
        return;
      }
      this.status = status || {
        error: "Could not ask the service for its terms. Please try again."
      };
    },
    changed() {
      // The Lightning wallet looks at a pasted SHA256 invoice again.
      this.$root.$emit("bitcoin-invoices-changed");
    },
    async addService() {
      this.adding = true;
      this.error = "";
      this.notice = "";
      try {
        const res = await API.post(bitcoinInvoicesUrl("/service"), {
          code: this.code.trim()
        });
        this.code = "";
        this.useSettings(res.data);
        this.status = res.data.terms ? { terms: res.data.terms } : null;
        this.notice =
          "Service added. You can now pay SHA256 invoices from the Lightning wallet.";
        this.changed();
        this.loadStatus();
      } catch (error) {
        this.error = getErrorMessage(
          error,
          "Could not add the service. Please try again."
        );
      }
      this.adding = false;
    },
    async removeService() {
      if (!this.confirmRemove) {
        this.confirmRemove = true;
        return;
      }
      this.confirmRemove = false;
      this.removing = true;
      this.error = "";
      this.notice = "";
      try {
        const res = await API.delete(bitcoinInvoicesUrl("/service"));
        this.statusSeq++;
        this.status = null;
        this.useSettings(res.data);
        this.notice = "Service removed.";
        this.changed();
      } catch (error) {
        this.error = getErrorMessage(
          error,
          "Could not remove the service. Please try again."
        );
      }
      this.removing = false;
    },
    async savePremium() {
      if (!this.premiumChanged) {
        return;
      }
      const value = Number(this.premiumInput);
      if (
        !(value >= this.premiumMinPercent && value <= this.premiumMaxPercent)
      ) {
        this.error = `Choose between ${this.premiumMinPercent}% and ${this.premiumMaxPercent}%.`;
        return;
      }
      this.savingPremium = true;
      this.error = "";
      this.notice = "";
      try {
        const res = await API.post(bitcoinInvoicesUrl("/premium"), {
          premium: Math.round(value * 100) / 10000
        });
        this.useSettings(res.data);
        this.notice = `Saved. Payments may cost up to ${percent(
          res.data.premium
        )} above the market rate, plus the market's own movement.`;
        this.changed();
        if (this.settings.service) {
          this.loadStatus();
        }
      } catch (error) {
        this.error = getErrorMessage(
          error,
          "Could not save. Please try again."
        );
      }
      this.savingPremium = false;
    }
  }
};
</script>

<style lang="scss" scoped>
.code-input {
  font-family: monospace;
  font-size: 0.8rem;
  word-break: break-all;
}
.premium-input {
  max-width: 130px;
}
</style>
