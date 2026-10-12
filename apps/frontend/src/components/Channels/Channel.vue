<template>
  <div class="py-3 px-3 channel">
    <div class="d-flexflex-wrap">
      <b-col col cols="12">
        <!-- on large screens -->
        <div class="d-none d-xl-block">
          <div class="d-flex">
            <status :variant="statusVariant" size="sm">{{
              channel.status
            }}</status>
            <!-- we do not render private/public text when 'private' property does not exist on channel (e.g., from PendingChannels rpc) -->
            <small v-if="channel.private !== undefined" class="ml-1">{{ channel.private ? "Private Channel" : "Public Channel" }}</small>
            <span v-if="resizeChip" class="resize-chip ml-1">{{ resizeChip }}</span>
          </div>
          <div>
            <span v-if="channel.remoteAlias">{{ channel.remoteAlias }}</span>
            <span
              class="loading-placeholder loading-placeholder-sm block"
              style="width:80%; margin-top: 8px;"
              v-else
            ></span>
          </div>
        </div>

        <!-- on small screens -->
        <div
          class="d-xl-none d-flex justify-content-between align-items-center mb-1"
        >
          <div class="">
            <status :variant="statusVariant" size="sm">{{
              channel.status
            }}</status>
            <!-- we do not render private/public text when 'private' property does not exist on channel (e.g., from PendingChannels rpc) -->
            <small v-if="channel.private !== undefined" class="">{{ channel.private ? "Private Channel" : "Public Channel" }}</small>
            <span v-if="resizeChip" class="resize-chip ml-1">{{ resizeChip }}</span>
          </div>
          <div>
            <small>{{ channel.remoteAlias }}</small>
          </div>
        </div>
      </b-col>
      <b-col col cols="12">
        <div class>
          <div class="d-flex justify-content-between">
            <span
              class="text-primary font-bold"
              v-b-tooltip.hover.right
              :title="channel.localBalance | satsToFiat"
              >{{ channel.localBalance | unit | localize }}
              {{ unit | formatUnit }}</span
            >
            <span
              v-b-tooltip.hover.left
              :title="channel.remoteBalance | satsToFiat"
              class="text-success text-right font-bold"
              >{{ channel.remoteBalance | unit | localize }}
              {{ unit | formatUnit }}</span
            >
          </div>
          <bar
            :local="barLocal"
            :remote="Number(channel.remoteBalance)"
            :change="pendingLocalDelta"
            class="my-1"
          ></bar>
          <div class="d-flex justify-content-between">
            <small class="text-muted font-bold">Max Send</small>
            <small class="text-muted font-bold text-right">Max Receive</small>
          </div>
        </div>
      </b-col>
    </div>
  </div>
</template>

<script>
import Status from "@/components/Utility/Status";
import Bar from "@/components/Channels/Bar";

export default {
  computed: {
    unit() {
      return this.$store.state.system.unit;
    },
    pendingLocalDelta() {
      const p = this.channel.pendingSplice;
      return p && !p.dead ? Number(p.localDeltaSat) || 0 : 0;
    },
    barLocal() {
      return Number(this.channel.localBalance) + Math.max(0, this.pendingLocalDelta);
    },
    // "Resizing 2/6" while a resize confirms; the count is in the text.
    resizeChip() {
      const p = this.channel.pendingSplice;
      if (!p) {
        return "";
      }
      if (p.dead) {
        return "Resize failed";
      }
      const depth = Number(p.lockDepth) || 0;
      const confs = Math.min(Number(p.confirmations) || 0, depth);
      return depth > 0 ? `Resizing ${confs}/${depth}` : "Resizing";
    },
    statusVariant() {
      if (this.channel.status === "Online") {
        return "success";
      }
      if (this.channel.status === "Offline") {
        return "default";
      }
      if (this.channel.status === "Opening") {
        return "warning";
      }
      if (this.channel.status === "Closing") {
        return "danger";
      }
      if (this.channel.status === "Needs update") {
        return "warning";
      }
      if (this.channel.status === "Unkown") {
        return "danger";
      }
      return "default";
    },
  },
  data() {
    return {};
  },
  methods: {
    getStatusVariant() {
      if (this.channel.type === "OPEN") {
        return {
          text: "Online",
          variant: "success",
        };
      }
      if (this.channel.type === "PENDING_OPEN_CHANNEL") {
        return {
          text: "Opening",
          variant: "warning",
        };
      }
      if (
        this.channel.type === "WAITING_CLOSING_CHANNEL" ||
        this.channel.type === "PENDING_CLOSING_CHANNEL"
      ) {
        return {
          text: "Closing",
          variant: "warning",
        };
      }
      if (this.channel.type === "FORCE_CLOSING_CHANNEL") {
        return {
          text: "Force Closing",
          variant: "danger",
        };
      }
    },
  },
  props: {
    channel: Object,
  },
  components: {
    Status,
    Bar,
  },
};
</script>

<style lang="scss" scoped>
.channel {
  transition: box-shadow 0.3s, background 0.3s ease;
  &:hover {
    cursor: pointer;
    background: linear-gradient(346.78deg, #f7fcfc 0%, #fafcfa 100%);
    box-shadow: inset 0px 0px 10px rgba(0, 0, 0, 0.08);
    // box-shadow: 0 0 20px rgba(0, 0, 0, 0.1);
    // transform: translateY(-5px);
  }
}
</style>
