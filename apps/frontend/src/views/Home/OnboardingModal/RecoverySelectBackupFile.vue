<template>
  <div class="d-flex align-items-center w-100 flex flex-column text-center p-3 pb-4">
    <h3>Recover your channels</h3>
    <p>
      These are the copies of channel.backup your backup targets hold.
    </p>
    <p>
      Pick the one from the last time your previous node was online.
    </p>
    <div class="backup-files py-3 mb-3 d-flex">
      <div
        v-for="copy in copies"
        :key="copy.provider"
        class="backup-file mx-1"
        @click="selectBackup(copy.provider)"
      >
      <img
        class="icon-backup-file mx-3"
        src="@/assets/icon-backup-file.svg"
      />
      <small class="d-block mt-2 font-weight-bold">{{ label(copy.provider) }}</small>
      <small class="d-block">{{ copy.mtime ? getDate(copy.mtime) : "" }}</small>
      <small class="d-block text-muted">{{ copy.size }} bytes</small>
      </div>
    </div>
    <p v-if="unreachable.length" class="text-warning">
      Not reached: {{ unreachable.map(u => `${label(u.target)} (${u.code})`).join(", ") }}
    </p>
    <p class="text-muted">Or upload your own channel backup file</p>
    <div>
      <b-button
        variant="primary px-4"
        :disabled="disabled"
        :class="{'fade-in-out': loading}"
        @click="onSkip"
      >Upload</b-button>
      <div class="mt-3">
        <a
          href="#"
          class="text-center text-uppercase"
          :class="{'disabled-link': disabled}"
          @click.prevent="onBack"
        >
          Back
        </a>
      </div>
    </div>
  </div>
</template>

<script>
import moment from "moment";

export default {
  props: {
    disabled: Boolean,
    loading: Boolean,
    copies: Array,
    unreachable: Array,
    onSelect: Function,
    onSkip: Function,
    onBack: Function,
  },
  methods: {
    label(provider) {
      return { sftp: "SFTP", nextcloud: "Nextcloud", dropbox: "Dropbox", gdrive: "Google Drive" }[provider] || provider;
    },
    getDate(seconds) {
      return moment(seconds * 1000).format("MMM D, YYYY h:mm a");
    },
    selectBackup(provider) {
      if (this.disabled) {
        return;
      }
      this.onSelect(provider);
    },
  },
};
</script>

<style lang="scss" scoped>
.backup-files {
  flex-wrap: wrap;
  justify-content: center;
}
.backup-file {
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 0.5rem;
  &:hover {
    background: rgba(78, 147, 255, 0.12);
  }
}
.icon-backup-file {
  height: 64px;
}
</style>
