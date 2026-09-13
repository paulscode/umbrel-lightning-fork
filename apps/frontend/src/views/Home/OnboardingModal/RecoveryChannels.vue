<template>
  <div>
    <!-- Disable channel backup recovery if LND is not ready -->
    <recovery-lightning-is-syncing
      v-if="isLightningSyncing"
      :onConfirm="onClose"
    />

    <!-- Fetching every configured target's copy -->
    <div v-else-if="step === 'loading'">
      <div class="d-flex align-items-center w-100 flex flex-column text-center p-3 pb-4">
        <h3>Recover your channels</h3>
        <p class="text-muted">Asking your backup targets for their copy of channel.backup…</p>
        <div class="py-3 my-3 d-flex">
          <b-spinner variant="primary"></b-spinner>
        </div>
      </div>
    </div>

    <!-- Recovery: pick a retrieved copy -->
    <recovery-select-backup-file
      v-else-if="step === 'recovery-select-backup'"
      :copies="copies"
      :unreachable="unreachable"
      :onSelect="(provider) => restoreBackup({provider, backupFile: null})"
      :onSkip="() => changeStep('recovery-upload-backup')"
      :onBack="onBack"
      :loading="isRestoringBackup"
      :disabled="isRestoringBackup"
    />

    <!-- Recovery: Upload backup file -->
    <recovery-upload-backup-file
      v-else-if="step === 'recovery-upload-backup'"
      :disabled="isRestoringBackup"
      :loading="isRestoringBackup"
      :note="uploadNote"
      :onBack="() => copies.length ? changeStep('recovery-select-backup') : onBack()"
      :onNext="(file) => restoreBackup({provider: null, backupFile: file})"
    />

  </div>
</template>

<script>
import { mapState } from "vuex";

import API from "@/helpers/api";
import getErrorMessage from "@/helpers/error-message";

import RecoveryLightningIsSyncing from '@/views/Home/OnboardingModal/RecoveryLightningIsSyncing.vue';
import RecoverySelectBackupFile from '@/views/Home/OnboardingModal/RecoverySelectBackupFile.vue';
import RecoveryUploadBackupFile from '@/views/Home/OnboardingModal/RecoveryUploadBackupFile.vue';


const toBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(',').pop());
    reader.onerror = error => reject(error);
});

export default {
  props: {
    onComplete: Function,
    onBack: Function,
    onClose: Function,
  },
  data() {
    return {
      step: 'loading',
      copies: [],
      unreachable: [],
      uploadNote: '',
      isRestoringBackup: false,
    };
  },
  computed: {
    ...mapState({
      isLightningSyncing: state => !state.lightning.syncedToChain,
    }),
  },
  methods: {
    changeStep(step) {
      this.step = step;
    },

    // The backup targets are asked for their copy; whichever answer are
    // offered, and a file of the user's own is always an option.
    async getBackups() {
      let result;
      try {
        result = (await API.post(`${process.env.VUE_APP_API_BASE_URL}/v1/channel-backup/pull`)).data;
      } catch (err) {
        result = { retrieved: [], unreachable: [], message: getErrorMessage(err, "Your backup targets could not be asked.") };
      }
      this.copies = result.retrieved || [];
      this.unreachable = result.unreachable || [];
      if (this.copies.length === 0) {
        this.uploadNote = result.message
          || (this.unreachable.length
            ? `Your backup target could not be reached (${this.unreachable.map(u => `${u.target}: ${u.code}`).join("; ")}).`
            : "No backup target holds a copy of channel.backup.");
        return this.changeStep('recovery-upload-backup');
      }
      return this.changeStep('recovery-select-backup');
    },

    // Restoring force-closes every channel in the backup; it is asked for
    // in as many words, and again if the node still has channels open.
    async restoreBackup({ provider, backupFile }) {
      const what = backupFile
        ? `the file ${backupFile.name}`
        : `the copy held by ${{ sftp: "SFTP", nextcloud: "Nextcloud", dropbox: "Dropbox", gdrive: "Google Drive" }[provider] || provider}`;
      if (!window.confirm(`Recover your channels from ${what}? Every channel in that backup will be force-closed and its funds returned on-chain over the following days. This cannot be undone.`)) {
        return;
      }
      this.isRestoringBackup = true;
      const body = backupFile
        ? { backup: await toBase64(backupFile), confirm: true }
        : { provider, confirm: true };
      try {
        try {
          await API.post(`${process.env.VUE_APP_API_BASE_URL}/v1/channel-backup/restore`, body);
        } catch (first) {
          const open = first.response && first.response.status === 409 && first.response.data && first.response.data.openChannels;
          if (!open) {
            throw first;
          }
          if (!window.confirm(`This node still has ${open} open channel${open === 1 ? "" : "s"}. Recovering a backup now would force-close them too. Continue anyway?`)) {
            this.isRestoringBackup = false;
            return;
          }
          await API.post(`${process.env.VUE_APP_API_BASE_URL}/v1/channel-backup/restore`, { ...body, force: true });
        }
      } catch (err) {
        this.$bvToast.toast(
          getErrorMessage(
            err,
            "Unable to recover channel backup. Please try again."
          ),
          {
            title: "Error",
            autoHideDelay: 3000,
            variant: "danger",
            solid: true,
            toaster: "b-toaster-bottom-right",
          }
        );
        return this.isRestoringBackup = false;
      }
      this.isRestoringBackup = false;
      return this.onComplete();
    },
  },
  created() {
    this.getBackups();
  },
  components: {
    RecoveryLightningIsSyncing,
    RecoverySelectBackupFile,
    RecoveryUploadBackupFile,
  }
};
</script>

<style lang="scss"></style>
