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
        :local="barLocal"
        :remote="Number(channel.remoteBalance)"
        :change="pendingLocalDelta"
        size="lg"
        class="my-1"
      ></bar>
      <div class="d-flex justify-content-between">
        <b class="text-muted">Max Send</b>
        <b class="text-muted text-right">Max Receive</b>
      </div>
      <!-- In the details the resize block below says it. -->
      <small
        v-if="pendingSplice && !pendingSplice.dead && view !== 'details'"
        class="d-block text-muted"
      >
        {{ pendingSummary }}
      </small>

      <!-- Resizing: shown where the daemon can splice; the buttons stay
           visible and explain when they can't be used. -->
      <div v-if="showResizeButtons && view === 'details'" class="mt-3">
        <div class="d-flex resize-actions">
          <b-button
            variant="outline-primary"
            class="flex-fill mr-2"
            @click="openResize('in')"
          >Add funds</b-button>
          <b-button
            variant="outline-primary"
            class="flex-fill"
            @click="openResize('out')"
          >Move funds out</b-button>
        </div>
        <b-alert
          v-if="resizeExplanation"
          variant="info"
          show
          dismissible
          class="mt-2 mb-0"
          @dismissed="resizeExplanation = ''"
        >
          {{ resizeExplanation }}
          <a
            v-if="channel.spliceStatus === 'disabled' && !isStartOS"
            href="#"
            @click.prevent="$emit('opensettings')"
          >Open Advanced Settings</a>
        </b-alert>
      </div>
    </div>

    <transition name="mode-change" mode="out-in">
      <resize
        v-if="view === 'resize'"
        key="resize"
        :channel="channel"
        :direction="resizeDirection"
        :initial-amount="resizeAmount"
        @cancel="view = 'details'"
        @done="view = 'details'"
        @changed="$emit('channelresize')"
      ></resize>

      <div v-else-if="view === 'details'" key="details">
        <b-alert v-if="channel.fundingSpentUnknown" variant="warning" show>
          This channel's funds were moved by a transaction this version of
          Lightning Fork doesn't recognise, most likely a resize made with a
          newer version. Nothing will be closed or swept until you update
          Lightning Fork from the StartOS Marketplace, the Umbrel App Store or
          the release page.
        </b-alert>
        <div
          class="d-flex justify-content-between align-items-center mt-1 mb-3"
        >
          <span class="text-muted">Status</span>
          <span class="text-capitalize font-bold">{{ channel.status }}</span>
        </div>

        <b-alert
          v-if="channel.spliceStatus === 'peer_not_announcing'"
          variant="warning"
          show
        >
          {{ notAnnouncingText }}
        </b-alert>
        <div v-if="pendingSplice" class="mb-3">
          <div class="d-flex justify-content-between align-items-center mb-1">
            <span class="text-muted">Resize</span>
            <tx-link v-if="pendingSplice.txid" :txid="pendingSplice.txid"></tx-link>
          </div>
          <b-alert v-if="pendingSplice.dead" variant="warning" show class="mb-0">
            {{ pendingSummary }}
            <div class="mt-2">
              <b-button size="sm" variant="outline-secondary" @click="reviewChannelClose">
                Close channel…
              </b-button>
            </div>
          </b-alert>
          <p v-else class="mb-0">{{ pendingSummary }}</p>
          <small
            v-if="pendingSplice.relayStatus === 'rejected' && !pendingSplice.dead"
            class="d-block text-warning mt-1"
          >
            Your node's mempool refused the transaction<template
              v-if="relayReason"
            >: {{ relayReason }}</template>. It is offered again at every
            block.
          </small>
          <small v-if="slowSplice" class="d-block text-muted mt-1">
            This is taking longer than usual. The resize's fee rate is below
            what the network asks for now; it confirms once blocks have room.
          </small>
        </div>
        <div v-else-if="lastSpliceSummary" class="mb-3">
          <small class="text-muted">{{ lastSpliceSummary }}</small>
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
          <span class="font-bold">{{ confirmationsLeft }} to go</span>
        </div>

        <div
          class="d-flex justify-content-between align-items-center mb-3"
          v-if="fundingTxid"
        >
          <span class="text-muted">Opening Transaction</span>
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

      <div v-else-if="view === 'close'" key="close">
        <template v-if="pendingSplice && !pendingSplice.dead">
          <h3 class="mb-3">A resize is in progress</h3>
          <p>
            The channel can't be closed normally until it finishes<template
              v-if="spliceConfirmationsLeft > 0"
            > ({{ spliceConfirmationsLeft }} confirmation{{ spliceConfirmationsLeft === 1 ? "" : "s" }} left)</template>.
          </p>
        </template>
        <template v-else-if="channel.status === 'Offline'">
          <h3 class="mb-3">The peer is offline</h3>
          <p>
            A normal close needs both nodes online. Wait for the peer to come
            back, or force close the channel without it.
          </p>
        </template>
        <template v-else>
          <h3 class="mb-3">Are you sure you want to close this channel?</h3>
          <p>
            Your local channel balance of
            <b>{{ parseInt(channel.localBalance).toLocaleString() }} Sats</b>
            (excluding transaction fee) will be returned to your Bitcoin wallet.
          </p>
        </template>

        <div class="d-flex justify-content-end align-items-center close-actions">
          <b-button variant="link" class="mt-2 mr-2 text-danger" @click="view = 'force'">
            Force close…
          </b-button>
          <b-button class="mt-2 mr-2" variant="outline-secondary" @click="view = 'details'">
            Back
          </b-button>
          <b-button
            v-if="canCoopClose"
            class="mt-2"
            variant="danger"
            @click="confirmChannelClose(false)"
            :disabled="isClosing"
            >{{ isClosing ? "Closing Channel..." : "Confirm Close" }}</b-button
          >
        </div>
      </div>

      <div v-else-if="view === 'force'" key="force">
        <h3 class="mb-3">Force close this channel?</h3>
        <p>
          A force close publishes your node's latest copy of the channel
          without the peer. Your balance of
          <b>{{ parseInt(channel.localBalance).toLocaleString() }} Sats</b>
          returns to your Bitcoin wallet only after
          <b>{{ csvDelayText }}</b>, and the network fee is higher than for a
          normal close. Payments in flight are settled on-chain, which can
          cost more than they are worth.
        </p>
        <p v-if="pendingSplice">
          The resize in progress is dropped: the channel closes from the
          transaction that confirms.
        </p>
        <b-alert variant="warning" show>
          Use it only when the peer can't close with you.
        </b-alert>
        <div class="d-flex justify-content-end close-actions">
          <b-button class="mt-2 mr-2" variant="outline-secondary" @click="view = 'details'">
            Back
          </b-button>
          <b-button
            class="mt-2"
            variant="danger"
            @click="confirmChannelClose(true)"
            :disabled="isClosing"
            >{{ isClosing ? "Closing Channel..." : "Force Close" }}</b-button
          >
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import Bar from "@/components/Channels/Bar";
import Resize from "@/components/Channels/Resize";
import TxLink from "@/components/Utility/TxLink";
import InputCopy from "@/components/Utility/InputCopy";
import API from "@/helpers/api";
import getErrorMessage from "@/helpers/error-message";
import { statusText, pendingText, lastText } from "@/helpers/resize";

