<template>
  <!-- The nodes found that could be on the SHA256 chain, each with what it
       is; the usable ones can be chosen when a v-model is given. -->
  <div class="sha256-nodes mb-2">
    <div
      v-for="n in nodes"
      :key="n.id"
      class="d-flex align-items-start py-1"
    >
      <b-form-radio
        v-if="choosing"
        :checked="value"
        :value="n.id"
        :disabled="n.state !== 'sha256'"
        :name="`sha256-node-${uid}`"
        class="mr-1"
        @change="$emit('input', n.id)"
      ></b-form-radio>
      <div style="min-width: 0;">
        <div>
          {{ n.name }}
          <small :class="`ml-1 text-${state(n.state).variant}`">{{
            state(n.state).text
          }}</small>
        </div>
        <!-- What is wrong, where the state alone does not say -->
        <small
          v-if="['behind', 'unreachable', 'other-network'].includes(n.state)"
          class="d-block text-muted"
          >{{ n.detail }}</small
        >
      </div>
    </div>
  </div>
</template>

<script>
import { sha256NodeState } from "@/helpers/bridge";

let next = 0;

export default {
  props: {
    nodes: { type: Array, required: true },
    value: { type: String, default: undefined }
  },
  data() {
    next += 1;
    return { uid: next };
  },
  computed: {
    choosing() {
      return this.$listeners.input !== undefined;
    }
  },
  methods: {
    state: sha256NodeState
  }
};
</script>
