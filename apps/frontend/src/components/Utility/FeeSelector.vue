<template>
  <div>
    <div class="d-flex w-100 justify-content-between">
      <small class="text-muted block mb-0">Transaction Fee</small>
      <b-form-checkbox
        v-model="useCustomFee"
        class=""
        size="sm"
        switch
        :disabled="isDisabled"
      >
        <small class="text-muted">Custom</small>
      </b-form-checkbox>
    </div>
    <div class="vue-slider-container" v-if="useCustomFee">
      <vue-slider
        v-model="customFee"
        :marks="false"
        hide-label
        :min="customMinFee"
        :max="customMaxFee"
        :interval="1"
        :dotSize="[22, 22]"
        contained
        :tooltip="isDisabled ? 'none' : 'always'"
        :disabled="isDisabled"
        @change="emitValue"
        key="custom-fee"
      >
        <template v-slot:tooltip="{ value, focus }">
          <div
            :class="[
              'vue-slider-dot-tooltip-inner vue-slider-dot-tooltip-inner-top',
              { focus },
            ]"
          >
            <span class="vue-slider-dot-tooltip-text block"
              >{{ value }} sat/vB
            </span>
            <small class="text-muted d-sm-inline d-block"
              >≈ {{ totalFor(value) | satsToFiat }}</small
            >
          </div>
        </template>
      </vue-slider>
      <div class="d-flex w-100 justify-content-between custom-fee-labels">
        <small class="text-muted mb-0">Slow</small>
        <small class="text-muted mb-0">Fast</small>
      </div>
    </div>
    <div class="fee-levels" v-else>
      <div class="d-flex w-100 fee-level-row">
        <b-button
          v-for="level in levels"
          :key="level.key"
          class="fee-level flex-fill mx-1"
          :variant="chosen === level.key ? 'primary' : 'outline-secondary'"
          :disabled="isDisabled || Boolean(level.error)"
          :title="errorText(level.error) || level.hint"
          @click="choose(level.key)"
        >
          <span class="d-block fee-level-label">{{ level.label }}</span>
          <small class="d-block fee-level-rate">
            <template v-if="!isDisabled && !level.error">{{ level.rate }} sat/vB</template>
            <template v-else>—</template>
          </small>
        </b-button>
      </div>
      <div class="d-flex w-100 justify-content-between align-items-baseline mt-2">
        <small class="text-muted">{{ sourceLabel }}</small>
        <small v-if="!isDisabled && chosenLevel && !chosenLevel.error" class="text-muted text-right">
          ≈ {{ chosenLevel.total | satsToFiat }}
        </small>
      </div>
    </div>
  </div>
</template>

<script>
import VueSlider from "vue-slider-component";
// import "vue-slider-component/theme/default.css";

// Low, Medium and High are the rates the chosen Mempool app shows on its
// own page (hourFee, halfHourFee and fastestFee of its recommended fees),
// or, without an app, the node's estimate for 24, 6 and 1 blocks. The
// node's estimate is always fetched: it sizes the transaction, which is
// how a rate becomes a total.
// The stores keep an estimate's error as false, a string, or an object
// with code and text, and start with an empty object: only one that says
// something counts.
function hasError(error) {
  if (!error) {
    return false;
  }
  if (typeof error === "string") {
    return error.length > 0;
  }
  return Boolean(error.code || error.text);
}

const LEVELS = [
  { key: "low", label: "Low", speed: "slow", mempoolKey: "hourFee", hint: "Low priority" },
  { key: "medium", label: "Medium", speed: "normal", mempoolKey: "halfHourFee", hint: "Medium priority" },
  { key: "high", label: "High", speed: "fast", mempoolKey: "fastestFee", hint: "High priority" },
];

