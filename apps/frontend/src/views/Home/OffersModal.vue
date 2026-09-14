<template>
  <b-modal id="offers-modal" size="lg" centered hide-footer @show="refresh">
    <template v-slot:modal-header="{ close }">
      <div class="px-2 px-sm-3 pt-2 d-flex justify-content-between w-100">
        <h3 class="m-0">Lightning offers</h3>
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
      <p class="text-muted">
        An offer is a reusable payment code (BOLT 12). Anyone holding it can
        pay you as many times as they like, and a mining pool that pays to
        offers pays your payouts to it. Your node answers each payment
        request itself, so it has to be running, with a channel that can
        receive.
      </p>

      <!-- Create -->
      <div v-if="creating" class="neu-card p-3 mb-3">
        <h5 class="mb-3">New offer</h5>
        <label class="mb-1 d-block"><small class="font-weight-bold">Description</small></label>
        <b-input
          class="neu-input mb-1"
          size="sm"
          v-model="form.description"
          placeholder="e.g. OCEAN Payouts for bc1q…"
          :disabled="form.busy"
          autofocus
        ></b-input>
        <small class="text-muted d-block mb-3">
          For a mining pool payout, enter exactly the description the pool asks
          for, and leave the amount empty so the pool sets it.
        </small>
        <label class="mb-1 d-block"><small class="font-weight-bold">Amount <span class="text-muted">(optional, sats)</span></small></label>
        <b-input
          class="neu-input mb-1"
          size="sm"
          type="number"
          min="0"
          v-model.number="form.amountSat"
          placeholder="Any amount"
          :disabled="form.busy"
        ></b-input>
        <small class="text-muted d-block mb-3">
          Empty means the payer chooses the amount.
        </small>
        <label class="mb-1 d-block"><small class="font-weight-bold">Expires</small></label>
        <b-form-select
          class="mb-3"
          size="sm"
          v-model="form.expiry"
          :options="expiryOptions"
          :disabled="form.busy"
        ></b-form-select>
        <label class="mb-1 d-block"><small class="font-weight-bold">Label <span class="text-muted">(optional, only you see it)</span></small></label>
        <b-input
          class="neu-input mb-3"
          size="sm"
          v-model="form.label"
          placeholder="e.g. pool payouts"
          :disabled="form.busy"
        ></b-input>
        <div class="d-flex justify-content-end">
          <b-button variant="link" size="sm" class="mr-2" @click="creating = false" :disabled="form.busy">Cancel</b-button>
          <b-button variant="success" size="sm" @click="create" :disabled="form.busy || !form.description.trim()">
            {{ form.busy ? "Creating…" : "Create offer" }}
          </b-button>
        </div>
        <small v-if="form.error" class="text-danger d-block mt-2">{{ form.error }}</small>
      </div>
      <div v-else class="d-flex justify-content-between align-items-center mb-3">
        <span class="text-muted"><small v-if="offers.length">{{ offers.length }} offer{{ offers.length === 1 ? "" : "s" }}</small></span>
        <b-button variant="success" size="sm" @click="startCreate">New offer</b-button>
      </div>

      <small v-if="error" class="text-danger d-block mb-2">{{ error }}</small>

      <!-- List -->
      <div v-if="loading && !offers.length" class="text-muted py-3 text-center">Loading offers…</div>
      <div v-else-if="!offers.length && !creating" class="text-muted py-3 text-center">
        No offers yet. Create one to be paid over Lightning without handing out an invoice each time.
      </div>
      <div v-for="offer in offers" :key="offer.offerId" class="neu-card p-3 mb-2">
        <div class="d-flex justify-content-between align-items-start">
          <div class="mr-2" style="min-width: 0;">
            <div class="text-truncate font-weight-bold">{{ offer.description || "(no description)" }}</div>
            <small class="text-muted d-block">
              <span v-if="offer.anyAmount">Any amount</span>
              <span v-else>{{ offer.amountSat | localize }} sats</span>
              · {{ offer.invoicesIssued }} invoice{{ offer.invoicesIssued === 1 ? "" : "s" }} issued
              <span v-if="offer.label"> · {{ offer.label }}</span>
              <span v-if="offer.absoluteExpiry"> · {{ expiryText(offer.absoluteExpiry) }}</span>
            </small>
          </div>
          <b-badge :variant="offer.active ? 'success' : 'secondary'" pill>{{ offer.active ? "Active" : "Disabled" }}</b-badge>
        </div>
        <div class="d-flex flex-wrap mt-2">
          <b-button variant="link" size="sm" class="pl-0" @click="toggleShow(offer.offerId)">
            {{ shown === offer.offerId ? "Hide" : "Show" }} offer
          </b-button>
          <b-button variant="link" size="sm" @click="toggleInvoices(offer.offerId)">
            {{ shownInvoices === offer.offerId ? "Hide" : "Show" }} payments
          </b-button>
          <b-button variant="link" size="sm" class="text-muted" @click="toggle(offer)" :disabled="busyId === offer.offerId">
            {{ offer.active ? "Disable" : "Enable" }}
          </b-button>
        </div>
        <div v-if="shown === offer.offerId" class="mt-2">
          <qr-code :value="offer.bolt12" :size="180" level="L" class="mx-auto mb-2" showLogo></qr-code>
          <input-copy size="sm" :value="offer.bolt12" class="mb-1"></input-copy>
          <small class="text-muted d-block">Reusable: share it as many times as you like. Give this to your pool as your Lightning payout address.</small>
        </div>
        <div v-if="shownInvoices === offer.offerId" class="mt-2">
          <div v-if="!invoices[offer.offerId] || !invoices[offer.offerId].length" class="text-muted"><small>No payment requests for this offer yet.</small></div>
          <div v-for="inv in invoices[offer.offerId]" :key="inv.paymentHash" class="d-flex justify-content-between">
            <small>{{ inv.amountSat | localize }} sats · {{ fromNow(inv.createdAt) }}</small>
            <small :class="inv.state === 'SETTLED' ? 'text-success' : 'text-muted'">{{ stateLabel(inv.state) }}</small>
          </div>
        </div>
      </div>
    </div>
  </b-modal>
