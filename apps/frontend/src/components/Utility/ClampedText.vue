<template>
  <!-- Text someone else wrote (an invoice's or offer's description) can be
       any length, and the wallet cards are a fixed height. This shows the
       first `lines` lines and, only when there is more, a link to show it
       all; the whole text is also its title, for a mouse. -->
  <span class="clamped-text" :class="{ 'd-block': block }">
    <span
      ref="body"
      class="clamped-text-body"
      :class="{ clamped: !open }"
      :style="open ? null : { '-webkit-line-clamp': lines }"
      :title="cut && !open ? text : null"
      >{{ text }}</span
    >
    <a
      v-if="cut || open"
      href="#"
      class="clamped-text-toggle"
      @click.prevent.stop="open = !open"
      >{{ open ? "Less" : "More" }}</a
    >
  </span>
</template>

<script>
export default {
  props: {
    text: { type: String, default: "" },
    lines: { type: Number, default: 2 },
    block: { type: Boolean, default: true },
  },
  data() {
    return { open: false, cut: false };
  },
  watch: {
    text() {
      this.open = false;
      this.$nextTick(this.measure);
    },
  },
  mounted() {
    this.$nextTick(this.measure);
    window.addEventListener("resize", this.measure);
  },
  beforeDestroy() {
    window.removeEventListener("resize", this.measure);
  },
  methods: {
    // Whether the clamp hides anything, so "More" shows only when it would
    // show more.
    measure() {
      const el = this.$refs.body;
      if (!el || this.open) {
        return;
      }
      this.cut = el.scrollHeight > el.clientHeight + 1;
    },
  },
};
</script>

<style lang="scss" scoped>
.clamped-text-body {
  overflow-wrap: anywhere;

  &.clamped {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
}

.clamped-text-toggle {
  font-size: 0.8rem;
  font-weight: normal;
}
</style>