export default {
  props: {
    fee: Object,
    // { app, name, fees: { fastestFee, halfHourFee, hourFee, ... } | null, error }
    mempoolFees: {
      type: Object,
      default: null,
    },
    customMinFee: {
      type: Number,
      default: 1,
    },
    customMaxFee: {
      type: Number,
      default: 350,
    },
    disabled: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      chosen: "medium",
      useCustomFee: false,
      customFee: 30,
      lastEmitted: "",
    };
  },
  computed: {
    isDisabled() {
      return (
        !this.fee ||
        !this.fee.fast ||
        this.fee.fast.total <= 0 ||
        this.fee.fast.total === "--" ||
        this.fee.fast.total === "N/A" ||
        this.disabled
      );
    },
    usingMempool() {
      return Boolean(
        this.mempoolFees && this.mempoolFees.fees && this.mempoolFees.app
      );
    },
    // The size of the transaction in vbytes, from the node's estimate for
    // any target: fee and rate come from the same transaction.
    vbytes() {
      const sized = ["fast", "normal", "slow", "cheapest"]
        .map((speed) => this.fee && this.fee[speed])
        .find((f) => f && !f.error && Number(f.perByte) > 0 && Number(f.total) > 0);
      return sized ? Number(sized.total) / Number(sized.perByte) : 0;
    },
    // The node's floor in sat/vB, under which it refuses to broadcast: an
    // app on another node may recommend less.
    minRelayRate() {
      const floor = this.mempoolFees && Number(this.mempoolFees.minRelayFeeSatPerVbyte);
      return Number.isFinite(floor) && floor > 0 ? floor : 0;
    },
    levels() {
      return LEVELS.map((level) => {
        if (this.usingMempool) {
          const rate = Math.max(1, Math.ceil(Number(this.mempoolFees.fees[level.mempoolKey])));
          // The node's fast estimate sizes the transaction and carries the
          // errors that hold for every rate (funds, address, dust); the
          // parent checks the same estimate, so both agree. A rate under
          // the node's own floor is refused here rather than at broadcast.
          const fast = (this.fee && this.fee.fast) || {};
          let error = hasError(fast.error) ? fast.error : false;
          if (!error && this.minRelayRate && rate < this.minRelayRate) {
            error = {
              code: "FEE_RATE_TOO_LOW",
              text: `Below your node's minimum relay fee of ${this.minRelayRate} sat/vB`,
            };
          }
          return {
            ...level,
            speed: "fast",
            rate,
            total: Math.round(this.vbytes * rate),
            error,
          };
        }
        const nodeFee = (this.fee && this.fee[level.speed]) || {};
        return {
          ...level,
          rate: nodeFee.perByte,
          total: Number(nodeFee.total) || 0,
          error: hasError(nodeFee.error) ? nodeFee.error : false,
        };
      });
    },
    chosenLevel() {
      return this.levels.find((level) => level.key === this.chosen) || null;
    },
    sourceLabel() {
      if (this.usingMempool) {
        return `Rates from ${this.mempoolFees.name}`;
      }
      if (this.mempoolFees && this.mempoolFees.error) {
        return `${this.mempoolFees.name || "The Mempool app"} is not answering; rates estimated by your node`;
      }
      return "Rates estimated by your node";
    },
  },
  methods: {
    errorText(error) {
      if (!hasError(error)) {
        return "";
      }
      return typeof error === "string" ? error : error.text || "";
    },
    totalFor(rate) {
      return Math.round(this.vbytes * Number(rate));
    },
    choose(key) {
      this.chosen = key;
      this.emitValue();
    },
    // The parent hears each change once: a store write that changes
    // nothing, or a second fee source arriving with the same numbers, does
    // not repeat the last value.
    emit(payload) {
      const key = JSON.stringify(payload);
      if (key === this.lastEmitted) {
        return;
      }
      this.lastEmitted = key;
      this.$emit("change", payload);
    },
    emitValue() {
      if (this.useCustomFee) {
        const rate = parseInt(this.customFee, 10);
        this.emit({
          type: "custom",
          speed: "fast",
          satPerByte: rate,
          total: this.totalFor(rate),
        });
        return;
      }
      // A level the node refuses (too low for its mempool, say) cannot be
      // sent: move to the next one up so the page never holds a rate the
      // node will reject.
      let level = this.chosenLevel;
      if (level && level.error) {
        const usable = this.levels.find((l) => !l.error);
        if (usable) {
          this.chosen = usable.key;
          level = usable;
        }
      }
      if (!level) {
        return;
      }
      this.emit({
        type: level.key,
        speed: level.speed,
        satPerByte: parseInt(level.rate, 10) || 0,
        total: level.total,
      });
    },
  },
  // The parent starts with no rate; say which one is chosen as soon as
  // there is one, not only when an estimate changes.
  mounted() {
    this.emitValue();
  },
  watch: {
    useCustomFee: function() {
      this.emitValue();
    },
    fee: {
      handler: function() {
        this.emitValue();
      },
      deep: true,
    },
    mempoolFees: {
      handler: function() {
        this.emitValue();
      },
      deep: true,
    },
  },
  components: {
    VueSlider,
  },
};
</script>

<style lang="scss">
/* Set the theme color of the component */
$themeColor: #edeef1;

$bgColor: #edeef1;
$railBorderRadius: 15px !default;

$dotShadow: 0px 4px 10px rgba(0, 0, 0, 0.25);
$dotShadowFocus: 0px 4px 10px rgba(0, 0, 0, 0.4);
$dotBgColor: #fff !default;
$dotBgColorDisable: #ccc !default;
$dotBorderRadius: 50% !default;

$tooltipBgColor: #fff !default;
$tooltipColor: #141821 !default;
$tooltipBorderRadius: 5px !default;
$tooltipPadding: 2px 5px !default;
$tooltipMinWidth: 20px !default;
$tooltipArrow: 10px !default;
$tooltipFontSize: 0.8rem !default;

$stepBorderRadius: 50% !default;
$stepBgColor: rgba(0, 0, 0, 0.1) !default;

$labelFontSize: 0.8rem;

/* import theme style */
@import "vue-slider-component/lib/theme/default.scss";

.vue-slider-container {
  padding-top: 3rem;
  padding-bottom: 1.5rem;
  margin-bottom: 1rem;
  position: relative;
}

.fee-levels {
  padding-top: 0.75rem;
  padding-bottom: 0.5rem;
  margin-bottom: 1rem;
}
.fee-level-row {
  margin-left: -0.25rem;
  margin-right: -0.25rem;
}
.fee-level {
  padding: 0.4rem 0.25rem;
  line-height: 1.2;
  border-radius: 0.75rem;
}
.fee-level-label {
  font-weight: 600;
}
.fee-level-rate {
  opacity: 0.85;
}

.vue-slider-ltr .vue-slider-mark-label,
.vue-slider-rtl .vue-slider-mark-label {
  margin-top: 1rem;
}

.vue-slider-dot-handle {
  transition: box-shadow 0.2s, background-color 0.2s ease;
}
.vue-slider-dot-tooltip {
  transition: opacity 0.2s ease;
}

.vue-slider-rail {
  cursor: pointer;
  background: linear-gradient(to right, #f6b900, #00cd98);
}
.vue-slider-process {
  background-color: transparent;
}
.vue-slider-disabled {
  .vue-slider-rail {
    cursor: not-allowed;
    background: #ccc;
  }
}
.vue-slider-dot-handle-disabled {
  box-shadow: none;
}

.vue-slider-dot-tooltip-inner {
  padding: 5px;
  font-size: 0.75rem;
  line-height: 1rem;
  box-shadow: 0 3px 15px rgba(0, 0, 0, 0.18);
}

.custom-fee-labels {
  position: absolute;
  bottom: 0;
  left: 0;
}
</style>
