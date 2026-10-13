<template>
  <!-- The dashboard password, asked again before something that outlasts the
       session is handed out: a stolen session cookie must not get it. -->
  <div class="neu-card p-3">
    <label class="mb-1 d-block" :for="inputId"
      ><small class="font-weight-bold">Dashboard password</small></label
    >
    <b-form-input
      :id="inputId"
      ref="input"
      v-model="password"
      type="password"
      size="sm"
      class="neu-input mb-1"
      autocomplete="current-password"
      @keyup.enter="submit"
    ></b-form-input>
    <small class="text-muted d-block mb-2">{{ why }}</small>
    <small v-if="error" class="text-danger d-block mb-2">{{ error }}</small>
    <div class="d-flex justify-content-end">
      <b-button
        v-if="cancellable"
        variant="link"
        size="sm"
        class="mr-2"
        @click="$emit('cancel')"
        >Cancel</b-button
      >
      <b-button
        variant="success"
        size="sm"
        :disabled="busy || !password"
        @click="submit"
        >{{ busy ? "Checking…" : action }}</b-button
      >
    </div>
  </div>
</template>

<script>
export default {
  props: {
    inputId: { type: String, required: true },
    why: { type: String, required: true },
    action: { type: String, required: true },
    busy: { type: Boolean, default: false },
    error: { type: String, default: "" },
    cancellable: { type: Boolean, default: true }
  },
  data() {
    return { password: "" };
  },
  mounted() {
    this.$nextTick(() => {
      const input = this.$refs.input;
      if (input && input.focus) {
        input.focus();
      }
    });
  },
  methods: {
    submit() {
      if (!this.password || this.busy) {
        return;
      }
      const password = this.password;
      this.password = "";
      this.$emit("submit", password);
    }
  }
};
</script>