</template>

<script>
import moment from "moment";
import API from "@/helpers/api";
import getErrorMessage from "@/helpers/error-message";
import InputCopy from "@/components/Utility/InputCopy";
import QrCode from "@/components/Utility/QrCode.vue";

const DAY = 24 * 60 * 60;

export default {
  data() {
    return {
      offers: [],
      invoices: {},
      loading: false,
      error: "",
      creating: false,
      shown: "",
      shownInvoices: "",
      busyId: "",
      form: {
        description: "",
        amountSat: null,
        expiry: 0,
        label: "",
        busy: false,
        error: "",
      },
      expiryOptions: [
        { value: 0, text: "Never" },
        { value: DAY, text: "In a day" },
        { value: 7 * DAY, text: "In a week" },
        { value: 30 * DAY, text: "In a month" },
        { value: 365 * DAY, text: "In a year" },
      ],
    };
  },
  methods: {
    fromNow(unixSeconds) {
      return moment(unixSeconds * 1000).fromNow();
    },
    expiryText(unixSeconds) {
      const when = moment(unixSeconds * 1000);
      return when.isBefore(moment()) ? `expired ${when.fromNow()}` : `expires ${when.fromNow()}`;
    },
    stateLabel(state) {
      return { SETTLED: "Paid", OPEN: "Awaiting payment", CANCELED: "Expired", ACCEPTED: "Paying" }[state] || state;
    },
    async refresh() {
      this.loading = true;
      this.error = "";
      try {
        const res = await API.get(`${process.env.VUE_APP_API_BASE_URL}/v1/lnd/offers`);
        if (!Array.isArray(res)) {
          throw new Error("Unable to load offers.");
        }
        this.offers = res;
      } catch (error) {
        this.error = getErrorMessage(error, "Unable to load offers.");
      }
      this.loading = false;
    },
    startCreate() {
      this.form = { description: "", amountSat: null, expiry: 0, label: "", busy: false, error: "" };
      this.creating = true;
    },
    async create() {
      this.form.busy = true;
      this.form.error = "";
      const payload = {
        description: this.form.description.trim(),
        amountSat: this.form.amountSat || 0,
        absoluteExpiry: this.form.expiry ? Math.floor(Date.now() / 1000) + this.form.expiry : 0,
        label: this.form.label.trim(),
      };
      try {
        const res = await API.post(`${process.env.VUE_APP_API_BASE_URL}/v1/lnd/offers`, payload);
        this.creating = false;
        await this.refresh();
        this.shown = res.data.offer.offerId;
        if (!res.data.created) {
          this.error = "That offer already existed; here it is again.";
        }
      } catch (error) {
        this.form.error = getErrorMessage(error, "Unable to create the offer.");
      }
      this.form.busy = false;
    },
    async toggle(offer) {
      this.busyId = offer.offerId;
      this.error = "";
      try {
        await API.post(`${process.env.VUE_APP_API_BASE_URL}/v1/lnd/offers/${offer.offerId}/${offer.active ? "disable" : "enable"}`, {});
        await this.refresh();
      } catch (error) {
        this.error = getErrorMessage(error, "Unable to change the offer.");
      }
      this.busyId = "";
    },
    toggleShow(offerId) {
      this.shown = this.shown === offerId ? "" : offerId;
    },
    async toggleInvoices(offerId) {
      if (this.shownInvoices === offerId) {
        this.shownInvoices = "";
        return;
      }
      this.shownInvoices = offerId;
      try {
        const res = await API.get(`${process.env.VUE_APP_API_BASE_URL}/v1/lnd/offers/invoices?offerId=${offerId}`);
        if (!Array.isArray(res)) {
          throw new Error("Unable to load the offer's payments.");
        }
        this.$set(this.invoices, offerId, res.slice().reverse());
      } catch (error) {
        this.error = getErrorMessage(error, "Unable to load the offer's payments.");
      }
    },
  },
  components: {
    InputCopy,
    QrCode,
  },
};
</script>
