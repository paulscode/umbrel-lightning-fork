<template>
  <div>
    <!-- The form -->
    <div v-if="step === 'form'">
      <h5 class="font-bold mb-3">
        {{
          isIn ? "Add funds to this channel" : "Move funds out of this channel"
        }}
      </h5>

      <label class="mb-1" for="resize-amount"
        ><small class="text-muted">Amount</small></label
      >
      <div class="d-flex align-items-center mb-1">
        <b-input-group class="neu-input-group flex-grow-1">
          <b-input
            id="resize-amount"
            class="neu-input"
            type="number"
            min="1"
            inputmode="numeric"
            v-model="amountInput"
            :disabled="useMax"
            @input="estimateSoon"
          ></b-input>
          <b-input-group-append is-text>sats</b-input-group-append>
        </b-input-group>
        <b-form-checkbox
          v-model="useMax"
          class="ml-3"
          switch
          @change="estimateSoon"
        >
          <small>Use maximum</small>
        </b-form-checkbox>
      </div>
      <small v-if="amountInput > 0" class="d-block text-muted">
        ≈ {{ amountInput | satsToFiat }}
      </small>
      <small v-if="isIn && limits" class="d-block text-muted mb-3">
        From your Bitcoin wallet: {{ limits.maxInSat | localize }} sats
        available
        <template v-if="limits.anchorReserveSat > 0">
          ({{ limits.anchorReserveSat | localize }} kept back to pay for closing
          channels)
        </template>
      </small>
      <small v-if="!isIn && limits" class="d-block text-muted mb-3">
        You can move up to {{ limits.maxOutSat | localize }} sats out of this
        channel
        <b-button
          v-if="limits.maxOutSat < Number(channel.localBalance)"
          :id="`reserve-info-${uid}`"
          variant="link"
          size="sm"
          class="p-0 align-baseline"
          aria-label="Why not all of it"
          >ⓘ</b-button
        >
        <b-popover
          v-if="limits.maxOutSat < Number(channel.localBalance)"
          :target="`reserve-info-${uid}`"
          triggers="click blur"
          placement="top"
        >
          A channel keeps a safety reserve on each side, and the network fee
          comes from your side.
        </b-popover>
      </small>

      <fieldset v-if="!isIn" class="mb-3">
        <legend class="mb-1 legend-small">
          <small class="text-muted">To</small>
        </legend>
        <b-form-radio
          v-model="destination"
          value="wallet"
          @change="estimateSoon"
        >
          Your Bitcoin wallet
        </b-form-radio>
        <b-form-radio
          v-model="destination"
          value="address"
          @change="estimateSoon"
        >
          Another address
        </b-form-radio>
        <b-input
          v-if="destination === 'address'"
          class="neu-input mt-2"
          type="text"
          placeholder="bc1q..."
          aria-label="Address"
          v-model="address"
          spellcheck="false"
          @input="estimateSoon"
        ></b-input>
        <small v-if="destination === 'address'" class="d-block text-muted mt-1">
          Use an address from a wallet that follows the BLAKE2b chain. A SHA256
          wallet won't show coins sent here.
        </small>
      </fieldset>

      <fee-selector
        :fee="fees"
        :mempool-fees="mempoolFees"
        :disabled="!hasAmount"
        :custom-max-fee="maxCustomFee"
        @change="selectFee"
      ></fee-selector>

      <div v-if="estimate && !estimate.refusalCode" class="mt-3">
        <small class="text-muted d-block mb-1"
          >Channel size after the change</small
        >
        <bar
          :local="newLocal"
          :remote="newRemote"
          :change="localDelta"
          size="lg"
        ></bar>
        <div class="d-flex justify-content-between mt-1">
          <small class="font-bold">
            You {{ newLocal | localize }} ({{ localDelta >= 0 ? "+" : "-"
            }}{{ Math.abs(localDelta) | localize }})
          </small>
          <small class="font-bold text-right"
            >Peer {{ newRemote | localize }}</small
          >
        </div>
        <small class="d-block text-muted">
          {{ Number(channel.capacity) | localize }} now →
          {{ estimate.newCapacitySat | localize }}
        </small>
      </div>

      <b-alert v-if="refusal" variant="warning" show class="mt-3 mb-0">{{
        refusal
      }}</b-alert>
      <b-alert v-if="highFee" variant="warning" show class="mt-3 mb-0">
        The network fee is more than a tenth of the amount.
      </b-alert>
      <b-alert v-if="error" variant="danger" show class="mt-3 mb-0">{{
        error
      }}</b-alert>

      <div class="d-flex justify-content-end mt-3 resize-buttons">
        <b-button
          variant="outline-secondary"
          class="mr-2"
          @click="$emit('cancel')"
          >Cancel</b-button
        >
        <b-button
          variant="primary"
          :disabled="!canReview || estimating"
          @click="step = 'review'"
        >
          Review
        </b-button>
      </div>
    </div>

    <!-- Review -->
    <div v-else-if="step === 'review'">
      <h5 class="font-bold mb-3">Review</h5>
      <template v-if="isIn">
        <p>
          Add <b>{{ estimate.amountSat | localize }} sats</b> from your Bitcoin
          wallet to your channel with <b>{{ peerName }}</b>
          <small class="text-monospace text-muted"> ({{ shortPubkey }})</small>?
          The channel keeps working while this confirms. Its size becomes
          <b>{{ estimate.newCapacitySat | localize }} sats</b> after at least
          <b>{{ estimate.lockDepth }} confirmations</b> (about
          {{ minutesText(estimate.lockMinutes) }}, longer if
          {{ peerName }} waits for more).
        </p>
        <p>
          Network fee: <b>{{ estimate.feeSat | localize }} sats</b> ({{
            estimate.satPerVbyte
          }}
          sat/vB).
          <template v-if="walletAfter !== null">
            Remaining in your Bitcoin wallet:
            <b>{{ walletAfter | localize }} sats</b>.
          </template>
        </p>
      </template>
      <template v-else>
        <p>
          <b>{{ estimate.amountSat | localize }} sats</b>
          ({{ estimate.amountSat | btc }} BTC,
          {{ estimate.amountSat | satsToFiat }}) go to
          <template v-if="toWallet">your Bitcoin wallet.</template>
          <template v-else>this address:</template>
        </p>
        <p v-if="!toWallet" class="text-monospace address-groups">
          {{ addressGroups }}
        </p>
        <p>
          The network fee of <b>{{ estimate.feeSat | localize }} sats</b> ({{
            estimate.satPerVbyte
          }}
          sat/vB) comes from your side of the channel with
          <b>{{ peerName }}</b>
          <small class="text-monospace text-muted"> ({{ shortPubkey }})</small>.
          This amount stops being spendable over Lightning right away; the
          channel's size becomes
          <b>{{ estimate.newCapacitySat | localize }} sats</b> after at least
          <b>{{ estimate.lockDepth }} confirmations</b> (about
          {{ minutesText(estimate.lockMinutes) }}).
        </p>
        <b-alert v-if="largeExternal" variant="warning" show>
          This moves nearly all your funds in this channel to an address outside
          this node.
        </b-alert>
      </template>
      <div class="d-flex justify-content-end resize-buttons">
        <b-button
          variant="outline-secondary"
          class="mr-2"
          @click="step = 'form'"
          >Back</b-button
        >
        <b-button variant="primary" @click="start">
          {{ isIn ? "Add funds" : "Move funds out" }}
        </b-button>
      </div>
    </div>

    <!-- Agreeing with the peer -->
    <div v-else-if="step === 'agreeing'" class="text-center py-4" role="status">
      <b-spinner small class="mr-2"></b-spinner>
      Agreeing on the transaction with {{ peerName }}…
    </div>

    <!-- Started -->
    <div v-else-if="step === 'started'">
      <p class="font-bold">
        {{
          isIn
            ? "Funds are on their way into the channel."
            : "Funds are on their way out of the channel."
        }}
        You can keep using it.
      </p>
      <p v-if="txid" class="d-flex align-items-center">
        <span class="mr-2">Transaction</span>
        <tx-link :txid="txid"></tx-link>
      </p>
      <div class="d-flex justify-content-end">
        <b-button variant="primary" @click="$emit('done')">Done</b-button>
      </div>
    </div>

    <!-- Our signatures went out; the peer's haven't come back -->
    <div v-else-if="step === 'waiting'">
      <p class="font-bold">Waiting for {{ peerName }} to finish signing.</p>
      <p class="text-muted small">
        The resize carries on by itself; the channel's details show how far it
        got.
      </p>
      <div class="d-flex justify-content-end">
        <b-button variant="primary" @click="$emit('done')">Done</b-button>
      </div>
    </div>

    <!-- Stopped before both signed, or no answer -->
    <div v-else-if="step === 'failed'">
      <p class="font-bold" v-if="failure.unknown">
        Your node didn't say how the resize went. Check the channel's details:
        if a resize shows there, it is going ahead.
      </p>
      <p class="font-bold" v-else-if="failure.fromPeer">
        {{ peerName }} stopped the resize. Nothing was spent; your funds are
        where they were.
      </p>
      <p class="font-bold" v-else>
        The resize stopped. Nothing was spent; your funds are where they were.
      </p>
      <p v-if="failure.text" class="text-muted">{{ failure.text }}</p>
      <div v-if="failure.peerMessage" class="mb-3">
        <b-button
          variant="link"
          size="sm"
          class="p-0"
          :aria-expanded="showPeerText ? 'true' : 'false'"
          @click="showPeerText = !showPeerText"
        >
          Their node's message
        </b-button>
        <pre v-if="showPeerText" class="peer-text mt-1">{{
          failure.peerMessage
        }}</pre>
      </div>
      <div class="d-flex justify-content-end resize-buttons">
        <b-button
          v-if="!failure.unknown"
          variant="outline-secondary"
          class="mr-2"
          @click="step = 'form'"
          >Back</b-button
        >
        <b-button variant="primary" @click="$emit('done')">Close</b-button>
      </div>
    </div>
  </div>
