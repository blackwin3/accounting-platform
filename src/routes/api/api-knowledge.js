/**
 * api-knowledge.js — the Knowledge Layer: Structures, LogicConditions,
 * Catalogue, Knowledge, Narrative. Currently only the "Add Note" action
 * lives in api.js proper — Structures/LogicConditions/Catalogue are
 * genuinely managed entirely through routes/nav/settings.js (the Rules
 * page), not api.js, and this file is where any future Knowledge-layer
 * API endpoint belongs, rather than being scattered back into a single
 * catch-all file. Extracted from the original single api.js as part of
 * a 5-layer split matching this system's own architectural
 * documentation.
 */

const express = require("express");
const router = express.Router();
const { prisma } = require("../../services/postingEngine");

// POST /api/knowledge — add a Knowledge note, optionally linked to a
// Transactions row or a Records row (a report). This is the "Add Note"
// action on Transactions and Reports.
router.post("/knowledge", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const { explanation, context, transactionId, recordsId } = req.body;
    if (!explanation || !explanation.trim()) return res.status(400).json({ error: "Note text is required" });

    // Author references a Stakeholder, but the logged-in Management user
    // may not have one linked (e.g. the generic role accounts). Link it
    // when we can; otherwise the note is still saved, just unattributed
    // at the Stakeholder level — the session still knows who posted it.
    const author = req.currentUser && req.currentUser.Stakeholder_id ? req.currentUser.Stakeholder_id : null;

    const note = await prisma.Knowledge.create({
      data: {
        Explanation: explanation.trim(),
        Knowledge_type: "EXPLANATION",
        Context: context || null,
        Confidence_Level: 3, // "Based on experience" — a person's own note, not formally verified
        Language: "en",
        Author: author,
        Transactions_id: transactionId ? Number(transactionId) : null,
        Records_id: recordsId ? Number(recordsId) : null,
        Entry_date: new Date(),
        Entreprise_id: entrepriseId,
      },
    });

    res.json({ ok: true, knowledgeId: note.Knowledge_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error saving note" });
  }
});

module.exports = router;
