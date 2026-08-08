const express = require("express");
const router = express.Router();

router.get("/pos", (req, res) => {
  res.render("pos", { layout: false }); // POS keeps its own full-bleed till-tape screen, no shared nav chrome
});

module.exports = router;