export default {
  props: {
    channel: Object,
    // { direction, amount }: a form to open on arrival.
    resizeRequest: {
      type: Object,
      default: null,
    },
  },
  data() {
    return {
      // details, resize, close or force.
      view: "details",
      resizeDirection: "in",
      resizeAmount: 0,
      resizeExplanation: "",
      isClosing: false,
    };
  },
  watch: {
    // Another channel chosen: back to its details.
    channelKey() {
      this.view = "details";
      this.resizeExplanation = "";
    },
    resizeRequest: {
      handler(request) {
        if (request) {
          this.$nextTick(() => this.openResize(request.direction, request.amount));
        }
      },
      immediate: true,
    },
  },
  computed: {
    channelKey() {
      return this.channel.originalChannelPoint || this.channel.channelPoint || "";
    },
    isStartOS() {
      return this.$store.state.system.platform === "startos";
    },
    pendingSplice() {
      return this.channel.pendingSplice || null;
    },
    // Our side's change while a resize is in progress.
    pendingLocalDelta() {
      if (!this.pendingSplice || this.pendingSplice.dead) {
        return 0;
      }
      return Number(this.pendingSplice.localDeltaSat) || 0;
    },
    // The local balance is the least across the channel's candidate
    // funding outputs: funds coming in are on top of it.
    barLocal() {
      return Number(this.channel.localBalance) + Math.max(0, this.pendingLocalDelta);
    },
    pendingSummary() {
      return pendingText(this.pendingSplice, {
        peerName: this.channel.remoteAlias,
        blockMinutes: this.pendingSplice && this.pendingSplice.blockMinutes,
      });
    },
    lastSpliceSummary() {
      return lastText(this.channel.lastSplice, { peerName: this.channel.remoteAlias });
    },
    spliceConfirmationsLeft() {
      if (!this.pendingSplice) {
        return 0;
      }
      const depth = Number(this.pendingSplice.lockDepth) || 0;
      return Math.max(0, depth - (Number(this.pendingSplice.confirmations) || 0));
    },
    notAnnouncingText() {
      return statusText("peer_not_announcing");
    },
    // The backend's reason, kept short.
    relayReason() {
      const r = String((this.pendingSplice && this.pendingSplice.relayReason) || "");
      return r.length > 160 ? `${r.slice(0, 160)}…` : r; // eslint-disable-line no-magic-numbers
    },
    // Six blocks since it went out, unconfirmed, at a rate under
    // what the Low level asks now.
    slowSplice() {
      const p = this.pendingSplice;
      if (!p || p.dead || Number(p.confirmations) > 0 || !(Number(p.broadcastHeight) > 0)) {
        return false;
      }
      const height = Number(this.$store.state.bitcoin.currentBlock) || 0;
      if (!height || height - Number(p.broadcastHeight) < 6) { // eslint-disable-line no-magic-numbers
        return false;
      }
      const mempool = this.$store.state.bitcoin.mempoolFees;
      const low = mempool && mempool.fees ? Number(mempool.fees.hourFee) : 0;
      return low > 0 && Number(p.satPerVbyte) < low;
    },
    // Only daemons that can splice report a status; closing channels hide
    // the buttons.
    showResizeButtons() {
      return (
        this.channel.type === "OPEN" &&
        typeof this.channel.spliceStatus === "string" &&
        this.channel.spliceStatus !== "" &&
        statusText(this.channel.spliceStatus) !== null
      );
    },
    // A failed resize doesn't stand in the way: it can never confirm.
    canCoopClose() {
      return (
        this.channel.status === "Online" &&
        (!this.pendingSplice || this.pendingSplice.dead)
      );
    },
    // The delay in blocks, and in time only at the chain's recent pace
    // when known: this chain's blocks don't come every ten minutes.
    csvDelayText() {
      const blocks = parseInt(this.channel.csvDelay, 10);
      if (!Number.isFinite(blocks) || blocks <= 0) {
        return "a delay set when the channel was opened";
      }
      const minutes = Number(
        this.pendingSplice && this.pendingSplice.blockMinutes
      );
      if (!(minutes > 0)) {
        return `${blocks.toLocaleString()} blocks`;
      }
      const hours = Math.round((blocks * minutes) / 60); // eslint-disable-line no-magic-numbers
      let about;
      if (hours < 2) { // eslint-disable-line no-magic-numbers
        about = "about an hour";
      } else if (hours < 48) { // eslint-disable-line no-magic-numbers
        about = `about ${hours} hours`;
      } else {
        about = `about ${Math.round(hours / 24)} days`; // eslint-disable-line no-magic-numbers
      }
      return `${blocks.toLocaleString()} blocks (${about})`;
    },
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
    // The transaction that opened the channel: a resize moves the channel
    // point, not the original one.
    fundingTxid() {
      const point = this.channel.originalChannelPoint || this.channel.channelPoint || "";
      const txid = point.split(":")[0];
      return /^[0-9a-fA-F]{64}$/.test(txid) ? txid : "";
    },
    confirmationsLeft() {
      const left = parseInt(this.channel.remainingConfirmations, 10);
      return Number.isFinite(left) ? Math.max(0, left) : 0;
    },
    canCloseChannel() {
      if (
        this.channel.status === "Opening" ||
        this.channel.status === "Closing" ||
        this.channel.status === "Needs update"
      ) {
        return false;
      }
      return true;
    },
  },
  methods: {
    reviewChannelClose() {
      this.view = "close";
    },
    openResize(direction, amount) {
      const why = statusText(this.channel.spliceStatus, {
        platform: this.$store.state.system.platform,
        dead: Boolean(this.pendingSplice && this.pendingSplice.dead),
      });
      // Said in the details; it doesn't stop a resize.
      if (why && this.channel.spliceStatus !== "peer_not_announcing") {
        this.resizeExplanation = why;
        return;
      }
      this.resizeExplanation = "";
      this.resizeDirection = direction;
      this.resizeAmount = amount > 0 ? amount : 0;
      this.view = "resize";
    },
    // Never forced unless the user chose Force Close.
    async confirmChannelClose(force) {
      this.isClosing = true;

      try {
        const payload = {
          channelPoint: this.channel.channelPoint,
          force: force === true,
        };
        await API.delete(
          `${process.env.VUE_APP_API_BASE_URL}/v1/lnd/channel/close`,
          payload
        );
        this.$emit("channelclose");
        const message = force
          ? "Force closing the channel. Your balance returns to your Bitcoin wallet after the timelock."
          : "Closing the channel. Your balance returns to your Bitcoin wallet once the close confirms.";
        setTimeout(() => {
          this.$bvToast.toast(message, {
            title: "Lightning Network",
            autoHideDelay: 5000,
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
    Resize,
    TxLink,
    InputCopy,
  },
};
</script>

<style lang="scss" scoped>
@media (max-width: 575px) {
  .resize-actions,
  .close-actions {
    flex-direction: column;
  }
  .resize-actions .btn,
  .close-actions .btn {
    width: 100%;
    margin: 0.25rem 0 !important;
  }
}

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
