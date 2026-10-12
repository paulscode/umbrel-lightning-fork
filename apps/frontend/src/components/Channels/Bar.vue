<template>
  <div
    v-if="!change"
    class="channel-bar"
    :style="style"
    aria-hidden="true"
  ></div>
  <!-- Funds in motion (a resize): hatched between the two sides. Adding
       funds hatches the end of our side; moving out hatches what leaves. -->
  <div
    v-else
    class="channel-bar channel-bar-split d-flex"
    :style="shape"
    aria-hidden="true"
  >
    <div class="segment local" :style="{ flexGrow: segments.local }"></div>
    <div
      class="segment moving"
      :class="change > 0 ? 'moving-in' : 'moving-out'"
      :style="{ flexGrow: segments.moving }"
    ></div>
    <div class="segment remote" :style="{ flexGrow: segments.remote }"></div>
  </div>
</template>

<script>
const LOCAL = "#4e93ff";
const REMOTE = "#00CD98";

export default {
  computed: {
    shape() {
      if (this.size === "lg") {
        return { height: "8px", borderRadius: "8px" };
      }
      return { height: "4px", borderRadius: "4px" };
    },
    style() {
      const leftValue = this.local;
      const rightValue = this.remote;
      const leftPercent = Math.round(
        (leftValue * 100) / (leftValue + rightValue)
      );

      let background;
      if (leftPercent === 100) {
        background = LOCAL;
      } else if (leftPercent === 0) {
        background = REMOTE;
      } else {
        background = `linear-gradient(90deg, ${LOCAL} 0%, ${LOCAL} ${leftPercent -
          7}%, ${REMOTE} ${leftPercent + 7}%, ${REMOTE} 100%)`;
      }

      return { background, ...this.shape };
    },
    // local and remote are the sides after the change; a positive change
    // is part of local, a negative one is on top of it.
    segments() {
      const local = Math.max(0, Number(this.local) || 0);
      const remote = Math.max(0, Number(this.remote) || 0);
      const change = Number(this.change) || 0;
      if (change > 0) {
        const moving = Math.min(change, local);
        return { local: local - moving, moving, remote };
      }
      return { local, moving: -change, remote };
    }
  },
  props: {
    local: Number,
    remote: Number,
    // Our side's change while a resize is in progress, in sats.
    change: {
      type: Number,
      default: 0
    },
    size: {
      type: String, //sm, lg
      default: "sm"
    }
  },
  components: {}
};
</script>

<style lang="scss" scoped>
.channel-bar {
  height: 4px;
  border-radius: 4px;
}
.channel-bar-split {
  overflow: hidden;
}
.segment {
  flex-basis: 0;
  min-width: 0;
}
.local {
  background: #4e93ff;
}
.remote {
  background: #00cd98;
}
.moving {
  min-width: 6px;
}
.moving-in {
  background: repeating-linear-gradient(
    135deg,
    #4e93ff 0,
    #4e93ff 3px,
    rgba(78, 147, 255, 0.35) 3px,
    rgba(78, 147, 255, 0.35) 6px
  );
}
.moving-out {
  background: repeating-linear-gradient(
    135deg,
    rgba(108, 117, 125, 0.6) 0,
    rgba(108, 117, 125, 0.6) 3px,
    rgba(108, 117, 125, 0.2) 3px,
    rgba(108, 117, 125, 0.2) 6px
  );
}
</style>
