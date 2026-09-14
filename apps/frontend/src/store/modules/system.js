import API from "@/helpers/api";

// Initial state
const state = () => ({
  version: "",
  onboarding: false, // assume false to prevent modal flickering
  loading: true,
  unit: "sats", //sats or btc
  theme: "dark",
  currency: "USD",
  // What the price feed can quote right now: dollars always, the rest while
  // Coingecko's conversion table is reachable (backend logic/price.js).
  supportedFiatCurrencies: ["USD"],
  // "umbrel" or "startos": what hosts the dashboard, from /v1/system/platform.
  // StartOS provides wallet setup, LND configuration, backups and connection
  // strings itself, so the dashboard hides its own versions of those there.
  platform: "umbrel",
  // Channel backups (Umbrel): the agent's status and the targets' settings,
  // secrets replaced by whether one is stored. See backend logic/channelBackup.js.
  channelBackup: {
    status: null,
    config: null
  },
  // The sign-in gate (StartOS): whether a password is configured, whether
  // this browser holds a session, and the session's CSRF token for writes.
  // With no password configured (Umbrel signs users in at its proxy) the
  // dashboard counts as signed in.
  auth: {
    known: false,
    passwordEnabled: false,
    authed: true,
    csrf: null
  },
  api: {
    operational: false,
    version: ""
  },
  onionAddress: "",
  seedExists: false,
  localExplorerUrl: false,
  explorerName: "",
  // The Mempool app chosen for fee rates and transaction links, and the
  // apps the wrapper can reach.
  mempool: { selected: "", apps: [], known: false },
});

// Functions to update the state directly
const mutations = {
  setVersion(state, version) {
    state.version = version;
  },
  setUnit(state, unit) {
    state.unit = unit;
  },
  setPlatform(state, platform) {
    state.platform = platform;
  },
  setChannelBackupStatus(state, status) {
    state.channelBackup = { ...state.channelBackup, status };
  },
  setChannelBackupConfig(state, config) {
    state.channelBackup = { ...state.channelBackup, config };
  },
  setAuth(state, { passwordEnabled, authed, csrf }) {
    state.auth = { known: true, passwordEnabled, authed, csrf };
  },
  setAuthed(state, authed) {
    state.auth = { ...state.auth, authed, csrf: authed ? state.auth.csrf : null };
  },
  setCurrency(state, currency) {
    state.currency = currency;
  },
  setSupportedFiatCurrencies(state, currencies) {
    state.supportedFiatCurrencies = currencies;
  },
  setTheme(state, theme) {
    state.theme = theme;
  },
  setApi(state, api) {
    state.api = api;
  },
  setLoading(state, loading) {
    state.loading = loading;
  },
  setOnionAddress(state, address) {
    state.onionAddress = address;
  },
  setOnboarding(state, status) {
    state.onboarding = status;
  },
  setSeedExists(state, seedExists) {
    state.seedExists = seedExists;
  },
  setLocalExplorerUrl(state, localExplorerUrl) {
    state.localExplorerUrl = localExplorerUrl;
  },
  setExplorerName(state, name) {
    state.explorerName = name;
  },
  setMempool(state, { selected, apps }) {
    state.mempool = { selected, apps, known: true };
  }
};

