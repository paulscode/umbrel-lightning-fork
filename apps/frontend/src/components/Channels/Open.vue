<template>
  <form @submit.prevent="openChannel">
    <b-row>
      <b-col col cols="12" sm="6">
        <label class="sr-onlsy" for="peer-connection">Node ID</label>
        <b-input
          id="peer-connection"
          class="mb-3 neu-input"
          placeholder="pubkey@ip:port"
          type="text"
          size="lg"
          v-model="peerConnectionCode"
          :disabled="isOpening"
          autofocus
        ></b-input>
      </b-col>
      <b-col col cols="12" sm="6">
        <label class="sr-onlsy" for="funding-amount">Amount</label>
        <div class="mb-3">
          <div>
            <b-input-group class="neu-input-group">
              <b-input
                id="funding-amount"
                class="neu-input"
                type="text"
                size="lg"
                v-model="fundingAmountInput"
                style="padding-right: 82px"
                :disabled="isOpening || sweep"
              ></b-input>
              <b-input-group-append class="neu-input-group-append">
                <sats-btc-switch
                  class="align-self-center"
                  size="sm"
                ></sats-btc-switch>
              </b-input-group-append>
            </b-input-group>
          </div>
          <div class="mt-1 w-100 d-flex justify-content-between">
            <!-- TODO: Enable Sweep -->
            <!-- <b-form-checkbox v-model="sweep" size="sm" switch>
              <small class="text-muted">Use all funds</small>
            </b-form-checkbox>-->
            <div></div>
            <small
              class="text-muted d-block mb-0"
              :style="{ opacity: fundingAmount > 0 ? 1 : 0 }"
              >~ {{ fundingAmount | satsToFiat }}</small
            >
          </div>
        </div>

        <!-- <small>{{ btc.confirmed.toLocaleString() }} Sats available out of {{ btc.total.toLocaleString() }} and {{ btc.pending.toLocaleString() }} pending</small> -->
      </b-col>
    </b-row>
    <b-row>
      <b-col col cols="12" sm="6">
        <fee-selector :fee="fee" :mempool-fees="mempoolFees" class @change="selectFee"></fee-selector>
      </b-col>
      <b-col class="d-flex" col cols="12" sm="6">
        <div class="w-100 d-flex flex-column justify-content-between">
          <div class="mt-4 mt-sm-0 d-flex justify-content-between">
            <div class="d-flex">
              <label class="sr-onlsy" for="private-channel">Private Channel</label>
              <div class="ml-1">
                <b-popover
                  target="private-channel-popover"
                  placement="bottom"
                  triggers="hover focus"
                >
                  <p>Private channels provide increased privacy by not broadcasting details to the entire Lightning Network. However, they have limited routing capabilities compared to public channels.</p>
                </b-popover>

                <b-icon
                  id="private-channel-popover"
                  icon="info-circle"
                  size="lg"
                  style="cursor: pointer"
                  class="text-muted"
                ></b-icon>
              </div>
            </div>
            <toggle-switch
              id="private-channel"
              class=""
              :on="isPrivate"
              @toggle="status => (isPrivate = status)"
            ></toggle-switch>
          </div>
          <div
            class="mt-4 mt-sm-0 d-flex w-100 justify-content-end"
          >
            <b-button
              type="submit"
              variant="success"
              :disabled="isOpening || !!error"
              >{{ this.isOpening ? "Opening..." : "Open Channel" }}</b-button
            >
          </div>
        </div>
      </b-col>
    </b-row>
    <small v-if="feeNotice && !error" class="d-block text-muted mt-2">{{ feeNotice }}</small>
    <b-alert v-if="error" show variant="danger" class="mt-2 mb-0 d-flex align-items-center">
      <b-icon class="d-block mr-2" icon="exclamation-triangle-fill"></b-icon>
      <small class="align-self-center">
        {{ error }}
      </small>
    </b-alert>
  </form>
</template>

<script>
import { mapState } from "vuex";

import API from "@/helpers/api";
import getErrorMessage from "@/helpers/error-message";
import { satsToBtc, btcToSats } from "@/helpers/units.js";

