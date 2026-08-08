const express = require("express");
const router = express.Router();
const { prisma } = require("../../services/postingEngine");

// GET /knowledge
router.get("/knowledge", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const rows = await prisma.Knowledge.findMany({ where: { Entreprise_id: entrepriseId }, orderBy: { Knowledge_id: "desc" } });
    const authorIds = rows.map((k) => k.Author).filter(Boolean);
    const authors = await prisma.Stakeholder.findMany({ where: { Stakeholder_id: { in: authorIds } } });
    const authorById = Object.fromEntries(authors.map((s) => [s.Stakeholder_id, s]));

    res.render("knowledge", {
      title: "Knowledge",
      active: "knowledge",
      entries: rows.map((k) => ({
        type: k.Knowledge_type,
        context: k.Context,
        explanation: k.Explanation,
        decisionReason: k.Decision_Reason,
        recommendation: k.Recommendation,
        lessonLearned: k.Lesson_Learned,
        author: k.Author && authorById[k.Author] ? [authorById[k.Author].First_name, authorById[k.Author].Last_name].filter(Boolean).join(" ") : "Unknown",
        date: k.Entry_date ? new Date(k.Entry_date).toLocaleDateString("en-GB") : "",
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading knowledge: " + err.message);
  }
});

// GET /narrative
router.get("/narrative", async (req, res) => {
  try {
    const entrepriseId = req.currentUser.Entreprise_id;
    const rows = await prisma.Narrative.findMany({ where: { Entreprise_id: entrepriseId }, orderBy: { Narrative_id: "desc" }, take: 100 });
    res.render("narrative", {
      title: "Narrative",
      active: "narrative",
      entries: rows.map((n) => ({
        date: n.Narrative_date ? new Date(n.Narrative_date).toLocaleString("en-GB") : "",
        source: n.Narrative_source || (n.Is_Generated ? "SYSTEM" : "HUMAN"),
        isGenerated: !!n.Is_Generated,
        description: n.Description,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading narrative: " + err.message);
  }
});

module.exports = router;
