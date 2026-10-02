// The mobile API on its own, for the TLS listener a platform without a TLS
// proxy in front of the app gets (bin/www, logic/mobileAccess.js). Nothing
// but the mobile API is served here: on Umbrel the dashboard's own API has
// no sign-in of its own and must stay behind the app proxy.
const express = require("express");
const bodyParser = require("body-parser");
const morgan = require("morgan");

const camelCaseReqMiddleware = require("middlewares/camelCaseRequest.js").camelCaseRequest;
const logger = require("utils/logger.js");
const mobile = require("routes/api/v1/mobile.js");

const app = express();
app.set("case sensitive routing", true);
app.disable("x-powered-by");
app.use(bodyParser.json({ limit: "64kb" }));
app.use(camelCaseReqMiddleware);
app.use(morgan(logger.morganConfiguration));
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use("/api/v1", mobile);
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

module.exports = app;
