<template>
  <div>
    <div class="mb-4">
      <div class="d-flex justify-content-between">
        <h4
          class="text-primary font-bold"
          v-b-tooltip.hover.right
          :title="channel.localBalance | satsToFiat"
        >
          {{ channel.localBalance | unit | localize }} {{ unit | formatUnit }}
        </h4>
        <h4
          class="text-success font-bold text-right"
          v-b-tooltip.hover.left
          :title="channel.remoteBalance | satsToFiat"
        >
          {{ channel.remoteBalance | unit | localize }} {{ unit | formatUnit }}
        </h4>
      </div>
      <bar
        :local="Number(channel.localBalance)"
        :remote="Number(channel.remoteBalance)"
        size="lg"
        class="my-1"
      ></bar>
      <div class="d-flex justify-content-between">
        <b class="text-muted">Max Send</b>
        <b class="text-muted text-right">Max Receive</b>
      </div>
    </div>

    <transition name="mode-change" mode="out-in">
      <div v-if="!isReviewingChannelClose">
        <div
          class="d-flex justify-content-between align-items-center mt-1 mb-3"
        >
          <span class="text-muted">Status</span>
          <span class="text-capitalize font-bold">{{ channel.status }}</span>
        </div>
        <!-- we do not render Channel Type when 'private' property does not exist on channel (e.g., from PendingChannels rpc) -->
        <div v-if="channel.private !== undefined" class="d-flex justify-content-between align-items-center mb-3">
          <span class="text-muted">Channel Type</span>
          <span class="text-capitalize font-bold"
            >{{ channel.private ? "Private" : "Public" }} Channel</span
          >
        </div>

        <!-- Only daemons from 0.21.3-beta-blake2b.13 report it. -->
        <div
          v-if="channel.unifiedSigs !== undefined"
          class="d-flex justify-content-between align-items-center mb-3"
          v-b-tooltip.hover.top
          title="Whether this channel's signatures bind to the Bitcoin BLAKE2b chain. A node holding such a channel must not go back to a version from before 0.21.3-beta-blake2b.10, which cannot sign for it."
        >
          <span class="text-muted">Chain-bound Signatures</span>
          <span class="font-bold">{{ channel.unifiedSigs ? "Yes" : "No" }}</span>
        </div>

        <div class="d-flex justify-content-between align-items-center mb-3">
          <span class="text-muted">Remote Peer Alias</span>
          <div class="w-75 text-right">
            <span class="font-bold" style="overflow-wrap: break-word;">{{
              channel.remoteAlias
            }}</span>
          </div>
        </div>

        <div
          class="d-flex justify-content-between align-items-center mb-3"
          v-if="channel.status !== 'Closing'"
        >
          <span class="text-muted">Opened By</span>
          <span class="text-capitalize font-bold">{{
            channel.initiator ? "Your node" : "Remote peer"
          }}</span>
        </div>

        <div class="d-flex justify-content-between align-items-center mb-3">
          <span class="text-muted">Local Balance</span>
          <span
            v-b-tooltip.hover.left
            :title="channel.localBalance | satsToFiat"
            class="text-capitalize font-bold"
          >
            {{ channel.localBalance | unit | localize }}
            {{ unit | formatUnit }}
          </span>
        </div>

        <div class="d-flex justify-content-between align-items-center mb-3">
          <span class="text-muted">Remote Balance</span>
          <span
            v-b-tooltip.hover.left
            :title="channel.remoteBalance | satsToFiat"
            class="text-capitalize font-bold"
          >
            {{ channel.remoteBalance | unit | localize }}
            {{ unit | formatUnit }}
          </span>
        </div>

        <div class="d-flex justify-content-between align-items-center mb-3">
          <span class="text-muted">Channel Capacity</span>
          <span
            v-b-tooltip.hover.left
            :title="channel.capacity | satsToFiat"
            class="text-capitalize font-bold"
          >
            {{ channel.capacity | unit | localize }}
            {{ unit | formatUnit }}
          </span>
        </div>

        <div
          class="d-flex justify-content-between align-items-center mb-3"
          v-if="channel.status === 'Online'"
        >
          <span class="text-muted">Withdrawal Timelock</span>
          <span class="text-capitalize font-bold"
            >{{ parseInt(channel.csvDelay).toLocaleString() }} Blocks</span
          >
        </div>

        <div
          class="d-flex justify-content-between align-items-center mb-3"
          v-if="channel.status === 'Online'"
        >
          <span class="text-muted">Commit Fee</span>
          <span class="text-capitalize font-bold">
            {{ channel.commitFee | unit | localize }}
            {{ unit | formatUnit }}
          </span>
        </div>

        <div
          class="d-flex justify-content-between align-items-center mb-3"
          v-if="channel.status === 'Opening' && confirmationsLeft > 0"
        >
          <span class="text-muted">Confirmations</span>
          <span class="font-bold">{{ confirmationsSoFar }} so far</span>
        </div>

        <div
          class="d-flex justify-content-between align-items-center mb-3"
          v-if="fundingTxid"
        >
          <span class="text-muted">Funding Transaction</span>
          <tx-link :txid="fundingTxid"></tx-link>
        </div>

        <div
          class="d-flex justify-content-between align-items-center mb-3"
          v-if="channel.closingTxid"
        >
          <span class="text-muted">Closing Transaction</span>
          <tx-link :txid="channel.closingTxid"></tx-link>
        </div>
        <div
          class="d-flex justify-content-between align-items-center mb-3"
          v-else-if="channel.status === 'Closing'"
        >
          <span class="text-muted">Closing Transaction</span>
          <small class="font-bold text-muted">Not known yet</small>
        </div>

        <div class="d-flex justify-content-between align-items-center mb-1">
          <span class="text-muted">Connect To</span>
        </div>
        <!-- What to enter to open a channel to this node: its key and an
             address it announces. A node that announces none can only be
             given as a key. -->
        <div class="mb-3">
          <template v-if="connectStrings.length">
            <input-copy
              v-for="uri in connectStrings"
              :key="uri"
              size="sm"
              :value="uri"
              class="mb-1"
            ></input-copy>
          </template>
          <template v-else>
            <input-copy
              size="sm"
              :value="channel.remotePubkey"
              class="mb-1"
            ></input-copy>
            <small class="text-muted"
              >No address is known for this node, as is usual for one with
              only private channels. To open a channel to it, ask its
              operator for an address and add it after the key, as
              key@host:port.</small
            >
          </template>
        </div>

        <div class="d-flex justify-content-end" v-if="canCloseChannel">
          <b-button class="mt-2" variant="danger" @click="reviewChannelClose"
            >Close Channel</b-button
          >
        </div>
      </div>

      <div v-else>
        <h3 class="mb-3">Are you sure you want to close this channel?</h3>
        <p>
          Your local channel balance of
          <b>{{ parseInt(channel.localBalance).toLocaleString() }} Sats</b>
          (excluding transaction fee) will be returned to your Bitcoin wallet.
        </p>
        <b-alert v-if="channel.status === 'Offline'" variant="warning" show>
          This channel is not online. It may take up to 24 hours to close it.
        </b-alert>

        <div class="d-flex justify-content-end">
          <b-button
            class="mt-2"
            variant="danger"
            @click="confirmChannelClose"
            :disabled="isClosing"
            >{{ isClosing ? "Closing Channel..." : "Confirm Close" }}</b-button
          >
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import Bar from "@/components/Channels/Bar";
import TxLink from "@/components/Utility/TxLink";
import InputCopy from "@/components/Utility/InputCopy";
import API from "@/helpers/api";
import getErrorMessage from "@/helpers/error-message";

