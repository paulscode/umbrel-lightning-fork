import API from "@/helpers/api";

const emptySeedArray = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""] // for loading placeholder

// Initial state
const state = () => ({
  seed: emptySeedArray,
  lndConfig: {}
});

// Functions to update the state directly
const mutations = {
  setSeed(state, seed) {
    state.seed = seed;
  },
  setLndConfig(state, lndConfig) {
    state.lndConfig = lndConfig;
  }
};

// Functions to get data from the API
const actions = {
  // The stored seed, if any. Outside onboarding the dashboard password is
  // asked again where there is one: throws on a refusal, for the screen to
  // show.
  async getSeed({ commit }, { password } = {}) {
    const res = await API.post(
      `${process.env.VUE_APP_API_BASE_URL}/v1/system/seed`,
      password ? { password } : {}
    );

    if (res && res.data && res.data.seed) {
      commit("setSeed", res.data.seed);
    }
  },
  async clearSeed({ commit }) {
    commit("setSeed", emptySeedArray);
  },
  async getLndConfig({ commit }) {
    const existingLndConfig = await API.get(
      `${process.env.VUE_APP_API_BASE_URL}/v1/lnd/conf/lnd-config`
    );
    if (existingLndConfig) {
      commit("setLndConfig", existingLndConfig);
    }
  },
  async updateLndConfig({ commit }, lndConfig) {
    commit("setLndConfig", lndConfig);
  }
};

const getters = {};

export default {
  namespaced: true,
  state,
  getters,
  actions,
  mutations
};