</template>

<script>
import { mapState } from "vuex";
import API from "@/helpers/api";
import getErrorMessage from "@/helpers/error-message";
import { refusalText, minutesText } from "@/helpers/resize";
import Bar from "@/components/Channels/Bar";
import FeeSelector from "@/components/Utility/FeeSelector";
import TxLink from "@/components/Utility/TxLink";

// The node's own estimates for the three levels, used when no Mempool app
// gives rates.
const TARGETS = { fast: 2, normal: 6, slow: 24 };

// A custom rate's ceiling, as the mobile API's.
const MAX_CUSTOM_FEE = 10000;

let uidCounter = 0;

export default {
  props: {
    channel: Object,
    direction: String, // "in" or "out"
    initialAmount: {
      type: Number,
      default: 0
    }
  },
  data() {
    uidCounter += 1;
    return {
      uid: uidCounter,
      step: "form",
      amountInput: "",
      useMax: false,
      destination: "wallet",
      address: "",
      limits: null,
      fees: null,
      selectedFee: null,
      estimate: null,
      estimating: false,
      error: "",
      timer: null,
      seq: 0,
      rateSeq: 0,
      txid: "",
      failure: { fromPeer: false, unknown: false, text: "", peerMessage: "" },
      showPeerText: false,
      maxCustomFee: MAX_CUSTOM_FEE
    };
  },
  computed: {
    ...mapState({
      mempoolFees: state => state.bitcoin.mempoolFees,
      walletConfirmed: state => state.bitcoin.balance.confirmed
    }),
    isIn() {
      return this.direction === "in";
    },
    toWallet() {
      return (
        this.destination === "wallet" ||
        Boolean(this.estimate && this.estimate.destinationIsOurs)
      );
    },
    hasAmount() {
      return this.useMax || Number(this.amountInput) > 0;
    },
    peerName() {
      return this.channel.remoteAlias || "your peer";
    },
    shortPubkey() {
      const p = this.channel.remotePubkey || "";
      return p ? `${p.slice(0, 8)}…${p.slice(-4)}` : "";
    },
    // Our side's change: what is added, or what goes out with the network
    // fee, which comes from our side. Shown against the balances the list
    // shows (with the commitment fee on the opener's side), so the node's
    // own figures for after the change aren't mixed in.
    localDelta() {
      if (!this.estimate) {
        return 0;
      }
      const amount = Number(this.estimate.amountSat);
      return this.isIn ? amount : -(amount + Number(this.estimate.feeSat));
    },
    newLocal() {
      return Number(this.channel.localBalance) + this.localDelta;
    },
    newRemote() {
      return Number(this.channel.remoteBalance);
    },
    walletAfter() {
      const confirmed = Number(this.walletConfirmed);
      if (!this.estimate || !Number.isFinite(confirmed) || confirmed <= 0) {
        return null;
      }
      return Math.max(
        0,
        confirmed -
          Number(this.estimate.amountSat) -
          Number(this.estimate.feeSat)
      );
    },
    refusal() {
      if (!this.estimate || !this.estimate.refusalCode) {
        return "";
      }
      return this.textFor(this.estimate);
    },
    highFee() {
      return Boolean(
        this.estimate &&
          !this.estimate.refusalCode &&
          Number(this.estimate.feeSat) * 10 > Number(this.estimate.amountSat) // eslint-disable-line no-magic-numbers
      );
    },
    // An external move of all or most of our side.
    largeExternal() {
      if (this.toWallet || !this.estimate) {
        return false;
      }
      return (
        this.useMax ||
        Number(this.estimate.amountSat) * 2 > Number(this.channel.localBalance)
      );
    },
    addressGroups() {
      return (this.address.trim().match(/.{1,4}/g) || []).join(" ");
    },
    canReview() {
      return Boolean(
        this.hasAmount &&
          this.estimate &&
          !this.estimate.refusalCode &&
          !this.error &&
          (this.isIn ||
            this.destination === "wallet" ||
            this.address.trim().length > 0)
      );
    }
  },
  methods: {
    minutesText,
    textFor(est) {
      return refusalText(est.refusalCode, {
        minSat: est.minSat,
        maxOutSat: est.maxOutSat,
        peerName: this.peerName
      });
    },
    request(extra) {
      return {
        channelPoint: this.channel.channelPoint,
        direction: this.direction,
        amountSat: this.useMax ? 0 : parseInt(this.amountInput, 10) || 0,
        useMax: this.useMax,
        // "Your Bitcoin wallet" sends no address: the node makes a fresh one.
        addr:
          !this.isIn && this.destination === "address"
            ? this.address.trim()
            : "",
        ...extra
      };
    },
    async post(path, payload) {
      const res = await API.post(
        `${process.env.VUE_APP_API_BASE_URL}/v1/lnd/channel/${path}`,
        payload
      );
      return res && res.data !== undefined ? res.data : res;
    },
    // What can be added or moved out, before an amount is entered.
    async loadLimits() {
      try {
        const est = await this.post(
          "splice/estimate",
          this.request({
            useMax: true,
            amountSat: 0,
            addr: "",
            targetConf: TARGETS.normal
          })
        );
        this.limits = {
          maxInSat: Number(est.maxInSat),
          maxOutSat: Number(est.maxOutSat),
          anchorReserveSat: Number(est.anchorReserveSat)
        };
      } catch (err) {
        // The form still works; the amounts' estimates carry the same.
      }
    },
    // Any change of amount, destination or maximum drops the estimate at
    // once: Review only ever shows what the node answered for the form as
    // it stands.
    estimateSoon() {
      clearTimeout(this.timer);
      this.seq += 1;
      this.estimate = null;
      this.error = "";
      this.timer = setTimeout(this.refreshFees, 400); // eslint-disable-line no-magic-numbers
    },
    // The three levels' totals come from the node, one estimate each; a
    // Mempool app's rates replace the node's in the selector.
    async refreshFees() {
      this.error = "";
      const seq = ++this.seq;
      if (!this.hasAmount) {
        this.fees = null;
        this.estimate = null;
        return;
      }
      this.$store.dispatch("bitcoin/getMempoolFees");
      this.estimating = true;
      try {
        const entries = await Promise.all(
          Object.entries(TARGETS).map(async ([speed, targetConf]) => [
            speed,
            await this.post("splice/estimate", this.request({ targetConf }))
          ])
        );
        if (seq !== this.seq) {
          return;
        }
        const fees = {};
        for (const [speed, est] of entries) {
          fees[speed] = {
            perByte: est.satPerVbyte,
            total: est.feeSat,
            error: est.refusalCode
              ? { code: est.refusalCode, text: this.textFor(est) }
              : false
          };
        }
        this.fees = fees;
        // The selector emits again only when its rate changes; the amount
        // may have changed under the same rate.
        await this.$nextTick();
        await this.estimateAt(seq);
      } catch (err) {
        if (seq === this.seq) {
          this.estimate = null;
          this.error = getErrorMessage(err, "Unable to estimate the resize.");
        }
      } finally {
        if (seq === this.seq) {
          this.estimating = false;
        }
      }
    },
    async selectFee(fee) {
      this.selectedFee = fee;
      await this.estimateAt(this.seq);
    },
    // The estimate at the chosen rate: what the review shows and the
    // splice uses. Only the latest request's answer counts, whether the
    // form or the rate changed since.
    async estimateAt(seq) {
      if (
        !this.hasAmount ||
        !this.selectedFee ||
        !(this.selectedFee.satPerByte > 0)
      ) {
        return;
      }
      const rateSeq = ++this.rateSeq;
      this.estimate = null;
      try {
        const est = await this.post(
          "splice/estimate",
          this.request({ satPerVbyte: this.selectedFee.satPerByte })
        );
        if (seq !== this.seq || rateSeq !== this.rateSeq) {
          return;
        }
        this.estimate = est;
        // The limits move with the rate: the fee comes out of them.
        this.limits = {
          maxInSat: Number(est.maxInSat),
          maxOutSat: Number(est.maxOutSat),
          anchorReserveSat: Number(est.anchorReserveSat)
        };
        if (this.useMax && !est.refusalCode) {
          this.amountInput = String(est.amountSat);
        }
      } catch (err) {
        if (seq === this.seq && rateSeq === this.rateSeq) {
          this.estimate = null;
          this.error = getErrorMessage(err, "Unable to estimate the resize.");
        }
      }
    },
    async start() {
      this.step = "agreeing";
      try {
        const res = await this.post(
          "splice",
          this.request({
            satPerVbyte: this.estimate.satPerVbyte,
            amountSat: this.estimate.amountSat,
            useMax: false
          })
        );
        if (res.state === "aborted") {
          this.failure = res.reasonFromPeer
            ? { fromPeer: true, text: "", peerMessage: res.reason }
            : {
                fromPeer: false,
                text: refusalText(res.reason, { peerName: this.peerName }),
                peerMessage: ""
              };
          this.step = "failed";
          this.$emit("changed");
          return;
        }
        this.txid = res.txid;
        this.step = res.state === "signed" ? "waiting" : "started";
        this.$emit("changed");
      } catch (err) {
        // A request the backend refused (4xx) started nothing. Anything
        // else, a lost connection or the node's stream failing, may have
        // left the node going on without us hearing it.
        const status = err && err.response ? err.response.status : 0;
        const refused = status >= 400 && status < 500; // eslint-disable-line no-magic-numbers
        this.failure = {
          fromPeer: false,
          unknown: !refused,
          text: getErrorMessage(err, "No answer from your node."),
          peerMessage: ""
        };
        this.step = "failed";
        this.$emit("changed");
      }
    }
  },
  created() {
    this.$store.dispatch("bitcoin/getBalance");
    this.loadLimits();
    if (this.initialAmount > 0) {
      this.amountInput = String(this.initialAmount);
      this.estimateSoon();
    }
  },
  beforeDestroy() {
    clearTimeout(this.timer);
    this.seq += 1;
  },
  components: {
    Bar,
    FeeSelector,
    TxLink
  }
};
</script>

<style lang="scss" scoped>
.legend-small {
  font-size: inherit;
}
.address-groups {
  word-spacing: 0.25rem;
  overflow-wrap: anywhere;
}
.peer-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 8rem;
  overflow: auto;
  font-size: 0.8rem;
  background: rgba(0, 0, 0, 0.04);
  padding: 0.5rem;
  border-radius: 4px;
}
@media (max-width: 575px) {
  .resize-buttons {
    flex-direction: column-reverse;
  }
  .resize-buttons .btn {
    width: 100%;
    margin: 0.25rem 0 !important;
  }
}
</style>
