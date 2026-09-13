<template>
  <b-modal
    id="channel-backup-modal"
    size="lg"
    centered
    hide-header
    hide-footer
    @hidden="$emit('hidden')"
  >
    <div class="px-2 px-sm-3 pt-2">
      <h3>Channel backups</h3>
      <p class="text-muted">
        Your channels can only be recovered from a fresh copy of
        <code>channel.backup</code>. Give one place to keep it, and it is copied
        there every time your channels change. The copy is encrypted by LND
        with a key from your seed; the provider sees when it changes, not what
        it holds.
      </p>

      <!-- Status -->
      <div class="status-box mb-3">
        <div class="d-flex justify-content-between align-items-center">
          <span class="font-weight-bold">Status</span>
          <b-button
            size="sm"
            variant="outline-primary"
            :disabled="busy || !enabledTargets.length"
            @click="backupNow"
            >{{ backingUp ? "Copying…" : "Back up now" }}</b-button
          >
        </div>
        <small class="d-block mt-2">{{ statusText }}</small>
        <small
          v-for="failure in failures"
          :key="failure.target + failure.code"
          class="d-block text-warning"
          >{{ label(failure.target) }}: {{ failure.code }}
          {{ failure.detail ? `(${failure.detail})` : "" }}</small
        >
      </div>

      <b-alert :show="Boolean(result)" :variant="resultVariant" class="pre-wrap">{{ result }}</b-alert>

      <!-- Provider -->
      <b-form-group label="Backup target">
        <b-form-select v-model="provider" :options="providerOptions" size="sm" class="w-auto"></b-form-select>
      </b-form-group>

      <b-form v-if="form" @submit.prevent="save">
        <b-form-checkbox v-model="form.enabled" switch class="mb-3">
          Copy channel.backup to {{ label(provider) }}
        </b-form-checkbox>

        <!-- SFTP -->
        <template v-if="provider === 'sftp'">
          <b-row>
            <b-col sm="8"><b-form-group label="Host"><b-form-input v-model="form.host" placeholder="nas.local or 203.0.113.5" size="sm" class="neu-input"></b-form-input></b-form-group></b-col>
            <b-col sm="4"><b-form-group label="Port"><b-form-input v-model="form.port" placeholder="22" size="sm" class="neu-input"></b-form-input></b-form-group></b-col>
          </b-row>
          <b-form-group label="User"><b-form-input v-model="form.user" size="sm" class="neu-input"></b-form-input></b-form-group>
          <b-form-group label="Sign in with">
            <b-form-radio-group v-model="form.authType" :options="[{text: 'Password', value: 'password'}, {text: 'SSH key', value: 'key'}]" size="sm"></b-form-radio-group>
          </b-form-group>
          <b-form-group v-if="form.authType === 'password'" label="Password" :description="stored.sftp && stored.sftp.hasPass ? 'A password is stored. Leave blank to keep it.' : ''">
            <b-form-input v-model="form.pass" type="password" autocomplete="off" size="sm" class="neu-input"></b-form-input>
          </b-form-group>
          <b-form-group v-else label="OpenSSH private key" :description="(stored.sftp && stored.sftp.hasKey ? 'A key is stored. Leave blank to keep it. ' : '') + 'Without a passphrase; the server must know its public key.'">
            <b-form-textarea v-model="form.keyPem" rows="4" size="sm" class="neu-input font-monospace" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></b-form-textarea>
          </b-form-group>
          <b-form-group label="Folder" description="Relative to the user's home on the server."><b-form-input v-model="form.path" size="sm" class="neu-input"></b-form-input></b-form-group>
          <div v-if="stored.sftp && stored.sftp.hostKeyFingerprints" class="status-box mb-3">
            <small class="d-block font-weight-bold">The server identified itself as</small>
            <small class="d-block pre-wrap font-monospace">{{ stored.sftp.hostKeyFingerprints }}</small>
            <b-form-checkbox v-model="form.hostKeyVerified" class="mt-2">
              Host key verified: I compared this with my server
            </b-form-checkbox>
          </div>
        </template>

        <!-- Nextcloud -->
        <template v-else-if="provider === 'nextcloud'">
          <b-form-group label="WebDAV URL" description="Files → Settings → WebDAV, e.g. https://cloud.example.com/remote.php/dav/files/USER/">
            <b-form-input v-model="form.url" size="sm" class="neu-input"></b-form-input>
          </b-form-group>
          <b-form-group label="Username"><b-form-input v-model="form.user" size="sm" class="neu-input"></b-form-input></b-form-group>
          <b-form-group label="Password or app password" :description="stored.nextcloud && stored.nextcloud.hasPass ? 'A password is stored. Leave blank to keep it.' : ''">
            <b-form-input v-model="form.pass" type="password" autocomplete="off" size="sm" class="neu-input"></b-form-input>
          </b-form-group>
          <b-form-checkbox v-model="form.insecureTls" class="mb-3">Accept a self-signed certificate</b-form-checkbox>
          <b-form-group label="Folder"><b-form-input v-model="form.path" size="sm" class="neu-input"></b-form-input></b-form-group>
        </template>

        <!-- Dropbox and Google Drive -->
        <template v-else>
          <p class="text-muted">
            <small v-if="provider === 'dropbox'">
              Create an app at dropbox.com/developers with "Scoped access" and
              "App folder", give it the files.content.write permission, and copy
              its App key and App secret here.
            </small>
            <small v-else>
              In Google Cloud Console, enable the Drive API and create an OAuth
              client of type "Desktop app"; copy its client ID and secret here.
            </small>
          </p>
          <b-form-group :label="provider === 'dropbox' ? 'App key' : 'Client ID'"><b-form-input v-model="form.clientId" size="sm" class="neu-input"></b-form-input></b-form-group>
          <b-form-group :label="provider === 'dropbox' ? 'App secret' : 'Client secret'" :description="stored[provider] && stored[provider].hasClientSecret ? 'A secret is stored. Leave blank to keep it.' : ''">
            <b-form-input v-model="form.clientSecret" type="password" autocomplete="off" size="sm" class="neu-input"></b-form-input>
          </b-form-group>
          <b-form-group label="Authorization" :description="stored[provider] && stored[provider].hasToken ? 'This app is authorized. Paste a new code only to re-authorize.' : ''">
            <b-button size="sm" variant="outline-primary" :disabled="!form.clientId" @click="openAuthPage">Open the authorization page</b-button>
            <b-form-input v-model="form.authCode" class="neu-input mt-2" size="sm" placeholder="Paste the authorization code (or the whole redirect URL) here"></b-form-input>
          </b-form-group>
          <b-form-group label="Refresh token (optional)" description="If you already have one; a new authorization code takes precedence.">
            <b-form-input v-model="form.refreshToken" type="password" autocomplete="off" size="sm" class="neu-input"></b-form-input>
          </b-form-group>
          <b-form-group label="Folder"><b-form-input v-model="form.path" size="sm" class="neu-input"></b-form-input></b-form-group>
        </template>

        <b-form-checkbox v-if="hasStoredSecret" v-model="form.forget" class="mb-3">
          Forget the stored credentials for {{ label(provider) }}
        </b-form-checkbox>

        <div class="d-flex justify-content-end">
          <b-button variant="outline-secondary" class="mr-2" @click="$bvModal.hide('channel-backup-modal')">Close</b-button>
          <b-button type="submit" variant="primary" :disabled="busy">{{ saving ? "Saving…" : "Save" }}</b-button>
        </div>
      </b-form>
    </div>
  </b-modal>
