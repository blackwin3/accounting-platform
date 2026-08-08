const express = require("express");
const router = express.Router();
const { verifyLogin, roleLabel, hashPassword } = require("../services/auth");
const { prisma } = require("../services/postingEngine");

// GET / — the public landing page. Always shown, regardless of login
// state — a logged-in person reaches their dashboard via Sign In/the
// sidebar, not by clicking the site title while already logged in.
router.get("/", (req, res) => {
  res.render("landing", { layout: false, showSignup: true });
});

// GET /about — public, no auth required
router.get("/about", (req, res) => {
  res.render("about", { layout: false, showSignup: true });
});

// GET /setup — creates a new business. Always reachable, since a person
// may want to start a second, entirely separate business at any time.
// If someone is already logged in, their session is cleared first, so
// every new business starts from a clean logged-out state rather than
// risking any confusion about which business a click belongs to.
router.get("/setup", (req, res) => {
  if (req.session && req.session.userId) {
    return req.session.destroy(() => res.redirect("/setup"));
  }
  res.render("setup", { layout: false, currentUser: null });
});

// POST /api/setup/signup — creates a brand new Organisation and its first
// Owner login + Stakeholder + Management row, all scoped to that new
// Entreprise_id. Each business is fully isolated from every other business
// sharing this database — usernames only need to be unique within a
// business, not globally.
router.post("/api/setup/signup", async (req, res) => {
  try {
    const { name, username, password, businessName } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Your name is required" });
    if (!username || !username.trim()) return res.status(400).json({ error: "A username is required" });
    if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    // Organisation.Account_id and Catalogue_id are NOT NULL with real
    // foreign key constraints — there's no account or catalogue yet for a
    // business that doesn't exist, so a minimal placeholder Catalogue and
    // Account are created first to obtain real, valid IDs. The Business
    // step later in the wizard (POST /api/organisation) fills in the real
    // profile fields on this same Organisation row.
    const placeholderCatalogue = await prisma.Catalogue.create({
      data: { Event_Name: "ORGANISATION_ROOT", Event_Description: "Placeholder anchor for the Organisation row — not a real business event." },
    });
    const placeholderAccount = await prisma.Account.create({
      data: { Account_Name: "Organisation Anchor", Account_Type: "ASSET", Normal_Balance: "DEBIT", Current_Balance: 0, Authoritative_Source: "JOURNAL", Is_Active: 0 },
    });

    const org = await prisma.Organisation.create({
      data: {
        Organisational_Name: businessName && businessName.trim() ? businessName.trim() : `${name.trim()}'s Business`,
        Account_id: placeholderAccount.Account_id,
        Catalogue_id: placeholderCatalogue.Catalogue_id,
      },
    });

    const nameParts = name.trim().split(" ");
    const stakeholder = await prisma.Stakeholder.create({
      data: {
        First_name: nameParts[0],
        Last_name: nameParts.slice(1).join(" ") || null,
        Stakeholder_Category: "Owner",
        Stakeholder_Role: "Owner",
        Relationship_Status: "ACTIVE",
        Entreprise_id: org.Entreprise_id,
      },
    });

    const passwordHash = await hashPassword(password);
    const owner = await prisma.Management.create({
      data: {
        Stakeholder_id: stakeholder.Stakeholder_id,
        Catalogue_id: placeholderCatalogue.Catalogue_id,
        Management_Name: name.trim(),
        Management_Role: "Owner",
        Administration_type: "Owner",
        Inheritance_Status: "CURRENT_OWNER",
        Access_Level: "OWNER_FULL",
        Username: username.trim(),
        Password_Hash: passwordHash,
        Entreprise_id: org.Entreprise_id,
      },
    });

    // Log the new owner in immediately so the rest of the wizard (Business,
    // Business Units, Team) runs as an authenticated session, same as every
    // other page in the app expects.
    req.session.userId = owner.Administration_id;
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(400).json({ error: "That username is already taken." });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error creating your account" });
  }
});

router.get("/login", (req, res) => {
  if (req.session && req.session.userId) return res.redirect("/dashboard");
  res.render("login", { error: null, layout: false, showSignup: true });
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const person = await verifyLogin(username, password);
  if (!person) {
    return res.render("login", { error: "Incorrect username or password.", layout: false, showSignup: true });
  }
  req.session.userId = person.Administration_id;
  res.redirect("/dashboard");
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