// Functions to get data from the API
const actions = {
  async getCurrencies({ commit }) {
    const currencies = await API.get(
      `${process.env.VUE_APP_API_BASE_URL}/v1/external/currencies`
    );
    if (Array.isArray(currencies) && currencies.length) {
      commit("setSupportedFiatCurrencies", currencies);
    }
  },
  async getCurrency({ commit }) {
    if (window.localStorage && window.localStorage.getItem("currency")) {
      const currency = window.localStorage.getItem("currency").toUpperCase();
      // Any well-formed code: the list of convertible ones changes with the
      // conversion table's availability, and a saved choice should outlive
      // an outage.
      if (/^[A-Z]{3}$/.test(currency)) {
        commit("setCurrency", currency);
      }
    }
  },
  changeCurrency({ commit }, currency) {
    currency = String(currency).toUpperCase();
    if (/^[A-Z]{3}$/.test(currency)) {
      window.localStorage.setItem("currency", currency);
      commit("setCurrency", currency);
    }
  },
  async getAuthState({ commit }) {
    const state = await API.get(
      `${process.env.VUE_APP_API_BASE_URL}/v1/auth/state`
    );
    if (state && typeof state.authed === "boolean") {
      commit("setAuth", {
        passwordEnabled: Boolean(state.password_enabled),
        authed: state.authed,
        csrf: state.csrf || null
      });
      return true;
    }
    return false;
  },
  // Resolves to "" on success, or a message for the sign-in screen.
  async login({ commit }, password) {
    try {
      const response = await API.post(
        `${process.env.VUE_APP_API_BASE_URL}/v1/auth/login`,
        { password }
      );
      commit("setAuth", {
        passwordEnabled: true,
        authed: true,
        csrf: response.data.csrf || null
      });
      return "";
    } catch (error) {
      const status = error.response && error.response.status;
      if (status === 429) {
        const wait = Number(error.response.data && error.response.data.retry_after) || 0;
        return wait > 0
          ? `Too many attempts. Try again in ${wait} second${wait === 1 ? "" : "s"}.`
          : "Too many attempts. Wait a moment and try again.";
      }
      if (status === 401) {
        return "Wrong password.";
      }
      if (status === 503) {
        return "No password is set on this server. Run Set Dashboard Password in StartOS.";
      }
      return "Could not sign in. Is the node running?";
    }
  },
  async logout({ commit }) {
    try {
      await API.post(`${process.env.VUE_APP_API_BASE_URL}/v1/auth/logout`);
    } catch (error) {
      // The session is gone either way.
    }
    commit("setAuthed", false);
  },
  async getChannelBackupStatus({ commit }) {
    const status = await API.get(
      `${process.env.VUE_APP_API_BASE_URL}/v1/channel-backup/status`
    );
    if (status && Array.isArray(status.targets)) {
      commit("setChannelBackupStatus", status);
    }
  },
  async getChannelBackupConfig({ commit }) {
    const config = await API.get(
      `${process.env.VUE_APP_API_BASE_URL}/v1/channel-backup/config`
    );
    if (config && typeof config === "object") {
      commit("setChannelBackupConfig", config);
    }
  },
  // Resolves to the backend's answer ({message, needsHostKeyConfirmation,
  // fingerprints}); a rejected save carries its reason in `error`.
  async saveChannelBackupProvider({ commit }, { provider, settings }) {
    const response = await API.post(
      `${process.env.VUE_APP_API_BASE_URL}/v1/channel-backup/config`,
      { provider, settings }
    );
    if (response.data && response.data.config) {
      commit("setChannelBackupConfig", response.data.config);
    }
    return response.data;
  },
  async channelBackupNow({ commit }) {
    const response = await API.post(
      `${process.env.VUE_APP_API_BASE_URL}/v1/channel-backup/now`
    );
    if (response.data && response.data.state) {
      const status = await API.get(
        `${process.env.VUE_APP_API_BASE_URL}/v1/channel-backup/status`
      );
      if (status) {
        commit("setChannelBackupStatus", status);
      }
    }
    return response.data;
  },
  async getPlatform({ commit }){
    const data = await API.get(
      `${process.env.VUE_APP_API_BASE_URL}/v1/system/platform`
    );
    if (data && data.platform) {
      commit("setPlatform", data.platform);
      return true;
    }
    return false;
  },
  async getVersion({ commit }) {
    const data = await API.get(
      `${process.env.VUE_APP_API_BASE_URL}/v1/system/info`
    );
    if (data && data.version) {
      let { version } = data;
      if (data.build) {
        version += `-build-${data.build}`;
      }
      commit("setVersion", version);
    }
  },
  async getUnit({ commit }) {
    if (window.localStorage && window.localStorage.getItem("unit")) {
      commit("setUnit", window.localStorage.getItem("unit"));
    }
  },
  changeUnit({ commit }, unit) {
    if (unit === "sats" || unit === "btc") {
      window.localStorage.setItem("unit", unit);
      commit("setUnit", unit);
    }
  },
  async getTheme({ commit }) {
    if (window.localStorage && window.localStorage.getItem("theme")) {
      const theme = window.localStorage.getItem("theme");
      if (theme === "light" || theme === "dark") {
        commit("setTheme", theme);
      }
    }
  },
  changeTheme({ commit }, theme) {
    if (theme === "light" || theme === "dark") {
      window.localStorage.setItem("theme", theme);
      commit("setTheme", theme);
    }
  },
  async getApi({ commit }) {
    const api = await API.get(`${process.env.VUE_APP_API_BASE_URL}/ping`);
    commit("setApi", {
      operational: !!(api && api.version),
      version: api && api.version ? api.version : ""
    });
  },
  async getOnboardingStatus({ commit }) {
    const onboarding = await API.get(
      `${process.env.VUE_APP_API_BASE_URL}/v1/system/onboarding`
    );

    commit("setOnboarding", onboarding);
  },
  async onboardingComplete({ commit }) {
    commit("setOnboarding", false); // update state to immediately hide modal
    await API.post(
      `${process.env.VUE_APP_API_BASE_URL}/v1/system/onboarding`
    );
  },
  async getSeedExists({ commit }) {
    const seedExists = await API.get(
      `${process.env.VUE_APP_API_BASE_URL}/v1/system/seed-exists`
    );
    commit("setSeedExists", seedExists);
  },
  // Where transaction links go: the chosen Mempool app's own address (a
  // full URL on StartOS, a port on this host on Umbrel, its onion address
  // for a page opened over Tor), or nothing, which means the public
  // explorer for this chain.
  async getLocalExplorerUrl({ commit }) {
    const explorer = await API.get(
      `${process.env.VUE_APP_API_BASE_URL}/v1/system/explorer`
    );
    if (!explorer) {
      return;
    }
    const { url, port, hiddenService, name } = explorer;

    let localExplorerUrl = false;

    if (window.location.origin.endsWith(".onion") && hiddenService) {
      localExplorerUrl = `http://${hiddenService}`;
    } else if (url) {
      localExplorerUrl = url;
    } else if (port) {
      localExplorerUrl = `${window.location.protocol}//${window.location.hostname}:${port}`;
    }
    commit("setLocalExplorerUrl", localExplorerUrl);
    commit("setExplorerName", localExplorerUrl ? name || "" : "");
  },
  async getMempool({ commit }) {
    const settings = await API.get(
      `${process.env.VUE_APP_API_BASE_URL}/v1/system/mempool`
    );
    if (settings && Array.isArray(settings.apps)) {
      commit("setMempool", settings);
    }
  },
  // Resolves to "" on success, or a message.
  async setMempool({ commit, dispatch }, app) {
    try {
      const response = await API.post(
        `${process.env.VUE_APP_API_BASE_URL}/v1/system/mempool`,
        { app }
      );
      commit("setMempool", response.data);
      await dispatch("getLocalExplorerUrl");
      return "";
    } catch (error) {
      const data = error.response && error.response.data;
      return (data && (data.message || data.error)) || "Could not save the choice.";
    }
  },
};

const getters = {
  isStartOS: state => state.platform === "startos",};

export default {
  namespaced: true,
  state,
  getters,
  actions,
  mutations
};
