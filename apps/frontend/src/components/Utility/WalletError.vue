<template>
  <!-- In the card's flow rather than laid over it: a long message grows the
       card instead of covering the buttons below. Bounded, so a very long
       one scrolls rather than pushing them out of reach. -->
  <div v-if="message" class="wallet-error-notice mx-3 mx-lg-4 mb-2" role="alert">
    <div class="wallet-error-text text-danger">{{ message }}</div>
    <button
      type="button"
      class="wallet-error-close"
      aria-label="Dismiss"
      title="Dismiss"
      @click="$emit('dismiss')"
    >
      &times;
    </button>
  </div>
</template>

<script>
export default {
  props: {
    message: { type: String, default: "" }
  }
};
</script>

<style lang="scss" scoped>
.wallet-error-notice {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem 0.5rem 0.5rem 0.75rem;
  border-radius: 0.5rem;
  background: rgba(220, 53, 69, 0.08);
  border: 1px solid rgba(220, 53, 69, 0.35);
}
.wallet-error-text {
  flex: 1;
  min-width: 0;
  font-size: 0.8rem;
  line-height: 1.3;
  max-height: 5.2rem;
  overflow-y: auto;
  // Hashes, ids and node keys have no spaces to break at.
  overflow-wrap: anywhere;
  white-space: pre-line;
}
.wallet-error-close {
  flex: none;
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  font-size: 1.1rem;
  line-height: 1;
  padding: 0 0.25rem;
  cursor: pointer;
  &:hover,
  &:focus {
    opacity: 1;
  }
}
</style>