import SatsBtcSwitch from "@/components/Utility/SatsBtcSwitch";
import FeeSelector from "@/components/Utility/FeeSelector";
import ToggleSwitch from "@/components/Utility/ToggleSwitch";

// Estimate errors no fee rate can fix: they stop the channel. Others only mean
// there was no estimate, and a custom rate still opens it.
const HARD_ESTIMATE_ERRORS = ["INSUFFICIENT_FUNDS", "OUTPUT_IS_DUST", "INVALID_ADDRESS"];

export default {
  props: {},
  data() {
    return {
      peerConnectionCode: "",
      fundingAmountInput: "",
      fundingAmount: 0,
      isOpening: false,
      selectedFee: {
        type: "medium",
        speed: "normal",
        satPerByte: 0,
        total: 0,
      },
      fee: {
        fast: {
          total: 0,
          perByte: "--",
          error: "",
          errorCode: "",
          sweepAmount: 0,
        },
        normal: {
          total: 0,
          perByte: "--",
          error: "",
          errorCode: "",
          sweepAmount: 0,
        },
        slow: {
          total: 0,
          perByte: "--",
          error: "",
          errorCode: "",
          sweepAmount: 0,
        },
        cheapest: {
          total: 0,
          perByte: "--",
          error: "",
          errorCode: "",
          sweepAmount: 0,
        },
      },
      isPrivate: false,
      error: "",
      // Why there is no estimate, when no rate could fix it either way: not
      // blocking, since a custom rate still opens the channel.
      feeNotice: "",
      feeTimeout: null,
      sweep: false,
    };
  },
  computed: {
    ...mapState({
      unit: (state) => state.system.unit,
      confirmedBtcBalance: (state) => state.bitcoin.balance.confirmed,
      mempoolFees: (state) => state.bitcoin.mempoolFees,
    }),
  },
  methods: {
    selectFee(fee) {
      // The estimate's error stands until the next estimate: a level with
      // an error cannot be chosen, so a choice never clears one.
      this.selectedFee = fee;
    },
    async openChannel() {
      this.isOpening = true;

      if (!this.peerConnectionCode || this.fundingAmount <= 0) {
        this.error = "Please fill all fields";
        this.isOpening = false;
        return;
      }

      // The node's estimate for the level's target sizes the transaction
      // and carries the errors that matter (funds, address, dust). Others
      // (no estimate could be made) do not stop a channel at a custom rate,
      // nor at a level that has its own estimate.
      const sized = this.fee[this.selectedFee.speed || "fast"];
      if (sized && sized.error && HARD_ESTIMATE_ERRORS.includes(sized.errorCode)) {
        this.isOpening = false;
        this.error = sized.error;
        return;
      }

      // No estimate and no custom rate: lnd would pick a rate nobody saw.
      if (!(parseInt(this.selectedFee.satPerByte, 10) > 0)) {
        this.isOpening = false;
        this.error =
          "The node has no fee estimate right now. Set a custom fee rate to open the channel.";
        return;
      }

      this.error = "";

      // When every coin goes into the channel, the amount is what is left
      // after the fee at the chosen rate, not at the node's target rate.
      const sweepAmount = sized
        ? parseInt(sized.sweepAmount, 10) +
          (parseInt(sized.total, 10) || 0) -
          (parseInt(this.selectedFee.total, 10) || 0)
        : 0;
      const payload = {
        amt: this.sweep ? sweepAmount : parseInt(this.fundingAmount, 10),
        name: "",
        purpose: "",
        satPerByte: parseInt(this.selectedFee.satPerByte, 10),
        isPrivate: this.isPrivate
      };

      const parsedConnectionCode = this.peerConnectionCode.match(
        /^(.*?)@(.*?)(?::([0-9]+))?$/
      );

      if (parsedConnectionCode) {
        payload.pubKey = parsedConnectionCode[1];
        payload.ip = parsedConnectionCode[2];

        // If we matched a port in the connection code
        // Otherwise the backend will automatically determine which port to use
        if (parsedConnectionCode[3]) {
          payload.port = parsedConnectionCode[3];
        }
      } else {
        this.isOpening = false;
        this.error =
          "Please check the Node ID (also known as peer address)";
        return;
      }

      //to do: connect to onion node if only the user's node is running tor

      try {
        await API.post(
          `${process.env.VUE_APP_API_BASE_URL}/v1/lnd/channel/open`,
          payload
        );
        this.isOpening = false;
        this.$emit("channelopen");
        //channel
        setTimeout(() => {
          this.$bvToast.toast(
            `Channel of ${this.fundingAmount} Sats opened successfully`,
            {
              title: "Lightning Network",
              autoHideDelay: 3000,
              variant: "success",
              solid: true,
              toaster: "b-toaster-bottom-right",
            }
          );
        }, 200);
      } catch (error) {
        this.isOpening = false;
        this.error = getErrorMessage(
          error,
          "Unable to open channel. Please try again."
        );
      }
    },

    async fetchFees() {
      if (this.feeTimeout) {
        clearTimeout(this.feeTimeout);
      }
      this.feeTimeout = setTimeout(async () => {
        this.error = "";
        this.feeNotice = "";
        if (this.fundingAmount) {
          this.$store.dispatch("bitcoin/getMempoolFees");
          // The dashboard's GET helper answers false when the request
          // fails, and undefined while the same one is still on its way.
          const estimates = await API.get(
            `${process.env.VUE_APP_API_BASE_URL}/v1/lnd/channel/estimateFee?confTarget=0&amt=${this.fundingAmount}&sweep=${this.sweep}`
          );

          if (estimates === false) {
            // No figures from before are left standing for a new amount.
            for (const speed of Object.keys(this.fee)) {
              this.fee[speed].total = 0;
              this.fee[speed].perByte = "N/A";
              this.fee[speed].error = "No estimate";
              this.fee[speed].errorCode = "ESTIMATE_FAILED";
              this.fee[speed].sweepAmount = 0;
            }
            this.feeNotice =
              "Your node could not estimate the fee just now. Set a custom fee rate, or change the amount to try again.";
            return;
          }

          if (estimates) {
            for (const [speed, estimate] of Object.entries(estimates)) {
              if (!this.fee[speed]) {
                continue;
              }
              // If the API returned an error message
              if (estimate.text) {
                this.fee[speed].total = 0;
                this.fee[speed].perByte = "N/A";
                this.fee[speed].error = estimate.text;
                this.fee[speed].errorCode = estimate.code || "";
                this.fee[speed].sweepAmount = 0;
              } else {
                this.fee[speed].total = estimate.feeSat;
                this.fee[speed].perByte = estimate.feerateSatPerByte;
                this.fee[speed].sweepAmount = estimate.sweepAmount;
                this.fee[speed].error = false;
                this.fee[speed].errorCode = "";
              }
            }

            // The fast level's error is the one every level shares when it
            // is about the amount or address (funds, dust): that one stops
            // the channel. Any other only means that level has no estimate,
            // https://github.com/getumbrel/umbrel-dashboard/issues/198
            const fast = estimates.fast;
            if (fast && fast.text) {
              if (HARD_ESTIMATE_ERRORS.includes(fast.code)) {
                this.error = fast.text;
              } else {
                this.feeNotice = `${fast.text} A custom fee rate can still be set.`;
              }
            }
          }
        }
      }, 500);
    },
  },
  watch: {
    unit: function(val) {
      if (val === "sats") {
        this.fundingAmount = Number(this.fundingAmountInput);
      } else if (val === "btc") {
        this.fundingAmount = btcToSats(this.fundingAmountInput);
      }
      this.fetchFees();
    },
    sweep: function(val) {
      if (val) {
        if (this.unit === "btc") {
          this.fundingAmountInput = String(satsToBtc(this.confirmedBtcBalance));
        } else if (this.unit === "sats") {
          this.fundingAmountInput = String(this.confirmedBtcBalance);
        }
      }
      this.fetchFees();
    },
    fundingAmountInput: function(val) {
      if (this.unit === "sats") {
        this.fundingAmount = Number(val);
      } else if (this.unit === "btc") {
        this.fundingAmount = btcToSats(val);
      }
      this.fetchFees();
    },
  },
  components: {
    SatsBtcSwitch,
    FeeSelector,
    ToggleSwitch
  },
};
</script>

<style lang="scss" scoped></style>
