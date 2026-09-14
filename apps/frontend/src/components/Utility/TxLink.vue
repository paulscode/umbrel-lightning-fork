<template>
  <span class="tx-link d-inline-flex align-items-center">
    <small class="font-bold text-monospace" :title="txid">{{ shortTxid }}</small>
    <b-button
      variant="link"
      size="sm"
      class="p-0 ml-2 tx-link-btn"
      :title="copied ? 'Copied' : 'Copy transaction id'"
      @click.stop.prevent="copy"
    >
      <b-icon :icon="copied ? 'clipboard-check' : 'clipboard'" :variant="copied ? 'success' : ''"></b-icon>
    </b-button>
    <b-button
      variant="link"
      size="sm"
      class="p-0 ml-2 tx-link-btn"
      :href="url"
      target="_blank"
      rel="noopener"
      :title="`Open in ${explorerName}`"
      @click="open"
    >
      <b-icon icon="box-arrow-up-right"></b-icon>
    </b-button>
  </span>
</template>

<script>
import { copyToClipboard } from "@/helpers/clipboard";
import {
  txExplorerUrl,
  confirmPublicExplorer,
  PUBLIC_EXPLORER_NAME
} from "@/helpers/explorer";

// A transaction id with a copy button and a link to the explorer: the
// Mempool app the operator chose, or the public explorer for this chain.
export default {
  props: {
    txid: String
  },
  data() {
    return {
      copied: false,
      copiedTimeout: null
    };
  },
  computed: {
    localExplorerUrl() {
      return this.$store.state.system.localExplorerUrl;
    },
    explorerName() {
      return this.$store.state.system.explorerName || PUBLIC_EXPLORER_NAME;
    },
    shortTxid() {
      const id = this.txid || "";
      return id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-10)}` : id;
    },
    url() {
      return txExplorerUrl(this.localExplorerUrl, this.txid);
    }
  },
  methods: {
    copy() {
      if (!copyToClipboard(this.txid)) {
        return;
      }
      this.copied = true;
      window.clearTimeout(this.copiedTimeout);
      this.copiedTimeout = window.setTimeout(() => {
        this.copied = false;
      }, 1500);
    },
    open(event) {
      confirmPublicExplorer(event, this.localExplorerUrl);
    }
  },
  beforeDestroy() {
    window.clearTimeout(this.copiedTimeout);
  }
};
</script>

<style lang="scss" scoped>
.tx-link-btn {
  line-height: 1;
  color: inherit;
  opacity: 0.7;
  &:hover {
    opacity: 1;
  }
}
</style>