export default {
  props: {
    channel: Object,
  },
  data() {
    return {
      isReviewingChannelClose: false,
      isClosing: false,
    };
  },
  computed: {
    unit() {
      return this.$store.state.system.unit;
    },
    // key@host:port for each address the peer announces.
    connectStrings() {
      const pubkey = this.channel.remotePubkey || "";
      return (this.channel.remoteAddresses || []).map(
        (addr) => `${pubkey}@${addr}`
      );
    },
    // The channel point is the funding outpoint, txid:index.
    fundingTxid() {
      const point = this.channel.channelPoint || "";
      const txid = point.split(":")[0];
      return /^[0-9a-fA-F]{64}$/.test(txid) ? txid : "";
    },
    confirmationsNeeded() {
      return 3;
    },
    confirmationsLeft() {
      const left = parseInt(this.channel.remainingConfirmations, 10);
      return Number.isFinite(left) ? Math.max(0, left) : 0;
    },
    confirmationsSoFar() {
      return Math.max(0, this.confirmationsNeeded - this.confirmationsLeft);
    },
    canCloseChannel() {
      if (
        this.channel.status === "Opening" ||
        this.channel.status === "Closing"
      ) {
        return false;
      }
      return true;
    },
  },
  methods: {
    reviewChannelClose() {
      this.isReviewingChannelClose = true;
    },
    async confirmChannelClose() {
      this.isClosing = true;

      try {
        const payload = {
          channelPoint: this.channel.channelPoint,
          force: !this.channel.active, // Avoids force closing if channel is active
        };
        await API.delete(
          `${process.env.VUE_APP_API_BASE_URL}/v1/lnd/channel/close`,
          payload
        );
        this.$emit("channelclose");
        setTimeout(() => {
          this.$bvToast.toast(`Channel closed`, {
            title: "Lightning Network",
            autoHideDelay: 3000,
            variant: "success",
            solid: true,
            toaster: "b-toaster-bottom-right",
          });
        }, 200);
      } catch (err) {
        this.$bvToast.toast(
          getErrorMessage(err, "Unable to close channel. Please try again."),
          {
            title: "Error",
            autoHideDelay: 3000,
            variant: "danger",
            solid: true,
            toaster: "b-toaster-bottom-right",
          }
        );
      }
      this.isClosing = false;
    },
  },
  components: {
    Bar,
    TxLink,
    InputCopy,
  },
};
</script>

<style lang="scss" scoped>
.mode-change-enter-active,
.mode-change-leave-active {
  transition: transform 0.3s, opacity 0.3s linear;
}

.mode-change-enter {
  transform: translate3d(20px, 0, 0);
  opacity: 0;
}

.mode-change-enter-to {
  transform: translate3d(0, 0, 0);
  opacity: 1;
}

.mode-change-leave {
  transform: translate3d(0, 0, 0);
  opacity: 1;
}

.mode-change-leave-to {
  transform: translate3d(-20px, 0, 0);
  opacity: 0;
}
</style>
