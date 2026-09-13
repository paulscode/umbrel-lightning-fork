import Vue from "vue";
import { BootstrapVue, BootstrapVueIcons } from "bootstrap-vue";

import App from "./App.vue";
import router from "./router";
import store from "./store";

import { satsToBtc } from "@/helpers/units";

// import "@/global-styles/designsystem.scss";
// import "bootstrap/dist/css/bootstrap.css";
// import 'bootstrap-vue/dist/bootstrap-vue.css'

Vue.use(BootstrapVue);
Vue.use(BootstrapVueIcons);

//transforms a number to sats or btc based on store
Vue.filter("unit", (value) => {
  if (store.state.system.unit === "sats") {
    return Number(value);
  } else if (store.state.system.unit === "btc") {
    return satsToBtc(value);
  }
});

//transforms a number to sats
Vue.filter("sats", (value) => Number(value));

//transforms a number to btc
Vue.filter("btc", (value) => satsToBtc(value));

//formats the unit
Vue.filter("formatUnit", (unit, value) => {
  if (unit === "sats") {
    return value === 1 ? "Sat" : "Sats";
    // return "Sats";
  } else if (unit === "btc") {
    return "BTC";
  }
});

// An amount in the selected fiat currency while the price feed has a quote
// for it, and in the other unit (BTC or sats) while it does not. The feed is
// neoxa.exchange, where BTCB2 trades, with Coingecko for the conversion to
// currencies other than dollars (backend logic/price.js); either can be down,
// and a stale or missing quote must never be dressed up as a figure.
Vue.filter("satsToFiat", (value) => {
  if (isNaN(parseInt(value))) {
    return value;
  }
  const price = store.state.bitcoin.price;
  const currency = store.state.bitcoin.priceCurrency;
  if (price > 0 && currency && currency === store.state.system.currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency
      }).format(satsToBtc(value) * price);
    } catch (error) {
      // A code this browser cannot format: fall through to the other unit.
    }
  }
  if (store.state.system.unit === "btc") {
    return `${Number(value).toLocaleString()} sats`;
  }
  return `${satsToBtc(value).toFixed(8)} BTC`;
});

//Localized number (comma, seperator, spaces, etc)
Vue.filter("localize", (n) =>
  Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 })
);

Vue.config.productionTip = false;

new Vue({
  router,
  store,
  render: (h) => h(App),
}).$mount("#app");