</template>

<script>
import { mapState } from "vuex";
import moment from "moment";
import API from "@/helpers/api";

const LABELS = { sftp: "SFTP", nextcloud: "Nextcloud", dropbox: "Dropbox", gdrive: "Google Drive" };

const blank = {
  sftp: () => ({ enabled: false, host: "", port: "22", user: "", authType: "password", pass: "", keyPem: "", path: "lnd-channel-backups", hostKeyVerified: false, forget: false }),
  nextcloud: () => ({ enabled: false, url: "", user: "", pass: "", insecureTls: false, path: "lnd-channel-backups", forget: false }),
  dropbox: () => ({ enabled: false, clientId: "", clientSecret: "", authCode: "", refreshToken: "", path: "lnd-channel-backups", forget: false }),
  gdrive: () => ({ enabled: false, clientId: "", clientSecret: "", authCode: "", refreshToken: "", path: "lnd-channel-backups", forget: false })
};

export default {
  data() {
    return {
      provider: "sftp",
      form: null,
      saving: false,
      backingUp: false,
      result: "",
      resultVariant: "info"
    };
  },
  computed: {
    ...mapState({
      status: state => state.system.channelBackup.status,
      config: state => state.system.channelBackup.config
    }),
    stored() {
      return this.config || {};
    },
    busy() {
      return this.saving || this.backingUp;
    },
    providerOptions() {
      return Object.keys(LABELS).map(value => ({ value, text: LABELS[value] + (this.stored[value] && this.stored[value].enabled ? " (on)" : "") }));
    },
    enabledTargets() {
      return this.status ? this.status.targets : [];
    },
    failures() {
      return this.status ? this.status.state.failures : [];
    },
    hasStoredSecret() {
      const t = this.stored[this.provider];
      return Boolean(t && (t.hasPass || t.hasKey || t.hasToken || t.hasClientSecret));
    },
    statusText() {
      const status = this.status;
      if (!status) {
        return "Loading…";
      }
      if (!status.targets.length) {
        return "No target is on. channel.backup stays on this Umbrel only, where a disk failure takes it with your channels.";
      }
      const names = status.targets.map(t => this.label(t.provider)).join(", ");
      const notReady = status.targets.filter(t => !t.ready).map(t => this.label(t.provider));
      if (notReady.length) {
        return `${notReady.join(", ")}: enabled but not ready; finish its settings below.`;
      }
      if (status.state.lastSuccess) {
        return `Last copied to ${names} ${moment(status.state.lastSuccess * 1000).fromNow()}.`;
      }
      if (!status.hasBackup) {
        return `Ready. LND writes channel.backup when your first channel opens; it is copied to ${names} from then on.`;
      }
      return `Ready; waiting for the first copy to ${names}.`;
    }
  },
  watch: {
    provider: {
      handler() {
        this.loadForm();
      },
      immediate: true
    },
    config() {
      this.loadForm();
    }
  },
  methods: {
    label(provider) {
      return LABELS[provider] || provider;
    },
    loadForm() {
      const t = this.stored[this.provider];
      const form = blank[this.provider]();
      if (t) {
        for (const key of Object.keys(form)) {
          if (key in t && !["pass", "keyPem", "clientSecret", "authCode", "refreshToken", "forget"].includes(key)) {
            form[key] = t[key];
          }
        }
      }
      this.form = form;
    },
    async refresh() {
      await Promise.all([
        this.$store.dispatch("system/getChannelBackupConfig"),
        this.$store.dispatch("system/getChannelBackupStatus")
      ]);
    },
    async save() {
      this.saving = true;
      this.result = "";
      try {
        const answer = await this.$store.dispatch("system/saveChannelBackupProvider", {
          provider: this.provider,
          settings: this.form
        });
        this.result = answer.message;
        this.resultVariant = answer.needsHostKeyConfirmation ? "warning" : "success";
        await this.$store.dispatch("system/getChannelBackupStatus");
      } catch (error) {
        this.result = (error.response && error.response.data && error.response.data.error) || "The settings could not be saved.";
        this.resultVariant = "danger";
      }
      this.saving = false;
    },
    async backupNow() {
      this.backingUp = true;
      this.result = "";
      try {
        const answer = await this.$store.dispatch("system/channelBackupNow");
        this.result = answer.message;
        this.resultVariant = answer.ok ? "success" : "danger";
      } catch (error) {
        this.result = "The copy could not be started.";
        this.resultVariant = "danger";
      }
      this.backingUp = false;
    },
    async openAuthPage() {
      try {
        const { url } = await API.get(
          `${process.env.VUE_APP_API_BASE_URL}/v1/channel-backup/oauth/url?provider=${this.provider}&clientId=${encodeURIComponent(this.form.clientId)}`
        );
        window.open(url, "_blank", "noopener");
      } catch (error) {
        this.result = "The authorization page could not be prepared.";
        this.resultVariant = "danger";
      }
    }
  },
  async mounted() {
    await this.refresh();
    this.$bvModal.show("channel-backup-modal");
  }
};
</script>

<style lang="scss" scoped>
.status-box {
  border: 1px solid var(--theme-border, rgba(88, 153, 242, 0.18));
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
}
.pre-wrap {
  white-space: pre-wrap;
}
.font-monospace {
  font-family: SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85em;
}
</style>
